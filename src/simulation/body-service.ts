import type { ProcessChangeRequest, StateChangeRequest } from "../config/rule-engine.js";
import type { SimpleValue } from "../config/value-expr.js";
import {
  BODY_ACTIVITY,
  BODY_CHANNELS,
  BODY_MODE,
  BODY_PARTICIPATION,
  BODY_VALUES,
  actionSpec,
  bodyConfigSpec,
  checkValue,
  influenceRelation,
  initialValues,
  itemsOf,
  localIdOf,
  modeAbilities,
  processSpec,
  resourceSpec,
  type ActionSpec,
} from "./config-view.js";
import type { BodyPerceptionMaterial, OutcomeMaterial } from "./perception-service.js";
import {
  IDLE_ACTIVITY,
  NO_INFLUENCE,
  NO_PROCESS,
  entitySlice,
  sharedSlice,
  type ProjectionSources,
} from "./projection.js";
import type { ServiceRuntime, TickContext } from "./world-service.js";
import { WorldService, changesInOrder, processRequestsInOrder, runIdOf } from "./world-service.js";
import type {
  ActionInstance,
  ActionPlan,
  ActionStatus,
  BodyProcess,
  BodyRecord,
  BodyState,
  CharacterState,
  InfluenceOutcome,
  RejectedChange,
  WorldInfluenceRequest,
  WorldState,
} from "./types.js";

/**
 * The body service: the authority over bodies and action execution.
 *
 * It owns body values and channels, the physical mode, established body
 * processes, and the actions a body is running. An action reserves the resources
 * its declared stages name for its whole life; two actions of one body may run in
 * parallel only when they share no exclusive resource. Every stage reaching its
 * world impact point hands a structured influence request to the world and waits;
 * the body never changes the world itself and the world never advances an action.
 */

export interface BodyRuntime {
  readonly body: BodyState;
  readonly actions: readonly ActionInstance[];
}

export interface PlanOutcome {
  readonly accepted: boolean;
  readonly actionId: string | null;
  readonly status: ActionStatus | "rejected";
  readonly reason: string;
}

export interface PlanAcceptance {
  readonly runtime: BodyRuntime;
  readonly outcome: PlanOutcome;
}

export interface BodyCommit {
  readonly runtime: BodyRuntime;
  readonly applied: readonly StateChangeRequest[];
  readonly rejected: readonly RejectedChange[];
  readonly notes: readonly string[];
}

export interface AdvanceResult extends BodyCommit {
  readonly pending: readonly ActionInstance[];
  readonly processChanges: readonly ProcessChangeRequest[];
}

export class BodyService {
  constructor(
    private readonly runtime: ServiceRuntime,
    private readonly world: WorldService,
  ) {}

  /** One body instance per character that declares a body configuration. */
  initialize(characters: CharacterState): BodyState {
    const bodies: Record<string, BodyRecord> = {};
    for (const entityId of Object.keys(characters.characters).sort()) {
      const character = characters.characters[entityId];
      if (character?.bodyConfig === null || character?.bodyConfig === undefined) continue;
      const spec = bodyConfigSpec(this.runtime.config, character.bodyConfig);
      bodies[entityId] = Object.freeze({
        entityId,
        configRef: character.bodyConfig,
        values: initialValues(this.runtime.config, BODY_VALUES),
        channels: initialValues(this.runtime.config, BODY_CHANNELS),
        // Until a rule says otherwise, a body may take part in cognition.
        participation: "allowed",
        mode: spec?.initialMode ?? "",
        processes: Object.freeze([]),
      });
    }
    return Object.freeze({ version: "body-1", bodies: Object.freeze(bodies) });
  }

  body(state: BodyState, entityId: string): BodyRecord | undefined {
    return state.bodies[entityId];
  }

