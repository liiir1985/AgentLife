import { Type } from "typebox";
import { error } from "../config/diagnostics.js";
import type { SystemSpec } from "../config/system-spec.js";
import { defineValueContainer } from "../config/value-shapes.js";

/**
 * World system system.
 *
 * The world system owns the place graph, item roles and one declared value
 * valueSet: environment facts. Every fact a rule inputs or writes is a item
 * in the pack (`lightLevel`, `fogDensity`, `visibility`, ...), so the set of
 * environmental inputs is content, not kernel vocabulary. The valueSet is not
 * marked contract: one fact may legitimately be written by several rules as long
 * as they agree on a combine method.
 *
 * Whether anyone is present, what an entity carries and how a place "feels" stay
 * world-internal; no projection of them exists yet, so none can be read.
 */

const LOCATION_SCHEMA = Type.Object(
  {
    name: Type.String(),
    description: Type.String(),
    exits: Type.Array(Type.String()),
    tags: Type.Array(Type.String()),
  },
  { additionalProperties: false },
);

const ITEM_SCHEMA = Type.Object(
  {
    name: Type.String(),
    description: Type.String(),
    roles: Type.Array(Type.Union([Type.Literal("carryable"), Type.Literal("surface"), Type.Literal("container")])),
    containerCapacity: Type.Number(),
    tags: Type.Array(Type.String()),
  },
  { additionalProperties: false },
);

/** World-level settings of one pack; the environment itself lives in facts. */
const WORLD_SCHEMA = Type.Object(
  {
    name: Type.String(),
    description: Type.String(),
  },
  { additionalProperties: false },
);

const WORLD_SYSTEM_ID = "agentlife.world";
/** Systems allowed to read environment facts; the declaring system is always allowed. */
const ENVIRONMENT_READERS: readonly string[] = ["agentlife.body", "agentlife.character"];

export function createWorldSpec(): SystemSpec {
  return {
    name: "system",
    namespace: "agentlife.world",
    version: "1.0.0",
    kernel: ">=1.0.0 <2.0.0",
    requires: [],
    items: [
      {
        kind: "location",
        fields: LOCATION_SCHEMA,
        defaults: { exits: [], tags: [] },
        references: { exits: ["agentlife.world/location"] },
        overridable: ["name", "description", "exits", "tags"],
        merge: { exits: "append", tags: "append", name: "replace", description: "replace" },
      },
      {
        kind: "item",
        fields: ITEM_SCHEMA,
        defaults: { roles: [], tags: [], containerCapacity: 0 },
        overridable: ["name", "description", "roles", "containerCapacity", "tags"],
        merge: {
          roles: "append",
          tags: "append",
          name: "replace",
          description: "replace",
          containerCapacity: "replace",
        },
        validate: ({ items, report }) => {
          for (const item of items) {
            const roles = item.values.roles;
            if (Array.isArray(roles) && roles.includes("container") && item.values.containerCapacity === 0)
              report(
                error("system", "system-rejected", `${item.ref} is a container but declares no capacity`, {
                  subject: item.ref,
                }),
              );
          }
        },
      },
      {
        kind: "world",
        fields: WORLD_SCHEMA,
        overridable: ["name", "description"],
        merge: { name: "replace", description: "replace" },
      },
      defineValueContainer({
        kind: "fact",
        valueSet: "environment",
        contract: false,
        input: { exposedTo: ENVIRONMENT_READERS },
        output: { exposedTo: [] },
      }),
    ],
    inputs: [],
    triggers: ["environment-changed", "world-tick"],
    outputs: [],
    validate: ({ packNamespace, items, report }) => {
      const worlds = items.filter((item) => item.type === "agentlife.world/world");
      const rootWorlds = worlds.filter((item) => item.namespace === packNamespace);
      if (rootWorlds.length !== 1)
        report(
          error(
            "system",
            "system-rejected",
            `The root pack must declare exactly one world settings item, found ${rootWorlds.length}`,
            { subject: WORLD_SYSTEM_ID },
          ),
        );
    },
  };
}
