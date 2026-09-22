import { BehaviorTreeAdapter, type JsonValue } from "../behavior/behavior-tree-adapter.js";
import { behaviorFunctionRegistry, plannedStep, type PlannedStep } from "../behavior/behavior-functions.js";
import type { RuntimeConfig } from "../config/config-builder.js";
import type { CoreRuntime } from "../config/core-runtime.js";
import type { ProcessChangeRequest, RuleResult, StateChangeRequest } from "../config/rule-engine.js";
import type { SystemIndex } from "../config/system-index.js";
import type { SimpleValue } from "../config/value-expr.js";
import { BodyService, type BodyRuntime, type PrerequisiteCheck } from "./body-service.js";
import { CharacterService } from "./character-service.js";
import {
  BODY_ACTIVITY,
  BODY_CHANNELS,
  BODY_MODE,
  BODY_PARTICIPATION,
  BODY_VALUES,
  WORLD_ATTRIBUTES,
  WORLD_FACTS,
  behaviourTreeSpec,
  localViewMembers,
} from "./config-view.js";
import { IDLE_ACTIVITY, entitySlice, sharedSlice, type ProjectionSources } from "./projection.js";
import {
  TICK_STAGES,
  NO_OP_STAGES,
  stateVersionOf,
  type ActionInstance,
  type ActionPlan,
  type ActivityState,
  type InfluenceOutcome,
  type RuleBarrier,
  type RunMode,
  type SimulationSettings,
  type SimulationState,
  type StageRecord,
  type TickFailure,
  type TickSummary,
  type WorldState,
} from "./types.js";
import { WorldService, type ChangeClaims, type ServiceRuntime, type TickContext } from "./world-service.js";

/**
 * The simulation orchestrator: the only owner of the clock, the tick and the
 * barriers.
 *
 * One tick executes twelve fixed stages in order. The first eleven stages either
 * advance a service, run the rules a committed change selected, or record an
 * explicit no-op for a later phase; stage twelve publishes the new authoritative
 * state. Nothing here decides a world fact or a body value: it wakes the services
 * and the rule engine, and it publishes exactly what they committed.
 */

export interface TickInput {
  /** Plans fixed at the start of this tick, e.g. from a diagnostic entry point. */
  readonly plans?: readonly ActionPlan[];
}

export interface TickResult {
  readonly status: "completed" | "barrier" | "failed";
  readonly summary: TickSummary;
}

export interface OrchestratorOptions {
  readonly timelineId: string;
  readonly settings?: Partial<SimulationSettings>;
  readonly claims?: ChangeClaims;
}

const DEFAULT_SETTINGS: SimulationSettings = Object.freeze({
  tickSeconds: 1,
  maxPropagationRounds: 8,
  maxEvents: 256,
});

/** Change identities applied on this timeline, restored with a loaded save. */
class TimelineClaims implements ChangeClaims {
  private readonly claimed = new Set<string>();

  constructor(seeded: readonly string[] = []) {
    for (const changeId of seeded) this.claimed.add(changeId);
  }

  claim(changeId: string): "claimed" | "duplicate" {
    if (this.claimed.has(changeId)) return "duplicate";
    this.claimed.add(changeId);
    return "claimed";
  }

  ids(): readonly string[] {
    return [...this.claimed].sort();
  }
}

export class SimulationOrchestrator {
  private readonly runtime: ServiceRuntime;
  private readonly settings: SimulationSettings;
  private claims: TimelineClaims;
  private readonly adapters = new Map<string, BehaviorTreeAdapter>();
  private current: SimulationState;

  constructor(
    private readonly core: CoreRuntime,
    readonly characters: CharacterService,
    readonly world: WorldService,
    readonly body: BodyService,
    options: OrchestratorOptions,
    private readonly systemIndex: SystemIndex,
  ) {
    const config = this.requireConfig();
    this.settings = Object.freeze({ ...DEFAULT_SETTINGS, ...(options.settings ?? {}) });
    this.runtime = {
      config,
      systemIndex,
      runRules: (request) => this.core.runRules(request),
    };
    this.claims = (options.claims as TimelineClaims | undefined) ?? new TimelineClaims();
    const characterState = characters.initialize();
    const worldState = world.initialize(
      characters.sorted(characterState).map((character) => ({
        entityId: character.entityId,
        homeLocation: character.homeLocation,
      })),
    );
    const bodyState = body.initialize(characterState);
    this.current = Object.freeze({
      timelineId: options.timelineId,
      tick: 0,
      simTime: { tick: 0, seconds: 0 },
      phase: "publish" as const,
      configId: config.configId,
      runMode: "single-step" as RunMode,
      settings: this.settings,
      world: worldState,
      characters: characterState,
      body: bodyState,
      behaviours: Object.freeze({}),
      activity: this.initialActivity(characterState),
      actions: Object.freeze([]),
      barrier: null,
      failure: null,
      claimedChangeIds: Object.freeze([]),
      summary: null,
    });
  }

