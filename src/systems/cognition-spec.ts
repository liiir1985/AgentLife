import { Type } from "typebox";
import { error } from "../config/diagnostics.js";
import type { SystemCheck, SystemItem, SystemSpec } from "../config/system-spec.js";

/**
 * Cognition system system.
 *
 * The cognition system owns what an AI normal entity is allowed to decide and
 * how long it may wait. Its content is a single settings item plus the authored
 * prompt the model is called with: the settings item fixes the bounded sizes the
 * runtime must respect (short plan length, bounded idle wait, model attempts,
 * request timeout), names the actions a decision may request, and carries the
 * provider and model the runtime starts with.
 *
 * Nothing here describes what a character should think. A prompt is text handed
 * to the model; it never becomes a rule, and no field of this system can form or
 * choose an intention on the model's behalf.
 */

/** A short body plan is what one decision may carry; three steps is the bound. */
const MAX_PLAN_STEPS = 3;

const COGNITION_SCHEMA = Type.Object(
  {
    name: Type.String(),
    description: Type.String(),
    /** Working Memory capacity for admitted observations. */
    observationCapacity: Type.Integer({ minimum: 1 }),
    /** Working Memory capacity reserved for intention references. */
    intentionReservation: Type.Integer({ minimum: 0 }),
    /** Subjects one entity may hold in attention at once. */
    attentionCapacity: Type.Integer({ minimum: 1 }),
    /** Action steps one AI decision may carry. */
    maxPlanSteps: Type.Integer({ minimum: 1 }),
    /** Model attempts, including the first, before the round reports a failure. */
    maxAttempts: Type.Integer({ minimum: 1 }),
    /** Wall-clock seconds one model request may take. */
    requestTimeoutSeconds: Type.Number({ exclusiveMinimum: 0 }),
    /** Ticks between two deterministic re-reviews of an idle commitment. */
    idleReviewTicks: Type.Integer({ minimum: 1 }),
    /** Hard bound on how long an idle commitment may wait for an external event. */
    idleWaitLimitTicks: Type.Integer({ minimum: 1 }),
    provider: Type.String(),
    model: Type.String(),
    /** The body actions a decision may request. */
    allowedActions: Type.Array(Type.String()),
  },
  { additionalProperties: false },
);

const PROMPT_SCHEMA = Type.Object(
  {
    name: Type.String(),
    description: Type.String(),
    text: Type.String(),
  },
  { additionalProperties: false },
);

function settingsProblems(item: SystemItem, report: (message: string) => void): void {
  const planSteps = item.values.maxPlanSteps;
  if (typeof planSteps === "number" && planSteps > MAX_PLAN_STEPS)
    report(`${item.ref} allows ${planSteps} plan steps, a phase 4 decision carries at most ${MAX_PLAN_STEPS}`);
  const review = item.values.idleReviewTicks;
  const limit = item.values.idleWaitLimitTicks;
  if (typeof review === "number" && typeof limit === "number" && review > limit)
    report(`${item.ref} reviews an idle commitment after its wait limit has already expired`);
  for (const field of ["provider", "model"] as const) {
    const value = item.values[field];
    if (typeof value !== "string" || value.trim() === "") report(`${item.ref} declares no ${field}`);
  }
  const actions = Array.isArray(item.values.allowedActions) ? item.values.allowedActions : [];
  if (actions.length === 0) report(`${item.ref} allows no action, so no decision could ever act`);
}

export function createCognitionSpec(): SystemSpec {
  return {
    name: "cognition",
    namespace: "agentlife.cognition",
    version: "1.0.0",
    kernel: ">=1.0.0 <2.0.0",
    requires: ["agentlife.perception", "agentlife.body"],
    items: [
      {
        kind: "settings",
        fields: COGNITION_SCHEMA,
        references: { allowedActions: ["agentlife.body/action"] },
        overridable: [
          "name",
          "description",
          "observationCapacity",
          "intentionReservation",
          "attentionCapacity",
          "maxPlanSteps",
          "maxAttempts",
          "requestTimeoutSeconds",
          "idleReviewTicks",
          "idleWaitLimitTicks",
          "provider",
          "model",
          "allowedActions",
        ],
        merge: {
          name: "replace",
          description: "replace",
          observationCapacity: "replace",
          intentionReservation: "replace",
          attentionCapacity: "replace",
          maxPlanSteps: "replace",
          maxAttempts: "replace",
          requestTimeoutSeconds: "replace",
          idleReviewTicks: "replace",
          idleWaitLimitTicks: "replace",
          provider: "replace",
          model: "replace",
          allowedActions: "replace",
        },
      },
      {
        kind: "prompt",
        fields: PROMPT_SCHEMA,
        overridable: ["name", "description", "text"],
        merge: { name: "replace", description: "replace", text: "replace" },
      },
    ],
    inputs: [],
    triggers: ["decision-formed"],
    outputs: [],
    propagation: [],
    validate: ({ packNamespace, items, report }: SystemCheck) => {
      const settings = items.filter((item) => item.type === "agentlife.cognition/settings");
      const rootSettings = settings.filter((item) => item.namespace === packNamespace);
      if (rootSettings.length > 1)
        report(
          error(
            "system",
            "system-rejected",
            `The root pack must declare at most one cognition settings item, found ${rootSettings.length}`,
            { subject: "agentlife.cognition" },
          ),
        );
      for (const item of settings)
        settingsProblems(item, (message) => report(error("system", "system-rejected", message, { subject: item.ref })));
      const prompts = items.filter((item) => item.type === "agentlife.cognition/prompt");
      if (settings.length > 0 && prompts.length === 0)
        report(
          error("system", "system-rejected", "Cognition settings are declared without a prompt for the model", {
            subject: "agentlife.cognition",
          }),
        );
      for (const prompt of prompts)
        if (typeof prompt.values.text !== "string" || prompt.values.text.trim() === "")
          report(error("system", "system-rejected", `${prompt.ref} carries an empty prompt`, { subject: prompt.ref }));
    },
  };
}
