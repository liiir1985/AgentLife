import { BehaviorTreeAdapter, type JsonValue } from "../behavior/behavior-tree-adapter.js";
import { behaviorFunctionRegistry, plannedStep, type PlannedStep } from "../behavior/behavior-functions.js";
import type { RuntimeConfig } from "../config/config-builder.js";
import type { CoreRuntime } from "../config/core-runtime.js";
import type { ProcessChangeRequest, RuleResult, StateChangeRequest } from "../config/rule-engine.js";
import type { SystemIndex } from "../config/system-index.js";
import type { SimpleValue } from "../config/value-expr.js";
import type { CognitionModelPort } from "../agent/cognition-agent.js";
import type { SessionTrace } from "../diagnostics/session-trace.js";
import { BodyService, type BodyRuntime } from "./body-service.js";
import { CharacterService } from "./character-service.js";
import { CognitionCoordinator, type DecisionResult, type RoundInput } from "./cognition-coordinator.js";
import { CognitionService } from "./cognition-service.js";
import {
  BODY_ACTIVITY,
  BODY_CHANNELS,
  BODY_MODE,
  BODY_PARTICIPATION,
  BODY_VALUES,
  WORLD_ATTRIBUTES,
  WORLD_FACTS,
  actionUtteranceField,
  behaviourTreeSpec,
  characterModules,
  cognitionSettings,
  itemLabel,
  localViewMembers,
} from "./config-view.js";
import { WorkingMemoryService } from "./memory-service.js";
import { PerceptionService, type PerceptionFrame } from "./perception-service.js";
import { IDLE_ACTIVITY, entitySlice, sharedSlice, type ProjectionSources } from "./projection.js";
import {
  TICK_STAGES,
  stateVersionOf,
  type ActionInstance,
  type ActionPlan,
  type ActivityState,
  type CharacterState,
  type CognitionDemand,
  type CognitionRound,
  type CognitionState,
  type InfluenceOutcome,
  type Observation,
  type PerceptionState,
  type RuleBarrier,
  type RunMode,
  type SimulationSettings,
  type SimulationState,
  type StageRecord,
  type TickFailure,
  type TickSummary,
  type WorkingMemoryEntry,
  type WorkingMemoryState,
  type WorldState,
} from "./types.js";
import { WorldService, type ServiceRuntime, type TickContext } from "./world-service.js";

/**
 * The simulation runner: the only owner of the clock, the tick and the
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

/**
 * One tick either completed, stopped on a missing rule set, stopped for cognition,
 * or failed. A cognitive barrier is not a failure: the tick is held exactly where
 * it is until every participant settled, and only then is it published.
 */
export type TickResult =
  | { readonly status: "completed"; readonly summary: TickSummary }
  | { readonly status: "rule-barrier"; readonly summary: TickSummary; readonly barrier: RuleBarrier }
  | { readonly status: "cognitive-barrier"; readonly round: CognitionRound }
  | { readonly status: "failed"; readonly summary: TickSummary; readonly failure: TickFailure };

export interface RunnerOptions {
  readonly timelineId: string;
  readonly settings?: Partial<SimulationSettings>;
  /** The cognition model the AI participants are decided with; required once an AI entity exists. */
  readonly models?: CognitionModelPort;
  readonly trace?: SessionTrace;
}

const DEFAULT_SETTINGS: SimulationSettings = Object.freeze({
  tickSeconds: 1,
  maxPropagationRounds: 8,
  maxEvents: 256,
});

/**
 * The port a timeline without any AI role is built with. Such a timeline never
 * opens a round for a model, so the port is unreachable there; a timeline that
 * does run AI cognition without a model is refused when it is constructed.
 */
const NO_MODEL_PORT: CognitionModelPort = Object.freeze({
  request: () =>
    Promise.resolve({ status: "failed" as const, detail: "this timeline runs no AI cognition", decision: null }),
  cancel: () => {},
});

