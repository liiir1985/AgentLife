import { Type } from "typebox";
import { error } from "../config/diagnostics.js";
import type { SystemSpec } from "../config/system-spec.js";
import { defineValueContainer } from "../config/value-shapes.js";

/**
 * World system system.
 *
 * The world system owns the place graph, the generic relations between world
 * entities and one declared value valueSet: environment facts. Every fact a rule
 * inputs or writes is an item in the pack (`light-level`, `fog-density`,
 * ...), so the set of environmental inputs is content, not kernel vocabulary.
 *
 * An item declares only what it is (a name, a description, tags) and the values
 * it gives to the attributes of its own pack. Whether it may be carried, used as
 * a support or operated is not a role the world system hard-codes: it is a
 * content-defined attribute (`portable`, `support`, `operable`) that the entity
 * itself carries. The generic relations only describe where an entity is and
 * what holds it.
 */

/** The values one entity declares for the attributes of the attribute family. */
const ATTRIBUTE_VALUES_SCHEMA = Type.Record(Type.String(), Type.Union([Type.Number(), Type.Boolean(), Type.String()]));

const LOCATION_SCHEMA = Type.Object(
  {
    name: Type.String(),
    description: Type.String(),
    exits: Type.Array(Type.String()),
    tags: Type.Array(Type.String()),
    attributes: Type.Optional(ATTRIBUTE_VALUES_SCHEMA),
  },
  { additionalProperties: false },
);

/** An item is an entity that persists and takes part in world relations. */
const ITEM_SCHEMA = Type.Object(
  {
    name: Type.String(),
    description: Type.String(),
    tags: Type.Array(Type.String()),
    attributes: Type.Optional(ATTRIBUTE_VALUES_SCHEMA),
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

/** A named kind of world influence an action may ask the world to adjudicate. */
const INFLUENCE_SCHEMA = Type.Object(
  {
    name: Type.String(),
    description: Type.String(),
    /** The world relation this influence changes, when it changes one. */
    relation: Type.Optional(
      Type.Union([Type.Literal("located-at"), Type.Literal("held-by"), Type.Literal("placed-on")]),
    ),
  },
  { additionalProperties: false },
);

/**
 * The allow-list of state a degraded entity's behaviour tree may read. Members
 * name a declared input field (`<stateRef>.<field>`), and the shared
 * configuration stage rejects a member that is not a granted runtime view.
 */
const LOCAL_VIEW_SCHEMA = Type.Object(
  {
    name: Type.String(),
    description: Type.String(),
    members: Type.Array(Type.String()),
  },
  { additionalProperties: false },
);

/** The initial position of one world entity, declared by content. */
const PLACEMENT_SCHEMA = Type.Object(
  {
    entity: Type.String(),
    location: Type.String(),
  },
  { additionalProperties: false },
);

const WORLD_SYSTEM_ID = "agentlife.world";
/** Systems allowed to read environment facts and generic relations. */
const WORLD_READERS: readonly string[] = ["agentlife.body", "agentlife.character"];
const ENTITY_REFERENCES = ["agentlife.world/location", "agentlife.world/item", "agentlife.character/character"];

const RELATION_FIELDS: readonly { readonly name: string; readonly field: string }[] = [
  { name: "located-at", field: "location" },
  { name: "held-by", field: "holder" },
  { name: "placed-on", field: "support" },
];

export function createWorldSpec(): SystemSpec {
  return {
    name: "system",
    namespace: "agentlife.world",
    version: "1.1.0",
    kernel: ">=1.0.0 <2.0.0",
    requires: [],
    items: [
      {
        kind: "location",
        fields: LOCATION_SCHEMA,
        defaults: { exits: [], tags: [] },
        references: { exits: ["agentlife.world/location"] },
        memberReferences: { attributes: ["agentlife.world/attribute"] },
        overridable: ["name", "description", "exits", "tags", "attributes"],
        merge: { exits: "append", tags: "append", name: "replace", description: "replace", attributes: "merge" },
      },
      {
        kind: "item",
        fields: ITEM_SCHEMA,
        defaults: { tags: [] },
        memberReferences: { attributes: ["agentlife.world/attribute"] },
        overridable: ["name", "description", "tags", "attributes"],
        merge: { tags: "append", name: "replace", description: "replace", attributes: "merge" },
      },
      {
        kind: "world",
        fields: WORLD_SCHEMA,
        overridable: ["name", "description"],
        merge: { name: "replace", description: "replace" },
      },
      {
        ...defineValueContainer({
          kind: "attribute",
          valueSet: "attributes",
          contract: false,
          input: { scope: "entity", exposedTo: [] },
        }),
      },
      {
        kind: "influence-kind",
        fields: INFLUENCE_SCHEMA,
        overridable: ["name", "description", "relation"],
        merge: { name: "replace", description: "replace", relation: "replace" },
      },
      {
        kind: "local-view",
        fields: LOCAL_VIEW_SCHEMA,
        overridable: ["name", "description", "members"],
        merge: { name: "replace", description: "replace", members: "replace" },
        viewMembers: ["members"],
      },
      {
        kind: "placement",
        fields: PLACEMENT_SCHEMA,
        references: { entity: ENTITY_REFERENCES, location: ["agentlife.world/location"] },
        overridable: ["entity", "location"],
        merge: { entity: "replace", location: "replace" },
      },
      defineValueContainer({
        kind: "fact",
        valueSet: "environment",
        contract: false,
        input: { scope: "shared", exposedTo: WORLD_READERS },
        output: { scope: "shared", exposedTo: [] },
      }),
    ],
    inputs: [
      ...RELATION_FIELDS.map((relation) => ({
        name: relation.name,
        scope: "entity" as const,
        fields: Type.Object({ [relation.field]: Type.String() }, { additionalProperties: false }),
        exposedTo: WORLD_READERS,
      })),
      {
        name: "influence",
        scope: "shared",
        fields: Type.Object(
          {
            kind: Type.String(),
            actor: Type.String(),
            subject: Type.String(),
            destination: Type.String(),
            accepted: Type.Boolean(),
          },
          { additionalProperties: false },
        ),
        // An influence request is scheduler input, not a role-visible fact.
        exposedTo: [],
      },
      {
        name: "participation",
        scope: "entity",
        fields: Type.Object({ role: Type.String() }, { additionalProperties: false }),
        exposedTo: [],
      },
      {
        name: "process",
        scope: "shared",
        fields: Type.Object({ process: Type.String(), gain: Type.Number() }, { additionalProperties: false }),
        units: { gain: "lux" },
        exposedTo: [],
      },
    ],
    triggers: ["environment-changed", "influence-requested", "influence-accepted", "process-advanced"],
    outputs: [
      ...RELATION_FIELDS.map((relation) => ({
        name: relation.name,
        scope: "entity" as const,
        valueType: "string" as const,
        exposedTo: WORLD_READERS,
      })),
      { name: "consent", scope: "entity", valueType: "boolean", exposedTo: [] },
    ],
    processes: [
      {
        name: "lamp-glow",
        scope: "shared",
        operations: ["establish", "advance", "end"],
        parameters: Type.Object({ gain: Type.Number() }, { additionalProperties: false }),
      },
    ],
    propagation: [{ stateRef: "agentlife.world/environment", trigger: "agentlife.world/environment-changed" }],
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