  static create(core: CoreRuntime, options: OrchestratorOptions): SimulationOrchestrator {
    const config = core.current();
    if (config === undefined) throw new Error("No runtime config is published");
    const systemIndex = core.systemIndex();
    const settings = Object.freeze({ ...DEFAULT_SETTINGS, ...(options.settings ?? {}) });
    const claims = (options.claims as TimelineClaims | undefined) ?? new TimelineClaims();
    const characters = new CharacterService(config);
    const world = new WorldService(
      { config, systemIndex, runRules: (request) => core.runRules(request) },
      settings,
      claims,
    );
    const body = new BodyService({ config, systemIndex, runRules: (request) => core.runRules(request) }, claims);
    return new SimulationOrchestrator(core, characters, world, body, { ...options, claims }, systemIndex);
  }

  private requireConfig(): RuntimeConfig {
    const config = this.core.current();
    if (config === undefined) throw new Error("No runtime config is published");
    return config;
  }

  state(): SimulationState {
    return this.current;
  }

  private initialActivity(characters: {
    readonly characters: Readonly<Record<string, { readonly bodyConfig: string | null }>>;
  }): ActivityState {
    const active = Object.keys(characters.characters)
      .filter((entityId) => characters.characters[entityId]?.bodyConfig !== null)
      .sort()
      .map((entityId) => ({ entryId: entityId, category: "entity" as const }));
    return Object.freeze({
      active: Object.freeze(active),
      scheduled: Object.freeze([{ entryId: "body-tick", tick: 1 }]),
    });
  }

