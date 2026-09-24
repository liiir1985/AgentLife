import type { RuntimeConfig } from "../config/config-builder.js";
import type { SessionTrace } from "../diagnostics/session-trace.js";
import { cognitionSettings, memorySettings, workingMemoryCapacity } from "../simulation/config-view.js";
import { stateVersionOf, type ActionPlan, type CognitionRound, type SimulationState } from "../simulation/types.js";
import { SimulationRunner, type TickResult } from "../simulation/runner.js";
import { checkSnapshot, decodeSnapshot, encodeSnapshot, snapshotOf } from "../simulation/save.js";
import { RuntimeStore, type SaveResult } from "../storage/runtime-store.js";
import type { VersionedPayload } from "../storage/runtime-store-probe.js";
import {
  availableActions,
  entityChoices,
  perceivedObservations,
  perceivedView,
  planFromCommand,
  type ActionCommandArgument,
  type ActionCommandDefinition,
  type ActionParameterValues,
  type AvailableAction,
  type EntityChoice,
  type PerceivedObservation,
  type PerceivedPlayerView,
} from "./context-actions.js";

export type ControllerMode = "ready" | "running" | "paused" | "barrier" | "idle" | "failed" | "cognition";

export interface SimulationControlStatus {
  readonly mode: ControllerMode;
  readonly tick: number;
  readonly simSeconds: number;
  readonly pendingPlans: number;
  readonly runLimitRemaining: number | null;
  /** Whether the player asked the clock to keep running; a settling round never changes it. */
  readonly running: boolean;
  /** What the open cognition barrier is waiting for, in readable terms. */
  readonly round: string | null;
  /** A save that will run once the tick in progress is published. */
  readonly pendingSave: string | null;
  readonly detail: string;
}

/** One entity's perception, for the management view only. */
export interface PerceptionPanelRow {
  readonly characterId: string;
  readonly subjects: number;
  readonly pending: number;
  readonly materialVersion: string;
  readonly attentionVersion: string;
}

/** One entity's cognition, for the management view only. */
export interface CognitionPanelRow {
  readonly characterId: string;
  readonly attention: readonly string[];
  readonly understanding: string;
  readonly questions: readonly string[];
  readonly persistence: string;
  readonly intentions: readonly string[];
  readonly idle: string | null;
  readonly decisions: number;
  readonly pendingRequestId: string | null;
  readonly attempts: number;
}

/** How much one entity holds, never what the private text says. */
export interface MemoryPanelRow {
  readonly characterId: string;
  readonly entries: number;
  readonly capacity: number;
  readonly consumed: number;
  readonly recent: number;
  readonly longTerm: number;
  readonly profiles: number;
}

export interface ManagementSnapshot {
  readonly state: SimulationState;
  readonly status: SimulationControlStatus;
  readonly pendingPlans: readonly ActionPlan[];
  readonly perception: readonly PerceptionPanelRow[];
  readonly cognition: readonly CognitionPanelRow[];
  readonly workingMemory: readonly MemoryPanelRow[];
  /** Model requests, validation refusals and round outcomes. */
  readonly diagnostics: readonly string[];
}

export interface TimerPort {
  schedule(callback: () => void, delayMs: number): unknown;
  cancel(handle: unknown): void;
}

