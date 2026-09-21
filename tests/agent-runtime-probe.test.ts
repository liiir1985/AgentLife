import { describe, expect, it } from "vitest";
import { AgentRuntimeProbe, type AgentRunIdentity, type AgentRunResult } from "../src/agent/agent-runtime-probe.js";

const CANCELLATION_RATE = 25;

/** Collapses consecutive identical labels so chunking never changes the expectation. */
function eventSequence(probe: AgentRuntimeProbe): string[] {
  const labels = probe.events.map((event) => {
    if (event.type === "message_update") return `update:${event.assistantMessageEvent.type}`;
    if (event.type === "message_start" || event.type === "message_end") return `${event.type}:${event.message.role}`;
    return event.type;
  });
  return labels.filter((label, index) => label !== labels[index - 1]);
}

/** Starts a slow run and resolves once the active request is provably mid-stream. */
async function startStreamingRun(
  probe: AgentRuntimeProbe,
): Promise<{ result: Promise<AgentRunResult>; identity: AgentRunIdentity }> {
  const streaming = Promise.withResolvers<AgentRunIdentity>();
  const unsubscribe = probe.onEvent((event) => {
    if (event.type === "message_update" && probe.activeIdentity !== undefined) streaming.resolve(probe.activeIdentity);
  });
  const result = probe.run({ timelineId: "timeline-1", roundId: "round-1", script: "narrative" });
  const identity = await streaming.promise;
  unsubscribe();
  return { result, identity };
}

describe("AgentRuntimeProbe", () => {
  it("accepts a probe submission and streams the documented event order", async () => {
    const probe = new AgentRuntimeProbe();
    const result = await probe.run({ timelineId: "timeline-1", roundId: "round-1" });

    expect(result.status).toBe("completed");
    expect(probe.toolNames).toEqual(["submit_probe"]);
    expect(result.submissions).toEqual([{ identity: result.identity, value: "ok" }]);
    expect(result.rejections).toEqual([]);
    expect(eventSequence(probe)).toEqual([
      "agent_start",
      "turn_start",
      "message_start:user",
      "message_end:user",
      "message_start:assistant",
      "update:toolcall_start",
      "update:toolcall_delta",
      "update:toolcall_end",
      "message_end:assistant",
      "tool_execution_start",
      "tool_execution_end",
      "message_start:toolResult",
      "message_end:toolResult",
      "turn_end",
      "turn_start",
      "message_start:assistant",
      "update:text_start",
      "update:text_delta",
      "update:text_end",
      "message_end:assistant",
      "turn_end",
      "agent_end",
    ]);

    expect(result.events.find((event) => event.type === "tool_execution_end")).toMatchObject({
      toolName: "submit_probe",
      isError: false,
    });
  });

  it("blocks tool arguments that violate the schema instead of coercing them", async () => {
    const probe = new AgentRuntimeProbe();
    const result = await probe.run({ timelineId: "timeline-1", roundId: "round-1", script: "invalid-submit" });

    expect(result.status).toBe("completed");
    expect(result.submissions).toEqual([]);
    expect(result.rejections).toEqual([
      { identity: result.identity, value: '{"value":42}', reason: "invalid-arguments" },
    ]);
    expect(result.events.find((event) => event.type === "tool_execution_end")).toMatchObject({
      toolName: "submit_probe",
      isError: true,
    });
    expect(probe.submissions).toEqual([]);
  });

  it("refuses tool calls outside the probe surface before they execute", async () => {
    const probe = new AgentRuntimeProbe();
    const result = await probe.run({ timelineId: "timeline-1", roundId: "round-1", script: "outside-capability" });

    expect(result.submissions).toEqual([]);
    expect(result.rejections).toEqual([]);
    expect(result.events.find((event) => event.type === "tool_execution_end")).toMatchObject({
      toolName: "read_world_file",
      isError: true,
    });
  });

  it("stops submitting after cancellation and discards late results", async () => {
    const probe = new AgentRuntimeProbe({ tokensPerSecond: CANCELLATION_RATE });
    const { result: running, identity: cancelledIdentity } = await startStreamingRun(probe);

    probe.cancel();
    const result = await running;
    expect(result.status).toBe("cancelled");
    expect(probe.activeIdentity).toBeUndefined();
    expect(probe.submissions).toEqual([]);
    expect(result.events.some((event) => event.type === "tool_execution_end")).toBe(false);

    expect(probe.submit(cancelledIdentity, "late")).toBe("stale");
    expect(probe.submit(cancelledIdentity, "later")).toBe("stale");
    expect(probe.rejections).toEqual([
      { identity: cancelledIdentity, value: "late", reason: "stale-identity" },
      { identity: cancelledIdentity, value: "later", reason: "stale-identity" },
    ]);
    expect(probe.submissions).toEqual([]);
  });

  it("times out through the wrapper abort controller and refuses the late result", async () => {
    const probe = new AgentRuntimeProbe({ tokensPerSecond: CANCELLATION_RATE });
    const result = await probe.run({
      timelineId: "timeline-1",
      roundId: "round-1",
      script: "narrative",
      timeoutMs: 60,
    });

    expect(result.status).toBe("timed-out");
    expect(probe.activeIdentity).toBeUndefined();
    expect(probe.submit(result.identity, "late")).toBe("stale");
    expect(probe.rejections).toEqual([{ identity: result.identity, value: "late", reason: "stale-identity" }]);
    expect(probe.submissions).toEqual([]);
  });

  it("recovers after cancellation with a new request identity", async () => {
    const probe = new AgentRuntimeProbe({ tokensPerSecond: CANCELLATION_RATE });
    const { result: running, identity: staleIdentity } = await startStreamingRun(probe);
    probe.cancel();
    expect((await running).status).toBe("cancelled");

    const recovered = await probe.run({ timelineId: "timeline-1", roundId: "round-1" });
    expect(recovered.status).toBe("completed");
    expect(recovered.identity.requestId).not.toBe(staleIdentity.requestId);
    expect(recovered.submissions).toEqual([{ identity: recovered.identity, value: "ok" }]);
    expect(probe.submit(staleIdentity, "late")).toBe("stale");
    expect(probe.submissions).toEqual([{ identity: recovered.identity, value: "ok" }]);
  });
});