  /** Runs one complete tick from the current stable state. */
  runTick(input: TickInput = {}): TickResult {
    const config = this.requireConfig();
    const stages: StageRecord[] = [];
    const startingTick = this.current.tick + 1;
    const context: TickContext = { timelineId: this.current.timelineId, tick: startingTick, command: "tick" };
    let world = this.current.world;
    let bodyRuntime: BodyRuntime = { body: this.current.body, actions: this.current.actions };
    const influenceOutcomes: InfluenceOutcome[] = [];
    const actionOutcomes: string[] = [];
    let failure: TickFailure | null = null;
    let barrier = this.current.barrier;
    let stageTruncated = false;

    // 1. Fix the tick identity and the plan inputs of this tick.
    const fixedPlans = [...(input.plans ?? [])];
    for (const plan of fixedPlans) {
      const attempt = this.body.acceptPlan(
        bodyRuntime,
        this.current.characters,
        plan,
        context,
        this.prerequisiteFor(world, bodyRuntime),
      );
      bodyRuntime = attempt.runtime;
      actionOutcomes.push(`${attempt.outcome.status} ${plan.planId}: ${attempt.outcome.reason}`);
    }
    stages.push({
      stage: "fixed",
      status: "done",
      detail: `tick ${startingTick}, ${fixedPlans.length} plan input(s), config ${config.configId.slice(0, 12)}`,
    });

    // 2. Advance the simulated clock and wake the index entries due now.
    const due = this.current.activity.scheduled.filter((entry) => entry.tick <= startingTick);
    const scheduled = Object.freeze([
      ...this.current.activity.scheduled.filter((entry) => entry.tick > startingTick),
      { entryId: "body-tick", tick: startingTick + 1 },
    ]);
    stages.push({
      stage: "clock",
      status: "done",
      detail: `simTime ${startingTick * this.settings.tickSeconds}s, woke ${due.map((entry) => entry.entryId).join(", ") || "nothing"}`,
    });

    // 3. Advance world processes, body processes and existing actions.
    const sourcesFor = (): ProjectionSources => ({
      config,
      world,
      characters: this.current.characters,
      body: bodyRuntime.body,
    });
    const worldProcesses = this.world.advanceProcesses(sourcesFor(), context);
    world = worldProcesses.state;
    const advanced = this.body.advance(
      bodyRuntime,
      sourcesFor(),
      this.current.characters,
      context,
      this.prerequisiteFor(world, bodyRuntime),
    );
    bodyRuntime = advanced.runtime;
    actionOutcomes.push(...advanced.notes);
    let changedRefs = [...worldProcesses.applied, ...advanced.applied].map((change) => change.stateRef);

    // The standing tick wake runs the body maintenance rules.
    for (const entry of due.filter((candidate) => candidate.entryId === "body-tick")) {
      const { run, frameVersion } = this.runRulesFor(
        config,
        "agentlife.body/tick-elapsed",
        this.bodyOwners(),
        world,
        bodyRuntime,
        context,
      );
      const committed = this.commitBySystem(world, bodyRuntime, context, run, frameVersion);
      world = committed.world;
      bodyRuntime = committed.body;
      changedRefs.push(...run.stateChanges.map((change) => change.stateRef));
      stages.push({
        stage: "clock",
        status: "done",
        detail: `${entry.entryId} rules ran for ${this.bodyOwners().length} bodies`,
      });
    }
    stages.push({
      stage: "advance",
      status: "done",
      detail: `${worldProcesses.advanced.length} world process(es), ${bodyRuntime.actions.length} action(s)`,
    });

    // 4. Let the degraded entities decide, then accept the plans they formed.
    const decisions = this.runBehaviourTrees(world, bodyRuntime, context);
    bodyRuntime = decisions.runtime;
    actionOutcomes.push(...decisions.notes);
    stages.push({
      stage: "decide",
      status: decisions.notes.length === 0 ? "no-op" : "done",
      detail: decisions.notes.length === 0 ? "no behaviour tree was due" : decisions.notes.join("; "),
    });

    // 5. The world adjudicates every action impact that reached its point.
    const pending = bodyRuntime.actions.filter((action) => action.status === "waiting-world");
    const frameVersion = world.version;
    for (const action of pending) {
      const request = action.worldRequest;
      if (request === null) continue;
      const sources: ProjectionSources = {
        config,
        world,
        characters: this.current.characters,
        body: bodyRuntime.body,
      };
      const adjudication = this.world.adjudicate(sources, request, frameVersion);
      world = adjudication.state;
      bodyRuntime = this.body.absorb(bodyRuntime, adjudication.outcome, context);
      influenceOutcomes.push(adjudication.outcome);
      changedRefs.push(...adjudication.applied.map((change) => change.stateRef));
      actionOutcomes.push(
        `world ${adjudication.outcome.status} for ${request.influenceId}: ${adjudication.outcome.reason}`,
      );
    }
    stages.push({
      stage: "adjudicate",
      status: pending.length === 0 ? "no-op" : "done",
      detail:
        pending.length === 0
          ? "no action reached a world impact point"
          : influenceOutcomes.map((outcome) => `${outcome.status}:${outcome.reason}`).join("; "),
    });

    // 6. Propagate committed changes through the indexed rules until stable.
    const propagation = this.propagate(world, bodyRuntime, context, changedRefs);
    world = propagation.world;
    bodyRuntime = propagation.body;
    actionOutcomes.push(...propagation.notes);
    stages.push({
      stage: "propagate",
      status: propagation.rounds === 0 ? "no-op" : "done",
      detail: `${propagation.rounds} round(s): ${propagation.triggers.join(", ") || "no trigger selected"}`,
    });

    // 7. Check stability: a missing rule set stops the tick, an unconverged
    //    propagation fails it. Neither publishes a stable tick.
    const barrierFinding = propagation.barrier;
    if (barrierFinding !== undefined) {
      barrier = barrierFinding;
      failure = null;
      stages.push({
        stage: "stability",
        status: "failed",
        detail: `rule barrier on ${barrierFinding.trigger} for ${barrierFinding.stateRef}`,
      });
      stageTruncated = true;
    } else if (propagation.exceeded) {
      failure = {
        stage: "stability",
        code: "propagation-limit",
        detail: `propagation did not stabilise within ${this.settings.maxPropagationRounds} rounds`,
      };
      stages.push({ stage: "stability", status: "failed", detail: failure.detail });
      stageTruncated = true;
    } else {
      barrier = null;
      failure = null;
      stages.push({ stage: "stability", status: "done", detail: "objective state is stable" });
    }

    // 8-11. Explicit extension points that phase 2 records as no-ops.
    if (!stageTruncated)
      for (const stage of NO_OP_STAGES) stages.push({ stage, status: "no-op", detail: "phase 2 records no work here" });

    // 12. Publish the new stable state and the tick summary.
    const nextTick = stageTruncated ? this.current.tick : startingTick;
    const nextPhase = stageTruncated ? "stability" : "publish";
    const nextState: Omit<SimulationState, "summary" | "runMode"> = {
      timelineId: this.current.timelineId,
      tick: nextTick,
      simTime: { tick: nextTick, seconds: nextTick * this.settings.tickSeconds },
      phase: nextPhase,
      configId: config.configId,
      settings: this.settings,
      world,
      characters: this.current.characters,
      body: bodyRuntime.body,
      behaviours: Object.freeze(this.behaviourStates()),
      activity: { active: this.activityEntries(), scheduled },
      actions: bodyRuntime.actions,
      barrier,
      failure,
      claimedChangeIds: Object.freeze(this.claims.ids()),
    };
    const runMode: RunMode =
      failure !== null ? "failed" : barrier !== null ? "barrier" : this.idle(nextState) ? "idle" : "single-step";
    stages.push({
      stage: "publish",
      status: "done",
      detail: `${runMode} at tick ${nextTick}, ${world.events.length} objective event(s)`,
    });
    const summary: TickSummary = Object.freeze({
      tick: nextTick,
      stages: Object.freeze(stages),
      stateVersion: stateVersionOf(nextState),
      actionOutcomes: Object.freeze(actionOutcomes),
      influenceOutcomes: Object.freeze(influenceOutcomes),
      eventCount: world.events.length,
    });
    this.current = Object.freeze({ ...nextState, runMode, summary });
    return {
      status: failure !== null ? "failed" : barrier !== null ? "barrier" : "completed",
      summary,
    };
  }

