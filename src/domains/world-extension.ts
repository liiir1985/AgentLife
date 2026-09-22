import { Type } from "typebox";
import { error } from "../config/diagnostics.js";
import type { DomainExtension } from "../config/extension.js";
import { defineValueContainer } from "../config/value-shapes.js";

/**
 * World domain extension.
 *
 * The world domain owns the place graph, item roles and one declared value
 * family: environment facts. Every fact a rule reads or writes is a definition
 * in the pack (`lightLevel`, `fogDensity`, `visibility`, ...), so the set of
 * environmental inputs is content, not kernel vocabulary. The family is not
 * marked contract: one fact may legitimately be written by several rules as long
 * as they agree on a composition method.
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

const WORLD_EXTENSION_REF = "agentlife.world/extension";
/** Domains allowed to read environment facts; the owner is always allowed. */
const ENVIRONMENT_READERS: readonly string[] = ["agentlife.body/extension", "agentlife.character/extension"];

export function createWorldExtension(): DomainExtension {
  return {
    name: "extension",
    namespace: "agentlife.world",
    version: "1.0.0",
    kernel: ">=1.0.0 <2.0.0",
    requires: [],
    configTypes: [
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
        validate: ({ definitions, report }) => {
          for (const definition of definitions) {
            const roles = definition.values.roles;
            if (Array.isArray(roles) && roles.includes("container") && definition.values.containerCapacity === 0)
              report(
                error("domain", "domain-rejected", `${definition.ref} is a container but declares no capacity`, {
                  subject: definition.ref,
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
        family: "environment",
        contract: false,
        view: { exposedTo: ENVIRONMENT_READERS },
        target: { exposedTo: [] },
      }),
    ],
    views: [],
    triggers: ["environment-changed", "world-tick"],
    outputTargets: [],
    validate: ({ packNamespace, definitions, report }) => {
      const worlds = definitions.filter((definition) => definition.type === "agentlife.world/world");
      const rootWorlds = worlds.filter((definition) => definition.namespace === packNamespace);
      if (rootWorlds.length !== 1)
        report(
          error(
            "domain",
            "domain-rejected",
            `The root pack must declare exactly one world settings definition, found ${rootWorlds.length}`,
            { subject: WORLD_EXTENSION_REF },
          ),
        );
    },
  };
}
