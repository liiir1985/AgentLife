import type { BehaviorRuntimeState } from "../behavior/behavior-tree-adapter.js";
import type { StateChangeRequest } from "../config/rule-engine.js";
import type { SimpleValue, SimTime } from "../config/value-expr.js";

/**
 * The authoritative runtime model of one simulation.
 *
 * `SimulationState` is the single in-process authority: every service state is a
 * plain immutable record inside it, so a tick ends by publishing one new state
 * and an explicit save is a copy of exactly that value. Nothing here is a
 * presentation summary, and nothing here can be written by a rule directly.
 */

/** The twelve stages of one tick, in execution order. */
export type TickStage =
  | "fixed"
  | "clock"
  | "advance"
  | "decide"
  | "adjudicate"
  | "propagate"
  | "stability"
  | "perception"
  | "cognitive-demand"
  | "cognitive-barrier"
  | "memory"
  | "publish";

export const TICK_STAGES: readonly TickStage[] = [
  "fixed",
  "clock",
  "advance",
  "decide",
  "adjudicate",
  "propagate",
  "stability",
  "perception",
  "cognitive-demand",
  "cognitive-barrier",
  "memory",
  "publish",
];

/** Stages phase 2 records as an explicit no-op. */
export const NO_OP_STAGES: readonly TickStage[] = ["perception", "cognitive-demand", "cognitive-barrier", "memory"];

export type RunMode = "single-step" | "continuous" | "fast-forward" | "barrier" | "paused" | "idle" | "failed";

export type StageStatus = "done" | "no-op" | "failed";

export interface StageRecord {
  readonly stage: TickStage;
  readonly status: StageStatus;
  readonly detail: string;
}

/** Bounded, deterministic simulation settings carried with the state. */
export interface SimulationSettings {
  /** Simulated seconds one tick advances. */
  readonly tickSeconds: number;
  /** Rounds of deterministic propagation one tick may run. */
  readonly maxPropagationRounds: number;
  /** Objective events one simulation keeps. */
  readonly maxEvents: number;
}

/** Management-only classification of one character; never a runtime read for rules. */
export type CapabilityTier = "dynamic" | "degraded" | "normal";
export type ControlKind = "none" | "behaviour-tree" | "cognition" | "user";
export type LifecycleStatus = "created" | "running" | "paused";

export interface CharacterRecord {
  readonly entityId: string;
  readonly tier: CapabilityTier;
  readonly control: ControlKind;
  readonly main: boolean;
  readonly lifecycle: LifecycleStatus;
  readonly identityVersion: number;
  readonly homeLocation: string;
  readonly bodyConfig: string | null;
  readonly behaviourTree: string | null;
  readonly localView: string | null;
}

export interface CharacterState {
  readonly version: string;
  readonly characters: Readonly<Record<string, CharacterRecord>>;
}

export type EntityKind = "location" | "item" | "character";

/** One world entity's objective position and content-declared attributes. */
export interface WorldEntity {
  readonly entityId: string;
  readonly kind: EntityKind;
  /** Relation `located-at`: the place this entity directly occupies. */
  readonly locatedAt: string | null;
  /** Relation `held-by`: the character holding this item. */
  readonly heldBy: string | null;
  /** Relation `placed-on`: the entity this item rests on. */
  readonly placedOn: string | null;
  readonly attributes: Readonly<Record<string, SimpleValue>>;
}

export interface WorldProcess {
  readonly processRef: string;
  /** `null` for a process shared by the whole world. */
  readonly ownerId: string | null;
  readonly establishedTick: number;
  readonly params: Readonly<Record<string, SimpleValue>>;
}

export type WorldEventKind =
  | "relation-changed"
  | "environment-changed"
  | "influence-rejected"
  | "process-established"
  | "process-advanced"
  | "process-ended";

/** An audit record of an objective world change; never a character experience. */
export interface WorldEvent {
  readonly eventId: string;
  readonly tick: number;
  readonly kind: WorldEventKind;
  readonly actor: string | null;
  readonly subject: string | null;
  readonly stateRef: string | null;
  readonly from: SimpleValue | null;
  readonly to: SimpleValue | null;
}

export interface WorldState {
  readonly version: string;
  readonly entities: Readonly<Record<string, WorldEntity>>;
  readonly environment: Readonly<Record<string, SimpleValue>>;
  readonly processes: readonly WorldProcess[];
  readonly events: readonly WorldEvent[];
}

export interface BodyProcess {
  readonly processRef: string;
  readonly ownerId: string;
  readonly establishedTick: number;
  readonly params: Readonly<Record<string, SimpleValue>>;
}

/** One body instance's authoritative state. */
export interface BodyRecord {
  readonly entityId: string;
  readonly configRef: string;
  /** Body values keyed by the value's member id, e.g. `stamina`. */
  readonly values: Readonly<Record<string, SimpleValue>>;
  /** Channel fields keyed by `<channel>.available` / `<channel>.efficiency`. */
  readonly channels: Readonly<Record<string, SimpleValue>>;
  readonly participation: string;
  readonly mode: string;
  readonly processes: readonly BodyProcess[];
}

