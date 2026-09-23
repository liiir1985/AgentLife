import { describe, expect, it } from "vitest";
import { cognitionRequestMessage, PiCognitionAgent } from "../src/agent/cognition-agent.js";
import type { CognitionInput } from "../src/simulation/types.js";
import { scriptedModel } from "./helpers/cognition.js";

/** Slow enough that a request is still in flight while it is superseded or out of time. */
const SLOW_RATE = 25;
/** Slow enough to stay in flight right after it starts, fast enough for its successor to settle. */
const SUPERSEDED_RATE = 400;

/** A complete request as the coordinator issues it; tests change only what they assert. */
function cognitionInput(changes: Partial<CognitionInput> = {}): CognitionInput {
  const base: CognitionInput = {
    characterId: "character-1",
    requestId: "request-1",
    roundId: "round-1",
    tick: 40,
    stateVersion: "world-1/characters-1/body-1",
    systemPrompt: "You are the cognition of one character. Submit exactly one decision.",
    situation: "The room is quiet; a lamp stands on the table.",
    attention: ["the lamp"],
    idle: null,
    observations: [
      { observationId: "observation-1", reference: "the lamp", text: "a lamp stands on the table", role: "item" },
    ],
    intentions: [{ intentionId: "intention-1", content: "find the key", status: "active" }],
    actions: [{ action: "agentlife.demo/walk", name: "walk", description: "walk to a place" }],
    maxSteps: 3,
    idleWaitLimitTicks: 12,
    attempt: 1,
    rejection: null,
    timeoutMs: 20_000,
    ...changes,
  };
  return base;
}

/** The tool arguments a cooperating model would submit. */
function draftedDecision(): Record<string, unknown> {
  return {
    attention: ["the lamp"],
    understanding: "the room is quiet",
    questions: ["where is the key?"],
    persistence: "the search continues while the light holds",
    intentionChanges: [{ intentionId: null, content: "search the room", status: "active" }],
    speech: "hello",
    steps: [{ action: "agentlife.demo/walk", destination: "the lamp", inputs: { pace: "slow" } }],
    idle: { kind: "review-condition", detail: "listen for the noise", event: null, waitTicks: 5, reviewInTicks: 2 },
    consumedObservations: ["observation-1"],
    consideredIntentions: ["intention-1"],
  };
}

/** The scripted model of one request: no tool call at all, so nothing is ever submitted. */
const narrativeOnly = (): unknown => null;

/**
 * Advances microtasks until the runtime has registered the request, so a
 * superseding request is issued against a request that is provably in flight.
 * Registration is a microtask hop; no wall-clock wait is involved.
 */
async function waitForActiveRequest(agent: PiCognitionAgent, requestId: string): Promise<void> {
  for (let step = 0; step < 1000 && agent.activeRequestId !== requestId; step++) await Promise.resolve();
  expect(agent.activeRequestId).toBe(requestId);
}

