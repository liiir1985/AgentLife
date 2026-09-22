import { Type, type TSchema } from "typebox";
import { Value } from "typebox/value";
import type { RuntimeConfig } from "../config/config-builder.js";
import { SIMULATION_SAVE_TYPE, SIMULATION_SAVE_VERSION } from "../storage/runtime-store.js";
import type { VersionedPayload } from "../storage/runtime-store-probe.js";
import type { BehaviorRuntimeState } from "../behavior/behavior-tree-adapter.js";
import type { SimulationSettings, SimulationState, TickStage } from "./types.js";

/**
 * Explicit saves.
 *
 * One save carries everything needed to continue the simulation from that exact
 * boundary: the tick and simulated time, the config identity and system versions,
 * and the complete authoritative state of the world, the characters and the
 * bodies. A save never carries a display summary, and loading never reinterprets
 * content: an unknown version, a different config or a payload that does not match
 * the declared shape is refused rather than silently replaced.
 */

const SCALAR = Type.Union([Type.Number(), Type.Boolean(), Type.String()]);
const SCALAR_MAP = Type.Record(Type.String(), SCALAR);
const NULLABLE_STRING = Type.Union([Type.String(), Type.Null()]);

const ENTITY_SCHEMA = Type.Object(
  {
    entityId: Type.String(),
    kind: Type.Union([Type.Literal("location"), Type.Literal("item"), Type.Literal("character")]),
    locatedAt: NULLABLE_STRING,
    heldBy: NULLABLE_STRING,
    placedOn: NULLABLE_STRING,
    attributes: SCALAR_MAP,
  },
  { additionalProperties: false },
);

const PROCESS_SCHEMA = Type.Object(
  {
    processRef: Type.String(),
    ownerId: NULLABLE_STRING,
    establishedTick: Type.Number(),
    params: SCALAR_MAP,
  },
  { additionalProperties: false },
);

const EVENT_SCHEMA = Type.Object(
  {
    eventId: Type.String(),
    tick: Type.Number(),
    kind: Type.String(),
    actor: NULLABLE_STRING,
    subject: NULLABLE_STRING,
    stateRef: NULLABLE_STRING,
    from: Type.Union([SCALAR, Type.Null()]),
    to: Type.Union([SCALAR, Type.Null()]),
  },
  { additionalProperties: false },
);

const WORLD_SCHEMA = Type.Object(
  {
    version: Type.String(),
    entities: Type.Record(Type.String(), ENTITY_SCHEMA),
    environment: SCALAR_MAP,
    processes: Type.Array(PROCESS_SCHEMA),
    events: Type.Array(EVENT_SCHEMA),
  },
  { additionalProperties: false },
);

const CHARACTER_SCHEMA = Type.Object(
  {
    entityId: Type.String(),
    tier: Type.Union([Type.Literal("dynamic"), Type.Literal("degraded"), Type.Literal("normal")]),
    control: Type.Union([
      Type.Literal("none"),
      Type.Literal("behaviour-tree"),
      Type.Literal("cognition"),
      Type.Literal("user"),
    ]),
    main: Type.Boolean(),
    lifecycle: Type.Union([Type.Literal("created"), Type.Literal("running"), Type.Literal("paused")]),
    identityVersion: Type.Number(),
    homeLocation: Type.String(),
    bodyConfig: NULLABLE_STRING,
    behaviourTree: NULLABLE_STRING,
    localView: NULLABLE_STRING,
  },
  { additionalProperties: false },
);

const BODY_SCHEMA = Type.Object(
  {
    entityId: Type.String(),
    configRef: Type.String(),
    values: SCALAR_MAP,
    channels: SCALAR_MAP,
    participation: Type.String(),
    mode: Type.String(),
    processes: Type.Array(PROCESS_SCHEMA),
  },
  { additionalProperties: false },
);