function requireModels(
  options: RunnerOptions,
  characters: CharacterService,
  state: CharacterState,
): CognitionModelPort {
  if (options.models !== undefined) return options.models;
  const ai = characters.sorted(state).filter((character) => character.control === "cognition");
  if (ai.length > 0)
    throw new Error(
      `timeline runs ${ai.length} AI cognition role(s) (${ai.map((character) => character.entityId).join(", ")}) but no cognition model was given`,
    );
  return NO_MODEL_PORT;
}

/** Everything a barrier holds while its participants are deciding. */
interface HeldTick {
  readonly startingTick: number;
  /** The published state the held tick started from, restored when it fails. */
  readonly previous: SimulationState;
  readonly world: WorldState;
  readonly characters: CharacterState;
  readonly body: BodyRuntime;
  readonly perception: PerceptionState;
  readonly memory: WorkingMemoryState;
  readonly cognition: CognitionState;
  readonly stages: StageRecord[];
  readonly actionOutcomes: string[];
  readonly influenceOutcomes: readonly InfluenceOutcome[];
  readonly barrier: RuleBarrier | null;
  readonly failure: TickFailure | null;
  readonly scheduled: ActivityState["scheduled"];
}

export class SimulationRunner {
  private readonly runtime: ServiceRuntime;
  private readonly settings: SimulationSettings;
  private readonly adapters = new Map<string, BehaviorTreeAdapter>();
  private readonly perception: PerceptionService;
  private readonly workingMemory = new WorkingMemoryService();
  private readonly cognition: CognitionService;
  private readonly rounds: CognitionCoordinator;
  private held: HeldTick | undefined;
  private roundSequence = 0;
  private readonly trace: SessionTrace | undefined;
  private current: SimulationState;