  /**
   * The purpose-limited material one body offers its own observer.
   *
   * It reports which of the body's sensory channels are available and how
   * efficient each is right now, plus the action results its owner can feel this
   * tick: what just finished, failed or was interrupted. It never reports body
   * values, another entity's actions or anything the body cannot itself sense.
   */
  perceptionMaterial(
    runtime: BodyRuntime,
    previous: readonly ActionInstance[],
    entityId: string,
  ): BodyPerceptionMaterial {
    const record = runtime.body.bodies[entityId];
    const terminal = new Set<ActionStatus>(["completed", "failed", "interrupted", "cancelled"]);
    const was = new Map(
      previous.filter((action) => action.entityId === entityId).map((action) => [action.actionId, action.status]),
    );
    const outcomes: OutcomeMaterial[] = [];
    for (const action of runtime.actions)
      if (action.entityId === entityId && terminal.has(action.status) && was.get(action.actionId) !== action.status)
        outcomes.push(
          Object.freeze({
            actionId: action.actionId,
            action: action.action,
            status: action.status,
            reason: action.outcome?.reason ?? action.status,
          }),
        );
    return Object.freeze({
      channels: Object.freeze(
        itemsOf(this.runtime.config, "agentlife.body/channel").map((item) => {
          const key = localIdOf(item.ref);
          const available = record?.channels[`${key}.available`];
          const efficiency = record?.channels[`${key}.efficiency`];
          return Object.freeze({
            channel: item.ref,
            available: available === true,
            efficiency: typeof efficiency === "number" ? efficiency : 0,
          });
        }),
      ),
      outcomes: Object.freeze(outcomes.sort((left, right) => left.actionId.localeCompare(right.actionId))),
      participation: record?.participation ?? "forbidden",
    });
  }

  actionSpecOf(actionRef: string): ActionSpec | undefined {
    return actionSpec(this.runtime.config, actionRef);
  }

  /**
   * The world's answer for one action. An action whose declared influence changes
   * a world relation needs that relation's premises; one that only names an entity
   * to act on needs that entity to be an item. The world decides and the body
   * simply passes the declared influence along.
   */
  private worldPremises(
    state: WorldState,
    action: ActionInstance,
  ): { readonly ok: true } | { readonly ok: false; readonly reason: string } {
    const spec = actionSpec(this.runtime.config, action.action);
    if (spec === undefined) return { ok: false, reason: `unknown action ${action.action}` };
    return this.world.actionPremises(state, action, {
      changesWorld: spec.worldInfluence !== null,
      relation: influenceRelation(this.runtime.config, spec.worldInfluence),
    });
  }

  private actionOf(actions: readonly ActionInstance[], actionId: string): ActionInstance | undefined {
    return actions.find((action) => action.actionId === actionId);
  }

  /** Actions of one body that are still holding resources. */
  private holding(body: string, actions: readonly ActionInstance[]): readonly ActionInstance[] {
    return actions.filter(
      (action) =>
        action.entityId === body &&
        (action.status === "queued" || action.status === "running" || action.status === "waiting-world"),
    );
  }

  private resourcesOf(actionRef: string): readonly string[] {
    const spec = actionSpec(this.runtime.config, actionRef);
    if (spec === undefined) return [];
    return [
      ...new Set(spec.stages.map((stage) => stage.resource).filter((name): name is string => name !== null)),
    ].sort();
  }

  /**
   * What one step needs from its body: the ability and resources the body config
   * declares, and the physical mode that has to allow the ability right now. A
   * queued action is checked again with this before it starts, so a mode that
   * changed while it waited keeps it from running.
   */
  private stepPremises(
    record: BodyRecord,
    bodyConfig: NonNullable<ReturnType<typeof bodyConfigSpec>>,
    actionRef: string,
  ): string | undefined {
    const spec = actionSpec(this.runtime.config, actionRef);
    if (spec === undefined) return `unknown action ${actionRef}`;
    if (!bodyConfig.abilities.includes(spec.ability))
      return `body ${record.configRef} does not declare ability ${spec.ability}`;
    const allowed = modeAbilities(this.runtime.config, record.mode) ?? [];
    if (!allowed.includes(spec.ability)) return `physical mode ${record.mode} does not allow ability ${spec.ability}`;
    for (const resource of this.resourcesOf(actionRef))
      if (!bodyConfig.resources.includes(resource))
        return `body ${record.configRef} does not declare resource ${resource}`;
    return undefined;
  }

  /** The same premises for an action that already exists: its body may have moved. */
  private startPremises(body: BodyState, action: ActionInstance): string | undefined {
    const record = body.bodies[action.entityId];
    if (record === undefined) return `${action.entityId} has no body instance`;
    const bodyConfig = bodyConfigSpec(this.runtime.config, record.configRef);
    if (bodyConfig === undefined) return `body configuration ${record.configRef} is not declared`;
    return this.stepPremises(record, bodyConfig, action.action);
  }

