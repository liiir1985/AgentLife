import {
  Box,
  getNativeClipboard,
  HStack,
  Input,
  KeybindingsManager,
  matchesKey,
  ScrollView,
  setKeybindings,
  Text,
  TUI_KEYBINDINGS,
  TuiAltScreen,
  VStack,
  type Component,
  type OverlayHandle,
  type Terminal,
  type TuiInputListenerResult,
} from "@earendil-works/pi-tui";
import { SpikeModel, WIDE_LAYOUT_MIN_WIDTH, type SpikeMonitorRow, type SpikeViewModel } from "./spike-view-model.js";

/** A paste targeting a single-line input: line breaks must not vanish without a separator. */
const LINE_BREAKS = /\r\n|\r|\n/g;

/** Bracketed-paste markers a terminal wraps a paste in. */
const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";

/**
 * Threshold above which a single-line paste becomes a token. Mirrors the marker-sized
 * rule in OMP's editor (`> 10 lines || > 1000 chars`), tightened to every multi-line
 * paste because a single-line input cannot hold a line break at all.
 */
const INLINE_PASTE_CHARS = 1000;

/** Ceiling on one staged paste; a bigger paste is cut with an explicit note. */
const MAX_PASTE_CHARS = 200_000;

/** Control bytes never reach the buffer or the log; line feeds are the one exception. */
const NON_LINE_CONTROLS = /[^\P{Cc}\n]/gu;

/** A component whose content is projected from the current view model on each render. */
class ProjectedText implements Component {
  private readonly text = new Text(undefined, 0, 0);

  constructor(
    private readonly view: () => SpikeViewModel,
    private readonly project: (view: SpikeViewModel) => string,
  ) {}

  render(width: number): string[] {
    this.text.setText(this.project(this.view()));
    return this.text.render(width);
  }

  invalidate(): void {
    this.text.invalidate();
  }
}

export interface SpikeAppOptions {
  /**
   * Capture the mouse for viewport scrolling, hover and app-owned selection. Default
   * `false` so the terminal keeps its own selection and right-click, as OMP does with
   * `tui.mouse` off; while on, native selection moves to Shift+drag.
   */
  readonly mouse?: boolean;
  readonly wheelScrollLines?: number;
  /** Clipboard reader for right-click paste; defaults to pi-tui's native helper. */
  readonly readClipboard?: () => Promise<string | null | undefined>;
}

/**
 * Phase 0 terminal spike: fixed header and input bar, side-by-side panes above 120
 * columns and tabs below it, a scrollable log, and an F2 monitor overlay. Streaming
 * tokens only request a frame, so the renderer coalesces them into one repaint.
 */
export class SpikeApp {
  readonly model = new SpikeModel();
  readonly tui: TuiAltScreen;
  readonly inputField = new Input({ prompt: "> " });

  private readonly view = (): SpikeViewModel => this.viewModel();
  private readonly readClipboard: () => Promise<string | null | undefined>;
  private monitor: OverlayHandle | undefined;
  private unsubscribe: (() => void) | undefined;
  /** Payload of a bracketed paste still being read, in arrival order. */
  private pasteChunk: string[] | undefined;

  constructor(terminal: Terminal, options: SpikeAppOptions = {}) {
    // Home/End belong to the focused input line (readline habit); the transcript keeps
    // Ctrl+Home/Ctrl+End. Without this the alt screen's listener — registered before the
    // app's — swallows Home/End for "scroll to top/bottom" and the caret never moves.
    setKeybindings(
      new KeybindingsManager(TUI_KEYBINDINGS, {
        "tui.altScreen.top": ["ctrl+home"],
        "tui.altScreen.bottom": ["ctrl+end"],
      }),
    );
    this.readClipboard = options.readClipboard ?? (() => getNativeClipboard()?.getText() ?? Promise.resolve(undefined));
    this.tui = new TuiAltScreen(terminal, true, undefined, {
      mouse: options.mouse ?? false,
      wheelScrollLines: options.wheelScrollLines ?? 3,
      onRightClickPaste: () => this.pasteFromClipboard(),
    });

    const locationPane = new Box(1, 0);
    locationPane.addChild(new ProjectedText(this.view, locationText));
    const entityPane = new Box(1, 0);
    entityPane.addChild(new ProjectedText(this.view, entityText));
    const tabbedPane = new Box(1, 0);
    tabbedPane.addChild(new ProjectedText(this.view, narrowBodyText));

    const log = new ScrollView(new ProjectedText(this.view, logText), {
      follow: "end",
      primary: true,
      scrollbar: "auto",
    });

    const inputBar = new Box(1, 0);
    inputBar.addChild(this.inputField);
    this.inputField.onSubmit = (value) => {
      this.model.appendLog(`> ${this.model.expandPastes(value)}`);
      this.model.clearPastes();
      this.inputField.setValue("");
      this.tui.requestRender(true);
    };

    this.tui.setLayoutRoot(
      new VStack(
        [
          // Fixed bars must pin their single row: the layout shrinks entries without a
          // `minSize` first, and a scroll view whose content far exceeds the viewport
          // would otherwise squeeze the header and the input bar down to zero rows.
          { component: new ProjectedText(this.view, headerText), basis: 1, minSize: 1, shrink: 0 },
          {
            component: new HStack([locationPane, entityPane], { gap: 1 }),
            grow: 2,
            minSize: 3,
            maxSize: 12,
            visible: (viewport) => viewport.width >= WIDE_LAYOUT_MIN_WIDTH,
          },
          {
            component: tabbedPane,
            grow: 2,
            minSize: 3,
            maxSize: 12,
            visible: (viewport) => viewport.width < WIDE_LAYOUT_MIN_WIDTH,
          },
          // `basis: 0` keeps the log out of the shrink pass entirely; it only grows.
          { component: log, basis: 0, grow: 6, minSize: 5 },
          // Paste chips sit directly above the input bar and take exactly the rows they
          // render, so an empty prompt has no reserved band.
          {
            component: new ProjectedText(this.view, chipText),
            basis: "auto",
            minSize: 0,
            shrink: 0,
            visible: () => this.viewModel().pastes.length > 0,
          },
          { component: inputBar, basis: 1, minSize: 1, shrink: 0 },
        ],
        { gap: 0 },
      ),
    );
  }

