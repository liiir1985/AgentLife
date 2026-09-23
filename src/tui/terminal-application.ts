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
import type {
  ActionParameterSession,
  ControllerMode,
  SimulationController,
} from "../interaction/simulation-controller.js";
import type { PerceivedSubject } from "../interaction/context-actions.js";
import type { CognitionRound } from "../simulation/types.js";
import { ContextActionBar } from "./context-action-bar.js";

const WIDE_WIDTH = 120;
const LOG_LIMIT = 500;
const NOTIFICATION_MS = 2_000;
const SHORTCUTS = "←/→ 选择  Enter 确认  Space 运行/暂停  / 管理  F2 监视";

type FocusMode = "action-bar" | "entity-parameter" | "text-parameter" | "management-input" | "monitor";
type NarrowTab = "location" | "entities" | "log";

/**
 * How the ordinary view names a perceived object: what it recognised, or the
 * appearance it was shown with, marked so a recognised person is distinguishable
 * from an unrecognised figure.
 */
function subjectLabel(subject: PerceivedSubject): string {
  return subject.recognisable ? subject.name : `${subject.name}（未识别）`;
}

/** One readable list for the management panel; private content never reaches this helper. */
function listOf(values: readonly string[]): string {
  return values.length === 0 ? "无" : values.join("、");
}

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
    const status = this.status();
    if (status.length === 0) return [truncateToWidth(SHORTCUTS, width)];
    const visibleStatus = truncateToWidth(status, width);
    const statusWidth = visibleWidth(visibleStatus);
    if (statusWidth >= width) return [visibleStatus];
    const visibleShortcuts = truncateToWidth(SHORTCUTS, width - statusWidth - 1);
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
  /** The model the AI characters think with, shown in the monitor panel. */
  readonly model?: string;
  readonly onExit?: () => void;
}

