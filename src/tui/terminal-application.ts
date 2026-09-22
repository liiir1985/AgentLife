import {
  Box,
  HStack,
  Input,
  matchesKey,
  ScrollView,
  SelectList,
  Text,
  TuiAltScreen,
  VStack,
  truncateToWidth,
  visibleWidth,
  type Component,
  type OverlayHandle,
  type SelectItem,
  type Terminal,
  type TuiInputListenerResult,
} from "@earendil-works/pi-tui";
import type { ActionParameterSession, SimulationController } from "../interaction/simulation-controller.js";
import type { PlayerView } from "../interaction/context-actions.js";
import { ContextActionBar } from "./context-action-bar.js";

const WIDE_WIDTH = 120;
type FocusMode = "action-bar" | "entity-parameter" | "text-parameter" | "management-input" | "monitor";
type NarrowTab = "location" | "entities" | "log";

class ProjectedText implements Component {
  private readonly text = new Text(undefined, 0, 0);
  constructor(private readonly project: () => string) {}
  render(width: number): string[] {
    this.text.setText(this.project());
    return this.text.render(width);
  }
  invalidate(): void {
    this.text.invalidate();
  }
}

class FooterStatusLine implements Component {
  constructor(private readonly status: () => string) {}
  render(width: number): string[] {
    const shortcuts = "←/→ 选择  Enter 确认  Space 运行/暂停  / 管理  F2 监视";
    const status = this.status();
    if (status.length === 0) return [truncateToWidth(shortcuts, width)];
    const visibleStatus = truncateToWidth(status, width);
    const statusWidth = visibleWidth(visibleStatus);
    if (statusWidth >= width) return [visibleStatus];
    const visibleShortcuts = truncateToWidth(shortcuts, width - statusWidth - 1);
    const padding = width - visibleWidth(visibleShortcuts) - statusWidth;
    return [`${visibleShortcuts}${" ".repeat(padding)}${visibleStatus}`];
  }
  invalidate(): void {}
}

const SELECT_THEME = {
  selectedPrefix: (text: string) => text,
  selectedText: (text: string) => text,
  description: (text: string) => text,
  scrollInfo: (text: string) => text,
  noMatch: (text: string) => text,
};

export interface TerminalApplicationOptions {
  readonly mouse?: boolean;
  readonly onExit?: () => void;
}

export class TerminalApplication {
  readonly tui: TuiAltScreen;
  readonly actionBar: ContextActionBar;
  private readonly log: string[] = [];
  private readonly shownEventIds = new Set<string>();
  private notification = "";
  private notificationTimer: ReturnType<typeof setTimeout> | undefined;
  private resumeAfterParameter = false;
  private mode: FocusMode = "action-bar";
  private tab: NarrowTab = "location";
  private overlay: OverlayHandle | undefined;
  private session: ActionParameterSession | undefined;
  private activeInput: Input | undefined;
  private readonly managementHistory: string[] = [];
  private historyIndex = 0;
  private unsubscribeInput: (() => void) | undefined;
  private unsubscribeController: (() => void) | undefined;

  constructor(
    terminal: Terminal,
    readonly controller: SimulationController,
    private readonly options: TerminalApplicationOptions = {},
  ) {
    this.tui = new TuiAltScreen(terminal, true, undefined, { mouse: options.mouse ?? false, wheelScrollLines: 3 });
    this.actionBar = new ContextActionBar(() => this.controller.availableActions());
    const locationPane = new Box(1, 0);
    locationPane.addChild(new ProjectedText(() => this.locationText()));
    const entityPane = new Box(1, 0);
    entityPane.addChild(new ProjectedText(() => this.entityText()));
    const logView = new ScrollView(new ProjectedText(() => this.log.join("\n")), {
      follow: "end",
      primary: true,
      scrollbar: "auto",
    });
    const narrowLog = new ScrollView(new ProjectedText(() => this.log.join("\n")), {
      follow: "end",
      scrollbar: "auto",
    });
    this.tui.setLayoutRoot(
      new VStack(
        [
          { component: new ProjectedText(() => this.headerText()), basis: 1, minSize: 1, shrink: 0 },
          {
            component: new HStack([locationPane, entityPane], { gap: 1 }),
            grow: 2,
            minSize: 4,
            maxSize: 12,
            visible: (viewport) => viewport.width >= WIDE_WIDTH,
          },
          {
            component: new ProjectedText(() => this.narrowText()),
            grow: 1,
            minSize: 4,
            visible: (viewport) => viewport.width < WIDE_WIDTH && this.tab !== "log",
          },
          {
            component: narrowLog,
            basis: 0,
            grow: 6,
            minSize: 5,
            visible: (viewport) => viewport.width < WIDE_WIDTH && this.tab === "log",
          },
          {
            component: logView,
            basis: 0,
            grow: 6,
            minSize: 5,
            visible: (viewport) => viewport.width >= WIDE_WIDTH,
          },
          { component: this.actionBar, basis: 1, minSize: 1, shrink: 0 },
          {
            component: new FooterStatusLine(() => this.notification),
            basis: 1,
            minSize: 1,
            shrink: 0,
          },
        ],
        { gap: 0 },
      ),
    );
  }

