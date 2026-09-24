import { Type } from "typebox";
import { error } from "../config/diagnostics.js";
import type { SystemCheck, SystemSpec } from "../config/system-spec.js";

const SETTINGS = Type.Object(
  {
    name: Type.String(),
    description: Type.String(),
    workingLifetimeTicks: Type.Integer({ minimum: 1 }),
    entryLoads: Type.Object(
      {
        observation: Type.Integer({ minimum: 1, maximum: 4 }),
        recollection: Type.Integer({ minimum: 1, maximum: 4 }),
        reflection: Type.Integer({ minimum: 1, maximum: 4 }),
        intention: Type.Integer({ minimum: 1, maximum: 4 }),
      },
      { additionalProperties: false },
    ),
    recentLifetimeTicks: Type.Integer({ minimum: 2 }),
    accessibilityDecayPerTick: Type.Number({ minimum: 0, maximum: 1 }),
    consolidationIntervalTicks: Type.Integer({ minimum: 1 }),
    consolidationBatchSize: Type.Integer({ minimum: 1 }),
    searchCandidateLimit: Type.Integer({ minimum: 1 }),
    searchResultLimit: Type.Integer({ minimum: 1 }),
    searchCallsPerDecision: Type.Integer({ minimum: 1 }),
    recallThreshold: Type.Number({ minimum: 0, maximum: 1 }),
    recognitionThreshold: Type.Number({ minimum: 0, maximum: 1 }),
    structureWeight: Type.Number({ minimum: 0, maximum: 1 }),
    associationWeight: Type.Number({ minimum: 0, maximum: 1 }),
    semanticWeight: Type.Number({ minimum: 0, maximum: 1 }),
    contextWeight: Type.Number({ minimum: 0, maximum: 1 }),
    accessibilityWeight: Type.Number({ minimum: 0, maximum: 1 }),
  },
  { additionalProperties: false },
);

export function createMemorySpec(): SystemSpec {
  const fields = Object.keys(SETTINGS.properties);
  return {
    name: "memory",
    namespace: "agentlife.memory",
    version: "1.0.0",
    kernel: ">=1.0.0 <2.0.0",
    requires: ["agentlife.cognition", "agentlife.perception"],
    items: [
      {
        kind: "settings",
        fields: SETTINGS,
        overridable: fields,
        merge: Object.fromEntries(fields.map((field) => [field, "replace"])) as Record<string, "replace">,
      },
    ],
    inputs: [],
    triggers: [],
    outputs: [],
    propagation: [],
    validate: ({ packNamespace, items, report }: SystemCheck) => {
      const settings = items.filter(
        (item) => item.type === "agentlife.memory/settings" && item.namespace === packNamespace,
      );
      const normalCharacters = items.some(
        (item) => item.type === "agentlife.character/character" && item.values.tier === "normal",
      );
      if (normalCharacters && settings.length === 0)
        report(
          error("system", "system-rejected", "Normal characters require memory settings", {
            subject: "agentlife.memory",
          }),
        );
      if (settings.length > 1)
        report(
          error("system", "system-rejected", "The root pack must declare at most one memory settings item", {
            subject: "agentlife.memory",
          }),
        );
      const values = settings[0]?.values;
      if (
        values !== undefined &&
        ["structureWeight", "associationWeight", "semanticWeight", "contextWeight"].reduce(
          (total, key) => total + Number(values[key]),
          0,
        ) > 1
      )
        report(
          error("system", "system-rejected", "Memory relevance weights exceed one", { subject: settings[0]!.ref }),
        );
      if (values !== undefined && Number(values.searchResultLimit) > Number(values.searchCandidateLimit))
        report(
          error("system", "system-rejected", "Memory results exceed the candidate limit", {
            subject: settings[0]!.ref,
          }),
        );
    },
  };
}