export class TerminalApplication {
  readonly tui: TuiAltScreen;
  readonly actionBar: ContextActionBar;
  private readonly log: string[] = [];
  /** Observation identities already written to the log; the pending list repeats them every tick. */
  private readonly shownObservations = new Set<string>();
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
  /** The mode the last notice was based on, so a stop is reported once. */
  private lastMode: ControllerMode | undefined;

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
    const logProjection = (): string => (this.log.length === 0 ? "（还没有观察到任何事情）" : this.log.join("\n"));
    const logView = new ScrollView(new ProjectedText(logProjection), {
      follow: "end",
      primary: true,
      scrollbar: "auto",
    });
    const narrowLog = new ScrollView(new ProjectedText(logProjection), {
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
    this.unsubscribeController = this.controller.subscribe(() => {
      this.appendPerceivedObservations();
      this.noticeStall();
      this.tui.requestRender(true);
    });
    this.appendPerceivedObservations();
    this.tui.start();
    this.tui.setFocus(this.actionBar);
    this.notify("左右选择动作，空格运行/暂停，/ 打开管理命令");
    this.tui.renderNow(true);
  }

  /**
   * Tells the player, once per stop, that a decision could not be made and what may be
   * done about it. The words stay in the player's own terms: what stopped, and the way on.
   */
  private noticeStall(): void {
    const mode = this.controller.status().mode;
    if (mode === this.lastMode) return;
    this.lastMode = mode;
    if (mode === "failed") this.notify("AI 这一轮没有给出可用的决定：按空格再试一次，或 /load 载入存档");
  }

  stop(): void {
    this.unsubscribeInput?.();
    this.unsubscribeController?.();
    if (this.notificationTimer !== undefined) clearTimeout(this.notificationTimer);
    this.closeOverlay();
    this.tui.stop();
    this.controller.close();
  }

  private notify(message: string): void {
    this.notification = message;
    if (this.notificationTimer !== undefined) clearTimeout(this.notificationTimer);
    this.notificationTimer = setTimeout(() => {
      this.notification = "";
      this.notificationTimer = undefined;
      this.tui.renderNow(true);
    }, NOTIFICATION_MS);
    this.tui.renderNow(true);
  }

  /** The only thing the ordinary log ever holds: what this player's own perception reported. */
  private appendPerceivedObservations(): void {
    for (const observation of this.controller.perceptionLog()) {
      if (this.shownObservations.has(observation.observationId)) continue;
      this.shownObservations.add(observation.observationId);
      this.log.push(observation.text);
    }
    if (this.log.length > LOG_LIMIT) this.log.splice(0, this.log.length - LOG_LIMIT);
  }

  /**
   * What the simulation is waiting for, in the player's own terms.
   *
   * The header names no character, no control source and no barrier: something being
   * worked out reads as waiting for it, everything else as whose turn it is.
   */
  private waitState(): string {
    const status = this.controller.status();
    if (status.mode === "cognition") return "等待 AI";
    if (status.mode === "failed") return "认知失败";
    if (status.mode === "barrier") return "运行中";
    if (status.mode === "running") return "连续运行中";
    return "等待玩家选择";
  }

  private headerText(): string {
    const view = this.controller.view();
    const status = this.controller.status();
    const save = status.pendingSave === null ? "" : ` · 保存待处理 ${status.pendingSave}`;
    return `AgentLife │ ${view.simSeconds}s · Tick ${view.tick} · ${this.waitState()} · ${view.configId.slice(0, 12)}${save}`;
  }

  private locationText(): string {
    const view = this.controller.view();
    const place = view.place;
    const lines = [
      place === null ? "地点：未知（按空格推进一次，角色才有第一个观察）" : `地点：${subjectLabel(place)}`,
    ];
    if (place !== null && place.detail !== place.name) lines.push(place.detail);
    lines.push(`出口：${view.exits.map(subjectLabel).join("、") || "无"}`);
    for (const action of view.playerActions)
      lines.push(
        `自身动作：${action.action}（${action.status}）${action.outcome === null ? "" : ` — ${action.outcome}`}`,
      );
    return lines.join("\n");
  }

  private entityText(): string {
    const view = this.controller.view();
    const nearby =
      view.entities
        .map((subject) =>
          subject.detail === subject.name
            ? `· ${subjectLabel(subject)}`
            : `· ${subjectLabel(subject)} — ${subject.detail}`,
        )
        .join("\n") || "（无）";
    const held = view.heldItems.map((subject) => subject.name).join("、") || "无";
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
      // Recalled the way the terminal writes a line, so the cursor lands at its end.
      this.activeInput.setValue("");
      this.activeInput.handleInput(this.managementHistory[this.historyIndex] ?? "/");
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
      // Asked for before a decision is reached, applied by the tick that reaches it.
      this.controller.toggleRunning();
      this.notify(this.controller.status().running ? this.runState() : "已暂停");
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

  /** How an ongoing run reads, without the internal detail text the controller carries. */
  private runState(): string {
    const remaining = this.controller.status().runLimitRemaining;
    return remaining === null ? "连续运行中" : `连续运行，剩余 ${remaining} Tick`;
  }

  private confirmAction(): void {
    const selected = this.actionBar.current();
    if (selected === undefined) return;
    const wasRunning = this.controller.status().running;
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
      value: choice.reference,
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

  /** Esc leaves the parameter form only; the round the player may be in stays open. */
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
    // The slash that opened this line stays in it, with the cursor after it.
    input.handleInput("/");
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
        this.notify(
          result.status === "cognitive-barrier" ? this.waitState() : `Tick ${result.summary.tick}: ${result.status}`,
        );
      } else if (command === "/run") {
        this.controller.run(argument === undefined ? undefined : Number(argument));
        this.notify(this.runState());
      } else if (command === "/pause") {
        this.controller.pause();
        this.notify("已暂停");
      } else if (command === "/skip") {
        this.notify(this.controller.skipPlayer().message);
      } else if (command === "/save" && argument !== undefined) {
        this.notify(this.controller.save(argument).message);
      } else if (command === "/load" && argument !== undefined) {
        this.notify(this.controller.load(argument).message);
      } else if (command === "/status") this.notify(this.statusLine());
      else if (command === "/monitor") this.toggleMonitor();
      else if (command === "/help")
        this.notify("管理：/step /run [ticks] /pause /skip /save <id> /load <id> /status /monitor /help");
      else this.notify("未知或缺少参数的管理命令；输入 /help 查看帮助");
    } catch (failure) {
      this.notify(failure instanceof Error ? failure.message : String(failure));
    }
  }