  start(): void {
    this.unsubscribe = this.tui.addInputListener((data) => this.handleGlobalKey(data));
    this.tui.start();
    this.tui.setFocus(this.inputField);
    this.render();
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.closeMonitor();
    this.tui.stop();
  }

  render(): void {
    this.tui.renderNow(true);
  }

  get focusedComponent(): Component | null {
    return this.tui.getFocusedComponent();
  }

  get isMonitorOpen(): boolean {
    return this.monitor !== undefined;
  }

  viewModel(): SpikeViewModel {
    return this.model.snapshot(this.tui.terminal.columns, this.inputField.getValue());
  }

  /** A single streaming token costs a frame request, not a repaint. */
  appendStreamToken(token: string): void {
    this.model.appendStreamToken(token);
    this.tui.requestRender();
  }

  appendLog(line: string): void {
    this.model.appendLog(line);
    this.tui.requestRender();
  }

  toggleMonitor(): void {
    if (this.monitor === undefined) {
      const pane = new Box(1, 1);
      pane.addChild(new ProjectedText(this.view, monitorText));
      this.monitor = this.tui.showOverlay(pane, { width: "60%", maxHeight: "70%", anchor: "center" });
      this.render();
      return;
    }
    this.closeMonitor();
    this.render();
  }

  private closeMonitor(): void {
    const handle = this.monitor;
    if (handle === undefined) return;
    this.monitor = undefined;
    handle.unfocus({ target: this.inputField });
    handle.hide();
  }

  /**
   * Right-click paste. Pi's handler only calls back on Windows and never clears the
   * selection, so the app owns the insertion and reports nothing on failure.
   */
  private pasteFromClipboard(): void {
    void this.readClipboard()
      .then((text) => {
        if (text === null || text === undefined || text.length === 0) return;
        this.tui.setFocus(this.inputField);
        this.stagePaste(text);
        this.tui.requestRender(true);
      })
      .catch(() => {
        // Clipboard access is best effort; a failure must not break the frame.
      });
  }

  /**
   * Routes a paste to the line, or — when it cannot fit one — behind a token that is
   * expanded again where the line is consumed. The token is what the user sees, so the
   * paste survives a single-line buffer without being rewritten.
   */
  private stagePaste(raw: string): void {
    const text = sanitizePaste(raw);
    if (text.length === 0) return;
    if (!text.includes("\n") && text.length <= INLINE_PASTE_CHARS) {
      this.typeInput(toSingleLine(text));
      return;
    }
    this.typeInput(this.model.stagePaste(text).label);
  }

  /** Feeds text to whatever holds focus, so an overlay keeps swallowing it. */
  private typeInput(text: string): void {
    const target = this.tui.getFocusedComponent() ?? this.inputField;
    target.handleInput?.(text);
  }

  /**
   * Consumes bracketed-paste chunks. A paste can span reads, so the payload is buffered
   * until its closing marker arrives; anything typed before the marker in the same chunk
   * still reaches the line. Returns `false` when the chunk carries no paste at all.
   */
  private handlePasteChunk(data: string): boolean {
    if (this.pasteChunk === undefined && !data.includes(PASTE_START)) return false;
    let rest = data;
    while (rest.length > 0) {
      if (this.pasteChunk !== undefined) {
        const end = rest.indexOf(PASTE_END);
        if (end < 0) {
          this.pasteChunk.push(rest);
          return true;
        }
        this.pasteChunk.push(rest.slice(0, end));
        this.stagePaste(this.pasteChunk.join(""));
        this.pasteChunk = undefined;
        rest = rest.slice(end + PASTE_END.length);
        continue;
      }
      const start = rest.indexOf(PASTE_START);
      if (start < 0) {
        this.typeInput(rest);
        return true;
      }
      if (start > 0) this.typeInput(rest.slice(0, start));
      this.pasteChunk = [];
      rest = rest.slice(start + PASTE_START.length);
    }
    return true;
  }

