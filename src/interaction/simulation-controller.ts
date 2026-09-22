import type { RuntimeConfig } from "../config/config-builder.js";
import { stateVersionOf, type ActionPlan, type SimulationState } from "../simulation/types.js";
import { SimulationRunner, type TickResult } from "../simulation/runner.js";
import { checkSnapshot, decodeSnapshot, encodeSnapshot, snapshotOf } from "../simulation/save.js";
import { RuntimeStore, type SaveResult } from "../storage/runtime-store.js";
import {
  availableActions,
  entityChoices,
  observedEvents,
  planFromCommand,
  playerView,
  type ActionCommandArgument,
  type ActionCommandDefinition,
  type ActionParameterValues,
  type AvailableAction,
  type EntityChoice,
  type PlayerView,
  type ObservedEvent,
} from "./context-actions.js";

export type ControllerMode = "ready" | "running" | "paused" | "barrier" | "idle" | "failed";

export interface SimulationControlStatus {
  readonly mode: ControllerMode;
  readonly tick: number;
  readonly simSeconds: number;
  readonly pendingPlans: number;
  readonly runLimitRemaining: number | null;
  readonly detail: string;
}

export interface ManagementSnapshot {
  readonly state: SimulationState;
  readonly status: SimulationControlStatus;
  readonly pendingPlans: readonly ActionPlan[];
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

  acceptEntity(entityId: string): { readonly done: boolean; readonly error?: string } {
    const current = this.current();
    if (current?.kind !== "entity") return { done: false, error: "当前参数不是实体选择" };
    if (!this.choices().some((choice) => choice.entityId === entityId))
      return { done: false, error: "该对象已不在候选中" };
    if (current.binding === "target") this.target = entityId;
    else this.destination = entityId;
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

  view(): PlayerView {
    return playerView(this.config, this.runner.state(), this.options.playerId);
  }

  availableActions(): readonly AvailableAction[] {
    return availableActions(this.config, this.runner.state(), this.options.playerId);
  }

  observedEvents(): readonly ObservedEvent[] {
    return observedEvents(this.config, this.runner.state(), this.options.playerId);
  }

  beginAction(commandRef: string): ActionParameterSession | undefined {
    if (this.mode === "running") this.pause();
    const action = this.availableActions().find((entry) => entry.command.ref === commandRef);
    if (action === undefined) return undefined;
    return new ActionParameterSession(action.command, this.config, () => this.runner.state(), this.options.playerId);
  }

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
      `player-command-${state.tick}-${this.sequence}`,
      stateVersionOf(state),
    );
    this.pending.push(plan);
    this.detail = `${session.command.name}已排入下一 Tick`;
    this.changed();
    return { ok: true, message: this.detail };
  }

  step(): TickResult {
    this.clearTimer();
    const plans = this.pending.splice(0);
    const result = this.runner.runTick({ plans });
    this.mode = result.status === "failed" ? "failed" : result.status === "barrier" ? "barrier" : "ready";
    this.detail = `Tick ${result.summary.tick} ${result.status}`;
    this.changed();
    return result;
  }

  run(limit?: number): void {
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) throw new Error("运行 Tick 数必须是正整数");
    this.clearTimer();
    this.mode = "running";
    this.runRemaining = limit ?? null;
    this.detail = limit === undefined ? "连续运行中" : `连续运行，剩余 ${limit} Tick`;
    this.changed();
    this.scheduleNext(0);
  }

  pause(): void {
    this.clearTimer();
    this.mode = "paused";
    this.runRemaining = null;
    this.detail = "已暂停";
    this.changed();
  }

  toggleRunning(): void {
    if (this.mode === "running") this.pause();
    else this.run();
  }

  private scheduleNext(delayMs: number): void {
    this.timerHandle = this.timer.schedule(() => {
      this.timerHandle = undefined;
      if (this.mode !== "running") return;
      const plans = this.pending.splice(0);
      const result = this.runner.runTick({ plans });
      if (this.runRemaining !== null) this.runRemaining -= 1;
      if (result.status !== "completed") {
        this.mode = result.status === "barrier" ? "barrier" : "failed";
        this.detail = `自动运行因 ${result.status} 停止`;
      } else if (this.runRemaining === 0) {
        this.mode = "ready";
        this.runRemaining = null;
        this.detail = "已达到运行 Tick 数";
      } else {
        this.detail = this.runRemaining === null ? "连续运行中" : `连续运行，剩余 ${this.runRemaining} Tick`;
      }
      this.changed();
      if (this.mode === "running") this.scheduleNext(this.intervalMs);
    }, delayMs);
  }

  private clearTimer(): void {
    if (this.timerHandle !== undefined) this.timer.cancel(this.timerHandle);
    this.timerHandle = undefined;
  }

  status(): SimulationControlStatus {
    const state = this.runner.state();
    return Object.freeze({
      mode: this.mode,
      tick: state.tick,
      simSeconds: state.simTime.seconds,
      pendingPlans: this.pending.length,
      runLimitRemaining: this.runRemaining,
      detail: this.detail,
    });
  }

  managementSnapshot(): ManagementSnapshot {
    return Object.freeze({
      state: this.runner.state(),
      status: this.status(),
      pendingPlans: Object.freeze([...this.pending]),
    });
  }

  save(saveId: string): SaveResult {
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(saveId)) throw new Error("存档名只能包含字母、数字、点、下划线和短横线");
    if (this.pending.length > 0) throw new Error("仍有未接纳动作，请先推进 Tick");
    if (this.mode === "running") throw new Error("请先暂停再保存");
    const state = this.runner.state();
    if (state.phase !== "publish") throw new Error("只能在稳定 Tick 边界保存");
    const snapshot = snapshotOf(state, saveId, this.config);
    const result = this.store.saveSimulation({
      saveId,
      timelineId: snapshot.timelineId,
      tick: snapshot.tick,
      configId: snapshot.configId,
      payload: encodeSnapshot(snapshot),
    });
    this.detail = `已保存 ${saveId}`;
    this.changed();
    return result;
  }

  load(saveId: string): { readonly ok: boolean; readonly message: string } {
    const document = this.store.loadSimulation(saveId);
    if (document === undefined) return { ok: false, message: `找不到存档 ${saveId}` };
    const decoded = decodeSnapshot(document);
    if (!decoded.ok) return { ok: false, message: decoded.reason };
    const check = checkSnapshot(decoded.snapshot, this.config);
    if (!check.ok) return { ok: false, message: check.reason };
    this.clearTimer();
    this.pending.splice(0);
    this.loadSequence += 1;
    this.runner.load({
      ...decoded.snapshot.state,
      timelineId: `${decoded.snapshot.timelineId}/load-${this.loadSequence}`,
    });
    this.mode = "ready";
    this.detail = `已加载 ${saveId}`;
    this.changed();
    return { ok: true, message: this.detail };
  }

  close(): void {
    this.clearTimer();
    this.store.close();
  }
}