  /** A one-line status the ordinary footer may carry: it names no character and no reference. */
  private statusLine(): string {
    const status = this.controller.status();
    const run = status.runLimitRemaining === null ? "不限" : `剩余 ${status.runLimitRemaining}`;
    const save = status.pendingSave === null ? "" : ` · 保存待处理 ${status.pendingSave}`;
    return `Tick ${status.tick} · ${this.waitState()} · 待交计划 ${status.pendingPlans} · 运行 ${run}${save}`;
  }

  private toggleMonitor(): void {
    if (this.mode === "monitor") {
      this.closeOverlayToActions();
      return;
    }
    this.closeOverlay();
    const box = new Box(1, 1);
    box.addChild(new ProjectedText(() => this.monitorText()));
    this.overlay = this.tui.showOverlay(box, { width: "92%", maxHeight: "85%", anchor: "center" });
    this.mode = "monitor";
    this.tui.setFocus(box);
    this.tui.renderNow(true);
  }

  /**
   * The management view: entity identities, perception bookkeeping, cognition state and
   * diagnostics belong here and nowhere else. Working Memory reports counts, never the
   * admitted text.
   */
  private monitorText(): string {
    const snapshot = this.controller.managementSnapshot();
    const state = snapshot.state;
    const status = snapshot.status;
    const round = state.round;
    const lines: string[] = [
      "管理员视图 — 不属于角色观察",
      `Entities: ${Object.keys(state.world.entities).length} · Bodies: ${Object.keys(state.body.bodies).length}`,
      `World: ${state.world.processes.length} process · ${state.world.events.length} events`,
      `Scheduler: ${status.mode} · Tick ${state.tick} · pending ${snapshot.pendingPlans.length}${status.pendingSave === null ? "" : ` · save ${status.pendingSave}`}`,
      `Model: ${this.options.model ?? "未设置"}`,
      `Barrier: ${state.barrier?.detail ?? "none"} · Failure: ${state.failure?.detail ?? "none"}`,
      "",
      `Perception（${snapshot.perception.length} 观察者）`,
    ];
    if (snapshot.perception.length === 0) lines.push("  （无）");
    for (const row of snapshot.perception)
      lines.push(
        `  ${row.characterId} · 对象 ${row.subjects} · 待处理 ${row.pending} · 材料 ${row.materialVersion} · 注意 ${row.attentionVersion}`,
      );
    lines.push("");
    lines.push(`Cognition（${this.waitState()}）`);
    lines.push(`  轮次：${round === null ? "无" : `${round.roundId} · ${round.status}`}`);
    lines.push(`  等待原因：${this.waitingReason(round)}`);
    for (const participant of round?.participants ?? [])
      lines.push(
        `  参与者：${participant.characterId}（${participant.control}）${participant.state} · 尝试 ${participant.attempts} · ${participant.detail}`,
      );
    if (snapshot.cognition.length === 0) lines.push("  （无）");
    for (const row of snapshot.cognition)
      lines.push(
        `  ${row.characterId} 注意：${listOf(row.attention)}｜理解：${row.understanding === "" ? "无" : row.understanding}｜疑问：${listOf(row.questions)}｜持续：${row.persistence === "" ? "无" : row.persistence}｜意图：${listOf(row.intentions)}｜空闲：${row.idle ?? "无"}｜决定 ${row.decisions}｜请求 ${row.pendingRequestId ?? "无"}`,
      );
    lines.push("");
    lines.push("Working Memory（容量、已准入与消费数量；不含私密文本）");
    if (snapshot.workingMemory.length === 0) lines.push("  （无）");
    for (const row of snapshot.workingMemory)
      lines.push(`  ${row.characterId} · 已准入 ${row.entries}/${row.capacity} · 已消费 ${row.consumed}`);
    lines.push("");
    lines.push("Diagnostics");
    if (snapshot.diagnostics.length === 0) lines.push("  （无）");
    for (const note of snapshot.diagnostics) lines.push(`  ${note}`);
    return lines.join("\n");
  }

  private waitingReason(round: CognitionRound | null): string {
    if (round === null) return "没有等待决定的轮次";
    const waiting = round.demands.map((demand) => `${demand.characterId}: ${demand.reason}（${demand.detail}）`);
    return waiting.length === 0 ? "无" : waiting.join("；");
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