  /** Restores a saved state after checking it belongs to the published config. */
  load(state: SimulationState): void {
    const config = this.requireConfig();
    if (state.configId !== config.configId)
      throw new Error(`save refers to config ${state.configId}, the runtime publishes ${config.configId}`);
    this.claims = new TimelineClaims(state.claimedChangeIds);
    this.adapters.clear();
    this.current = Object.freeze({ ...state, runMode: "single-step", summary: state.summary });
  }

  private behaviourStates(): Readonly<Record<string, ReturnType<BehaviorTreeAdapter["exportState"]>>> {
    // A record without a live adapter yet - one restored by `load()` whose entity
    // has not reached a decision point since - is published exactly as it was saved.
    const states: Record<string, ReturnType<BehaviorTreeAdapter["exportState"]>> = { ...this.current.behaviours };
    for (const [entityId, adapter] of [...this.adapters].sort(([left], [right]) => (left < right ? -1 : 1)))
      states[entityId] = adapter.exportState();
    return states;
  }

  private activityEntries(): ActivityState["active"] {
    const entries: { entryId: string; category: "entity" | "world-process" | "body-process" }[] = this.bodyOwners().map(
      (entityId) => ({ entryId: entityId, category: "entity" as const }),
    );
    for (const process of [
      ...this.current.world.processes,
      ...Object.values(this.current.body.bodies).flatMap((record) => record.processes),
    ])
      entries.push({
        entryId: `process:${process.processRef}${process.ownerId === null ? "" : `:${process.ownerId}`}`,
        category: process.ownerId === null ? ("world-process" as const) : ("body-process" as const),
      });
    return Object.freeze(entries.sort((left, right) => (left.entryId < right.entryId ? -1 : 1)));
  }

  private idle(state: Omit<SimulationState, "summary" | "runMode">): boolean {
    if (
      state.actions.some(
        (action) => action.status === "running" || action.status === "queued" || action.status === "waiting-world",
      )
    )
      return false;
    if (state.world.processes.length > 0) return false;
    for (const record of Object.values(state.body.bodies)) if (record.processes.length > 0) return false;
    return this.behaviourOwners().length === 0;
  }

  private bodyOwners(): readonly string[] {
    return this.characters.bodyOwners(this.current.characters);
  }