describe("PiCognitionAgent", () => {
  it("returns the submitted decision with absolute idle ticks and the step list", async () => {
    const agent = scriptedModel({ draft: draftedDecision });

    const result = await agent.request(cognitionInput());

    expect(agent.toolNames).toEqual(["submit_cognitive_decision"]);
    expect(result.status).toBe("decided");
    expect(result.decision).toMatchObject({
      characterId: "character-1",
      requestId: "request-1",
      attention: ["the lamp"],
      understanding: "the room is quiet",
      questions: ["where is the key?"],
      persistence: "the search continues while the light holds",
      speech: "hello",
      steps: [{ action: "agentlife.demo/walk", destination: "the lamp", inputs: { pace: "slow" } }],
      idle: {
        kind: "review-condition",
        detail: "listen for the noise",
        event: null,
        reviewTick: 42,
        untilTick: 45,
      },
      consumedObservations: ["observation-1"],
      consideredIntentions: ["intention-1"],
    });
    expect(result.decision?.intentionChanges).toEqual([
      { intentionId: null, content: "search the room", status: "active" },
    ]);
    expect(agent.activeRequestId).toBeNull();
  });

  it("briefs the model with the observation references, their roles and the bounds", () => {
    const message = cognitionRequestMessage(
      cognitionInput({
        idle: {
          kind: "review-condition",
          detail: "listen for the noise",
          event: null,
          reviewTick: 42,
          untilTick: 45,
        },
        attempt: 2,
        rejection: "the walk step named a destination that is not observable",
      }),
    );

    expect(message).toContain("- the lamp（物品）：a lamp stands on the table");
    // The internal observation identity stays out of the prompt: every reference the
    // decision may carry is the observer-local name on the line, and a model that
    // copies anything else has its submission refused.
    expect(message).not.toContain("observation-1");
    expect(message).toContain("注意：the lamp");
    expect(message).toContain("intention-1（进行中）：find the key");
    expect(message).toContain("agentlife.demo/walk：walk：walk to a place");
    expect(message).toContain("当前空闲承诺：listen for the noise");
    // The wait is briefed from now, not as absolute tick numbers: a model that reads
    // them as tick numbers submits a wait that ends before it starts.
    expect(message).toContain("tick 后重审，最晚再等");
    expect(message).toContain("是相对 tick 数，不是 tick 号");
    expect(message).toContain("最多 3 个动作步骤；一次空闲等待不得超过 12 tick");
    expect(message).toContain(
      "第 2 次尝试：上一次提交被拒绝——the walk step named a destination that is not observable",
    );
  });

  it("refuses a coerced bound and an undeclared field without deciding or throwing", async () => {
    const coerced = scriptedModel({
      draft: () => ({
        ...draftedDecision(),
        idle: { kind: "review-condition", detail: "listen", event: null, waitTicks: "5", reviewInTicks: 2 },
      }),
    });

    const coercedResult = await coerced.request(cognitionInput());

    expect(coercedResult.status).toBe("failed");
    expect(coercedResult.decision).toBeNull();
    expect(coercedResult.detail).toContain("no decision");
    expect(coerced.diagnostics.some((diagnostic) => diagnostic.detail.includes("required shape"))).toBe(true);

    const overSpecified = scriptedModel({ draft: () => ({ ...draftedDecision(), mood: "wary" }) });

    const overSpecifiedResult = await overSpecified.request(cognitionInput({ requestId: "request-2" }));

    expect(overSpecifiedResult.status).toBe("failed");
    expect(overSpecifiedResult.decision).toBeNull();
    expect(overSpecifiedResult.detail.length).toBeGreaterThan(0);
  });

  it("reports a wall-clock timeout and drops the request", async () => {
    const agent = scriptedModel({ tokensPerSecond: SLOW_RATE, draft: narrativeOnly });

    const result = await agent.request(cognitionInput({ timeoutMs: 60 }));

    expect(result.status).toBe("timed-out");
    expect(result.detail).toContain("60 ms");
    expect(result.decision).toBeNull();
    expect(agent.activeRequestId).toBeNull();
  });

  it("cancels a superseded request and returns no decision of it", async () => {
    const agent = scriptedModel({ tokensPerSecond: SUPERSEDED_RATE, draft: draftedDecision });
    const superseded = agent.request(cognitionInput({ requestId: "request-1" }));
    await waitForActiveRequest(agent, "request-1");

    const current = agent.request(cognitionInput({ requestId: "request-2" }));
    const [supersededResult, currentResult] = await Promise.all([superseded, current]);

    expect(supersededResult.status).toBe("cancelled");
    expect(supersededResult.decision).toBeNull();
    expect(currentResult.status).toBe("decided");
    expect(currentResult.decision?.requestId).toBe("request-2");
    expect(currentResult.decision?.steps).toEqual([
      { action: "agentlife.demo/walk", destination: "the lamp", inputs: { pace: "slow" } },
    ]);
  });

  it("cancels only the request it was given the identity of", async () => {
    const agent = scriptedModel({ tokensPerSecond: SLOW_RATE, draft: narrativeOnly });
    const running = agent.request(cognitionInput({ requestId: "request-7" }));
    await waitForActiveRequest(agent, "request-7");

    agent.cancel("request-other");
    expect(agent.activeRequestId).toBe("request-7");

    agent.cancel("request-7");
    const result = await running;

    expect(result.status).toBe("cancelled");
    expect(result.decision).toBeNull();
  });

  it("names an unresolvable provider configuration in a readable failure", async () => {
    const unknownProvider = new PiCognitionAgent({ provider: "not-a-provider", model: "not-a-model" });
    const unknownProviderResult = await unknownProvider.request(cognitionInput());

    expect(unknownProviderResult.status).toBe("failed");
    expect(unknownProviderResult.decision).toBeNull();
    expect(unknownProviderResult.detail).toContain("not-a-provider");

    const unknownModel = new PiCognitionAgent({ provider: "anthropic", model: "not-a-model" });
    const unknownModelResult = await unknownModel.request(cognitionInput());

    expect(unknownModelResult.status).toBe("failed");
    expect(unknownModelResult.detail).toContain("not-a-model");
  });
});
