import type { RuntimeConfig } from "../config/config-builder.js";
import type { ProcessChangeRequest, RuleRequest, RuleResult, StateChangeRequest } from "../config/rule-engine.js";
import type { SystemIndex } from "../config/system-index.js";
import type { SimpleValue } from "../config/value-expr.js";
import {
  WORLD_ATTRIBUTES,
  WORLD_FACTS,
  appearanceFor,
  declaredAttributes,
  checkValue,
  initialValues,
  itemDescription,
  itemLabel,
  itemOf,
  itemPlacements,
  itemsOf,
  membersOf,
  processSpec,
  type ItemTypeRef,
} from "./config-view.js";
import type { SubjectMaterial, WorldPerceptionMaterial } from "./perception-service.js";
import { NO_INFLUENCE, entitySlice, sharedSlice, type InfluenceView, type ProjectionSources } from "./projection.js";
import type {
  EntityKind,
  InfluenceOutcome,
  RejectedChange,
  SimulationSettings,
  WorldCommit,
  WorldEntity,
  WorldEvent,
  WorldInfluenceRequest,
  WorldProcess,
  WorldState,
} from "./types.js";

/**
 * The world service: the sole authority over objective world state.
 *
 * It owns where every entity is, which item is held or placed and what the
 * environment currently reads, and it owns the generic relations between them:
 * `located-at`, `held-by` and `placed-on`. Whether a specific item may be taken,
 * used as a support or operated is not its business: it hands the influence
 * request to the content rules, which read the content-declared attributes and
 * decide, and only then does the service check the relation invariants and commit
 * one complete new world state, or nothing at all.
 */

/** Everything a service may reach: the compiled config, the index and rule runs. */
export interface ServiceRuntime {
  readonly config: RuntimeConfig;
  readonly systemIndex: SystemIndex;
  runRules(request: RuleRequest): RuleResult;
}

/** The state patch an accepted change applies, or why it cannot be applied. */
type ChangeEffect =
  | { readonly kind: "unknown" }
  | { readonly kind: "unchanged" }
  | { readonly kind: "environment"; readonly member: string; readonly value: SimpleValue }
  | { readonly kind: "entity"; readonly entity: WorldEntity };

export interface TickContext {
  readonly timelineId: string;
  readonly tick: number;
  readonly command: string;
  /**
   * The state version this command's rule frame was formed against. World state
   * changes are only accepted while the world still stands where the frame read
   * it; callers that read the world alone leave it out.
   */
  readonly baseVersion?: string;
}

export interface AdjudicationResult extends WorldCommit {
  readonly outcome: InfluenceOutcome;
  readonly processRequests: readonly ProcessChangeRequest[];
}

export interface ProcessAdvanceResult extends WorldCommit {
  readonly advanced: readonly string[];
  readonly processRequests: readonly ProcessChangeRequest[];
}