const SYSTEM_TIMER: TimerPort = {
  schedule: (callback, delayMs) => setTimeout(callback, delayMs),
  cancel: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export interface ControllerOptions {
  readonly playerId: string;
  readonly intervalMs?: number;
  readonly timer?: TimerPort;
  readonly trace?: SessionTrace;
}

export class ActionParameterSession {
  private index = 0;
  private target: string | undefined;
  private destination: string | undefined;
  private readonly inputs: Record<string, string> = {};

  constructor(
    readonly command: ActionCommandDefinition,
    private readonly config: RuntimeConfig,
    private readonly state: () => SimulationState,
    private readonly playerId: string,
  ) {}

  current(): ActionCommandArgument | undefined {
    return this.command.arguments[this.index];
  }

  choices(): readonly EntityChoice[] {
    const current = this.current();
    return current?.kind === "entity" ? entityChoices(this.config, this.state(), this.playerId, current) : [];
  }

  /** The player chose by reference; the session keeps the anchor the plan needs. */
  acceptEntity(reference: string): { readonly done: boolean; readonly error?: string } {
    const current = this.current();
    if (current?.kind !== "entity") return { done: false, error: "当前参数不是实体选择" };
    const choice = this.choices().find((candidate) => candidate.reference === reference);
    if (choice === undefined) return { done: false, error: "该对象已不在候选中" };
    if (current.binding === "target") this.target = choice.anchor;
    else this.destination = choice.anchor;
    this.index += 1;
    return { done: this.current() === undefined };
  }

  acceptText(text: string): { readonly done: boolean; readonly error?: string } {
    const current = this.current();
    if (current?.kind !== "text") return { done: false, error: "当前参数不是文本输入" };
    if (text.length < current.minLength)
      return { done: false, error: `${current.name}至少需要 ${current.minLength} 个字符` };
    if (text.length > current.maxLength)
      return { done: false, error: `${current.name}不能超过 ${current.maxLength} 个字符` };
    this.inputs[current.field] = text;
    this.index += 1;
    return { done: this.current() === undefined };
  }

  back(): boolean {
    if (this.index === 0) return false;
    this.index -= 1;
    const current = this.current();
    if (current?.kind === "entity") {
      if (current.binding === "target") this.target = undefined;
      else this.destination = undefined;
    } else if (current?.kind === "text") delete this.inputs[current.field];
    return true;
  }

  values(): ActionParameterValues {
    return {
      ...(this.target === undefined ? {} : { target: this.target }),
      ...(this.destination === undefined ? {} : { destination: this.destination }),
      ...(Object.keys(this.inputs).length === 0 ? {} : { inputs: Object.freeze({ ...this.inputs }) }),
    };
  }
}

export class SimulationController {
  private readonly timer: TimerPort;
  private readonly intervalMs: number;
  private mode: ControllerMode = "ready";
  private timerHandle: unknown;
  private runRemaining: number | null = null;
  private continuous = false;
  private pendingSaveId: string | null = null;
  private readonly pending: ActionPlan[] = [];
  private sequence = 0;
  private loadSequence = 0;
  private readonly listeners = new Set<() => void>();
  private detail = "等待操作";

  constructor(
    readonly runner: SimulationRunner,
    readonly config: RuntimeConfig,
    readonly store: RuntimeStore,
    readonly options: ControllerOptions,
  ) {
    this.timer = options.timer ?? SYSTEM_TIMER;
    this.intervalMs = options.intervalMs ?? 1_000;
    const pack = config.packs[0];
    this.store.saveConfig({
      configId: config.configId,
      namespace: pack?.namespace ?? "agentlife.runtime",
      packVersion: pack?.version ?? "0.0.0",
      document: config.sourceData,
    });
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private changed(): void {
    for (const listener of this.listeners) listener();
  }

  view(): PerceivedPlayerView {
    return perceivedView(this.config, this.runner.state(), this.options.playerId);
  }

  availableActions(): readonly AvailableAction[] {
    return availableActions(this.config, this.runner.state(), this.options.playerId);
  }

  /** What the player really perceived; never a management or diagnostic text. */
  perceptionLog(): readonly PerceivedObservation[] {
    return perceivedObservations(this.runner.state(), this.options.playerId);
  }

  beginAction(commandRef: string): ActionParameterSession | undefined {
    // The wizard takes the clock from the player's run, wherever that run stands: a
    // round still settling holds the tick, so the request is what has to stand down.
    if (this.continuous) this.pause();
    const action = this.availableActions().find((entry) => entry.command.ref === commandRef);
    if (action === undefined) return undefined;
    return new ActionParameterSession(action.command, this.config, () => this.runner.state(), this.options.playerId);
  }

  /**
   * Queues one fulfilled command.
   *
   * While a cognition barrier is open the plan joins that round, so everything the
   * tick's participants decided is handed to the body as one batch; at a stable
   * boundary it is fixed at the start of the next tick instead.
   */
  queueAction(session: ActionParameterSession): { readonly ok: boolean; readonly message: string } {
    const available = this.availableActions().some((entry) => entry.command.ref === session.command.ref);
    if (!available) return { ok: false, message: "上下文已经变化，该动作不再可用" };
    const current = session.current();
    if (current !== undefined) return { ok: false, message: `仍需填写参数：${current.name}` };
    this.sequence += 1;
    const state = this.runner.state();
    const plan = planFromCommand(
      session.command,
      session.values(),
      this.options.playerId,
      `${this.options.playerId}/tick-${state.tick + 1}/command-${this.sequence}`,
      stateVersionOf(state),
    );
    if (this.runner.openRound() !== null) {
      const joined = this.runner.submitPlayerPlan(plan);
      this.detail = joined.message;
      this.changed();
      if (joined.ok) this.afterJoin();
      return { ok: joined.ok, message: joined.message };
    }
    this.pending.push(plan);
    this.detail = `${session.command.name}已排入下一 Tick`;
    this.changed();
    return { ok: true, message: this.detail };
  }

  /** The player declines to decide in the open round; its existing actions keep running. */
  skipPlayer(): { readonly ok: boolean; readonly message: string } {
    const result = this.runner.skipPlayer(this.options.playerId);
    this.detail = result.message;
    this.changed();
    if (result.ok) this.afterJoin();
    return result;
  }

  /** Only lines already admitted to the player's Working Memory are offered. */
  playerMemoryChoices(): readonly { readonly reference: string; readonly text: string }[] {
    const record = this.runner.state().memory.records[this.options.playerId];
    return Object.freeze(
      (record?.entries ?? [])
        .filter((entry) => entry.kind === "observation" && entry.reference !== null)
        .map((entry) => ({ reference: entry.reference!, text: entry.text })),
    );
  }

  async rememberPlayerObservation(
    reference: string,
    text: string,
  ): Promise<{ readonly ok: boolean; readonly message: string }> {
    const result = await this.runner.rememberPlayerObservation(this.options.playerId, reference, text);
    this.detail = result.message;
    this.changed();
    return result;
  }

  step(): TickResult {
    this.clearTimer();
    const open = this.runner.openRound();
    if (open !== null) {
      this.detail = `等待决定：${this.roundDetail(open)}`;
      this.changed();
      return { status: "cognitive-barrier", round: open };
    }
    const plans = this.pending.splice(0);
    const result = this.runner.runTick({ plans });
    this.afterTick(result);
    return result;
  }

  /**
   * Starts or continues a run. A round that is still settling owns the clock, so the
   * request is remembered and applied by the tick that closes it: the player never
   * has to wait for a decision in order to ask for one.
   */
  run(limit?: number): void {
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) throw new Error("运行 Tick 数必须是正整数");
    this.clearTimer();
    this.continuous = true;
    this.runRemaining = limit ?? null;
    this.detail = limit === undefined ? "连续运行中" : `连续运行，剩余 ${limit} Tick`;
    if (this.runner.openRound() === null) {
      this.mode = "running";
      this.changed();
      this.scheduleNext(0);
      return;
    }
    this.changed();
  }

  /**
   * Stops a run. A round that is still settling accepts this too: the intention is
   * recorded, and the tick that closes the round publishes without starting another.
   */
  pause(): void {
    this.clearTimer();
    this.continuous = false;
    this.runRemaining = null;
    this.detail = "已暂停";
    if (this.runner.openRound() === null) this.mode = "paused";
    this.changed();
  }

  toggleRunning(): void {
    if (this.continuous) this.pause();
    else this.run();
  }

  private scheduleNext(delayMs: number): void {
    this.timerHandle = this.timer.schedule(() => {
      this.timerHandle = undefined;
      if (this.mode !== "running") return;
      const plans = this.pending.splice(0);
      const result = this.runner.runTick({ plans });
      if (this.runRemaining !== null) this.runRemaining -= 1;
      this.afterTick(result);
    }, delayMs);
  }

  /**
   * Applies one tick result: a cognition barrier freezes the simulation until its
   * participants settled, and only a published tick runs the pending save and lets
   * a continuous run continue.
   */
  private afterTick(result: TickResult): void {
    if (result.status === "cognitive-barrier") {
      this.mode = "cognition";
      this.detail = `等待决定：${this.roundDetail(result.round)}`;
      this.changed();
      void this.resolveBarrier();
      return;
    }
    this.mode = result.status === "failed" ? "failed" : result.status === "rule-barrier" ? "barrier" : "ready";
    if (this.mode === "failed" || this.mode === "barrier") this.continuous = false;
    let detail = `Tick ${result.summary.tick} ${result.status}`;
    const saved = this.runPendingSave();
    if (saved !== null) detail = `${detail}；${saved}`;
    if (this.continuous && this.runRemaining === 0) {
      this.continuous = false;
      this.runRemaining = null;
      detail = `${detail}；已达到运行 Tick 数`;
    } else if (this.continuous) {
      this.mode = "running";
      detail = this.runRemaining === null ? "连续运行中" : `连续运行，剩余 ${this.runRemaining} Tick`;
    }
    this.detail = detail;
    this.changed();
    if (this.continuous) this.scheduleNext(this.intervalMs);
  }

  /** Runs the AI participants of the barrier, then publishes the tick if it can. */
  private async resolveBarrier(): Promise<void> {
    const round = this.runner.openRound();
    if (round === null) return;
    await this.runner.resolveCognition();
    const finished = await this.runner.completeCognitionWithMemory();
    if (finished === null) {
      const still = this.runner.openRound();
      if (still !== null) this.detail = `等待决定：${this.roundDetail(still)}`;
      this.changed();
      return;
    }
    this.afterTick(finished);
  }

  /** A player decision may have been the last one the round was waiting for. */
  private async afterJoin(): Promise<void> {
    const finished = await this.runner.completeCognitionWithMemory();
    if (finished !== null) this.afterTick(finished);
  }

  private roundDetail(round: CognitionRound): string {
    const waiting = round.participants
      .filter((participant) => participant.state === "waiting" || participant.state === "requested")
      .map((participant) => `${participant.characterId}(${participant.control})`);
    return waiting.length === 0 ? "全部已决定" : waiting.join(", ");
  }

  private clearTimer(): void {
    if (this.timerHandle !== undefined) this.timer.cancel(this.timerHandle);
    this.timerHandle = undefined;
  }

  status(): SimulationControlStatus {
    const state = this.runner.state();
    const round = this.runner.openRound();
    return Object.freeze({
      mode: this.mode,
      tick: state.tick,
      simSeconds: state.simTime.seconds,
      pendingPlans: this.pending.length,
      runLimitRemaining: this.runRemaining,
      running: this.continuous,
      round:
        round === null
          ? null
          : round.participants.map((participant) => `${participant.characterId}=${participant.state}`).join(", "),
      pendingSave: this.pendingSaveId,
      detail: this.detail,
    });
  }

  managementSnapshot(): ManagementSnapshot {
    const state = this.runner.state();
    const settings = cognitionSettings(this.config);
    return Object.freeze({
      state,
      status: this.status(),
      pendingPlans: Object.freeze([...this.pending]),
      perception: Object.freeze(
        Object.entries(state.perception.observers)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([characterId, observer]) => ({
            characterId,
            subjects: Object.keys(observer.subjects).length,
            pending: observer.pending.length,
            materialVersion: observer.materialVersion,
            attentionVersion: observer.attentionVersion,
          })),
      ),
      cognition: Object.freeze(
        Object.entries(state.cognition.records)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([characterId, record]) => ({
            characterId,
            attention: record.attention,
            understanding: record.understanding,
            questions: record.questions,
            persistence: record.persistence,
            intentions: record.intentions.map(
              (intention) =>
                `${intention.intentionId} ${intention.status}(${intention.useCount}): ${intention.content}`,
            ),
            idle:
              record.idle === null ? null : `${record.idle.kind} until ${record.idle.untilTick}: ${record.idle.detail}`,
            decisions: record.decisions,
            pendingRequestId: record.pendingRequestId,
            attempts: record.attempts,
          })),
      ),
      workingMemory: Object.freeze(
        Object.entries(state.memory.records)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([characterId, record]) => ({
            characterId,
            entries: record.entries.length,
            // The bound is the entity's own: a body whose tier declares fewer
            // entries must show that bound, not the full-effort one. An entity
            // without a body record was admitted at the full-effort capacity,
            // and the row reports what admission actually used.
            capacity: workingMemoryCapacity(settings, state.body.bodies[characterId]?.participation ?? "allowed"),
            consumed: record.consumed.length,
            recent: record.recent.length,
            longTerm: record.longTerm.length,
            profiles: record.profiles.length,
          })),
      ),
      diagnostics: Object.freeze([
        ...(memorySettings(this.config) === undefined
          ? []
          : [
              `embedding ${this.runner.embeddingService().provider}/${this.runner.embeddingService().model} · ${state.embeddingVersion}`,
            ]),
        ...this.runner.roundNotes(),
        ...(state.round === null ? [] : [`round ${state.round.roundId} ${state.round.status}`]),
      ]),
    });
  }

  /**
   * Saves at a stable boundary.
   *
   * A request that arrives while the tick is held for cognition is not lost and not
   * half-applied either: it becomes the pending save, which runs once the tick is
   * published and before the next tick starts. A second request is refused rather
   * than queued behind the first.
   */
  save(saveId: string): { readonly ok: boolean; readonly message: string } {
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(saveId))
      return { ok: false, message: "存档名只能包含字母、数字、点、下划线和短横线" };
    const state = this.runner.state();
    if (state.phase !== "publish" || this.runner.openRound() !== null) {
      if (this.pendingSaveId !== null)
        return { ok: false, message: `已有待处理保存 ${this.pendingSaveId}，本次请求被拒绝` };
      this.pendingSaveId = saveId;
      this.detail = `保存 ${saveId} 待 Tick 发布后执行`;
      this.changed();
      return { ok: true, message: this.detail };
    }
    if (this.pending.length > 0) return { ok: false, message: "仍有未接纳动作，请先推进 Tick" };
    if (this.mode === "running") return { ok: false, message: "请先暂停再保存" };
    const outcome: SaveResult = this.commitSave(saveId);
    this.options.trace?.record("simulation-save", { saveId, tick: state.tick, outcome });
    this.changed();
    return { ok: true, message: outcome === "duplicate" ? `已覆盖存档 ${saveId}` : `已保存 ${saveId}` };
  }

  private commitSave(saveId: string): SaveResult {
    const state = this.runner.state();
    const snapshot = snapshotOf(state, saveId, this.config);
    return this.store.saveSimulation({
      saveId,
      timelineId: snapshot.timelineId,
      tick: snapshot.tick,
      configId: snapshot.configId,
      payload: encodeSnapshot(snapshot),
    });
  }

  /** The pending save runs after a published tick and before the next one starts. */
  private runPendingSave(): string | null {
    const saveId = this.pendingSaveId;
    if (saveId === null) return null;
    if (this.runner.state().phase !== "publish") return null;
    this.pendingSaveId = null;
    const outcome = this.commitSave(saveId);
    this.options.trace?.record("simulation-save", { saveId, tick: this.runner.state().tick, outcome });
    return `已保存 ${saveId}${outcome === "duplicate" ? "（覆盖）" : ""}（屏障后执行）`;
  }

  load(saveId: string): { readonly ok: boolean; readonly message: string } {
    let document: VersionedPayload | undefined;
    try {
      document = this.store.loadSimulation(saveId);
    } catch (failure) {
      // A payload stored by another schema version is an incompatibility to report,
      // not a crash: phase 4 refuses a phase 3 save instead of migrating it.
      return { ok: false, message: failure instanceof Error ? failure.message : String(failure) };
    }
    if (document === undefined) return { ok: false, message: `找不到存档 ${saveId}` };
    const decoded = decodeSnapshot(document);
    if (!decoded.ok) return { ok: false, message: decoded.reason };
    const check = checkSnapshot(decoded.snapshot, this.config, this.runner.embeddingService().representationVersion);
    if (!check.ok) return { ok: false, message: check.reason };
    this.clearTimer();
    this.pending.splice(0);
    this.pendingSaveId = null;
    this.runRemaining = null;
    this.loadSequence += 1;
    const previousTimelineId = this.runner.state().timelineId;
    this.runner.load({
      ...decoded.snapshot.state,
      timelineId: `${decoded.snapshot.timelineId}/load-${this.loadSequence}`,
    });
    this.options.trace?.timelineChanged(previousTimelineId, this.runner.state().timelineId, saveId);
    this.mode = "ready";
    this.detail = `已加载 ${saveId}`;
    this.changed();
    return { ok: true, message: this.detail };
  }

  /** The commands the player may run right now, in readable terms. */
  commandSummary(): string {
    return this.availableActions()
      .map((entry) => `${entry.command.name}(${entry.command.ref})`)
      .join(", ");
  }

  close(): void {
    this.clearTimer();
    this.store.close();
  }
}