  private behaviourOwners(): readonly string[] {
    return this.characters.behaviorOwners(this.current.characters).map((character) => character.entityId);
  }

  private prerequisiteFor(world: WorldState, runtime: BodyRuntime): PrerequisiteCheck {
    return (action: ActionInstance) => {
      const actor = world.entities[action.entityId];
      if (actor === undefined) return { ok: false, reason: `${action.entityId} is not in the world` };
      const spec = this.body.actionSpecOf(action.action);
      if (spec === undefined) return { ok: false, reason: `unknown action ${action.action}` };
      if (spec.worldInfluence === "agentlife.demo/relocate") {
        const destination = action.destination;
        if (destination === null) return { ok: false, reason: "the move names no destination" };
        if (world.entities[destination]?.kind !== "location")
          return { ok: false, reason: `${destination} is not a place` };
        const from = actor.locatedAt;
        if (from !== null && from !== destination) {
          const exits = exitsOf(this.runtime.config, from);
          if (!exits.includes(destination)) return { ok: false, reason: `${destination} is not an exit of ${from}` };
        }
        return { ok: true };
      }
      if (spec.worldInfluence !== null && action.target !== null) {
        const target = world.entities[action.target];
        if (target === undefined) return { ok: false, reason: `${action.target} is not in the world` };
        if (target.kind !== "item") return { ok: false, reason: `${action.target} is not an item` };
      }
      void runtime;
      return { ok: true };
    };
  }

  private runRulesFor(
    config: RuntimeConfig,
    trigger: string,
    entityIds: readonly string[],
    world: WorldState,
    runtime: BodyRuntime,
    context: TickContext,
  ): { readonly run: RuleResult; readonly frameVersion: string } {
    const sources: ProjectionSources = {
      config,
      world,
      characters: this.current.characters,
      body: runtime.body,
    };
    const entities: Record<string, Record<string, unknown>> = {};
    for (const entityId of [...new Set(entityIds)].sort()) {
      const slice = entitySlice(sources, entityId, {
        activity: activityOf(runtime, entityId),
      });
      if (slice !== undefined) entities[entityId] = slice;
    }
    const version = stateVersionOf({ world, characters: this.current.characters, body: runtime.body });
    const run = this.runtime.runRules({
      runId: `${context.timelineId}/tick-${context.tick}/${trigger.replace(/[^a-z0-9]+/gi, "-")}`,
      trigger,
      entityIds: [...new Set(entityIds)].sort(),
      baseVersion: version,
      input: {
        stateVersion: version,
        simTime: { tick: context.tick, seconds: context.tick * this.settings.tickSeconds },
        shared: sharedSlice(sources),
        entities,
      },
    });
    return { run, frameVersion: version };
  }

  private commitBySystem(
    world: WorldState,
    runtime: BodyRuntime,
    context: TickContext,
    run: RuleResult,
    frameVersion: string,
  ): { world: WorldState; body: BodyRuntime; applied: readonly StateChangeRequest[] } {
    const origin = { actor: null, subject: null };
    const worldCommit = this.world.commit(
      world,
      { ...context, baseVersion: frameVersion },
      run.stateChanges.filter((change) => change.system === "agentlife.world"),
      run.processChanges.filter((change) => change.system === "agentlife.world"),
      { kind: "propagation", actor: null, subject: null },
    );
    const bodyCommit = this.body.commit(
      { body: runtime.body, actions: runtime.actions },
      context,
      run.stateChanges.filter((change) => change.system === "agentlife.body"),
      run.processChanges.filter((change) => change.system === "agentlife.body"),
      origin,
    );
    return {
      world: worldCommit.state,
      body: { body: bodyCommit.runtime.body, actions: bodyCommit.runtime.actions },
      applied: [...worldCommit.applied, ...bodyCommit.applied],
    };
  }