  private handleGlobalKey(data: string): TuiInputListenerResult | undefined {
    if (matchesKey(data, "f2")) {
      this.toggleMonitor();
      return { consume: true };
    }
    if (matchesKey(data, "tab")) {
      this.model.setActiveTab(this.viewModel().activeTab === "location" ? "entities" : "location");
      this.render();
      return { consume: true };
    }
    if (this.handlePasteChunk(data)) return { consume: true };
    const parts = splitControlChunk(data);
    if (parts === undefined) return undefined;
    // Pi drops a chunk that mixes printable text with control characters, so a
    // terminal coalescing "text" and Enter would silently lose the whole line.
    // Replaying the parts separately keeps such input working.
    const target = this.tui.getFocusedComponent() ?? this.inputField;
    for (const part of parts) target.handleInput?.(part);
    if (this.monitor === undefined) this.tui.requestRender(true);
    return { consume: true };
  }
}

/** Normalizes a paste for the buffer: line feeds survive, every other control byte goes. */
function sanitizePaste(text: string): string {
  const normalized = text.replace(LINE_BREAKS, "\n").replace(/\t/g, "    ").replace(NON_LINE_CONTROLS, "");
  return normalized.length > MAX_PASTE_CHARS
    ? `${normalized.slice(0, MAX_PASTE_CHARS)}\n…（粘贴内容超过 ${MAX_PASTE_CHARS} 字，已截断）`
    : normalized;
}

/** Flattens pasted text for the single-line input, keeping control bytes out of it. */
function toSingleLine(text: string): string {
  return text
    .replace(LINE_BREAKS, " ")
    .replace(/\t/g, "    ")
    .replace(/\p{Cc}/gu, "");
}

function headerText(view: SpikeViewModel): string {
  return `AgentLife 阶段 0 │ 时间线 ${view.timelineId} · 轮次 ${view.roundId} · Tick ${view.tick} · ${view.phase}`;
}

/**
 * Splits a chunk that mixes printable text with control characters into separate
 * keystrokes. Escape sequences are left untouched so terminal protocols keep working.
 */
function splitControlChunk(data: string): readonly string[] | undefined {
  if (data.includes("\x1b")) return undefined;
  const parts: string[] = [];
  let text = "";
  for (const character of data) {
    const code = character.charCodeAt(0);
    if (code < 32 || code === 0x7f) {
      if (text.length > 0) parts.push(text);
      text = "";
      parts.push(character);
      continue;
    }
    text += character;
  }
  if (text.length > 0) parts.push(text);
  return parts.length > 1 ? parts : undefined;
}

function locationText(view: SpikeViewModel): string {
  return [`地点`, "", view.location].join("\n");
}

function entityText(view: SpikeViewModel): string {
  const rows = view.entities.map((entity) => `· ${entity.name} — ${entity.detail}`);
  return ["实体", "", ...(rows.length === 0 ? ["（无）"] : rows)].join("\n");
}

/** One card line per staged paste, directly above the input bar. */
function chipText(view: SpikeViewModel): string {
  return view.pastes
    .map((paste) => `#${paste.n} 粘贴 · ${paste.lines} 行 · ${paste.chars} 字 · ${paste.preview}`)
    .join("\n");
}

function narrowBodyText(view: SpikeViewModel): string {
  const tabs = view.activeTab === "location" ? "[地点]  实体" : " 地点  [实体]";
  const body = view.activeTab === "location" ? locationText(view) : entityText(view);
  return `${tabs}\n\n${body}`;
}

function logText(view: SpikeViewModel): string {
  const lines = [...view.log];
  if (view.stream.length > 0) lines.push(`… ${view.stream}`);
  return lines.join("\n");
}

function monitorText(view: SpikeViewModel): string {
  const rows: SpikeMonitorRow[] = [
    { label: "时间线", value: view.timelineId },
    { label: "轮次", value: view.roundId },
    { label: "Tick", value: String(view.tick) },
    { label: "阶段", value: view.phase },
    { label: "布局", value: `${view.layout}（${view.width} 列）` },
    { label: "日志行", value: String(view.log.length) },
    { label: "流式字符", value: String(view.stream.length) },
    { label: "实体数", value: String(view.entities.length) },
    { label: "粘贴", value: String(view.pastes.length) },
    { label: "输入", value: view.input },
  ];
  return ["监视 (F2)", "", ...rows.map((row) => `${row.label}  ${row.value}`)].join("\n");
}