export interface BodyState {
  readonly version: string;
  readonly bodies: Readonly<Record<string, BodyRecord>>;
}

export type ActionStatus =
  "queued" | "running" | "waiting-world" | "completed" | "failed" | "interrupted" | "cancelled";

export type ActionPolicy = "parallel" | "queue" | "replace";

export type ActionSource = "diagnostic" | "behaviour-tree" | "cognition";

export interface ActionStep {
  readonly action: string;
  /** Entity the action acts on: a held item, a supported item, an operated item. */
  readonly target?: string;
  /** Place or supporting entity the action names. */
  readonly destination?: string;
}

export interface ActionPlan {
  readonly planId: string;
  readonly entityId: string;
  readonly source: ActionSource;
  /** Body/world state version the plan was formed against. */
  readonly formedVersion: string;
  readonly conflict: ActionPolicy;
  readonly steps: readonly ActionStep[];
}

/** The structured world impact one action stage asks the world to adjudicate. */
export interface WorldInfluenceRequest {
  readonly influenceId: string;
  readonly timelineId: string;
  /** Declared influence kind, e.g. `agentlife.demo/relocate`. */
  readonly kind: string;
  readonly actor: string;
  readonly subject: string;
  readonly destination: string | null;
  /** World version the request was formed against. */
  readonly baseVersion: string;
  readonly tick: number;
}

export interface ActionOutcome {
  readonly status: ActionStatus;
  readonly reason: string;
  readonly tick: number;
  readonly changes: readonly SimpleValue[];
}

export interface ActionInstance {
  readonly actionId: string;
  readonly entityId: string;
  readonly plan: ActionPlan;
  readonly stepIndex: number;
  readonly action: string;
  readonly status: ActionStatus;
  readonly stageIndex: number;
  /** Ticks accumulated inside the current stage. */
  readonly stageTicks: number;
  readonly acceptedTick: number;
  /** First tick this action may accumulate progress: `acceptedTick + 1`. */
  readonly eligibleTick: number;
  readonly target: string | null;
  readonly destination: string | null;
  /** Resources this action holds for its whole life, from its declared stages. */
  readonly resources: readonly string[];
  readonly worldRequest: WorldInfluenceRequest | null;
  readonly outcome: ActionOutcome | null;
}

/** One influence the world rejected, kept for the tick trace. */
export interface InfluenceOutcome {
  readonly influenceId: string;
  readonly status: "applied" | "rejected" | "stale";
  readonly reason: string;
  readonly changes: number;
}

/** The result of one atomic world commit attempt. */
export interface WorldCommit {
  readonly state: WorldState;
  readonly applied: readonly StateChangeRequest[];
  readonly rejected: readonly { readonly changeId: string; readonly reason: string }[];
  readonly events: readonly WorldEvent[];
}

export interface RuleBarrier {
  readonly kind: "missing-rules";
  readonly tick: number;
  readonly trigger: string;
  readonly stateRef: string;
  readonly detail: string;
}

export interface TickFailure {
  readonly stage: TickStage;
  readonly code: "propagation-limit" | "action-rejected" | "world-rejected" | "config-mismatch";
  readonly detail: string;
}

/** One entry the orchestrator must wake. */
export interface ActivityEntry {
  readonly entryId: string;
  readonly category: "entity" | "world-process" | "body-process";
}

export interface ScheduledCheck {
  readonly entryId: string;
  readonly tick: number;
}

export interface ActivityState {
  readonly active: readonly ActivityEntry[];
  readonly scheduled: readonly ScheduledCheck[];
}

export interface TickSummary {
  readonly tick: number;
  readonly stages: readonly StageRecord[];
  readonly stateVersion: string;
  readonly actionOutcomes: readonly string[];
  readonly influenceOutcomes: readonly InfluenceOutcome[];
  readonly eventCount: number;
}

export interface SimulationState {
  readonly timelineId: string;
  readonly tick: number;
  readonly simTime: SimTime;
  readonly phase: TickStage;
  readonly configId: string;
  readonly runMode: RunMode;
  readonly settings: SimulationSettings;
  readonly world: WorldState;
  readonly characters: CharacterState;
  readonly body: BodyState;
  readonly behaviours: Readonly<Record<string, BehaviorRuntimeState>>;
  readonly activity: ActivityState;
  readonly actions: readonly ActionInstance[];
  readonly barrier: RuleBarrier | null;
  readonly failure: TickFailure | null;
  /** Change identities already applied on this timeline. */
  readonly claimedChangeIds: readonly string[];
  readonly summary: TickSummary | null;
}

/** Composes the per-service versions into the version a rule run is based on. */
export function stateVersionOf(state: {
  readonly world: WorldState;
  readonly characters: CharacterState;
  readonly body: BodyState;
}): string {
  return `${state.world.version}/${state.characters.version}/${state.body.version}`;
}