  private conflicts(reserved: readonly string[], others: readonly ActionInstance[]): readonly ActionInstance[] {
    const exclusive = reserved.filter((resource) => resourceSpec(this.runtime.config, resource)?.exclusive === true);
    if (exclusive.length === 0) return [];
    return others.filter((other) => other.resources.some((resource) => exclusive.includes(resource)));
  }

  /**
   * Accepts one plan. A plan that fails validation holds no resource and produces
   * no effect, and every accepted plan starts accumulating progress on the next
   * tick, whatever its source.
   */
  acceptPlan(
    runtime: BodyRuntime,
    characters: CharacterState,
    plan: ActionPlan,
    world: WorldState,
    context: TickContext,
  ): PlanAcceptance {
    const fail = (reason: string): PlanAcceptance => ({
      runtime,
      outcome: { accepted: false, actionId: null, status: "rejected", reason },
    });
    const record = runtime.body.bodies[plan.entityId];
    if (record === undefined) return fail(`${plan.entityId} has no body instance`);
    const character = characters.characters[plan.entityId];
    if (character === undefined) return fail(`${plan.entityId} is not a character instance`);
    if (character.lifecycle !== "running") return fail(`${plan.entityId} is paused and accepts no new plan`);
    if (plan.steps.length === 0) return fail("the plan declares no step");
    const bodyConfig = bodyConfigSpec(this.runtime.config, record.configRef);
    if (bodyConfig === undefined) return fail(`body configuration ${record.configRef} is not declared`);
    for (const step of plan.steps) {
      const problem = this.stepPremises(record, bodyConfig, step.action);
      if (problem !== undefined) return fail(problem);
    }
    const first = plan.steps[0];
    if (first === undefined) return fail("the plan declares no step");
    const reserved = this.resourcesOf(first.action);
    const actionId = `${context.tick}/${plan.entityId}/${plan.planId}/${first.action}`;
    const existing = runtime.actions.find((action) => action.actionId === actionId);
    if (existing !== undefined)
      return {
        runtime,
        outcome: {
          accepted: true,
          actionId: existing.actionId,
          status: existing.status,
          reason: "the plan was already accepted in this tick",
        },
      };
    const others = this.holding(plan.entityId, runtime.actions);
    const conflicts = plan.conflict === "parallel" ? [] : this.conflicts(reserved, others);
    if (plan.conflict === "parallel" && this.conflicts(reserved, others).length > 0)
      return fail(
        `resource conflict with ${this.conflicts(reserved, others)
          .map((action) => action.actionId)
          .join(", ")}`,
      );

    let actions = [...runtime.actions];
    if (conflicts.length > 0) {
      if (plan.conflict === "queue") {
        const queued = this.instanceOf(plan, first.action, context, reserved, first, "queued");
        return {
          runtime: { body: runtime.body, actions: freeze([...actions, queued]) },
          outcome: {
            accepted: true,
            actionId: queued.actionId,
            status: "queued",
            reason: `waiting for ${conflicts
              .map((action) => action.actionId)
              .sort()
              .join(", ")}`,
          },
        };
      }
      const blocking = conflicts.filter((action) => this.actionSpecOf(action.action)?.interruptible !== true);
      if (blocking.length > 0)
        return fail(
          `cannot replace ${blocking
            .map((action) => action.actionId)
            .sort()
            .join(", ")}: not interruptible`,
        );
      const interrupted = new Set(conflicts.map((action) => action.actionId));
      actions = actions.map((action) =>
        interrupted.has(action.actionId)
          ? {
              ...action,
              status: "interrupted" as ActionStatus,
              outcome: {
                status: "interrupted" as ActionStatus,
                reason: `replaced by ${plan.planId}`,
                tick: context.tick,
                changes: [],
              },
            }
          : action,
      );
    }
    const spec = actionSpec(this.runtime.config, first.action);
    if (spec === undefined) return fail(`unknown action ${first.action}`);
    const created = this.instanceOf(plan, first.action, context, reserved, first, "running");
    if (plan.conflict !== "queue") {
      const premises = this.worldPremises(world, created);
      if (!premises.ok) return fail(premises.reason);
    }
    return {
      runtime: { body: runtime.body, actions: freeze([...actions, created]) },
      outcome: { accepted: true, actionId: created.actionId, status: "running", reason: "accepted" },
    };
  }