export function runIdOf(context: TickContext): string {
  return `${context.timelineId}/tick-${context.tick}/${context.command}`;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Stable, readable batch order: system, then entity, then the state the change names. */
export function changesInOrder(changes: readonly StateChangeRequest[]): readonly StateChangeRequest[] {
  return [...changes].sort(
    (left, right) =>
      compareText(left.system, right.system) ||
      compareText(left.entityId ?? "", right.entityId ?? "") ||
      compareText(left.stateRef, right.stateRef),
  );
}

/** The same order for process requests, which name a process instead of a state. */
export function processRequestsInOrder(requests: readonly ProcessChangeRequest[]): readonly ProcessChangeRequest[] {
  return [...requests].sort(
    (left, right) =>
      compareText(left.system, right.system) ||
      compareText(left.entityId ?? "", right.entityId ?? "") ||
      compareText(left.processRef, right.processRef),
  );
}

export function entityKindOf(typeRef: string): EntityKind | undefined {
  if (typeRef === "agentlife.world/location") return "location";
  if (typeRef === "agentlife.world/item") return "item";
  if (typeRef === "agentlife.character/character") return "character";
  return undefined;
}

function relationTarget(value: SimpleValue | undefined): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

export class WorldService {
  constructor(
    private readonly runtime: ServiceRuntime,
    private readonly settings: SimulationSettings,
  ) {}

  private get config(): RuntimeConfig {
    return this.runtime.config;
  }

  /** Builds the starting world from content: places, items, characters, facts, attributes. */
  initialize(characters: readonly { readonly entityId: string; readonly homeLocation: string }[]): WorldState {
    const attributes = declaredAttributes(this.config);
    const placements = itemPlacements(this.config);
    const entities: Record<string, WorldEntity> = {};
    const add = (entityId: string, kind: EntityKind, locatedAt: string | null): void => {
      entities[entityId] = Object.freeze({
        entityId,
        kind,
        locatedAt,
        heldBy: null,
        placedOn: null,
        attributes: Object.freeze({ ...initialValues(this.config, WORLD_ATTRIBUTES), ...(attributes[entityId] ?? {}) }),
      });
    };
    const declared: readonly { readonly typeRef: ItemTypeRef; readonly kind: EntityKind }[] = [
      { typeRef: "agentlife.world/location", kind: "location" },
      { typeRef: "agentlife.world/item", kind: "item" },
    ];
    for (const entry of declared)
      for (const item of itemsOf(this.config, entry.typeRef)) add(item.ref, entry.kind, placements[item.ref] ?? null);
    for (const character of [...characters].sort((left, right) => (left.entityId < right.entityId ? -1 : 1)))
      add(character.entityId, "character", character.homeLocation);
    return Object.freeze({
      version: "world-1",
      entities: Object.freeze(entities),
      environment: Object.freeze(initialValues(this.config, WORLD_FACTS)),
      processes: Object.freeze([]),
      events: Object.freeze([]),
    });
  }

  entity(state: WorldState, entityId: string): WorldEntity | undefined {
    return state.entities[entityId];
  }

  /** Objective position of one entity, whatever relation currently carries it. */
  position(state: WorldState, entityId: string): string | null {
    const entity = state.entities[entityId];
    if (entity === undefined) return null;
    return entity.locatedAt ?? entity.heldBy ?? entity.placedOn;
  }

  /**
   * Records what an entity actually said once every stage of its utterance action
   * finished. The event becomes objective world history, and only a character that
   * can hear this place receives it; an empty or unfinished utterance is never
   * recorded, so nothing a body refused can be heard.
   */
  recordUtterance(
    state: WorldState,
    utterance: { readonly actor: string; readonly text: string },
    context: TickContext,
  ): WorldState {
    if (utterance.text.trim() === "") return state;
    const spoken = state.events.filter((event) => event.tick === context.tick && event.kind === "utterance").length;
    const event: WorldEvent = Object.freeze({
      eventId: `${context.timelineId}/${context.tick}/utterance-${spoken + 1}`,
      tick: context.tick,
      kind: "utterance",
      actor: utterance.actor,
      subject: utterance.actor,
      stateRef: null,
      from: null,
      to: null,
      text: utterance.text,
    });
    // An utterance changes no objective state, so it does not move the version every
    // other request in this tick was formed against; it only joins the event history.
    return Object.freeze({ ...state, events: capEvents([...state.events, event], this.settings.maxEvents) });
  }

  /**
   * The purpose-limited material one observer may perceive at one tick.
   *
   * It carries only the observer's own place, the exits of that place, the objects
   * standing there, the environment values, what changed in them and the events of
   * that tick. No entity is dereferenced: an item, a character or a place arrives
   * with the appearance content declares for it, and a character never carries its
   * name, its background or its control source.
   */
  perceptionMaterial(
    state: WorldState,
    observer: string,
    tick: number,
    previousEnvironment: Readonly<Record<string, SimpleValue>>,
  ): WorldPerceptionMaterial {
    const observerEntity = state.entities[observer];
    const place = observerEntity?.locatedAt ?? null;
    const subject = (
      entityId: string,
      role: "character" | "item" | "exit" | "place",
      held: boolean,
    ): SubjectMaterial => {
      const entity = state.entities[entityId];
      return Object.freeze({
        anchor: entityId,
        role,
        held,
        place: entity === undefined ? null : this.position(state, entityId),
        appearance: appearanceFor(this.config, entityId),
        label: itemLabel(this.config, entityId),
        description: itemDescription(this.config, entityId),
      });
    };
    const subjects: SubjectMaterial[] = [];
    for (const entityId of Object.keys(state.entities).sort()) {
      if (entityId === observer) continue;
      const entity = state.entities[entityId];
      if (entity === undefined || entity.kind === "location") continue;
      if (entity.heldBy === observer) subjects.push(subject(entityId, entity.kind, true));
      else if (entity.heldBy === null && entity.placedOn === null && place !== null && entity.locatedAt === place)
        subjects.push(subject(entityId, entity.kind, false));
    }
    const declaredExits = place === null ? [] : itemOf(this.config, place)?.values["exits"];
    const exits = [...new Set(Array.isArray(declaredExits) ? declaredExits : [])]
      .filter((exit): exit is string => typeof exit === "string" && state.entities[exit] !== undefined)
      .sort()
      .map((exit) => subject(exit, "exit", false));
    const changedFacts = Object.keys(state.environment)
      .filter((member) => state.environment[member] !== previousEnvironment[member])
      .sort();
    return Object.freeze({
      place:
        place === null
          ? null
          : Object.freeze({
              anchor: place,
              label: itemLabel(this.config, place),
              description: itemDescription(this.config, place),
            }),
      exits: Object.freeze(exits),
      subjects: Object.freeze(subjects),
      environment: state.environment,
      changedFacts: Object.freeze(changedFacts),
      events: Object.freeze(
        state.events
          .filter((event) => event.tick === tick)
          .map((event) =>
            Object.freeze({
              eventId: event.eventId,
              kind: event.kind as string,
              actor: event.actor,
              place: event.actor === null ? null : this.position(state, event.actor),
              text: event.text,
            }),
          ),
      ),
    });
  }

  /**
   * The rule-facing projection: the declared world views of the entities that
   * take part in one request, plus the request itself. Nothing else is reachable.
   */
  projection(
    sources: ProjectionSources,
    entityIds: readonly string[],
    influence: InfluenceView,
    roles: Readonly<Record<string, string>>,
  ): { readonly shared: Record<string, unknown>; readonly entities: Record<string, Record<string, unknown>> } {
    const entities: Record<string, Record<string, unknown>> = {};
    for (const entityId of [...new Set(entityIds)].sort()) {
      const slice = entitySlice(sources, entityId, { role: roles[entityId] ?? "bystander" });
      if (slice !== undefined) entities[entityId] = slice;
    }
    return { shared: sharedSlice(sources, influence), entities };
  }

  /**
   * Adjudicates one action impact: the rules decide whether every participant
   * consents by reading its own attributes, and the accepted request becomes one
   * atomic world state transition only if it also satisfies the relation
   * invariants. A rejected or stale request changes nothing.
   */
  adjudicate(sources: ProjectionSources, request: WorldInfluenceRequest, frameVersion: string): AdjudicationResult {
    const state = sources.world;
    const context: TickContext = {
      timelineId: request.timelineId,
      tick: request.tick,
      command: `influence-${request.influenceId}`,
    };
    // Requests formed inside one adjudication frame share its starting version, so
    // a peer influence that commits first cannot make a concurrent request stale.
    // A request from an earlier frame met a world that has since moved: it is stale.
    if (request.baseVersion !== frameVersion)
      return {
        ...this.emptyCommit(state),
        outcome: {
          influenceId: request.influenceId,
          status: "stale",
          reason: `request was formed against ${request.baseVersion}, this frame started from ${frameVersion}`,
          changes: 0,
        },
        processRequests: [],
      };

    const participants = this.participants(state, request);
    const roles: Record<string, string> = { [request.actor]: "actor" };
    if (request.subject !== request.actor) roles[request.subject] = "subject";
    if (request.destination !== null && request.destination !== request.actor)
      roles[request.destination] ??= "destination";
    const requestView: InfluenceView = {
      kind: request.kind,
      actor: request.actor,
      subject: request.subject,
      destination: request.destination ?? "",
      accepted: false,
    };

    const judgement = this.runtime.runRules({
      runId: runIdOf({ ...context, command: `influence-${request.influenceId}/judgement` }),
      trigger: "agentlife.world/influence-requested",
      entityIds: participants,
      baseVersion: state.version,
      input: {
        stateVersion: state.version,
        simTime: { tick: request.tick, seconds: 0 },
        ...this.projection(sources, participants, requestView, roles),
      },
    });
    if (judgement.status === "state-version-stale" || judgement.status === "config-unavailable")
      return {
        ...this.emptyCommit(state),
        outcome: {
          influenceId: request.influenceId,
          status: "stale",
          reason: `judgement did not run: ${judgement.status}`,
          changes: 0,
        },
        processRequests: [],
      };

    const withheld = judgement.stateChanges
      .filter((change) => change.stateRef === "agentlife.world/consent" && change.newValue !== true)
      .map((change) => `${change.entityId ?? "shared"}(${roles[change.entityId ?? ""] ?? "bystander"})`);
    const consented = new Set(
      judgement.stateChanges
        .filter((change) => change.stateRef === "agentlife.world/consent")
        .map((change) => change.entityId ?? "shared"),
    );
    const missing = participants.filter((entityId) => !consented.has(entityId));
    if (withheld.length > 0 || missing.length > 0) {
      const reason =
        withheld.length > 0
          ? `refused by ${withheld.sort().join(", ")}`
          : `no consent rule covered ${missing.sort().join(", ")}`;
      return {
        ...this.emptyCommit(state),
        outcome: { influenceId: request.influenceId, status: "rejected", reason, changes: 0 },
        processRequests: [],
      };
    }

    const applied = this.runtime.runRules({
      runId: runIdOf({ ...context, command: `influence-${request.influenceId}/application` }),
      trigger: "agentlife.world/influence-accepted",
      entityIds: participants,
      baseVersion: state.version,
      input: {
        stateVersion: state.version,
        simTime: { tick: request.tick, seconds: 0 },
        ...this.projection(sources, participants, { ...requestView, accepted: true }, roles),
      },
    });
    if (applied.status === "state-version-stale" || applied.status === "config-unavailable")
      return {
        ...this.emptyCommit(state),
        outcome: {
          influenceId: request.influenceId,
          status: "stale",
          reason: `application did not run: ${applied.status}`,
          changes: 0,
        },
        processRequests: [],
      };

    const committed = this.commit(
      state,
      { ...context, command: `influence-${request.influenceId}` },
      applied.stateChanges,
      applied.processChanges,
      { kind: "influence", actor: request.actor, subject: request.subject },
    );
    const accepted = committed.applied.length > 0 || applied.processChanges.length > 0;
    return {
      ...committed,
      outcome: accepted
        ? { influenceId: request.influenceId, status: "applied", reason: "accepted", changes: committed.applied.length }
        : {
            influenceId: request.influenceId,
            status: "rejected",
            reason:
              committed.rejected[0]?.reason ??
              `no rule turned the accepted influence into a world change (rule run ${applied.status}, ${applied.stateChanges.length} requested)`,
            changes: 0,
          },
      processRequests: applied.processChanges,
    };
  }

  /** Advances every established world process once, through its own rules. */
  advanceProcesses(sources: ProjectionSources, context: TickContext): ProcessAdvanceResult {
    const state = sources.world;
    const advanced: string[] = [];
    const appliedChanges: StateChangeRequest[] = [];
    const rejected: RejectedChange[] = [];
    const events: WorldEvent[] = [];
    const processRequests: ProcessChangeRequest[] = [];
    let current = state;
    for (const process of [...state.processes].sort((left, right) => (left.processRef < right.processRef ? -1 : 1))) {
      const result = this.runtime.runRules({
        runId: runIdOf({ ...context, command: `world-process/${process.processRef}` }),
        trigger: "agentlife.world/process-advanced",
        entityIds: [],
        baseVersion: current.version,
        input: {
          stateVersion: current.version,
          simTime: { tick: context.tick, seconds: 0 },
          shared: sharedSlice({ ...sources, world: current }, NO_INFLUENCE, {
            process: process.processRef,
            rate: 0,
            gain: Number(process.params["gain"] ?? 0),
          }),
          entities: {},
        },
      });
      advanced.push(`${process.processRef}@${context.tick}`);
      if (result.stateChanges.length === 0 && result.processChanges.length === 0) continue;
      const committed = this.commit(
        current,
        { ...context, command: `world-process/${process.processRef}` },
        result.stateChanges,
        result.processChanges,
        { kind: "process-advanced", actor: null, subject: process.processRef },
      );
      current = committed.state;
      appliedChanges.push(...committed.applied);
      rejected.push(...committed.rejected);
      events.push(...committed.events);
      processRequests.push(...result.processChanges);
    }
    return { state: current, applied: appliedChanges, rejected, events, advanced, processRequests };
  }

  /**
   * Commits rule-requested world state changes. Every change is validated, the
   * whole set is applied to a candidate state, and the candidate is committed
   * only when it still satisfies every relation invariant.
   */
  commit(
    state: WorldState,
    context: TickContext,
    changes: readonly StateChangeRequest[],
    processChanges: readonly ProcessChangeRequest[],
    origin: {
      readonly kind: "influence" | "process-advanced" | "propagation";
      readonly actor: string | null;
      readonly subject: string | null;
    },
  ): WorldCommit {
    const rejected: RejectedChange[] = [];
    const baseline = context.baseVersion ?? state.version;
    const accepted: { readonly change: StateChangeRequest; readonly effect: ChangeEffect }[] = [];
    for (const change of changesInOrder(changes)) {
      if (change.system !== "agentlife.world") {
        rejected.push({
          ref: change.stateRef,
          entityId: change.entityId,
          reason: `${change.stateRef} is not owned by the world system`,
        });
        continue;
      }
      if (change.baseVersion !== baseline) {
        rejected.push({
          ref: change.stateRef,
          entityId: change.entityId,
          reason: `change was formed against ${change.baseVersion}`,
        });
        continue;
      }
      const shape = checkValue(this.config, change.stateRef, change.newValue);
      if (!shape.ok) {
        rejected.push({ ref: change.stateRef, entityId: change.entityId, reason: shape.reason });
        continue;
      }
      const effect = this.changeEffect(state, change);
      if (effect.kind === "unknown") {
        rejected.push({
          ref: change.stateRef,
          entityId: change.entityId,
          reason: `${change.stateRef} names no world state`,
        });
        continue;
      }
      const precondition = this.relationPrecondition(state, change);
      if (precondition !== undefined) {
        rejected.push({ ref: change.stateRef, entityId: change.entityId, reason: precondition });
        continue;
      }
      // A change that leaves the objective state identical is not a change: it is
      // not recorded, so propagation can reach a fixpoint.
      if (effect.kind === "unchanged") continue;
      accepted.push({ change, effect });
    }
    // A batch is committed as a whole: a refused change is never part-written, and
    // the rest of the batch is not committed without it.
    if (rejected.length > 0) return { state, applied: [], rejected, events: [] };
    const entities: Record<string, WorldEntity> = { ...state.entities };
    const environment: Record<string, SimpleValue> = { ...state.environment };
    for (const { effect } of accepted) {
      if (effect.kind === "environment") environment[effect.member] = effect.value;
      else if (effect.kind === "entity") entities[effect.entity.entityId] = effect.entity;
    }
    const problems = this.invariantProblems({ ...state, entities, environment });
    if (problems.length > 0)
      return {
        state,
        applied: [],
        rejected: [
          ...rejected,
          ...accepted.map(({ change }) => ({
            ref: change.stateRef,
            entityId: change.entityId,
            reason: problems[0] ?? "invariant violated",
          })),
        ],
        events: [],
      };

    const processes = this.applyProcessRequests(state.processes, processChanges, context, rejected);
    const changed = accepted.length > 0 || processes !== state.processes;
    let next: WorldState = {
      // The version identifies a world state, so an attempt that changed nothing
      // keeps the version every other request in this tick was formed against.
      version: changed ? bumpVersion(state.version) : state.version,
      entities: Object.freeze(entities),
      environment: Object.freeze(environment),
      processes,
      events: state.events,
    };
    const events: WorldEvent[] = [];
    for (const [index, { change }] of accepted.entries())
      events.push({
        eventId: `${context.timelineId}/${context.tick}/change-${index + 1}`,
        tick: context.tick,
        kind: change.stateRef.startsWith("agentlife.world/environment") ? "environment-changed" : "relation-changed",
        actor: origin.actor,
        subject: change.entityId ?? origin.subject,
        stateRef: change.stateRef,
        from: this.readState(state, change),
        to: change.newValue,
        text: null,
      });
    if (processes !== state.processes)
      events.push(...this.processEvents(state, processes, processChanges, context, origin));
    for (const processChange of processChanges)
      if (processChange.system !== "agentlife.world")
        rejected.push({
          ref: processChange.processRef,
          entityId: processChange.entityId,
          reason: "process is not owned by the world system",
        });
    if (events.length > 0) next = { ...next, events: capEvents([...state.events, ...events], this.settings.maxEvents) };
    return { state: next, applied: accepted.map(({ change }) => change), rejected, events };
  }

  private processEvents(
    previous: WorldState,
    next: readonly WorldProcess[],
    requests: readonly ProcessChangeRequest[],
    context: TickContext,
    origin: { readonly actor: string | null; readonly subject: string | null },
  ): readonly WorldEvent[] {
    const before = new Set(previous.processes.map((process) => process.processRef));
    const after = new Set(next.map((process) => process.processRef));
    const events: WorldEvent[] = [];
    for (const process of next)
      if (!before.has(process.processRef))
        events.push({
          eventId: `${context.timelineId}/${context.tick}/${process.processRef}/established`,
          tick: context.tick,
          kind: "process-established",
          actor: origin.actor,
          subject: process.processRef,
          stateRef: null,
          from: null,
          to: process.processRef,
          text: null,
        });
    for (const process of previous.processes)
      if (!after.has(process.processRef))
        events.push({
          eventId: `${context.timelineId}/${context.tick}/${process.processRef}/ended`,
          tick: context.tick,
          kind: "process-ended",
          actor: origin.actor,
          subject: process.processRef,
          stateRef: null,
          from: process.processRef,
          to: null,
          text: null,
        });
    void requests;
    return events;
  }

  private applyProcessRequests(
    processes: readonly WorldProcess[],
    requests: readonly ProcessChangeRequest[],
    context: TickContext,
    rejected: RejectedChange[],
  ): readonly WorldProcess[] {
    let current = [...processes];
    let mutated = false;
    for (const request of processRequestsInOrder(requests)) {
      if (request.system !== "agentlife.world") continue;
      const spec = processSpec(this.runtime.systemIndex, request.processRef);
      if (spec === undefined) {
        rejected.push({
          ref: request.processRef,
          entityId: request.entityId,
          reason: `unknown world process ${request.processRef}`,
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
      const ownerId = spec.scope === "shared" ? null : request.entityId;
      const existing = current.find(
        (process) => process.processRef === request.processRef && process.ownerId === ownerId,
      );
      if (request.action === "establish") {
        if (existing !== undefined) continue;
        const params = this.checkProcessParams(spec, request.params, rejected, request.processRef, request.entityId);
        if (params === undefined) continue;
        current = [...current, { processRef: request.processRef, ownerId, establishedTick: context.tick, params }];
        mutated = true;
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
      current = current.filter((process) => process !== existing);
      mutated = true;
    }
    // An attempt that changed no process keeps the very array it was given, so a
    // no-op commit cannot make an already formed request look stale.
    return mutated ? Object.freeze(current) : processes;
  }

  private checkProcessParams(
    spec: { readonly parameters: readonly { readonly name: string; readonly valueType: string }[] },
    params: Readonly<Record<string, SimpleValue>>,
    rejected: RejectedChange[],
    processRef: string,
    entityId: string | null,
  ): Readonly<Record<string, SimpleValue>> | undefined {
    const checked: Record<string, SimpleValue> = {};
    for (const parameter of spec.parameters) {
      const value = params[parameter.name];
      if (value === undefined || typeof value !== parameter.valueType) {
        rejected.push({
          ref: processRef,
          entityId,
          reason: `parameter ${parameter.name} must be a ${parameter.valueType}`,
        });
        return undefined;
      }
      checked[parameter.name] = value;
    }
    return Object.freeze(checked);
  }

  /**
   * What one change would do to the state it was formed from. Pure: an effect is
   * only applied to a candidate state once the change is accepted, so a refused
   * change can never leave a half-written relation behind.
   */
  private changeEffect(state: WorldState, change: StateChangeRequest): ChangeEffect {
    const entityId = change.entityId;
    if (change.stateRef.startsWith("agentlife.world/environment.")) {
      const member = change.stateRef.slice("agentlife.world/environment.".length);
      if (!membersOf(this.config, WORLD_FACTS).some((entry) => entry.key === member)) return { kind: "unknown" };
      if (state.environment[member] === change.newValue) return { kind: "unchanged" };
      return { kind: "environment", member, value: change.newValue };
    }
    if (entityId === null) return { kind: "unknown" };
    const entity = state.entities[entityId];
    if (entity === undefined) return { kind: "unknown" };
    if (change.stateRef === "agentlife.world/located-at") {
      const location = relationTarget(change.newValue);
      if (entity.locatedAt === location && entity.heldBy === null && entity.placedOn === null)
        return { kind: "unchanged" };
      return { kind: "entity", entity: { ...entity, locatedAt: location, heldBy: null, placedOn: null } };
    }
    if (change.stateRef === "agentlife.world/held-by") {
      const holder = relationTarget(change.newValue);
      if (entity.heldBy === holder && entity.locatedAt === null && entity.placedOn === null)
        return { kind: "unchanged" };
      return { kind: "entity", entity: { ...entity, locatedAt: null, heldBy: holder, placedOn: null } };
    }
    if (change.stateRef === "agentlife.world/placed-on") {
      const support = relationTarget(change.newValue);
      if (entity.placedOn === support && entity.locatedAt === null && entity.heldBy === null)
        return { kind: "unchanged" };
      return { kind: "entity", entity: { ...entity, locatedAt: null, heldBy: null, placedOn: support } };
    }
    return { kind: "unknown" };
  }

  /**
   * Whether the world still lets this action start, judged only from the generic
   * relations the world owns. `relation` is the world relation the action's
   * declared influence changes, so the world never has to know a content action
   * by name.
   */
  actionPremises(
    state: WorldState,
    action: { readonly entityId: string; readonly target: string | null; readonly destination: string | null },
    influence: { readonly changesWorld: boolean; readonly relation: string | null },
  ): { readonly ok: true } | { readonly ok: false; readonly reason: string } {
    const actor = state.entities[action.entityId];
    if (actor === undefined) return { ok: false, reason: `${action.entityId} is not in the world` };
    if (influence.relation === "located-at") {
      const destination = action.destination;
      if (destination === null) return { ok: false, reason: "the move names no destination" };
      if (state.entities[destination]?.kind !== "location")
        return { ok: false, reason: `${destination} is not a place` };
      const from = actor.locatedAt;
      if (from !== null && from !== destination && !this.locationExits(from).includes(destination))
        return { ok: false, reason: `${destination} is not an exit of ${from}` };
      return { ok: true };
    }
    if (influence.changesWorld && action.target !== null) {
      const target = state.entities[action.target];
      if (target === undefined) return { ok: false, reason: `${action.target} is not in the world` };
      if (target.kind !== "item") return { ok: false, reason: `${action.target} is not an item` };
    }
    return { ok: true };
  }

  /**
   * Generic preconditions of the relation vocabulary, independent of any content
   * attribute: an item can only be taken where it is, an item can only be placed
   * by whoever carries it, and a character can only move along a declared exit.
   */
  private relationPrecondition(state: WorldState, change: StateChangeRequest): string | undefined {
    const entityId = change.entityId;
    if (entityId === null) return undefined;
    const entity = state.entities[entityId];
    if (entity === undefined) return undefined;
    if (change.stateRef === "agentlife.world/held-by") {
      const holder = relationTarget(change.newValue);
      if (holder === null) return undefined;
      if (entity.locatedAt === null) return `${entityId} is not anywhere to be taken from`;
      const carrier = state.entities[holder];
      if (carrier === undefined) return `unknown holder ${holder}`;
      if (carrier.locatedAt !== entity.locatedAt)
        return `${holder} is at ${String(carrier.locatedAt)}, ${entityId} is at ${entity.locatedAt}`;
      return undefined;
    }
    if (change.stateRef === "agentlife.world/placed-on") {
      const support = relationTarget(change.newValue);
      if (support === null) return undefined;
      const carried = entity.heldBy;
      if (carried === null) return `${entityId} is not carried, so it cannot be put down`;
      const carrier = state.entities[carried];
      const other = state.entities[support];
      if (carrier === undefined || other === undefined) return `unknown carrier or support for ${entityId}`;
      if (carrier.locatedAt === null || carrier.locatedAt !== other.locatedAt)
        return `${carried} is at ${String(carrier.locatedAt)}, ${support} is at ${String(other.locatedAt)}`;
      return undefined;
    }
    if (change.stateRef === "agentlife.world/located-at" && entity.kind === "character") {
      const destination = relationTarget(change.newValue);
      if (destination === null) return undefined;
      if (state.entities[destination]?.kind !== "location") return `${destination} is not a place`;
      const from = entity.locatedAt;
      if (from === null || from === destination) return undefined;
      const exits = this.locationExits(from);
      if (!exits.includes(destination)) return `${destination} is not an exit of ${from}`;
      return undefined;
    }
    return undefined;
  }

  /** Declared exits of one place, straight from its content item. */
  locationExits(locationRef: string): readonly string[] {
    const item = this.config.items.find((candidate) => candidate.ref === locationRef);
    const exits = item?.values["exits"];
    return Array.isArray(exits) ? exits.filter((entry): entry is string => typeof entry === "string") : [];
  }

  private readState(state: WorldState, change: StateChangeRequest): SimpleValue | null {
    if (change.stateRef.startsWith("agentlife.world/environment."))
      return state.environment[change.stateRef.slice("agentlife.world/environment.".length)] ?? null;
    const entity = change.entityId === null ? undefined : state.entities[change.entityId];
    if (entity === undefined) return null;
    if (change.stateRef === "agentlife.world/located-at") return entity.locatedAt;
    if (change.stateRef === "agentlife.world/held-by") return entity.heldBy;
    return entity.placedOn;
  }

  /** Relation invariants the rules can never bypass. */
  invariantProblems(state: WorldState): readonly string[] {
    const problems: string[] = [];
    for (const entity of entitiesSorted(state)) {
      const relationCount = [entity.locatedAt, entity.heldBy, entity.placedOn].filter(
        (target) => target !== null,
      ).length;
      if (relationCount > 1) problems.push(`${entity.entityId} carries more than one position relation`);
      if (entity.kind !== "location" && relationCount === 0)
        problems.push(`${entity.entityId} has no position relation`);
      if (entity.kind === "location" && relationCount > 0)
        problems.push(`${entity.entityId} is a place and cannot be held, carried or placed`);
      if (entity.kind !== "item" && (entity.heldBy !== null || entity.placedOn !== null))
        problems.push(`${entity.entityId} is a ${entity.kind} and cannot be held or placed`);
      if (entity.heldBy === entity.entityId || entity.placedOn === entity.entityId)
        problems.push(`${entity.entityId} cannot hold or support itself`);
      for (const target of [entity.locatedAt, entity.heldBy, entity.placedOn]) {
        if (target === null) continue;
        const other = state.entities[target];
        if (other === undefined) {
          problems.push(`${entity.entityId} references unknown entity ${target}`);
          continue;
        }
        if (other.kind === "location" && entity.heldBy === target)
          problems.push(`${entity.entityId} cannot be held by the place ${target}`);
        if (entity.placedOn === target && other.kind !== "item")
          problems.push(`${entity.entityId} can only be placed on an item, not on ${target}`);
      }
    }
    for (const entity of entitiesSorted(state)) {
      if (entity.heldBy !== null && state.entities[entity.heldBy]?.kind !== "character")
        problems.push(`${entity.entityId} is held by ${entity.heldBy}, which is not a character`);
      if (entity.locatedAt !== null && state.entities[entity.locatedAt]?.kind !== "location")
        problems.push(`${entity.entityId} is located at ${entity.locatedAt}, which is not a place`);
    }
    problems.push(...this.supportCycles(state));
    return problems;
  }

  private supportCycles(state: WorldState): readonly string[] {
    const problems: string[] = [];
    for (const entity of entitiesSorted(state)) {
      const seen = new Set<string>([entity.entityId]);
      let current: string | null = entity.placedOn;
      while (current !== null) {
        if (seen.has(current)) {
          problems.push(`${entity.entityId} is placed on itself through ${current}`);
          break;
        }
        seen.add(current);
        current = state.entities[current]?.placedOn ?? null;
      }
    }
    return problems;
  }

  /** The entities that take part in one influence: actor, subject and support. */
  private participants(state: WorldState, request: WorldInfluenceRequest): readonly string[] {
    const participants = new Set<string>([request.actor]);
    if (state.entities[request.subject] !== undefined && request.subject !== request.actor)
      participants.add(request.subject);
    const destination = request.destination;
    if (destination !== null && state.entities[destination]?.kind !== "location" && destination !== request.actor)
      participants.add(destination);
    return [...participants].sort();
  }

  private emptyCommit(state: WorldState): WorldCommit {
    return { state, applied: [], rejected: [], events: [] };
  }
}

function entitiesSorted(state: WorldState): readonly WorldEntity[] {
  return Object.values(state.entities).sort((left, right) => (left.entityId < right.entityId ? -1 : 1));
}

function bumpVersion(version: string): string {
  const separator = version.lastIndexOf("-");
  const counter = Number(version.slice(separator + 1));
  return `${version.slice(0, separator)}-${Number.isFinite(counter) ? counter + 1 : 1}`;
}

function capEvents(events: readonly WorldEvent[], maximum: number): readonly WorldEvent[] {
  return Object.freeze(events.length <= maximum ? [...events] : events.slice(events.length - maximum));
}

export { bumpVersion, capEvents };