const STEP_SCHEMA = Type.Object(
  {
    action: Type.String(),
    target: Type.Optional(Type.String()),
    destination: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

const PLAN_SCHEMA = Type.Object(
  {
    planId: Type.String(),
    entityId: Type.String(),
    source: Type.Union([Type.Literal("diagnostic"), Type.Literal("behaviour-tree"), Type.Literal("cognition")]),
    formedVersion: Type.String(),
    conflict: Type.Union([Type.Literal("parallel"), Type.Literal("queue"), Type.Literal("replace")]),
    steps: Type.Array(STEP_SCHEMA),
  },
  { additionalProperties: false },
);

const ACTION_SCHEMA = Type.Object(
  {
    actionId: Type.String(),
    entityId: Type.String(),
    plan: PLAN_SCHEMA,
    stepIndex: Type.Number(),
    action: Type.String(),
    status: Type.String(),
    stageIndex: Type.Number(),
    stageTicks: Type.Number(),
    acceptedTick: Type.Number(),
    eligibleTick: Type.Number(),
    target: NULLABLE_STRING,
    destination: NULLABLE_STRING,
    resources: Type.Array(Type.String()),
    worldRequest: Type.Unknown(),
    outcome: Type.Unknown(),
  },
  { additionalProperties: false },
);

const BEHAVIOUR_SCHEMA = Type.Object(
  {
    tick: Type.Number(),
    blackboard: Type.Unknown(),
    plan: Type.Array(Type.String()),
    trace: Type.Unknown(),
    appliedKeys: Type.Array(Type.String()),
    cooldownUntilTick: Type.Number(),
    activePlanId: NULLABLE_STRING,
    inputVersion: Type.String(),
  },
  { additionalProperties: false },
);

const ACTIVITY_SCHEMA = Type.Object(
  {
    active: Type.Array(
      Type.Object(
        {
          entryId: Type.String(),
          category: Type.Union([Type.Literal("entity"), Type.Literal("world-process"), Type.Literal("body-process")]),
        },
        { additionalProperties: false },
      ),
    ),
    scheduled: Type.Array(
      Type.Object({ entryId: Type.String(), tick: Type.Number() }, { additionalProperties: false }),
    ),
  },
  { additionalProperties: false },
);

const SETTINGS_SCHEMA = Type.Object(
  {
    tickSeconds: Type.Number(),
    maxPropagationRounds: Type.Number(),
    maxEvents: Type.Number(),
  },
  { additionalProperties: false },
);

/** The complete authoritative state one save carries. */
export const saveStateSchema: TSchema = Type.Object(
  {
    timelineId: Type.String(),
    tick: Type.Number(),
    simTime: Type.Object({ tick: Type.Number(), seconds: Type.Number() }, { additionalProperties: false }),
    phase: Type.String(),
    configId: Type.String(),
    runMode: Type.String(),
    settings: SETTINGS_SCHEMA,
    world: WORLD_SCHEMA,
    characters: Type.Object(
      { version: Type.String(), characters: Type.Record(Type.String(), CHARACTER_SCHEMA) },
      { additionalProperties: false },
    ),
    body: Type.Object(
      { version: Type.String(), bodies: Type.Record(Type.String(), BODY_SCHEMA) },
      { additionalProperties: false },
    ),
    behaviours: Type.Record(Type.String(), BEHAVIOUR_SCHEMA),
    activity: ACTIVITY_SCHEMA,
    actions: Type.Array(ACTION_SCHEMA),
    barrier: Type.Unknown(),
    failure: Type.Unknown(),
    /** A tick summary is a display record; a save stores the boundary state only. */
    summary: Type.Union([Type.Null(), Type.Unknown()]),
    claimedChangeIds: Type.Array(Type.String()),
  },
  { additionalProperties: false },
);

export interface SaveSnapshot {
  readonly saveId: string;
  readonly timelineId: string;
  readonly tick: number;
  readonly simTime: SimulationState["simTime"];
  readonly phase: TickStage;
  readonly configId: string;
  readonly systems: readonly { readonly systemId: string; readonly version: string; readonly specHash: string }[];
  readonly settings: SimulationSettings;
  readonly state: SimulationState;
}

export type SnapshotRead =
  { readonly ok: true; readonly snapshot: SaveSnapshot } | { readonly ok: false; readonly reason: string };

export type SnapshotCheck = { readonly ok: true } | { readonly ok: false; readonly reason: string };

/** Payload carried inside the store envelope, state included. */
export const savePayloadSchema: TSchema = Type.Object(
  {
    saveId: Type.String(),
    timelineId: Type.String(),
    tick: Type.Number(),
    phase: Type.String(),
    configId: Type.String(),
    systems: Type.Array(
      Type.Object(
        { systemId: Type.String(), version: Type.String(), specHash: Type.String() },
        { additionalProperties: false },
      ),
    ),
    settings: SETTINGS_SCHEMA,
    state: saveStateSchema,
  },
  { additionalProperties: false },
);

/** One explicit save of the current stable state. */
export function snapshotOf(state: SimulationState, saveId: string, config: RuntimeConfig): SaveSnapshot {
  return {
    saveId,
    timelineId: state.timelineId,
    tick: state.tick,
    simTime: state.simTime,
    phase: state.phase,
    configId: state.configId,
    systems: config.systems.map((system) => ({ ...system })),
    settings: state.settings,
    state,
  };
}

export function encodeSnapshot(snapshot: SaveSnapshot): VersionedPayload {
  return {
    schemaVersion: SIMULATION_SAVE_VERSION,
    type: SIMULATION_SAVE_TYPE,
    data: {
      saveId: snapshot.saveId,
      timelineId: snapshot.timelineId,
      tick: snapshot.tick,
      phase: snapshot.phase,
      configId: snapshot.configId,
      systems: snapshot.systems.map((system) => ({ ...system })),
      settings: { ...snapshot.settings },
      state: { ...snapshot.state, summary: null },
    },
  };
}

/** Validates a stored payload against the declared shape of a save. */
export function decodeSnapshot(stored: unknown): SnapshotRead {
  if (typeof stored !== "object" || stored === null) return { ok: false, reason: "save payload is not an object" };
  const envelope = stored as { readonly schemaVersion?: unknown; readonly type?: unknown; readonly data?: unknown };
  if (envelope.schemaVersion !== SIMULATION_SAVE_VERSION || envelope.type !== SIMULATION_SAVE_TYPE)
    return {
      ok: false,
      reason: `save payload has unknown version ${String(envelope.schemaVersion)}:${String(envelope.type)}`,
    };
  const data = envelope.data;
  if (!Value.Check(savePayloadSchema, data)) {
    const first = Value.Errors(savePayloadSchema, data)[0];
    const where = typeof first?.instancePath === "string" && first.instancePath !== "" ? first.instancePath : "<root>";
    return { ok: false, reason: `save payload does not match its declared shape at ${where}` };
  }
  const payload = data as {
    readonly saveId: string;
    readonly timelineId: string;
    readonly tick: number;
    readonly phase: string;
    readonly configId: string;
    readonly systems: SaveSnapshot["systems"];
    readonly settings: SimulationSettings;
    readonly state: SimulationState;
  };
  return {
    ok: true,
    snapshot: {
      saveId: payload.saveId,
      timelineId: payload.timelineId,
      tick: payload.tick,
      simTime: payload.state.simTime,
      phase: payload.phase as TickStage,
      configId: payload.configId,
      systems: payload.systems,
      settings: payload.settings,
      state: payload.state,
    },
  };
}

/** A save may only be loaded against the runtime config and systems it was made with. */
export function checkSnapshot(snapshot: SaveSnapshot, config: RuntimeConfig): SnapshotCheck {
  if (snapshot.configId !== config.configId)
    return {
      ok: false,
      reason: `save refers to config ${snapshot.configId}, the runtime publishes ${config.configId}`,
    };
  if (snapshot.systems.length !== config.systems.length)
    return { ok: false, reason: "save and runtime config declare different systems" };
  for (const system of config.systems) {
    const saved = snapshot.systems.find((candidate) => candidate.systemId === system.systemId);
    if (saved === undefined) return { ok: false, reason: `save was made without system ${system.systemId}` };
    if (saved.version !== system.version || saved.specHash !== system.specHash)
      return {
        ok: false,
        reason: `system ${system.systemId} differs between save (${saved.version}) and runtime (${system.version})`,
      };
  }
  for (const character of Object.values(snapshot.state.characters.characters)) {
    for (const ref of [character.bodyConfig, character.behaviourTree, character.localView]) {
      if (ref === null) continue;
      if (config.items.every((item) => item.ref !== ref))
        return {
          ok: false,
          reason: `${character.entityId} refers to ${ref}, which the runtime config does not declare`,
        };
    }
  }
  for (const entity of Object.values(snapshot.state.world.entities)) {
    for (const target of [entity.locatedAt, entity.heldBy, entity.placedOn]) {
      if (target === null) continue;
      if (snapshot.state.world.entities[target] === undefined)
        return { ok: false, reason: `${entity.entityId} refers to ${target}, which the save does not contain` };
    }
  }
  return { ok: true };
}

export type { BehaviorRuntimeState };