  constructor(
    private readonly core: CoreRuntime,
    readonly characters: CharacterService,
    readonly world: WorldService,
    readonly body: BodyService,
    options: RunnerOptions,
    private readonly systemIndex: SystemIndex,
  ) {
    const config = this.requireConfig();
    this.trace = options.trace;
    this.settings = Object.freeze({ ...DEFAULT_SETTINGS, ...(options.settings ?? {}) });
    this.runtime = {
      config,
      systemIndex,
      runRules: (request) => this.core.runRules(request),
    };
    this.perception = new PerceptionService(config);
    this.cognition = new CognitionService(config);
    const characterState = characters.initialize();
    this.rounds = new CognitionCoordinator(
      config,
      this.cognition,
      requireModels(options, characters, characterState),
      this.trace,
    );
    const worldState = world.initialize(
      characters.sorted(characterState).map((character) => ({
        entityId: character.entityId,
        homeLocation: character.homeLocation,
      })),
    );
    const bodyState = body.initialize(characterState);
    const observerIds = this.observerIds(characterState);
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
      perception: this.perception.create(observerIds),
      memory: this.workingMemory.create(observerIds),
      cognition: this.cognition.create(this.cognitionIds(characterState)),
      round: null,
      behaviours: Object.freeze({}),
      activity: this.initialActivity(characterState),
      actions: Object.freeze([]),
      barrier: null,
      failure: null,
      summary: null,
    });
  }

  static create(core: CoreRuntime, options: RunnerOptions): SimulationRunner {
    const config = core.current();
    if (config === undefined) throw new Error("No runtime config is published");
    const systemIndex = core.systemIndex();
    const settings = Object.freeze({ ...DEFAULT_SETTINGS, ...(options.settings ?? {}) });
    const characters = new CharacterService(config);
    const world = new WorldService({ config, systemIndex, runRules: (request) => core.runRules(request) }, settings);
    const body = new BodyService({ config, systemIndex, runRules: (request) => core.runRules(request) }, world);
    return new SimulationRunner(core, characters, world, body, options, systemIndex);
  }

  /** Entities that keep a perception instance: normal entities with a body. */
  private observerIds(state: CharacterState): readonly string[] {
    const config = this.runtime.config;
    return this.characters
      .sorted(state)
      .filter(
        (character) =>
          character.bodyConfig !== null && characterModules(config, character.entityId).includes("perception"),
      )
      .map((character) => character.entityId);
  }

  /** Entities that keep cognition state: every AI and user controlled role. */
  private cognitionIds(state: CharacterState): readonly string[] {
    return this.characters
      .sorted(state)
      .filter((character) => character.control === "cognition" || character.control === "user")
      .map((character) => character.entityId);
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
    if (this.held !== undefined)
      throw new Error("a cognition barrier holds this tick; complete it before running another tick");
    const config = this.requireConfig();
    const stages: StageRecord[] = [];
    const startingTick = this.current.tick + 1;
    this.trace?.startTurn(this.current.timelineId, startingTick);
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
      const attempt = this.body.acceptPlan(bodyRuntime, this.current.characters, plan, world, context);
      bodyRuntime = attempt.runtime;
      actionOutcomes.push(`${attempt.outcome.status} ${plan.planId}: ${attempt.outcome.reason}`);
      this.trace?.record("plan-acceptance", { plan, outcome: attempt.outcome }, { entityId: plan.entityId });
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
    const advanced = this.body.advance(bodyRuntime, sourcesFor(), this.current.characters, context);
    this.trace?.record("advance-result", {
      worldProcesses: worldProcesses.advanced,
      worldChanges: worldProcesses.applied,
      bodyChanges: advanced.applied,
      actionNotes: advanced.notes,
    });
    bodyRuntime = advanced.runtime;
    actionOutcomes.push(...advanced.notes);
    // Only an action that finished every stage it declares becomes audible: what a
    // body refused, interrupted or is still speaking is never a world utterance.
    for (const utterance of this.completedUtterances(this.current.actions, bodyRuntime.actions))
      world = this.world.recordUtterance(world, utterance, context);
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
    this.trace?.record("behaviour-result", { notes: decisions.notes });
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
      this.trace?.record(
        "world-adjudication",
        { request, outcome: adjudication.outcome, applied: adjudication.applied },
        { entityId: action.entityId },
      );
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
    this.trace?.record("propagation-result", {
      rounds: propagation.rounds,
      triggers: propagation.triggers,
      notes: propagation.notes,
      barrier: propagation.barrier ?? null,
      exceeded: propagation.exceeded,
    });
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

    // 8. Perception: every observer receives the material of this tick and commits
    //    the observations the conditions allow.
    let perceptionState = this.current.perception;
    let memoryState = this.current.memory;
    let cognitionState = this.current.cognition;
    const observers = this.observerIds(this.current.characters);
    const admitted: Record<string, readonly Observation[]> = {};
    if (!stageTruncated) {
      const materialVersion = `${world.version}/${bodyRuntime.body.version}/${startingTick}`;
      const notes: string[] = [];
      for (const observer of observers) {
        const frame: PerceptionFrame = {
          observer,
          tick: startingTick,
          materialVersion,
          attention: this.cognition.record(cognitionState, observer)?.attention ?? [],
          world: this.world.perceptionMaterial(world, observer, startingTick, this.current.world.environment),
          body: this.body.perceptionMaterial(bodyRuntime, this.current.actions, observer),
        };
        const result = this.perception.observe(perceptionState, frame);
        perceptionState = result.state;
        this.trace?.record(
          "perception-result",
          {
            material: frame,
            observations: result.observations,
            notes: result.notes,
            pending: result.state.observers[observer]?.pending ?? [],
          },
          { entityId: observer },
        );
        notes.push(...result.notes.map((note) => `${observer}: ${note}`));
      }
      stages.push({
        stage: "perception",
        status: observers.length === 0 ? "no-op" : "done",
        detail:
          observers.length === 0
            ? "no entity keeps a perception instance"
            : `${observers.length} observer(s): ${notes.filter((note) => note.includes("submitted")).join("; ")}`,
      });

      // 9. Admission and demands: what was perceived enters Working Memory before
      //    anyone is asked to think about it.
      for (const observer of observers) {
        const admittedNow = this.perception.pendingObservations(perceptionState, observer);
        const previousEntries = this.workingMemory.contextFor(memoryState, observer);
        const result = this.workingMemory.admitObservations(memoryState, {
          characterId: observer,
          tick: startingTick,
          capacity: cognitionSettings(config)?.observationCapacity ?? 0,
          observations: admittedNow,
          references: this.perception.observer(perceptionState, observer)?.references ?? {},
        });
        memoryState = result.state;
        const retained = new Set(this.workingMemory.contextFor(memoryState, observer).map((entry) => entry.sourceId));
        const evictedObservations = admittedNow
          .filter((observation) => !retained.has(observation.observationId))
          .map((observation) => observation.observationId);
        evictedObservations.push(
          ...previousEntries.filter((entry) => result.evicted.includes(entry.entryId)).map((entry) => entry.sourceId),
        );
        // Capacity drops are final. Leaving them in perception.pending would
        // reintroduce the same old observations on every following tick.
        perceptionState = this.perception.confirmConsumed(perceptionState, observer, evictedObservations);
        this.trace?.record(
          "memory-admission",
          {
            offered: admittedNow,
            admitted: result.admitted,
            evicted: result.evicted,
            discardedObservations: evictedObservations,
            notes: result.notes,
          },
          { entityId: observer },
        );
        admitted[observer] = Object.freeze(
          admittedNow.filter((observation) =>
            result.admitted.some((entry) => entry.sourceId === observation.observationId),
          ),
        );
      }
    }

    const demands: readonly CognitionDemand[] = stageTruncated
      ? []
      : this.cognition.demands({
          tick: startingTick,
          cognition: cognitionState,
          characters: this.current.characters.characters,
          participation: this.participationOf(bodyRuntime),
          admitted,
        });
    this.trace?.record("cognitive-demands", { demands });
    stages.push({
      stage: "cognitive-demand",
      status: demands.length === 0 ? "no-op" : "done",
      detail:
        demands.length === 0
          ? "no entity owes a decision"
          : demands.map((demand) => `${demand.characterId}: ${demand.reason} (${demand.detail})`).join("; "),
    });

    // 10. The barrier: the tick is held exactly where it is while its participants
    //     decide, and nothing simulated advances until every one of them settled.
    if (demands.length > 0 && !stageTruncated) {
      this.roundSequence += 1;
      const entries: Record<string, readonly WorkingMemoryEntry[]> = {};
      const situations: Record<string, string> = {};
      const demanded = new Set(demands.map((demand) => demand.characterId));
      // A user-controlled entity may join the round while the barrier is open, so
      // every entity that keeps Working Memory belongs to the fixed barrier snapshot
      // of this tick, not only the ones that owe a decision right now.
      for (const characterId of Object.keys(memoryState.records).sort()) {
        if (!demanded.has(characterId) && this.current.characters.characters[characterId]?.control !== "user") continue;
        entries[characterId] = this.workingMemory.contextFor(memoryState, characterId);
        situations[characterId] = this.situationOf(characterId, world, bodyRuntime, startingTick);
      }
      const input: RoundInput = {
        roundId: `${this.current.timelineId}/tick-${startingTick}/round-${this.roundSequence}`,
        tick: startingTick,
        stateVersion: stateVersionOf({ world, characters: this.current.characters, body: bodyRuntime.body }),
        demands,
        participants: demands.map((demand) => ({ characterId: demand.characterId, control: "cognition" as const })),
        admitted,
        entries,
        situations,
        cognition: cognitionState,
      };
      const round = this.rounds.openRound(input);
      this.trace?.record("cognitive-barrier", { round, situations, entries }, { roundId: round.roundId });
      stages.push({
        stage: "cognitive-barrier",
        status: "done",
        detail: `${round.participants.length} participant(s) deciding at round ${round.roundId}`,
      });
      this.held = {
        startingTick,
        previous: this.current,
        world,
        characters: this.current.characters,
        body: bodyRuntime,
        perception: perceptionState,
        memory: memoryState,
        cognition: cognitionState,
        stages,
        actionOutcomes,
        influenceOutcomes,
        barrier,
        failure,
        scheduled,
      };
      this.current = Object.freeze({
        timelineId: this.current.timelineId,
        tick: startingTick,
        simTime: { tick: startingTick, seconds: startingTick * this.settings.tickSeconds },
        phase: "cognitive-barrier" as const,
        configId: config.configId,
        runMode: "barrier" as RunMode,
        settings: this.settings,
        world,
        characters: this.current.characters,
        body: bodyRuntime.body,
        perception: perceptionState,
        memory: memoryState,
        cognition: cognitionState,
        round,
        behaviours: Object.freeze(this.behaviourStates()),
        activity: { active: this.activityEntries(), scheduled },
        actions: bodyRuntime.actions,
        barrier,
        failure: null,
        summary: null,
      });
      for (const stage of stages) this.trace?.record("stage", stage);
      return { status: "cognitive-barrier", round };
    }
    stages.push({ stage: "cognitive-barrier", status: "no-op", detail: "no barrier was needed" });
    stages.push({ stage: "memory", status: "no-op", detail: "nothing was consumed" });

    // 12. Publish the new stable state and the tick summary.
    return this.publish({
      startingTick,
      world,
      characters: this.current.characters,
      body: bodyRuntime,
      perception: perceptionState,
      memory: memoryState,
      cognition: cognitionState,
      stages,
      actionOutcomes,
      influenceOutcomes,
      barrier,
      failure,
      scheduled,
      stageTruncated,
    });
  }

  /** Finishes the held tick: consumption, intention maintenance and the batch handoff. */
  completeCognition(): TickResult | null {
    const held = this.held;
    if (held === undefined) return null;
    const resolution = this.rounds.resolution();
    if (resolution === null) return null;
    const stages = [...held.stages];
    const actionOutcomes = [...held.actionOutcomes];
    if (resolution.round.status === "failed") {
      const failure: TickFailure = {
        stage: "cognitive-barrier",
        code: "cognition-failed",
        detail: resolution.round.failure ?? "a participant submitted no usable decision",
      };
      this.rounds.close(failure.detail);
      this.held = undefined;
      // A tick that could not be decided is not published: the objective state stays
      // exactly where the barrier found it, and only the failure becomes visible.
      const failed = this.publishFailed(held, failure, resolution.round);
      this.trace?.record("stage", { stage: "cognitive-barrier", status: "failed", detail: failure.detail });
      this.trace?.finishTurn("failed", { failure, summary: failed });
      return { status: "failed", summary: failed, failure };
    }

    // 11. Consumption confirmation and intention maintenance, in entity identity order.
    let cognitionState = held.cognition;
    let memoryState = held.memory;
    let perceptionState = held.perception;
    for (const decision of resolution.decisions) {
      const applied = this.cognition.applyDecision(cognitionState, {
        characterId: decision.characterId,
        tick: held.startingTick,
        decision,
      });
      cognitionState = applied.state;
      this.trace?.record(
        "cognitive-decision",
        { decision, notes: applied.notes },
        { entityId: decision.characterId, requestId: decision.requestId, roundId: resolution.round.roundId },
      );
    }
    for (const [characterId, references] of Object.entries(resolution.consumptions)) {
      const entries = this.workingMemory.contextFor(memoryState, characterId);
      const acknowledgedEvents = new Set(
        this.perception
          .pendingObservations(perceptionState, characterId)
          .filter((observation) => observation.kind === "event" || observation.kind === "outcome")
          .map((observation) => observation.observationId),
      );
      const entryIds = [
        ...new Set([
          ...this.cognition.usedEntries(entries, references),
          ...entries.filter((entry) => acknowledgedEvents.has(entry.sourceId)).map((entry) => entry.entryId),
        ]),
      ];
      const confirmed = this.workingMemory.confirmUsage(memoryState, { characterId, entryIds });
      memoryState = confirmed.state;
      const observationIds = confirmed.confirmed
        .map((entryId) => entries.find((entry) => entry.entryId === entryId)?.sourceId)
        .filter((sourceId): sourceId is string => sourceId !== undefined);
      perceptionState = this.perception.confirmConsumed(perceptionState, characterId, observationIds);
      this.trace?.record(
        "memory-consumption",
        { references, confirmed: confirmed.confirmed, observationIds },
        { entityId: characterId, roundId: resolution.round.roundId },
      );
    }
    stages.push({
      stage: "memory",
      status: resolution.decisions.length === 0 && Object.keys(resolution.consumptions).length === 0 ? "no-op" : "done",
      detail: `${resolution.decisions.length} decision(s), ${resolution.plans.length} plan(s), ${Object.keys(resolution.consumptions).length} consumption(s)`,
    });

    // 12. The batch handoff: every plan of the round reaches the same body validation.
    let bodyRuntime = held.body;
    for (const plan of resolution.plans) {
      const attempt = this.body.acceptPlan(bodyRuntime, held.characters, plan, held.world, {
        timelineId: this.current.timelineId,
        tick: held.startingTick,
        command: `cognition/${plan.planId}`,
      });
      bodyRuntime = attempt.runtime;
      actionOutcomes.push(`${attempt.outcome.status} ${plan.planId}: ${attempt.outcome.reason}`);
      this.trace?.record(
        "plan-acceptance",
        { plan, outcome: attempt.outcome },
        { entityId: plan.entityId, roundId: resolution.round.roundId },
      );
    }
    this.rounds.close();
    this.held = undefined;
    return this.publish({
      startingTick: held.startingTick,
      world: held.world,
      characters: held.characters,
      body: bodyRuntime,
      perception: perceptionState,
      memory: memoryState,
      cognition: cognitionState,
      stages,
      actionOutcomes,
      influenceOutcomes: held.influenceOutcomes,
      barrier: held.barrier,
      failure: held.failure,
      scheduled: held.scheduled,
      stageTruncated: false,
      round: resolution.round,
      recordedStages: held.stages.length,
    });
  }

  /** Runs every AI participant of the open barrier; the player answers through its own input. */
  async resolveCognition(): Promise<CognitionRound | undefined> {
    if (this.held === undefined) return undefined;
    return this.rounds.resolveAiParticipants();
  }

  /**
   * Runs one tick and, when it stopped for cognition, lets every AI participant
   * decide before publishing it. A barrier that still waits for the player is
   * returned as it is, so the caller can submit the player's own decision.
   */
  async runTickToPublication(input: TickInput = {}): Promise<TickResult> {
    const result = this.runTick(input);
    if (result.status !== "cognitive-barrier") return result;
    await this.resolveCognition();
    return this.completeCognition() ?? result;
  }

  /** The plan the player chose while the barrier is open joins this round. */
  submitPlayerPlan(plan: ActionPlan): DecisionResult {
    const control = this.current.characters.characters[plan.entityId]?.control;
    if (control === undefined) return { ok: false, message: `未知角色 ${plan.entityId}` };
    const allowed = Object.values(this.perception.observer(this.current.perception, plan.entityId)?.subjects ?? {}).map(
      (subject) => subject.anchor,
    );
    const consumed = plan.steps
      .flatMap((step) => [step.target, step.destination])
      .filter((anchor): anchor is string => anchor !== undefined)
      .map((anchor) => this.perception.referenceFor(this.current.perception, plan.entityId, anchor))
      .filter((reference): reference is string => reference !== undefined);
    return this.rounds.submitPlayerPlan(
      { characterId: plan.entityId, control: control === "user" ? "user" : "cognition" },
      plan,
      [...new Set(consumed)],
      allowed,
    );
  }

  /** The player declines to act in this round. */
  skipPlayer(characterId: string): DecisionResult {
    const control = this.current.characters.characters[characterId]?.control;
    if (control === undefined) return { ok: false, message: `未知角色 ${characterId}` };
    return this.rounds.skipPlayer({ characterId, control: control === "user" ? "user" : "cognition" });
  }

  /** The round currently holding the tick, for status and diagnostics. */
  openRound(): CognitionRound | null {
    return this.rounds.current() ?? null;
  }

  /** Model requests, refusals and outcomes of the most recent round. */
  roundNotes(): readonly string[] {
    return this.rounds.notes();
  }

  /** One readable frame per participant: where it is and what it is doing. */
  private situationOf(characterId: string, world: WorldState, runtime: BodyRuntime, tick: number): string {
    const place = this.world.position(world, characterId);
    const activity = activityOf(runtime, characterId);
    const parts = [
      `当前为第 ${tick} Tick，模拟时间 ${tick * this.settings.tickSeconds} 秒`,
      place === null ? "你还不知道自己在哪里" : `你在${itemLabel(this.config, place)}`,
    ];
    if (activity.action !== "")
      parts.push(`当前动作：${itemLabel(this.config, activity.action)}（${activity.status}）`);
    return `${parts.join("；")}。`;
  }

  private get config(): RuntimeConfig {
    return this.runtime.config;
  }

  /** Body participation per entity, so a body that forbids cognition is never asked. */
  private participationOf(runtime: BodyRuntime): Readonly<Record<string, string>> {
    const participation: Record<string, string> = {};
    for (const [entityId, record] of Object.entries(runtime.body.bodies))
      participation[entityId] = record.participation;
    return participation;
  }

  /** Actions that finished their last stage in this tick and declare an utterance. */
  private completedUtterances(
    previous: readonly ActionInstance[],
    next: readonly ActionInstance[],
  ): readonly { readonly actor: string; readonly text: string }[] {
    const before = new Map(previous.map((action) => [action.actionId, action.status]));
    const spoken: { readonly actor: string; readonly text: string }[] = [];
    for (const action of [...next].sort((left, right) => left.actionId.localeCompare(right.actionId))) {
      if (action.status !== "completed" || before.get(action.actionId) === "completed") continue;
      const field = actionUtteranceField(this.config, action.action);
      if (field === null) continue;
      const inputs = action.plan.steps[action.stepIndex]?.inputs ?? action.plan.steps[0]?.inputs;
      const text = inputs?.[field];
      if (text === undefined) continue;
      spoken.push(Object.freeze({ actor: action.entityId, text }));
    }
    return Object.freeze(spoken);
  }

  /** Records a failed barrier without moving the objective state. */
  private publishFailed(held: HeldTick, failure: TickFailure, round: CognitionRound): TickSummary {
    const config = this.requireConfig();
    const summary: TickSummary = Object.freeze({
      tick: held.previous.tick,
      stages: Object.freeze([
        ...held.stages,
        { stage: "cognitive-barrier" as const, status: "failed" as const, detail: failure.detail },
      ]),
      stateVersion: stateVersionOf(held.previous),
      actionOutcomes: Object.freeze([...held.actionOutcomes]),
      influenceOutcomes: Object.freeze([...held.influenceOutcomes]),
      eventCount: held.previous.world.events.length,
      observations: 0,
      cognition: failure.detail,
    });
    this.current = Object.freeze({
      ...held.previous,
      phase: "cognitive-barrier" as const,
      runMode: "failed" as RunMode,
      failure,
      round,
      summary,
      configId: config.configId,
    });
    return summary;
  }

  /** Publishes one finished tick and returns the matching result. */
  private publish(
    held: Omit<HeldTick, "previous"> & {
      readonly stageTruncated: boolean;
      readonly round?: CognitionRound;
      readonly recordedStages?: number;
    },
  ): TickResult {
    const config = this.requireConfig();
    const stages = [...held.stages];
    const nextTick = held.stageTruncated ? this.current.tick : held.startingTick;
    const nextPhase = held.stageTruncated ? "stability" : "publish";
    const nextState: Omit<SimulationState, "summary" | "runMode"> = {
      timelineId: this.current.timelineId,
      tick: nextTick,
      simTime: { tick: nextTick, seconds: nextTick * this.settings.tickSeconds },
      phase: nextPhase,
      configId: config.configId,
      settings: this.settings,
      world: held.world,
      characters: held.characters,
      body: held.body.body,
      perception: held.perception,
      memory: held.memory,
      cognition: held.cognition,
      // A published tick keeps no open round: what the round decided is recorded in
      // the summary and in the diagnostics, and only a failed barrier leaves one.
      round: null,
      behaviours: Object.freeze(this.behaviourStates()),
      activity: { active: this.activityEntries(), scheduled: held.scheduled },
      actions: held.body.actions,
      barrier: held.barrier,
      failure: held.failure,
    };
    const runMode: RunMode =
      held.failure !== null
        ? "failed"
        : held.barrier !== null
          ? "barrier"
          : this.idle(nextState)
            ? "idle"
            : "single-step";
    stages.push({
      stage: "publish",
      status: "done",
      detail: `${runMode} at tick ${nextTick}, ${held.world.events.length} objective event(s)`,
    });
    const summary = Object.freeze({
      tick: nextTick,
      stages: Object.freeze(stages),
      stateVersion: stateVersionOf(nextState),
      actionOutcomes: Object.freeze(held.actionOutcomes),
      influenceOutcomes: Object.freeze(held.influenceOutcomes),
      eventCount: held.world.events.length,
      observations: Object.values(held.perception.observers).reduce(
        (total, observer) => total + observer.pending.length,
        0,
      ),
      cognition:
        held.round === undefined
          ? null
          : `${held.round.roundId} ${held.round.status}: ${held.round.participants.map((participant) => `${participant.characterId}=${participant.state}`).join(", ")}`,
    });
    this.current = Object.freeze({ ...nextState, runMode, summary });
    for (const stage of stages.slice(held.recordedStages ?? 0)) this.trace?.record("stage", stage);
    this.trace?.finishTurn(held.failure !== null ? "failed" : held.barrier !== null ? "rule-barrier" : "completed", {
      summary,
      failure: held.failure,
      barrier: held.barrier,
    });
    if (held.failure !== null) return { status: "failed", summary, failure: held.failure };
    if (held.barrier !== null) return { status: "rule-barrier", summary, barrier: held.barrier };
    return { status: "completed", summary };
  }

  /** Restores a saved state after checking it belongs to the published config. */
  load(state: SimulationState): void {
    const config = this.requireConfig();
    if (state.configId !== config.configId)
      throw new Error(`save refers to config ${state.configId}, the runtime publishes ${config.configId}`);
    // A loaded timeline keeps nothing from the one it replaces: in-flight model
    // requests, an held barrier and every adapter belong to the old timeline.
    this.rounds.cancelAll();
    this.held = undefined;
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
      const acceptance = this.body.acceptPlan(body, this.current.characters, plan, world, context);
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

export { TICK_STAGES, IDLE_ACTIVITY, stageSummary };

function stageSummary(stages: readonly StageRecord[]): string {
  return stages.map((stage) => `${stage.stage}:${stage.status}`).join(" ");
}

export type { SimpleValue, ProcessChangeRequest };
