import { describe, expect, it } from "vitest";
import type { Api, Model, Usage } from "@earendil-works/pi-ai";
import { formatSessionCost, SessionCost } from "../src/diagnostics/session-cost.js";

const usage: Usage = {
  input: 1_000_000,
  output: 500_000,
  cacheRead: 100_000,
  cacheWrite: 50_000,
  totalTokens: 1_650_000,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function model(cost: Model<Api>["cost"]): Model<Api> {
  return { provider: "example", id: "example-model", cost } as Model<Api>;
}

describe("session LLM cost", () => {
  it("uses Pi prices when no cost is configured and accumulates retries", () => {
    const tracker = new SessionCost();
    let changes = 0;
    tracker.subscribe(() => changes++);
    const priced = model({ input: 1, output: 3, cacheRead: 0.1, cacheWrite: 0.2 });
    const charged = tracker.record(priced, usage);
    expect(charged.pricing).toBe("pi");
    expect(charged.usd).toBeCloseTo(2.52);
    tracker.record(priced, usage);
    expect(tracker.totalUsd).toBeCloseTo(5.04);
    expect(changes).toBe(2);
  });

  it("uses configured rates even when Pi has a price", () => {
    const priced = model({ input: 1, output: 3, cacheRead: 0.1, cacheWrite: 0.2 });
    const tracker = new SessionCost({ input: 2, output: 8, cacheRead: 0.04, cacheWrite: 0.04 });
    const charged = tracker.record(priced, usage);
    expect(charged.pricing).toBe("configured");
    expect(charged.usd).toBeCloseTo(6.006);
    expect(formatSessionCost(tracker.totalUsd)).toBe("推理 $6.006000");
  });

  it("uses configured rates for an unpriced model and reports an unpriced session", () => {
    const unpriced = model({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
    const tracker = new SessionCost({ input: 2, output: 8, cacheRead: 0.04, cacheWrite: 0.04 });
    const charged = tracker.record(unpriced, usage);
    expect(charged.pricing).toBe("configured");
    expect(charged.usd).toBeCloseTo(6.006);
    expect(formatSessionCost(tracker.totalUsd)).toBe("推理 $6.006000");
    const unknown = new SessionCost();
    expect(unknown.record(unpriced, usage)).toEqual({ usd: null, pricing: "unknown" });
    expect(formatSessionCost(unknown.totalUsd)).toBe("费用待配置");
  });
});
