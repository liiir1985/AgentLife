export interface DemoScriptOptions {
  readonly narrative: string;
  readonly roundCount: number;
  readonly tokenIntervalMs: number;
  readonly roundGapMs: number;
  readonly onRoundStart: (round: number) => void;
  readonly onToken: (token: string) => void;
  readonly onStreamEnd: (round: number, cancelled: boolean) => void;
  readonly onFinish: () => void;
}

/**
 * Drives the manual acceptance demo: one round at a time, one timer at a time.
 *
 * The stream must finish (or be cancelled) before the next round is scheduled — an
 * uncontrolled interval per round would leave several streams running at once and
 * flood the screen, which is exactly what makes the input bar unusable.
 */
export class DemoScript {
  private streamTimer: ReturnType<typeof setInterval> | undefined;
  private roundTimer: ReturnType<typeof setTimeout> | undefined;
  private round = 1;
  private running = false;

  constructor(private readonly options: DemoScriptOptions) {}

  get isRunning(): boolean {
    return this.running;
  }

  get currentRound(): number {
    return this.round;
  }

  /** Starts from round 1; calling it again replays the demo without leaving old timers. */
  start(): void {
    this.stop();
    this.round = 1;
    this.running = true;
    this.beginRound();
  }

  /** Esc: stop the current stream, stop the demo and report the cancellation. */
  cancel(): void {
    if (!this.running) return;
    const round = this.round;
    this.running = false;
    this.clearStream();
    this.clearRound();
    this.options.onStreamEnd(round, true);
  }

  /** Shutdown: drop every pending timer without reporting. */
  stop(): void {
    this.running = false;
    this.clearStream();
    this.clearRound();
  }

  private beginRound(): void {
    if (!this.running) return;
    const round = this.round;
    if (round > this.options.roundCount) {
      this.running = false;
      this.options.onFinish();
      return;
    }

    this.clearStream();
    this.options.onRoundStart(round);
    const narrative = this.options.narrative;
    let index = 0;
    this.streamTimer = setInterval(() => {
      if (index >= narrative.length) {
        this.clearStream();
        this.options.onStreamEnd(round, false);
        this.round = round + 1;
        this.roundTimer = setTimeout(() => this.beginRound(), this.options.roundGapMs);
        return;
      }
      this.options.onToken(narrative[index] as string);
      index += 1;
    }, this.options.tokenIntervalMs);
  }

  private clearStream(): void {
    clearInterval(this.streamTimer);
    this.streamTimer = undefined;
  }

  private clearRound(): void {
    clearTimeout(this.roundTimer);
    this.roundTimer = undefined;
  }
}