  start(): void {
    this.unsubscribeInput = this.tui.addInputListener((data) => this.handleGlobal(data));
    for (const event of this.controller.observedEvents()) this.shownEventIds.add(event.eventId);
    this.unsubscribeController = this.controller.subscribe(() => {
      this.appendObservedEvents();
      this.tui.requestRender(true);
    });
    this.tui.start();
    this.tui.setFocus(this.actionBar);
    this.notify("左右选择动作，空格运行/暂停，/ 打开管理命令");
    this.tui.renderNow(true);
  }

  stop(): void {
    this.unsubscribeInput?.();
    this.unsubscribeController?.();
    if (this.notificationTimer !== undefined) clearTimeout(this.notificationTimer);
    this.closeOverlay();
    this.tui.stop();
    this.controller.close();
  }

  appendLog(message: string): void {
    this.log.push(message);
    if (this.log.length > 500) this.log.splice(0, this.log.length - 500);
    this.tui.renderNow(true);
  }

  private notify(message: string): void {
    this.notification = message;
    if (this.notificationTimer !== undefined) clearTimeout(this.notificationTimer);
    this.notificationTimer = setTimeout(() => {
      this.notification = "";
      this.notificationTimer = undefined;
      this.tui.renderNow(true);
    }, 2_000);
    this.tui.renderNow(true);
  }

  private appendObservedEvents(): void {
    for (const event of this.controller.observedEvents()) {
      if (this.shownEventIds.has(event.eventId)) continue;
      this.shownEventIds.add(event.eventId);
      this.appendLog(event.text);
    }
  }

  private view(): PlayerView {
    return this.controller.view();
  }

  private headerText(): string {
    const view = this.view();
    const status = this.controller.status();
    return `AgentLife │ ${view.simSeconds}s · Tick ${view.tick} · ${status.mode} · ${view.configId.slice(0, 12)}${view.barrier === null ? "" : " · 屏障"}`;
  }

  private locationText(): string {
    const view = this.view();
    return [
      `地点：${view.locationName}`,
      view.locationDescription,
      `出口：${view.exits.map((entry) => entry.name).join("、") || "无"}`,
    ].join("\n");
  }

  private entityText(): string {
    const view = this.view();
    const nearby = view.entities.map((entry) => `· ${entry.name}`).join("\n") || "（无）";
    const held = view.heldItems.map((entry) => entry.name).join("、") || "无";
    return `人物与物品\n${nearby}\n持有：${held}`;
  }

  private narrowText(): string {
    const tabs = `${this.tab === "location" ? "[地点]" : "地点"} ${this.tab === "entities" ? "[实体]" : "实体"} ${this.tab === "log" ? "[日志]" : "日志"}`;
    return `${tabs}\n${this.tab === "location" ? this.locationText() : this.entityText()}`;
  }

