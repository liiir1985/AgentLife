import { appendFileSync, mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

export interface TraceIdentity {
  readonly entityId?: string;
  readonly roundId?: string;
  readonly requestId?: string;
}

export interface SessionLogEntry extends TraceIdentity {
  readonly schemaVersion: 1;
  readonly sessionId: string;
  readonly sequence: number;
  readonly at: string;
  readonly turn: number | null;
  readonly timelineId: string | null;
  readonly targetTick: number | null;
  readonly kind: string;
  readonly data: unknown;
}

/** Diagnostics are observational: a broken log must never alter a simulated decision. */
export interface SessionTrace {
  startTurn(timelineId: string, targetTick: number): void;
  record(kind: string, data: unknown, identity?: TraceIdentity): void;
  finishTurn(status: string, data: unknown): void;
  timelineChanged(previous: string, next: string, saveId: string): void;
}

/** One append-only file for one TUI process, with an independent attempt number. */
export class SessionLog implements SessionTrace {
  readonly sessionId = randomUUID();
  readonly path: string;
  private sequence = 0;
  private turn = 0;
  private active: { readonly turn: number; readonly timelineId: string; readonly tick: number } | null = null;
  private problem: string | null = null;

  constructor(directory: string) {
    this.path = join(directory, `${new Date().toISOString().replace(/[:.]/g, "-")}-${this.sessionId}.jsonl`);
    try {
      mkdirSync(directory, { recursive: true });
      this.record("session-start", { path: this.path });
    } catch (error) {
      this.problem = error instanceof Error ? error.message : String(error);
    }
  }

  get error(): string | null {
    return this.problem;
  }

  startTurn(timelineId: string, targetTick: number): void {
    this.turn += 1;
    this.active = { turn: this.turn, timelineId, tick: targetTick };
    this.record("turn-start", { targetTick });
  }

  record(kind: string, data: unknown, identity: TraceIdentity = {}): void {
    if (this.problem !== null) return;
    const entry: SessionLogEntry = {
      schemaVersion: 1,
      sessionId: this.sessionId,
      sequence: ++this.sequence,
      at: new Date().toISOString(),
      turn: this.active?.turn ?? null,
      timelineId: this.active?.timelineId ?? null,
      targetTick: this.active?.tick ?? null,
      kind,
      ...identity,
      data,
    };
    try {
      appendFileSync(this.path, `${JSON.stringify(entry)}\n`, "utf8");
    } catch (error) {
      this.problem = error instanceof Error ? error.message : String(error);
    }
  }

  finishTurn(status: string, data: unknown): void {
    this.record("turn-end", { status, result: data });
    this.active = null;
  }

  timelineChanged(previous: string, next: string, saveId: string): void {
    this.record("timeline-load", { previous, next, saveId });
  }

  close(): void {
    this.record("session-end", {});
  }
}