  private instanceOf(
    plan: ActionPlan,
    actionRef: string,
    context: TickContext,
    reserved: readonly string[],
    step: { readonly target?: string; readonly destination?: string },
    status: ActionStatus,
  ): ActionInstance {
    return Object.freeze({
      // The action identity is a function of the plan and the tick it was accepted
      // in, so it does not change when a save is loaded on another timeline.
      actionId: `${context.tick}/${plan.entityId}/${plan.planId}/${actionRef}`,
      entityId: plan.entityId,
      plan,
      stepIndex: 0,
      action: actionRef,
      status,
      stageIndex: 0,
      stageTicks: 0,
      acceptedTick: context.tick,
      eligibleTick: context.tick + 1,
      target: step.target ?? null,
      destination: step.destination ?? null,
      resources: reserved,
      worldRequest: null,
      outcome: null,
    });
  }

  /**
   * Advances every established body process and every live action one tick. A
   * stage that ends runs the stage rules (consumption, recovery, mode) and a final
   * stage with a world influence turns into a waiting request instead of a result.
   */
  advance(
    runtime: BodyRuntime,
    sources: ProjectionSources,
    characters: CharacterState,
    context: TickContext,
  ): AdvanceResult {
    let body = runtime.body;
    let actions = [...runtime.actions];
    const applied: StateChangeRequest[] = [];
    const rejected: RejectedChange[] = [];
    const notes: string[] = [];
    const processChanges: ProcessChangeRequest[] = [];

    for (const record of Object.values(body.bodies).sort((left, right) => (left.entityId < right.entityId ? -1 : 1))) {
      for (const process of [...record.processes].sort((left, right) =>
        left.processRef < right.processRef ? -1 : 1,
      )) {
        const run = this.runtime.runRules({
          runId: runIdOf({ ...context, command: `body-process/${record.entityId}/${process.processRef}` }),
          trigger: "agentlife.body/process-advanced",
          entityIds: [record.entityId],
          baseVersion: body.version,
          input: {
            stateVersion: body.version,
            simTime: { tick: context.tick, seconds: 0 },
            ...this.projection(sources, body, [record.entityId], {
              entityId: record.entityId,
              process: { process: process.processRef, rate: Number(process.params["rate"] ?? 0), gain: 0 },
            }),
          },
        });
        notes.push(`body-process ${record.entityId}/${process.processRef}@${context.tick}`);
        const commit = this.commit({ body, actions }, context, run.stateChanges, run.processChanges, {
          actor: record.entityId,
          subject: process.processRef,
        });
        body = commit.runtime.body;
        actions = [...commit.runtime.actions];
        applied.push(...commit.applied);
        rejected.push(...commit.rejected);
        notes.push(...commit.notes);
        processChanges.push(...run.processChanges);
      }
    }

    for (const action of [...actions].sort((left, right) => (left.actionId < right.actionId ? -1 : 1))) {
      const spec = this.actionSpecOf(action.action);
      if (spec === undefined) continue;
      if (action.status === "queued") {
        if (context.tick < action.eligibleTick) continue;
        // Waiting may have moved the body: check its premises again before starting.
        const premises = this.startPremises(body, action);
        if (premises !== undefined) {
          notes.push(`queued ${action.actionId} still blocked: ${premises}`);
          continue;
        }
        const conflicts = this.conflicts(
          action.resources,
          this.holding(action.entityId, actions).filter((other) => other.actionId !== action.actionId),
        );
        const ready = this.worldPremises(sources.world, action);
        if (conflicts.length > 0) continue;
        if (!ready.ok) {
          notes.push(`queued ${action.actionId} still blocked: ${ready.reason}`);
          continue;
        }
        actions = actions.map((entry) =>
          entry.actionId === action.actionId ? { ...entry, status: "running" as ActionStatus } : entry,
        );
        notes.push(`queued ${action.actionId} started at ${context.tick}`);
        continue;
      }
      if (action.status !== "running") continue;
      if (context.tick < action.eligibleTick) continue;
      const stage = spec.stages[action.stageIndex];
      if (stage === undefined) continue;
      const ticks = action.stageTicks + 1;
      if (ticks < stage.ticks) {
        actions = actions.map((entry) =>
          entry.actionId === action.actionId ? { ...entry, stageTicks: ticks } : entry,
        );
        continue;
      }
      const finalStage = action.stageIndex === spec.stages.length - 1;
      const stageStatus = finalStage ? "completed" : "advanced";
      const stageRun = this.runtime.runRules({
        runId: runIdOf({ ...context, command: `action-stage/${action.actionId}/${stage.name}` }),
        trigger: "agentlife.body/action-advanced",
        entityIds: [action.entityId],
        baseVersion: body.version,
        input: {
          stateVersion: body.version,
          simTime: { tick: context.tick, seconds: 0 },
          ...this.projection(sources, body, [action.entityId], {
            entityId: action.entityId,
            activity: { action: action.action, stage: stage.name, status: stageStatus },
          }),
        },
      });
      const commit = this.commit({ body, actions }, context, stageRun.stateChanges, stageRun.processChanges, {
        actor: action.entityId,
        subject: action.action,
      });
      body = commit.runtime.body;
      actions = [...commit.runtime.actions];
      applied.push(...commit.applied);
      rejected.push(...commit.rejected);
      notes.push(...commit.notes);
      processChanges.push(...stageRun.processChanges);
      notes.push(`stage ${stage.name} of ${action.actionId} ${stageStatus}`);

      const current = this.actionOf(actions, action.actionId);
      if (current === undefined) continue;
      if (!finalStage) {
        actions = actions.map((entry) =>
          entry.actionId === action.actionId ? { ...entry, stageIndex: entry.stageIndex + 1, stageTicks: 0 } : entry,
        );
        continue;
      }
      if (spec.worldInfluence !== null) {
        const request: WorldInfluenceRequest = {
          influenceId: `${action.actionId}/world`,
          timelineId: context.timelineId,
          kind: spec.worldInfluence,
          actor: action.entityId,
          subject: action.target ?? action.entityId,
          destination: action.destination,
          baseVersion: sources.world.version,
          tick: context.tick,
        };
        actions = actions.map((entry) =>
          entry.actionId === action.actionId
            ? { ...entry, status: "waiting-world" as ActionStatus, worldRequest: request }
            : entry,
        );
        continue;
      }
      actions = actions.map((entry) =>
        entry.actionId === action.actionId
          ? {
              ...entry,
              status: "completed" as ActionStatus,
              outcome: {
                status: "completed" as ActionStatus,
                reason: "all stages done",
                tick: context.tick,
                changes: [],
              },
            }
          : entry,
      );
    }
    void characters;
    return {
      runtime: { body, actions: freeze(actions) },
      applied,
      rejected,
      notes,
      pending: actions.filter((action) => action.status === "waiting-world"),
      processChanges,
    };
  }

