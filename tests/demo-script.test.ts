import { afterEach, describe, expect, it, vi } from "vitest";
import { DemoScript } from "../src/tui/demo-script.js";

interface Recorder {
  readonly events: string[];
  readonly script: DemoScript;
}

function build(narrative = "abc", roundCount = 3, roundGapMs = 100): Recorder {
  const events: string[] = [];
  const script = new DemoScript({
    narrative,
    roundCount,
    tokenIntervalMs: 10,
    roundGapMs,
    onRoundStart: (round) => events.push(`start:${round}`),
    onToken: (token) => events.push(`token:${token}`),
    onStreamEnd: (round, cancelled) => events.push(`end:${round}:${cancelled ? "cancelled" : "done"}`),
    onFinish: () => events.push("finish"),
  });
  return { events, script };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("DemoScript", () => {
  it("runs every round back to back and then stops with no timer left", () => {
    vi.useFakeTimers();
    const { events, script } = build();

    script.start();
    expect(events).toEqual(["start:1"]);
    vi.advanceTimersByTime(40);
    expect(events).toEqual(["start:1", "token:a", "token:b", "token:c", "end:1:done"]);
    expect(vi.getTimerCount()).toBe(1);

    vi.advanceTimersByTime(1_000);
    expect(events.filter((event) => event === "finish")).toEqual(["finish"]);
    expect(events.filter((event) => event.startsWith("start:"))).toEqual(["start:1", "start:2", "start:3"]);
    expect(events.filter((event) => event.startsWith("end:"))).toHaveLength(3);
    expect(vi.getTimerCount()).toBe(0);
    expect(script.isRunning).toBe(false);
  });

  it("never runs two streams at once", () => {
    vi.useFakeTimers();
    const events: string[] = [];
    const script = new DemoScript({
      narrative: "abcdefghij",
      roundCount: 5,
      tokenIntervalMs: 10,
      roundGapMs: 0,
      onRoundStart: (round) => events.push(`start:${round}`),
      onToken: (token) => events.push(`token:${token}`),
      onStreamEnd: (round) => events.push(`end:${round}`),
      onFinish: () => events.push("finish"),
    });

    script.start();
    for (let step = 0; step < 200; step += 1) {
      vi.advanceTimersByTime(10);
      expect(vi.getTimerCount()).toBeLessThanOrEqual(1);
    }

    const tokensPerRound = events.filter((event) => event.startsWith("token:")).length / 5;
    expect(tokensPerRound).toBe(10);
    expect(events.filter((event) => event === "finish")).toEqual(["finish"]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("stops the stream, reports the cancellation and schedules nothing after Esc", () => {
    vi.useFakeTimers();
    const { events, script } = build();

    script.start();
    vi.advanceTimersByTime(15);
    script.cancel();

    expect(events.filter((event) => event.includes("cancelled"))).toEqual(["end:1:cancelled"]);
    expect(script.isRunning).toBe(false);
    expect(vi.getTimerCount()).toBe(0);

    vi.advanceTimersByTime(10_000);
    expect(events).not.toContain("finish");
    expect(events.filter((event) => event.startsWith("token:")).length).toBe(1);
  });

  it("replays cleanly when started again", () => {
    vi.useFakeTimers();
    const { events, script } = build("ab", 1);

    script.start();
    vi.advanceTimersByTime(130);
    expect(events).toEqual(["start:1", "token:a", "token:b", "end:1:done", "finish"]);

    script.start();
    expect(script.currentRound).toBe(1);
    expect(events.at(-1)).toBe("start:1");
    expect(vi.getTimerCount()).toBe(1);
  });

  it("drops pending timers on stop", () => {
    vi.useFakeTimers();
    const { events, script } = build();

    script.start();
    vi.advanceTimersByTime(15);
    script.stop();

    expect(vi.getTimerCount()).toBe(0);
    const before = events.length;
    vi.advanceTimersByTime(10_000);
    expect(events.length).toBe(before);
  });
});
