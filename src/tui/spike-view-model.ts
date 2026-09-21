/** Entities shown in the wide layout's right column and the narrow layout's tab. */
export interface SpikeEntity {
  readonly id: string;
  readonly name: string;
  readonly detail: string;
}

export interface SpikeMonitorRow {
  readonly label: string;
  readonly value: string;
}

/**
 * A paste too large for the single-line buffer: it stays out of the line as a token
 * (`[粘贴 #1]`) and is expanded where the line is consumed. Mirrors the `[Paste #N]`
 * attachment token in OMP's editor.
 */
export interface SpikePaste {
  readonly n: number;
  readonly label: string;
  readonly lines: number;
  readonly chars: number;
  readonly preview: string;
}

export type SpikePhase = "idle" | "streaming" | "cancelled" | "timed-out";
export type SpikeTab = "location" | "entities";
export type SpikeLayout = "wide" | "narrow";

/**
 * Everything both the terminal UI and a possible browser fallback need to draw a
 * frame. It is a plain, frozen snapshot: no components, no timers, no library types.
 */
export interface SpikeViewModel {
  readonly timelineId: string;
  readonly roundId: string;
  readonly tick: number;
  readonly phase: SpikePhase;
  readonly location: string;
  readonly entities: readonly SpikeEntity[];
  readonly log: readonly string[];
  readonly stream: string;
  readonly input: string;
  /** Pastes whose token is still in the input line; deleting the token drops the paste. */
  readonly pastes: readonly SpikePaste[];
  readonly activeTab: SpikeTab;
  readonly monitor: readonly SpikeMonitorRow[];
  readonly layout: SpikeLayout;
  readonly width: number;
}

/** Width at which the side-by-side panes give way to tabs. */
export const WIDE_LAYOUT_MIN_WIDTH = 120;

const MAX_LOG_LINES = 500;

/** Characters of the first pasted line kept for the chip card. */
const PREVIEW_CHARS = 32;

/** A staged paste and the text its token expands to. */
interface StagedPaste {
  readonly paste: SpikePaste;
  readonly text: string;
}

/** Mutable source of truth; the UI only ever reads frozen snapshots of it. */
export class SpikeModel {
  private timelineId = "timeline-1";
  private roundId = "-";
  private tick = 0;
  private phase: SpikePhase = "idle";
  private location = "(unknown)";
  private entities: SpikeEntity[] = [];
  private log: string[] = [];
  private stream = "";
  private activeTab: SpikeTab = "location";
  private monitor: SpikeMonitorRow[] = [];
  private pastes: StagedPaste[] = [];
  private pasteCount = 0;

  startRound(timelineId: string, roundId: string, tick: number): void {
    this.timelineId = timelineId;
    this.roundId = roundId;
    this.tick = tick;
    this.phase = "idle";
    this.stream = "";
  }

  setPhase(phase: SpikePhase): void {
    this.phase = phase;
  }

  setLocation(location: string, entities: readonly SpikeEntity[]): void {
    this.location = location;
    this.entities = [...entities];
  }

  appendLog(line: string): void {
    this.log.push(line);
    if (this.log.length > MAX_LOG_LINES) this.log.splice(0, this.log.length - MAX_LOG_LINES);
  }

  beginStream(): void {
    this.stream = "";
    this.phase = "streaming";
  }

  appendStreamToken(token: string): void {
    this.stream += token;
  }

  finishStream(phase: SpikePhase = "idle"): void {
    if (this.stream.length > 0) this.appendLog(this.stream);
    this.stream = "";
    this.phase = phase;
  }

  setActiveTab(activeTab: SpikeTab): void {
    this.activeTab = activeTab;
  }

  setMonitor(rows: readonly SpikeMonitorRow[]): void {
    this.monitor = [...rows];
  }

  /**
   * Keeps `text` out of the single-line buffer behind a numbered token. The counter only
   * ever grows, so a token deleted from one line can never rebind to a later paste.
   */
  stagePaste(text: string): SpikePaste {
    this.pasteCount += 1;
    const lines = text.split("\n");
    const paste: SpikePaste = Object.freeze({
      n: this.pasteCount,
      label: `[粘贴 #${this.pasteCount}]`,
      lines: lines.length,
      chars: text.length,
      preview: pastePreview(lines[0] ?? ""),
    });
    this.pastes.push({ paste, text });
    return paste;
  }

  /** Substitutes every staged token still present in `input` with its pasted text. */
  expandPastes(input: string): string {
    let expanded = input;
    for (const entry of this.pastes) expanded = expanded.replaceAll(entry.paste.label, entry.text);
    return expanded;
  }

  clearPastes(): void {
    this.pastes = [];
  }

  snapshot(width: number, input: string): SpikeViewModel {
    return Object.freeze({
      timelineId: this.timelineId,
      roundId: this.roundId,
      tick: this.tick,
      phase: this.phase,
      location: this.location,
      entities: Object.freeze(this.entities.map((entity) => Object.freeze({ ...entity }))),
      log: Object.freeze([...this.log]),
      stream: this.stream,
      input,
      pastes: Object.freeze(
        this.pastes.filter((entry) => input.includes(entry.paste.label)).map((entry) => entry.paste),
      ),
      activeTab: this.activeTab,
      monitor: Object.freeze(this.monitor.map((row) => Object.freeze({ ...row }))),
      layout: width >= WIDE_LAYOUT_MIN_WIDTH ? "wide" : "narrow",
      width,
    });
  }
}

function pastePreview(firstLine: string): string {
  const trimmed = firstLine.trim();
  return trimmed.length > PREVIEW_CHARS ? `${trimmed.slice(0, PREVIEW_CHARS)}…` : trimmed;
}