  /** Absorbs one world adjudication into the action that asked for it. */
  absorb(runtime: BodyRuntime, outcome: InfluenceOutcome, context: TickContext): BodyRuntime {
    const action = runtime.actions.find((entry) => entry.worldRequest?.influenceId === outcome.influenceId);
    if (action === undefined || action.status !== "waiting-world") return runtime;
    const spec = this.actionSpecOf(action.action);
    if (outcome.status !== "applied") {
      return {
        body: runtime.body,
        actions: bumpAction(runtime.actions, action.actionId, (entry) => ({
          ...entry,
          status: "failed",
          outcome: {
            status: "failed",
            reason: `world ${outcome.status}: ${outcome.reason}`,
            tick: context.tick,
            changes: [],
          },
        })),
      };
    }
    const steps = action.plan.steps;
    const nextStep = steps[action.stepIndex + 1];
    if (nextStep !== undefined)
      return {
        body: runtime.body,
        actions: bumpAction(runtime.actions, action.actionId, (entry) => ({
          ...entry,
          stepIndex: entry.stepIndex + 1,
          action: nextStep.action,
          status: "running",
          stageIndex: 0,
          stageTicks: 0,
          eligibleTick: context.tick + 1,
          target: nextStep.target ?? null,
          destination: nextStep.destination ?? null,
          resources: this.resourcesOf(nextStep.action),
          worldRequest: null,
        })),
      };
    void spec;
    return {
      body: runtime.body,
      actions: bumpAction(runtime.actions, action.actionId, (entry) => ({
        ...entry,
        status: "completed",
        outcome: { status: "completed", reason: "world applied", tick: context.tick, changes: [] },
      })),
    };
  }

