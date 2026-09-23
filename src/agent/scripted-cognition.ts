import type { CognitionInput } from "../simulation/types.js";

/** One scripted decision, expressed as the raw arguments of the submission tool. */
export type ScriptedDraft = (input: CognitionInput) => unknown;

/** The demo's walking action; a scripted policy is tied to the content it runs on. */
const WALK = "agentlife.demo/walk";

/**
 * Faux cognition policies.
 *
 * A faux provider has no model behind it, so a demo or a test has to say what the
 * entity decides. Every policy below goes through the real submission path: it
 * returns raw tool arguments, and the adapter, the coordinator and the body
 * validate them exactly as they validate a real model's answer.
 */

/** Acts on nothing and commits to the longest wait the content allows. */
export const idleDecision: ScriptedDraft = (input: CognitionInput): unknown => ({
  attention: [],
  understanding: "眼前没有必须立刻处理的事",
  questions: [],
  persistence: "",
  intentionChanges: [],
  speech: null,
  steps: [],
  idle: {
    kind: "external-event",
    detail: "等一件能听见的事",
    event: "utterance",
    waitTicks: input.idleWaitLimitTicks,
    reviewInTicks: 1,
  },
  consumedObservations: [],
  consideredIntentions: [],
});

/**
 * Answers the first utterance it hears and goes to where the speaker is.
 *
 * The policy reads only the request: the heard line names the speaker by its
 * observer-local reference, and the exit observation is the place it may walk to.
 */
export const answeringDecision: ScriptedDraft = (input: CognitionInput): unknown => {
  // Only a line that names an object can be answered; one's own words name none.
  const heard = input.observations.find(
    (observation) => observation.reference !== null && observation.text.includes("说："),
  );
  if (heard === undefined) return idleDecision(input);
  const exit = input.observations.find((observation) => observation.reference !== null && observation.role === "exit");
  const walk = input.actions.find((action) => action.action === WALK);
  const destination = exit?.reference;
  const steps = destination === undefined || walk === undefined ? [] : [{ action: walk.action, destination }];
  return {
    attention: [heard.reference as string],
    understanding: `${heard.reference}向我说话了`,
    questions: [],
    persistence: "先回应眼前这个人",
    intentionChanges: [{ intentionId: null, content: "回应向我说话的人", status: "active" }],
    speech: "我在果园里。你要过来吗？",
    steps,
    idle: null,
    consumedObservations: [heard.reference as string],
    consideredIntentions: [],
  };
};

/**
 * Walks to the first exit in view.
 *
 * A scripted way to make a character leave the place it stands in, so a test or a
 * demo can observe a disappearance and a later reappearance.
 */
export const walkingDecision: ScriptedDraft = (input: CognitionInput): unknown => {
  const exit = input.observations.find((observation) => observation.reference !== null && observation.role === "exit");
  const walk = input.actions.find((action) => action.action === WALK);
  if (exit === undefined || walk === undefined) return idleDecision(input);
  return {
    attention: [exit.reference as string],
    understanding: `可以从${exit.reference}走出去`,
    questions: [],
    persistence: "先离开这里",
    intentionChanges: [],
    speech: null,
    steps: [{ action: walk.action, destination: exit.reference as string }],
    idle: null,
    consumedObservations: [exit.reference as string],
    consideredIntentions: [],
  };
};

/** Idles until a tick and walks from then on: lets a script hold a character still first. */
export function walkingFrom(tick: number): ScriptedDraft {
  return (input: CognitionInput): unknown => (input.tick < tick ? idleDecision(input) : walkingDecision(input));
}
