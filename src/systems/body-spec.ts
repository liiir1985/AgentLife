import { Type } from "typebox";
import { error } from "../config/diagnostics.js";
import type { SystemSpec } from "../config/system-spec.js";
import { defineChannelContainer, defineValueContainer } from "../config/value-shapes.js";

/**
 * Body system system.
 *
 * The body system owns two kinds of declared value and one contract value:
 *
 * - `value` items (stamina, load, ...) are content values: several rules
 *   may write them as long as they agree on one combine method, because the
 *   body runtime is the only authority that can judge the resulting state.
 * - `channel` items (vision, ...) are contract values: each channel
 *   contributes `<id>.available` and `<id>.efficiency`, and exactly one rule per
 *   field writes it, so perception can rely on a single, unambiguous producer.
 * - `cognitive-participation` is the contract value the cognition system inputs
 *   before it may run at all; the body system owns its vocabulary.
 *
 * Phase 2 adds the execution vocabulary: abilities, exclusive or compatible
 * resources, physical modes and the actions a body may run. None of it is
 * inferred from a value name — an action states the ability it needs, the
 * resources each stage holds and how long each stage lasts, and a body instance
 * states the abilities, resources and modes it actually has.
 */

const PARTICIPATION_VOCABULARY: readonly string[] = ["allowed", "restricted", "forbidden"];

const PARTICIPATION_VIEW = Type.Object({ permission: Type.String() }, { additionalProperties: false });

/** Readers allowed to see body values and channels; owners are always allowed. */
const BODY_READERS: readonly string[] = ["agentlife.character"];

const NAMED_SCHEMA = Type.Object(
  {
    name: Type.String(),
    description: Type.String(),
  },
  { additionalProperties: false },
);

const RESOURCE_SCHEMA = Type.Object(
  {
    name: Type.String(),
    description: Type.String(),
    exclusive: Type.Boolean(),
  },
  { additionalProperties: false },
);

const MODE_SCHEMA = Type.Object(
  {
    name: Type.String(),
    description: Type.String(),
    abilities: Type.Array(Type.String()),
  },
  { additionalProperties: false },
);

const BODY_SCHEMA = Type.Object(
  {
    name: Type.String(),
    description: Type.String(),
    abilities: Type.Array(Type.String()),
    resources: Type.Array(Type.String()),
    modes: Type.Array(Type.String()),
    initialMode: Type.String(),
  },
  { additionalProperties: false },
);