  /** Cancels or interrupts one action on request. */
  terminate(runtime: BodyRuntime, actionId: string, status: ActionStatus, reason: string, tick: number): BodyRuntime {
    return {
      body: runtime.body,
      actions: bumpAction(runtime.actions, actionId, (entry) => ({
        ...entry,
        status,
        outcome: { status, reason, tick, changes: [] },
      })),
    };
  }

  /**
   * Commits rule-requested body state changes and process requests. Body values,
   * channels, participation and the physical mode are the only states it owns,
   * and a mode the body instance does not declare is refused.
   */
  commit(
    runtime: BodyRuntime,
    context: TickContext,
    changes: readonly StateChangeRequest[],
    processChanges: readonly ProcessChangeRequest[],
    origin: { readonly actor: string | null; readonly subject: string | null },
  ): BodyCommit {
    const bodies: Record<string, BodyRecord> = { ...runtime.body.bodies };
    const applied: StateChangeRequest[] = [];
    const rejected: RejectedChange[] = [];
    const notes: string[] = [];
    for (const change of changesInOrder(changes)) {
      if (change.system !== "agentlife.body") {
        rejected.push({
          ref: change.stateRef,
          entityId: change.entityId,
          reason: `${change.stateRef} is not owned by the body system`,
        });
        continue;
      }
      if (change.entityId === null || bodies[change.entityId] === undefined) {
        rejected.push({
          ref: change.stateRef,
          entityId: change.entityId,
          reason: `${String(change.entityId)} has no body instance`,
        });
        continue;
      }
      const shape = checkValue(this.runtime.config, change.stateRef, change.newValue);
      if (!shape.ok) {
        rejected.push({ ref: change.stateRef, entityId: change.entityId, reason: shape.reason });
        continue;
      }
      const staged = stageBodyChange(this.runtime.config, bodies, change);
      if (staged === undefined) {
        rejected.push({
          ref: change.stateRef,
          entityId: change.entityId,
          reason: `${change.stateRef} names no body state`,
        });
        continue;
      }
      // An identical value is not a change: it is not reported, so deterministic
      // propagation can reach a fixpoint.
      if (staged === bodies[change.entityId]) continue;
      bodies[change.entityId] = staged;
      applied.push(change);
    }
    const processes = this.applyProcessRequests(bodies, processChanges, context, rejected, notes);
    const body: BodyState =
      applied.length === 0 && processes === runtime.body.bodies
        ? runtime.body
        : {
            version: applied.length === 0 ? runtime.body.version : bump(runtime.body.version),
            bodies: processes === runtime.body.bodies ? Object.freeze(bodies) : processes,
          };
    void origin;
    // Actions are always held in one stable order, whatever path produced them.
    return { runtime: { body, actions: freeze(runtime.actions) }, applied, rejected, notes };
  }

  private applyProcessRequests(
    bodies: Readonly<Record<string, BodyRecord>>,
    requests: readonly ProcessChangeRequest[],
    context: TickContext,
    rejected: RejectedChange[],
    notes: string[],
  ): Readonly<Record<string, BodyRecord>> {
    let next: Record<string, BodyRecord> | undefined;
    const mutable = (): Record<string, BodyRecord> => (next ??= { ...bodies });
    for (const request of processRequestsInOrder(requests)) {
      if (request.system !== "agentlife.body") continue;
      const spec = processSpec(this.runtime.systemIndex, request.processRef);
      if (spec === undefined) {
        rejected.push({
          ref: request.processRef,
          entityId: request.entityId,
          reason: `unknown body process ${request.processRef}`,
        });
        continue;
      }
      if (!spec.operations.includes(request.action)) {
        rejected.push({
          ref: request.processRef,
          entityId: request.entityId,
          reason: `process ${request.processRef} does not allow ${request.action}`,
        });
        continue;
      }
      const owner = request.entityId;
      const record = owner === null ? undefined : mutable()[owner];
      if (record === undefined) {
        rejected.push({
          ref: request.processRef,
          entityId: request.entityId,
          reason: `${String(owner)} has no body instance`,
        });
        continue;
      }
      const existing = record.processes.find((process) => process.processRef === request.processRef);
      if (request.action === "establish") {
        if (existing !== undefined) continue;
        const params: Record<string, SimpleValue> = {};
        let valid = true;
        for (const parameter of spec.parameters) {
          const value = request.params[parameter.name];
          if (value === undefined || typeof value !== parameter.valueType) {
            rejected.push({
              ref: request.processRef,
              entityId: request.entityId,
              reason: `parameter ${parameter.name} must be a ${parameter.valueType}`,
            });
            valid = false;
            break;
          }
          params[parameter.name] = value;
        }
        if (!valid) continue;
        const process: BodyProcess = {
          processRef: request.processRef,
          ownerId: owner as string,
          establishedTick: context.tick,
          params: Object.freeze(params),
        };
        mutable()[owner as string] = { ...record, processes: Object.freeze([...record.processes, process]) };
        notes.push(`process ${request.processRef} established for ${owner as string}`);
        continue;
      }
      if (existing === undefined) {
        rejected.push({
          ref: request.processRef,
          entityId: request.entityId,
          reason: `process ${request.processRef} is not established`,
        });
        continue;
      }
      if (request.action === "advance" || request.action === "pause") continue;
      mutable()[owner as string] = {
        ...record,
        processes: Object.freeze(record.processes.filter((process) => process !== existing)),
      };
      notes.push(`process ${request.processRef} ended for ${owner as string}`);
    }
    return next === undefined ? bodies : Object.freeze(next);
  }