  /** Runs the behaviour trees that reached a decision point and accepts their plans. */
  private runBehaviourTrees(
    world: WorldState,
    runtime: BodyRuntime,
    context: TickContext,
  ): { runtime: BodyRuntime; notes: string[] } {
    const config = this.runtime.config;
    let body = runtime;
    const notes: string[] = [];
    for (const character of this.characters.behaviorOwners(this.current.characters)) {
      if (character.lifecycle !== "running") continue;
      if (this.holding(body, character.entityId)) continue;
      const tree = character.behaviourTree === null ? undefined : behaviourTreeSpec(config, character.behaviourTree);
      if (tree === undefined || character.localView === null) continue;
      const adapter = this.adapterFor(character.entityId, tree.ref, tree.definition, tree.blackboard);
      const state = adapter.exportState();
      if (context.tick < state.cooldownUntilTick) {
        notes.push(`${character.entityId} waits until tick ${state.cooldownUntilTick}`);
        continue;
      }
      const version = stateVersionOf({ world, characters: this.current.characters, body: body.body });
      const view = this.localView(world, body, character.entityId, character.localView);
      const decision = adapter.decide({
        tick: context.tick,
        key: `${character.entityId}/tick-${context.tick}`,
        view,
        inputVersion: version,
      });
      if (decision.status === "already-applied") {
        notes.push(`${character.entityId} already decided in tick ${context.tick}`);
        continue;
      }
      const steps: PlannedStep[] = decision.plan
        .map((entry) => plannedStep(entry))
        .filter((step): step is PlannedStep => step !== undefined);
      if (steps.length === 0) {
        notes.push(`${character.entityId} decided on no plan`);
        continue;
      }
      const plan: ActionPlan = {
        planId: `${character.entityId}/tick-${context.tick}`,
        entityId: character.entityId,
        source: "behaviour-tree",
        formedVersion: version,
        conflict: "queue",
        steps,
      };
      const acceptance = this.body.acceptPlan(
        body,
        this.current.characters,
        plan,
        context,
        this.prerequisiteFor(world, body),
      );
      body = acceptance.runtime;
      adapter.bindPlan(plan.planId, context.tick + tree.decisionCooldown);
      notes.push(
        `${character.entityId} planned ${steps.map((step) => step.action).join(" -> ")}: ${acceptance.outcome.status} (${acceptance.outcome.reason})`,
      );
    }
    return { runtime: body, notes };
  }

  private holding(runtime: BodyRuntime, entityId: string): boolean {
    return runtime.actions.some(
      (action) =>
        action.entityId === entityId &&
        (action.status === "running" || action.status === "queued" || action.status === "waiting-world"),
    );
  }

  private adapterFor(
    entityId: string,
    ref: string,
    definition: unknown,
    blackboard: Readonly<Record<string, unknown>>,
  ): BehaviorTreeAdapter {
    const existing = this.adapters.get(entityId);
    if (existing !== undefined) return existing;
    const options = {
      definition,
      registry: behaviorFunctionRegistry(),
      tickSeconds: this.settings.tickSeconds,
      view: {},
    } as const;
    const saved = this.current.behaviours[entityId];
    const adapter =
      saved === undefined
        ? BehaviorTreeAdapter.create(options)
        : BehaviorTreeAdapter.restore(options, {
            ...saved,
            blackboard: { ...blackboard, ...saved.blackboard } as never,
          });
    void ref;
    this.adapters.set(entityId, adapter);
    return adapter;
  }

  /** The declared local view of one entity, filled from the authoritative state. */
  private localView(
    world: WorldState,
    runtime: BodyRuntime,
    entityId: string,
    localViewRef: string,
  ): Readonly<Record<string, JsonValue>> {
    const config = this.runtime.config;
    const entity = world.entities[entityId];
    const record = runtime.body.bodies[entityId];
    const activity = activityOf(runtime, entityId);
    const view: Record<string, JsonValue> = {};
    for (const member of localViewMembers(config, localViewRef)) {
      const separator = member.lastIndexOf(".");
      if (separator <= 0) continue;
      const viewRef = member.slice(0, separator);
      const field = member.slice(separator + 1);
      let container: Readonly<Record<string, unknown>> | undefined;
      if (viewRef === WORLD_FACTS) container = world.environment;
      else if (viewRef === WORLD_ATTRIBUTES) container = entity?.attributes;
      else if (viewRef === BODY_VALUES) container = record?.values;
      else if (viewRef === BODY_CHANNELS) container = record?.channels;
      else if (viewRef === BODY_PARTICIPATION) container = { permission: record?.participation ?? "" };
      else if (viewRef === BODY_MODE) container = { mode: record?.mode ?? "" };
      else if (viewRef === BODY_ACTIVITY) container = activity;
      else if (viewRef === "agentlife.world/located-at") container = { location: entity?.locatedAt ?? "" };
      else if (viewRef === "agentlife.world/held-by") container = { holder: entity?.heldBy ?? "" };
      else if (viewRef === "agentlife.world/placed-on") container = { support: entity?.placedOn ?? "" };
      const value = container?.[field];
      if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") view[member] = value;
      else if (typeof value === "object" && value !== null) view[member] = value as never;
    }
    return Object.freeze(view);
  }