/** One stage of an action: how long it lasts and which resources it holds. */
const STAGE_SCHEMA = Type.Object(
  {
    name: Type.String(),
    ticks: Type.Integer(),
    resource: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

/**
 * Declaration that an action becomes audible once it completes. The text is the
 * value of the named input field; the body system never interprets it, and the
 * world only records it after every stage of the action has finished.
 */
const UTTERANCE_SCHEMA = Type.Object(
  {
    /** Input field of the action step that carries the spoken text. */
    field: Type.String(),
  },
  { additionalProperties: false },
);

const ACTION_SCHEMA = Type.Object(
  {
    name: Type.String(),
    description: Type.String(),
    ability: Type.String(),
    interruptible: Type.Boolean(),
    worldInfluence: Type.Optional(Type.String()),
    utterance: Type.Optional(UTTERANCE_SCHEMA),
    stages: Type.Array(STAGE_SCHEMA),
  },
  { additionalProperties: false },
);

function actionProblems(
  item: { readonly ref: string; readonly values: Readonly<Record<string, unknown>> },
  resources: ReadonlySet<string>,
  report: (message: string) => void,
): void {
  const stages = Array.isArray(item.values.stages) ? item.values.stages : [];
  if (stages.length === 0) report(`${item.ref} declares no stage`);
  for (const stage of stages) {
    if (typeof stage !== "object" || stage === null) continue;
    const ticks: unknown = Reflect.get(stage, "ticks");
    if (typeof ticks !== "number" || !Number.isInteger(ticks) || ticks < 1)
      report(`${item.ref} declares a stage that does not last a positive whole number of ticks`);
    const resource: unknown = Reflect.get(stage, "resource");
    if (typeof resource === "string" && !resources.has(resource))
      report(`${item.ref} names unknown resource ${resource}`);
  }
  const utterance = item.values.utterance;
  if (utterance === undefined) return;
  const field = typeof utterance === "object" && utterance !== null ? Reflect.get(utterance, "field") : undefined;
  if (typeof field !== "string" || field.trim() === "")
    report(`${item.ref} declares an utterance whose text field is empty`);
  else if (item.values.worldInfluence !== undefined)
    report(`${item.ref} changes the world and speaks in the same action`);
}

export function createBodySpec(): SystemSpec {
  return {
    name: "system",
    namespace: "agentlife.body",
    version: "1.2.0",
    kernel: ">=1.0.0 <2.0.0",
    requires: [],
    items: [
      defineValueContainer({
        kind: "value",
        valueSet: "values",
        contract: false,
        input: { scope: "entity", exposedTo: BODY_READERS },
        output: { scope: "entity", exposedTo: [] },
      }),
      defineChannelContainer({
        kind: "channel",
        valueSet: "channels",
        contract: true,
        input: { scope: "entity", exposedTo: BODY_READERS },
        output: { scope: "entity", exposedTo: [] },
      }),
      {
        kind: "ability",
        fields: NAMED_SCHEMA,
        overridable: ["name", "description"],
        merge: { name: "replace", description: "replace" },
      },
      {
        kind: "resource",
        fields: RESOURCE_SCHEMA,
        overridable: ["name", "description", "exclusive"],
        merge: { name: "replace", description: "replace", exclusive: "replace" },
      },
      {
        kind: "mode",
        fields: MODE_SCHEMA,
        references: { abilities: ["agentlife.body/ability"] },
        overridable: ["name", "description", "abilities"],
        merge: { name: "replace", description: "replace", abilities: "append" },
      },
      {
        kind: "body",
        fields: BODY_SCHEMA,
        references: {
          abilities: ["agentlife.body/ability"],
          resources: ["agentlife.body/resource"],
          modes: ["agentlife.body/mode"],
          initialMode: ["agentlife.body/mode"],
        },
        overridable: ["name", "description", "abilities", "resources", "modes", "initialMode"],
        merge: {
          name: "replace",
          description: "replace",
          abilities: "append",
          resources: "append",
          modes: "append",
          initialMode: "replace",
        },
      },
      {
        kind: "action",
        fields: ACTION_SCHEMA,
        references: { ability: ["agentlife.body/ability"], worldInfluence: ["agentlife.world/influence-kind"] },
        overridable: ["name", "description", "ability", "interruptible", "worldInfluence", "utterance", "stages"],
        merge: {
          name: "replace",
          description: "replace",
          ability: "replace",
          interruptible: "replace",
          worldInfluence: "replace",
          utterance: "replace",
          stages: "replace",
        },
      },
    ],
    inputs: [
      {
        name: "cognitive-participation",
        scope: "entity",
        fields: PARTICIPATION_VIEW,
        exposedTo: BODY_READERS,
      },
      {
        name: "activity",
        scope: "entity",
        fields: Type.Object(
          { action: Type.String(), stage: Type.String(), status: Type.String() },
          { additionalProperties: false },
        ),
        exposedTo: BODY_READERS,
      },
      {
        name: "current-mode",
        scope: "entity",
        fields: Type.Object({ mode: Type.String() }, { additionalProperties: false }),
        exposedTo: BODY_READERS,
      },
      {
        name: "process",
        scope: "entity",
        fields: Type.Object({ process: Type.String(), rate: Type.Number() }, { additionalProperties: false }),
        units: { rate: "points" },
        // Process parameters are scheduler input for the rule that advances them.
        exposedTo: [],
      },
    ],
    triggers: ["tick-elapsed", "value-changed", "action-advanced", "process-advanced", "external-influence"],
    outputs: [
      {
        name: "cognitive-participation",
        scope: "entity",
        valueType: "string",
        allowedValues: PARTICIPATION_VOCABULARY,
        exposedTo: [],
      },
      { name: "current-mode", scope: "entity", valueType: "string", exposedTo: [] },
    ],
    processes: [
      {
        name: "recovery",
        scope: "entity",
        operations: ["establish", "advance", "end"],
        parameters: Type.Object({ rate: Type.Number() }, { additionalProperties: false }),
      },
    ],
    propagation: [
      { stateRef: "agentlife.body/values", trigger: "agentlife.body/value-changed" },
      { stateRef: "agentlife.body/channels", trigger: "agentlife.body/value-changed" },
    ],
    validate: ({ items, report }) => {
      const resources = new Set(
        items.filter((item) => item.type === "agentlife.body/resource").map((item) => item.ref),
      );
      for (const item of items.filter((candidate) => candidate.type === "agentlife.body/action"))
        actionProblems(item, resources, (message) =>
          report(error("system", "system-rejected", message, { subject: item.ref })),
        );
      for (const item of items.filter((candidate) => candidate.type === "agentlife.body/body")) {
        const modes = Array.isArray(item.values.modes) ? item.values.modes : [];
        if (!modes.includes(item.values.initialMode))
          report(
            error(
              "system",
              "system-rejected",
              `${item.ref} declares initial mode ${String(item.values.initialMode)}, which it does not list`,
              { subject: item.ref },
            ),
          );
      }
    },
  };
}