  private handleGlobal(data: string): TuiInputListenerResult | undefined {
    if (matchesKey(data, "ctrl+c")) {
      this.stop();
      this.options.onExit?.();
      return { consume: true };
    }
    if (matchesKey(data, "f2")) {
      this.toggleMonitor();
      return { consume: true };
    }
    if (
      this.mode === "management-input" &&
      this.activeInput !== undefined &&
      (matchesKey(data, "up") || matchesKey(data, "down"))
    ) {
      const delta = matchesKey(data, "up") ? -1 : 1;
      this.historyIndex = Math.max(0, Math.min(this.managementHistory.length, this.historyIndex + delta));
      this.activeInput.setValue(this.managementHistory[this.historyIndex] ?? "/");
      this.tui.requestRender(true);
      return { consume: true };
    }
    if (this.mode !== "action-bar") return undefined;
    if (matchesKey(data, "left") || matchesKey(data, "right")) {
      this.actionBar.handleInput(data);
      this.tui.requestRender(true);
      return { consume: true };
    }
    if (matchesKey(data, "enter")) {
      this.confirmAction();
      return { consume: true };
    }
    if (matchesKey(data, "space")) {
      this.controller.toggleRunning();
      this.notify(this.controller.status().detail);
      return { consume: true };
    }
    if (data === "/") {
      this.openManagementInput();
      return { consume: true };
    }
    if (matchesKey(data, "tab") || matchesKey(data, "shift+tab")) {
      const tabs: NarrowTab[] = ["location", "entities", "log"];
      const index = tabs.indexOf(this.tab);
      const delta = matchesKey(data, "shift+tab") ? -1 : 1;
      this.tab = tabs[(index + delta + tabs.length) % tabs.length] ?? "location";
      this.tui.requestRender(true);
      return { consume: true };
    }
    return undefined;
  }

  private confirmAction(): void {
    const selected = this.actionBar.current();
    if (selected === undefined) return;
    const wasRunning = this.controller.status().mode === "running";
    const session = this.controller.beginAction(selected.command.ref);
    if (session === undefined) {
      this.notify("上下文已经变化，该动作不再可用");
      return;
    }
    this.resumeAfterParameter = wasRunning;
    this.session = session;
    if (session.current() === undefined) {
      this.finishAction();
      return;
    }
    this.openCurrentParameter();
  }

  private openCurrentParameter(): void {
    const argument = this.session?.current();
    if (argument === undefined) {
      this.finishAction();
      return;
    }
    this.closeOverlay();
    if (argument.kind === "entity") this.openEntityParameter(argument.prompt);
    else this.openTextParameter(argument.prompt);
  }

  private openEntityParameter(prompt: string): void {
    const choices = this.session?.choices() ?? [];
    const items: SelectItem[] = choices.map((choice) => ({
      value: choice.entityId,
      label: choice.name,
      description: choice.detail,
    }));
    const list = new SelectList(items, 7, SELECT_THEME);
    list.onSelect = (item) => {
      const result = this.session?.acceptEntity(item.value);
      if (result?.error !== undefined) this.notify(result.error);
      else if (result?.done === true) this.finishAction();
      else this.openCurrentParameter();
    };
    list.onCancel = () => this.backOrCancel();
    const box = new Box(1, 1);
    box.addChild(new VStack([new Text(prompt, 0, 0), list], { gap: 1 }));
    this.overlay = this.tui.showOverlay(box, { width: "60%", maxHeight: "70%", anchor: "center" });
    this.mode = "entity-parameter";
    this.tui.setFocus(list);
    this.tui.renderNow(true);
  }

  private openTextParameter(prompt: string): void {
    const input = new Input({ prompt: "> ", placeholder: prompt });
    input.onSubmit = (value) => {
      const result = this.session?.acceptText(value);
      if (result?.error !== undefined) this.notify(result.error);
      else if (result?.done === true) this.finishAction();
      else this.openCurrentParameter();
    };
    input.onEscape = () => this.backOrCancel();
    const box = new Box(1, 1);
    box.addChild(new VStack([new Text(prompt, 0, 0), input], { gap: 1 }));
    this.overlay = this.tui.showOverlay(box, { width: "60%", maxHeight: 5, anchor: "bottom-center" });
    this.activeInput = input;
    this.mode = "text-parameter";
    this.tui.setFocus(input);
    this.tui.renderNow(true);
  }

