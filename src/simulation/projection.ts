import type { RuntimeConfig } from "../config/config-builder.js";
import {
  BODY_ACTIVITY,
  BODY_CHANNELS,
  BODY_MODE,
  BODY_PARTICIPATION,
  BODY_PROCESS,
  BODY_VALUES,
  WORLD_ATTRIBUTES,
  WORLD_FACTS,
  WORLD_INFLUENCE,
  WORLD_PARTICIPATION,
  WORLD_PROCESS,
} from "./config-view.js";
import type { BodyState, CharacterState, WorldState } from "./types.js";

/**
 * Read-only projections of the authoritative state.
 *
 * A rule run never sees a service object: it sees exactly the declared views of
 * the entities the run names. A view that is not projected is not readable, so a
 * missing slice turns into `input-missing` rather than into a hidden default.
 */

export interface ProjectionSources {
  readonly config: RuntimeConfig;
  readonly world: WorldState;
  readonly characters?: CharacterState;
  readonly body?: BodyState;
}

export interface InfluenceView {
  readonly kind: string;
  readonly actor: string;
  readonly subject: string;
  readonly destination: string;
  readonly accepted: boolean;
}

export interface ActivityView {
  readonly action: string;
  readonly stage: string;
  readonly status: string;
}

export interface ProcessView {
  readonly process: string;
  readonly rate: number;
  readonly gain: number;
}

export const IDLE_ACTIVITY: ActivityView = Object.freeze({ action: "", stage: "", status: "idle" });
export const NO_PROCESS: ProcessView = Object.freeze({ process: "", rate: 0, gain: 0 });
export const NO_INFLUENCE: InfluenceView = Object.freeze({
  kind: "",
  actor: "",
  subject: "",
  destination: "",
  accepted: false,
});

export function sharedSlice(
  sources: ProjectionSources,
  influence: InfluenceView = NO_INFLUENCE,
  process: ProcessView = NO_PROCESS,
): Record<string, unknown> {
  return {
    [WORLD_FACTS]: sources.world.environment,
    [WORLD_INFLUENCE]: influence,
    [WORLD_PROCESS]: { process: process.process, gain: process.gain },
  };
}

export function entitySlice(
  sources: ProjectionSources,
  entityId: string,
  options: {
    readonly role?: string | undefined;
    readonly activity?: ActivityView | undefined;
    readonly process?: ProcessView | undefined;
  } = {},
): Record<string, unknown> | undefined {
  const entity = sources.world.entities[entityId];
  const body = sources.body?.bodies[entityId];
  const slice: Record<string, unknown> = {};
  if (entity !== undefined) {
    slice[WORLD_ATTRIBUTES] = entity.attributes;
    slice[WORLD_PARTICIPATION] = { role: options.role ?? "bystander" };
    slice["agentlife.world/located-at"] = { location: entity.locatedAt ?? "" };
    slice["agentlife.world/held-by"] = { holder: entity.heldBy ?? "" };
    slice["agentlife.world/placed-on"] = { support: entity.placedOn ?? "" };
  }
  if (body !== undefined) {
    slice[BODY_VALUES] = body.values;
    slice[BODY_CHANNELS] = body.channels;
    slice[BODY_PARTICIPATION] = { permission: body.participation };
    slice[BODY_MODE] = { mode: body.mode };
    slice[BODY_ACTIVITY] = options.activity ?? IDLE_ACTIVITY;
    slice[BODY_PROCESS] = { process: options.process?.process ?? "", rate: options.process?.rate ?? 0 };
  }
  return Object.keys(slice).length === 0 ? undefined : slice;
}

/** Every entity that has an objective identity in the current state. */
export function knownEntities(sources: ProjectionSources): readonly string[] {
  const ids = new Set(Object.keys(sources.world.entities));
  for (const entityId of Object.keys(sources.body?.bodies ?? {})) ids.add(entityId);
  return [...ids].sort();
}