  /**
   * Deterministic propagation: only the rules the changed state selected run, in
   * stable order, each round based on the previous committed state, until the
   * objective state stops changing.
   */
  private propagate(
    world: WorldState,
    runtime: BodyRuntime,
    context: TickContext,
    changedRefs: readonly string[],
  ): {
    world: WorldState;
    body: BodyRuntime;
    rounds: number;
    triggers: readonly string[];
    notes: readonly string[];
    exceeded: boolean;
    barrier?: RuleBarrier;
  } {
    let currentWorld = world;
    let currentBody = runtime;
    let pending = this.triggersFor(changedRefs);
    const triggers: string[] = [];
    const notes: string[] = [];
    let rounds = 0;
    while (pending.size > 0) {
      const missing = [...pending].filter((trigger) => (this.runtime.config.triggerIndex[trigger] ?? []).length === 0);
      if (missing.length > 0) {
        const trigger = missing.sort()[0] as string;
        return {
          world: currentWorld,
          body: currentBody,
          rounds,
          triggers,
          notes,
          exceeded: false,
          barrier: {
            kind: "missing-rules",
            tick: context.tick,
            trigger,
            stateRef: changedRefs.find((ref) => this.triggersFor([ref]).has(trigger)) ?? "",
            detail: `no compiled rule is indexed for ${trigger}; phase 2 records the barrier instead of asking a model`,
          },
        };
      }
      if (rounds >= this.settings.maxPropagationRounds)
        return { world: currentWorld, body: currentBody, rounds, triggers, notes, exceeded: true };
      rounds += 1;
      const changed: StateChangeRequest[] = [];
      for (const trigger of [...pending].sort()) {
        triggers.push(trigger);
        const { run, frameVersion } = this.runRulesFor(
          this.runtime.config,
          trigger,
          this.propagationEntities(),
          currentWorld,
          currentBody,
          context,
        );
        const committed = this.commitBySystem(
          currentWorld,
          currentBody,
          { ...context, command: `propagate/${trigger}` },
          run,
          frameVersion,
        );
        currentWorld = committed.world;
        currentBody = committed.body;
        changed.push(...committed.applied);
        notes.push(
          `${trigger}: ${committed.applied.length} applied, ${run.trace.stateChanges.length - committed.applied.length} unchanged or refused`,
        );
      }
      pending = this.triggersFor(changed.map((change) => change.stateRef));
    }
    return { world: currentWorld, body: currentBody, rounds, triggers, notes, exceeded: false };
  }

  private triggersFor(stateRefs: readonly string[]): Set<string> {
    const triggers = new Set<string>();
    for (const stateRef of stateRefs) {
      const entry = this.systemIndex.propagationTrigger(stateRef);
      if (entry !== undefined) triggers.add(entry.trigger);
    }
    return triggers;
  }

  /** Entities a propagation round evaluates: every body owner, in stable order. */
  private propagationEntities(): readonly string[] {
    return this.bodyOwners();
  }
}

function activityOf(runtime: BodyRuntime, entityId: string): { action: string; stage: string; status: string } {
  const action = runtime.actions.find(
    (candidate) =>
      candidate.entityId === entityId &&
      (candidate.status === "running" || candidate.status === "waiting-world" || candidate.status === "queued"),
  );
  if (action === undefined) return IDLE_ACTIVITY;
  const spec = action.action;
  return { action: spec, stage: String(action.stageIndex), status: action.status };
}

function exitsOf(config: RuntimeConfig, locationRef: string): readonly string[] {
  const item = config.items.find((candidate) => candidate.ref === locationRef);
  const exits = item?.values["exits"];
  return Array.isArray(exits) ? exits.filter((entry): entry is string => typeof entry === "string") : [];
}

export { TICK_STAGES, IDLE_ACTIVITY, stageSummary };

function stageSummary(stages: readonly StageRecord[]): string {
  return stages.map((stage) => `${stage.stage}:${stage.status}`).join(" ");
}

export type { SimpleValue, ProcessChangeRequest };