  /** Body and process projection of the named entities. */
  projection(
    sources: ProjectionSources,
    body: BodyState,
    entityIds: readonly string[],
    options: {
      readonly entityId: string;
      readonly activity?: { readonly action: string; readonly stage: string; readonly status: string };
      readonly process?: { readonly process: string; readonly rate: number; readonly gain: number };
    },
  ): { readonly shared: Record<string, unknown>; readonly entities: Record<string, Record<string, unknown>> } {
    const entities: Record<string, Record<string, unknown>> = {};
    for (const entityId of [...new Set(entityIds)].sort()) {
      const slice = entitySlice({ ...sources, body }, entityId, {
        activity: entityId === options.entityId ? options.activity : undefined,
        process: entityId === options.entityId ? options.process : undefined,
      });
      if (slice !== undefined) entities[entityId] = slice;
    }
    return { shared: sharedSlice({ ...sources, body }, NO_INFLUENCE, options.process ?? NO_PROCESS), entities };
  }
}

function stageBodyChange(
  config: ServiceRuntime["config"],
  bodies: Readonly<Record<string, BodyRecord>>,
  change: StateChangeRequest,
): BodyRecord | undefined {
  const entityId = change.entityId;
  if (entityId === null) return undefined;
  const record = bodies[entityId];
  if (record === undefined) return undefined;
  if (change.stateRef.startsWith("agentlife.body/values.")) {
    const member = change.stateRef.slice("agentlife.body/values.".length);
    if (!(member in record.values)) return undefined;
    if (record.values[member] === change.newValue) return record;
    return { ...record, values: Object.freeze({ ...record.values, [member]: change.newValue }) };
  }
  if (change.stateRef.startsWith("agentlife.body/channels.")) {
    const member = change.stateRef.slice("agentlife.body/channels.".length);
    if (!(member in record.channels)) return undefined;
    if (record.channels[member] === change.newValue) return record;
    return { ...record, channels: Object.freeze({ ...record.channels, [member]: change.newValue }) };
  }
  if (change.stateRef === "agentlife.body/cognitive-participation") {
    if (record.participation === String(change.newValue)) return record;
    return { ...record, participation: String(change.newValue) };
  }
  if (change.stateRef === "agentlife.body/current-mode") {
    const modes = bodyConfigSpec(config, record.configRef)?.modes ?? [];
    if (!modes.includes(String(change.newValue))) return undefined;
    if (record.mode === String(change.newValue)) return record;
    return { ...record, mode: String(change.newValue) };
  }
  return undefined;
}

function bump(version: string): string {
  const separator = version.lastIndexOf("-");
  return `${version.slice(0, separator)}-${Number(version.slice(separator + 1)) + 1}`;
}

function freeze(actions: readonly ActionInstance[]): readonly ActionInstance[] {
  return Object.freeze([...actions].sort((left, right) => (left.actionId < right.actionId ? -1 : 1)));
}

function bumpAction(
  actions: readonly ActionInstance[],
  actionId: string,
  update: (action: ActionInstance) => ActionInstance,
): readonly ActionInstance[] {
  return freeze(actions.map((action) => (action.actionId === actionId ? Object.freeze(update(action)) : action)));
}

export { IDLE_ACTIVITY, BODY_ACTIVITY, BODY_PARTICIPATION, BODY_MODE };
