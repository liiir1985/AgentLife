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

/** The four stages perception, cognition and memory fill: 8 to 11. */
export const COGNITION_STAGES: readonly TickStage[] = ["perception", "cognitive-demand", "cognitive-barrier", "memory"];

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
  | "process-ended"
  | "utterance";

/** An audit record of one objective world change; never a character experience. */
export interface WorldEvent {
  readonly eventId: string;
  readonly tick: number;
  readonly kind: WorldEventKind;
  readonly actor: string | null;
  readonly subject: string | null;
  readonly stateRef: string | null;
  readonly from: SimpleValue | null;
  readonly to: SimpleValue | null;
  /** What was actually said; `null` for every kind but an utterance. */
  readonly text: string | null;
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

export type ActionSource = "diagnostic" | "player-command" | "behaviour-tree" | "cognition";

export interface ActionStep {
  readonly action: string;
  /** Entity the action acts on: a held item, a supported item, an operated item. */
  readonly target?: string;
  /** Place or supporting entity the action names. */
  readonly destination?: string;
  /** Content-defined text captured by the interaction layer; services keep it opaque. */
  readonly inputs?: Readonly<Record<string, string>>;
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

/** One refused request, reported in readable terms instead of an opaque identity. */
export interface RejectedChange {
  /** The state a change targeted, or the process a process request named. */
  readonly ref: string;
  /** The entity the request belonged to; `null` for world-level state. */
  readonly entityId: string | null;
  readonly reason: string;
}

/** The result of one atomic world commit attempt. */
export interface WorldCommit {
  readonly state: WorldState;
  readonly applied: readonly StateChangeRequest[];
  readonly rejected: readonly RejectedChange[];
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
  readonly code: "propagation-limit" | "action-rejected" | "world-rejected" | "config-mismatch" | "cognition-failed";
  readonly detail: string;
}

/** One entry the runner must wake. */
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

/**
 * What one observer actually perceived.
 *
 * A subject is the current structured description of one object in the
 * observer's own terms: an observer-local reference, the resolution level the
 * observation reached and the rendered description. The protected anchor is kept
 * for continuity and for mapping a reference back to the entity the services
 * work with; it is never shown to the observer and never used to look the
 * subject up elsewhere.
 */
export interface ObservationSubject {
  readonly anchor: string;
  readonly reference: string;
  readonly role: ObservationRole;
  /** Whether the observer itself carries the subject. */
  readonly held: boolean;
  readonly level: string;
  /** Whether the reached resolution allows attempting recognition at all. */
  readonly recognisable: boolean;
  readonly description: string;
  /** Recognised local name; only ever set at a recognisable resolution. */
  readonly identity: string | null;
}

/** Role one observed object plays in the observer's current view. */
export type ObservationRole = "place" | "exit" | "character" | "item";

/** One subject's continuity record: the last description plus its observation tick. */
export interface ObservedSubject extends ObservationSubject {
  /** Tick the subject was last observed as present. */
  readonly lastTick: number;
  /** Tick an observation about the subject was last submitted. */
  readonly lastEmittedTick: number;
}

export type ObservationKind =
  "appearance" | "continuing" | "change" | "disappearance" | "reappearance" | "event" | "outcome";

/** One structured observation; the authoritative record of what was perceived. */
export interface Observation {
  readonly observationId: string;
  readonly tick: number;
  /** Perception channel the observation arrived through. */
  readonly channel: string;
  readonly kind: ObservationKind;
  readonly subject: ObservationSubject | null;
  /** Objective event this observation is about, when it reports one. */
  readonly eventId: string | null;
  readonly text: string;
  readonly salience: number;
}

/** One observer's perception instance. */
export interface ObserverPerception {
  /** Current description of every object the observer can still see or hear. */
  readonly subjects: Readonly<Record<string, ObservedSubject>>;
  /** Observations formed and not yet consumed by that observer's cognition. */
  readonly pending: readonly Observation[];
  /** Observer-local reference per anchor; allocated once and kept while known. */
  readonly references: Readonly<Record<string, string>>;
  readonly referencesUsed: number;
  /** Tick until which a stable subject stays silent, keyed by anchor. */
  readonly suppressedUntil: Readonly<Record<string, number>>;
  /** Objective events already turned into observations; never processed twice. */
  readonly processedEvents: readonly string[];
  /** State version and attention version the last perception run was based on. */
  readonly materialVersion: string;
  readonly attentionVersion: string;
}

export interface PerceptionState {
  readonly version: string;
  readonly observers: Readonly<Record<string, ObserverPerception>>;
}

/**
 * One item admitted into an entity's Working Memory.
 *
 * Only what was admitted may enter a cognition call: `text` is the rendered line
 * the model reads, `reference` is the observer-local name it may quote back, and
 * `anchor` is what the service maps that quote onto.
 */
export interface WorkingMemoryEntry {
  readonly entryId: string;
  readonly kind: "observation" | "intention";
  readonly sourceId: string;
  readonly admittedTick: number;
  readonly salience: number;
  readonly text: string;
  readonly anchor: string | null;
  readonly reference: string | null;
  /** What kind of object the line is about, so an action can address it correctly. */
  readonly role: ObservationRole | null;
}

export interface WorkingMemoryRecord {
  readonly entries: readonly WorkingMemoryEntry[];
  readonly sequence: number;
  /** Entries the last confirmation consumed; diagnostics, never a delete list. */
  readonly consumed: readonly string[];
}

export interface WorkingMemoryState {
  readonly version: string;
  readonly records: Readonly<Record<string, WorkingMemoryRecord>>;
}

export type IntentionStatus = "active" | "paused" | "satisfied" | "abandoned";

/** One prospective state the cognition of an entity holds. */
export interface IntentionRecord {
  readonly intentionId: string;
  readonly content: string;
  readonly source: "cognition" | "user";
  readonly status: IntentionStatus;
  readonly createdTick: number;
  readonly reviewedTick: number;
  /** How often cognition actually considered or followed it. */
  readonly useCount: number;
}

export type IdleKind = "external-event" | "review-condition" | "ongoing-activity";

/** What an entity with nothing to do right now committed itself to wait for. */
export interface IdleCommitment {
  readonly kind: IdleKind;
  readonly detail: string;
  /** Verifiable event an `external-event` commitment waits for. */
  readonly event: string | null;
  /** Tick at which the commitment is reviewed again. */
  readonly reviewTick: number;
  /** Hard bound: after this tick the wait is over and cognition runs again. */
  readonly untilTick: number;
}

export interface CognitionRecord {
  readonly characterId: string;
  /** Observer-local references the entity currently attends to. */
  readonly attention: readonly string[];
  readonly understanding: string;
  readonly questions: readonly string[];
  readonly persistence: string;
  readonly intentions: readonly IntentionRecord[];
  /** Identity counter for intentions this entity has ever created. */
  readonly intentionSequence: number;
  readonly idle: IdleCommitment | null;
  readonly lastDecisionTick: number;
  /** Decisions accepted so far; an entity without one still owes an initial decision. */
  readonly decisions: number;
  /** Identity of the request currently allowed to commit, for late-response isolation. */
  readonly pendingRequestId: string | null;
  readonly attempts: number;
}

export interface CognitionState {
  readonly version: string;
  readonly records: Readonly<Record<string, CognitionRecord>>;
}

export type CognitionDemandReason =
  "initial" | "observation" | "outcome" | "idle-review" | "idle-expiry" | "player-command";

/** Why one entity has to think before the tick may go on. */
export interface CognitionDemand {
  readonly demandId: string;
  readonly characterId: string;
  readonly reason: CognitionDemandReason;
  readonly detail: string;
  /** Observation identities the demand is based on. */
  readonly observations: readonly string[];
}

export type ParticipantState = "waiting" | "requested" | "decided" | "skipped" | "failed";

export interface CognitionParticipant {
  readonly characterId: string;
  readonly control: "cognition" | "user";
  readonly state: ParticipantState;
  readonly requestId: string | null;
  readonly attempts: number;
  readonly detail: string;
}

/** One intention the model wants created, restated, paused, satisfied or dropped. */
export interface IntentionChange {
  /** Existing intention, or `null` to create a new one. */
  readonly intentionId: string | null;
  readonly content: string;
  readonly status: IntentionStatus;
}

/**
 * One body step as the model expressed it: `target` and `destination` name
 * observer-local references, which the service maps onto protected anchors
 * before anything is handed to the body.
 */
export interface CognitiveStep {
  readonly action: string;
  readonly target?: string;
  readonly destination?: string;
  readonly inputs?: Readonly<Record<string, string>>;
}

/** What one participant decided; the service validates every field before committing. */
export interface CognitiveDecision {
  readonly characterId: string;
  readonly requestId: string;
  readonly attention: readonly string[];
  readonly understanding: string;
  readonly questions: readonly string[];
  readonly persistence: string;
  readonly intentionChanges: readonly IntentionChange[];
  /** Text the entity wants to say; becomes the declaring action's utterance step. */
  readonly speech: string | null;
  readonly steps: readonly CognitiveStep[];
  readonly idle: IdleCommitment | null;
  /** Observation references the entity confirms it actually used. */
  readonly consumedObservations: readonly string[];
  /** Intention identities the entity actually considered or followed. */
  readonly consideredIntentions: readonly string[];
}

export type CognitionRoundStatus = "open" | "resolved" | "failed";

/** One global cognition barrier: the participants, their demands and their decisions. */
export interface CognitionRound {
  readonly roundId: string;
  readonly tick: number;
  readonly stateVersion: string;
  readonly participants: readonly CognitionParticipant[];
  readonly demands: readonly CognitionDemand[];
  readonly decisions: Readonly<Record<string, CognitiveDecision>>;
  readonly plans: readonly ActionPlan[];
  readonly status: CognitionRoundStatus;
  readonly failure: string | null;
}

/** One observation as a cognition request carries it. */
export interface CognitionObservationInput {
  readonly observationId: string;
  /** How the model may name the object; `null` when the line is about no object. */
  readonly reference: string | null;
  readonly text: string;
  /** `place`, `exit`, `character` or `item`, so an action can name the right object. */
  readonly role: ObservationRole | null;
}

/** One intention as a cognition request carries it. */
export interface CognitionIntentionInput {
  readonly intentionId: string;
  readonly content: string;
  readonly status: IntentionStatus;
}

/** One action a decision may request. */
export interface CognitionActionInput {
  readonly action: string;
  readonly name: string;
  readonly description: string;
}

/**
 * The complete input of one cognition request.
 *
 * It carries only what was admitted into Working Memory plus the entity's own
 * intentions and the actions its body may run. Nothing here is a world state, an
 * identity or another entity's private text.
 */
export interface CognitionInput {
  readonly characterId: string;
  readonly requestId: string;
  readonly roundId: string;
  readonly tick: number;
  readonly stateVersion: string;
  readonly systemPrompt: string;
  readonly situation: string;
  /** Observer-local references the entity currently attends to. */
  readonly attention: readonly string[];
  /** What the entity committed itself to wait for, if anything. */
  readonly idle: IdleCommitment | null;
  readonly observations: readonly CognitionObservationInput[];
  readonly intentions: readonly CognitionIntentionInput[];
  readonly actions: readonly CognitionActionInput[];
  readonly maxSteps: number;
  readonly idleWaitLimitTicks: number;
  /** Attempt number, counting from 1. */
  readonly attempt: number;
  /** Why the previous attempt was refused; `null` on the first attempt. */
  readonly rejection: string | null;
  readonly timeoutMs: number;
}

/** What one cognition request produced. */
export interface CognitionModelResult {
  readonly status: "decided" | "failed" | "timed-out" | "cancelled";
  readonly detail: string;
  /** Untrusted draft; the coordinator validates every reference before use. */
  readonly decision: CognitiveDecision | null;
}

export interface TickSummary {
  readonly tick: number;
  readonly stages: readonly StageRecord[];
  readonly stateVersion: string;
  readonly actionOutcomes: readonly string[];
  readonly influenceOutcomes: readonly InfluenceOutcome[];
  readonly eventCount: number;
  /** Observations this tick submitted to any observer's pending stream. */
  readonly observations: number;
  /** How the cognition round of this tick ended; `null` when nobody had to think. */
  readonly cognition: string | null;
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
  readonly perception: PerceptionState;
  readonly memory: WorkingMemoryState;
  readonly cognition: CognitionState;
  /** The cognition round of the tick in progress, while the barrier holds it. */
  readonly round: CognitionRound | null;
  readonly behaviours: Readonly<Record<string, BehaviorRuntimeState>>;
  readonly activity: ActivityState;
  readonly actions: readonly ActionInstance[];
  readonly barrier: RuleBarrier | null;
  readonly failure: TickFailure | null;
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