  private backOrCancel(): void {
    if (this.session?.back() === true) this.openCurrentParameter();
    else {
      this.session = undefined;
      this.closeOverlayToActions();
      this.resumeAfterTemporaryPause();
    }
  }

  private finishAction(): void {
    const session = this.session;
    if (session === undefined) return;
    const result = this.controller.queueAction(session);
    this.notify(result.message);
    this.session = undefined;
    this.closeOverlayToActions();
    if (result.ok) this.resumeAfterTemporaryPause();
    else this.resumeAfterParameter = false;
  }

  private resumeAfterTemporaryPause(): void {
    const shouldResume = this.resumeAfterParameter;
    this.resumeAfterParameter = false;
    if (shouldResume) this.controller.run();
  }

  private openManagementInput(): void {
    this.closeOverlay();
    const input = new Input({ prompt: "", placeholder: "/help" });
    input.setValue("/");
    input.onSubmit = (value) => {
      if (value.trim().length > 1) this.managementHistory.push(value.trim());
      this.historyIndex = this.managementHistory.length;
      this.executeManagement(value);
      this.closeOverlayToActions();
    };
    input.onEscape = () => this.closeOverlayToActions();
    const box = new Box(1, 1);
    box.addChild(input);
    this.overlay = this.tui.showOverlay(box, { width: "70%", maxHeight: 3, anchor: "bottom-center" });
    this.activeInput = input;
    this.mode = "management-input";
    this.tui.setFocus(input);
    this.tui.renderNow(true);
  }

  private executeManagement(raw: string): void {
    const [command = "", argument] = raw.trim().split(/\s+/, 2);
    try {
      if (command === "/step") {
        const result = this.controller.step();
        this.notify(`Tick ${result.summary.tick}: ${result.status}`);
      } else if (command === "/run") {
        this.controller.run(argument === undefined ? undefined : Number(argument));
        this.notify(this.controller.status().detail);
      } else if (command === "/pause") {
        this.controller.pause();
        this.notify("已暂停");
      } else if (command === "/save" && argument !== undefined) {
        this.controller.save(argument);
        this.notify(`已保存 ${argument}`);
      } else if (command === "/load" && argument !== undefined) {
        this.notify(this.controller.load(argument).message);
      } else if (command === "/status") this.notify(JSON.stringify(this.controller.status()));
      else if (command === "/monitor") this.toggleMonitor();
      else if (command === "/help")
        this.notify("管理：/step /run [ticks] /pause /save <id> /load <id> /status /monitor /help");
      else this.notify("未知或缺少参数的管理命令；输入 /help 查看帮助");
    } catch (failure) {
      this.notify(failure instanceof Error ? failure.message : String(failure));
    }
  }

  private toggleMonitor(): void {
    if (this.mode === "monitor") {
      this.closeOverlayToActions();
      return;
    }
    this.closeOverlay();
    const snapshot = this.controller.managementSnapshot();
    const state = snapshot.state;
    const lines = [
      "管理员视图 — 不属于角色观察",
      `Entities: ${Object.keys(state.world.entities).length} · Bodies: ${Object.keys(state.body.bodies).length}`,
      `World: ${state.world.processes.length} process · ${state.world.events.length} events`,
      `Scheduler: ${snapshot.status.mode} · Tick ${state.tick} · pending ${snapshot.pendingPlans.length}`,
      `Barrier: ${state.barrier?.detail ?? "none"} · Failure: ${state.failure?.detail ?? "none"}`,
      "Memory: 阶段 5 未接入",
      `Diagnostics: ${state.configId}`,
    ];
    const box = new Box(1, 1);
    box.addChild(new Text(lines.join("\n"), 0, 0));
    this.overlay = this.tui.showOverlay(box, { width: "70%", maxHeight: "70%", anchor: "center" });
    this.mode = "monitor";
    this.tui.setFocus(box);
    this.tui.renderNow(true);
  }

  private closeOverlay(): void {
    this.overlay?.hide();
    this.overlay = undefined;
    this.activeInput = undefined;
  }

  private closeOverlayToActions(): void {
    this.closeOverlay();
    this.mode = "action-bar";
    this.tui.setFocus(this.actionBar);
    this.tui.renderNow(true);
  }
}
