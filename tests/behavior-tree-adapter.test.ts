import { describe, expect, it } from "vitest";
import {
  BehaviorTreeAdapterError,
  BehaviorTreeAdapter,
  type BehaviorDecision,
  type BehaviorFunctionRegistry,
  type BehaviorTreeAdapterOptions,
} from "../src/behavior/behavior-tree-adapter.js";

const registry: BehaviorFunctionRegistry = {
  functions: {
    gather: (context) => {
      context.write("energy", (context.read("energy") as number) + 1);
      context.emit("gather");
      return "succeeded";
    },
    spend: (context) => {
      context.write("energy", (context.read("energy") as number) - 1);
      context.emit("spend");
      return "succeeded";
    },
    unavailable: () => "failed",
    note: (context, ...args) => {
      context.emit(`note:${String(args[0])}`);
      return "succeeded";
    },
  },
  predicates: {
    hasEnergy: (context) => (context.read("energy") as number) > 0,
    belowLimit: (context) => ((context.read("energy") as number) ?? 0) < 8,
  },
};

const definition = {
  type: "root",
  child: {
    type: "sequence",
    children: [
      { type: "condition", call: "hasEnergy" },
      { type: "action", call: "gather" },
      {
        type: "selector",
        children: [
          { type: "action", call: "unavailable" },
          { type: "action", call: "spend" },
        ],
      },
    ],
  },
};

const options: BehaviorTreeAdapterOptions = { definition, registry, tickSeconds: 1, maxBlackboardKeys: 4 };

const seededState = {
  tick: 0,
  blackboard: { energy: 2 },
  plan: [],
  trace: [],
  appliedKeys: [],
  cooldownUntilTick: 0,
  activePlanId: null,
  inputVersion: "",
} as const;

function decisionView(decision: BehaviorDecision): Omit<BehaviorDecision, "key"> {
  return {
    tick: decision.tick,
    status: decision.status,
    blackboard: decision.blackboard,
    plan: decision.plan,
    trace: decision.trace,
  };
}

describe("BehaviorTreeAdapter", () => {
  it("resolves a JSON definition within one decision and traces canonical paths", () => {
    const adapter = BehaviorTreeAdapter.restore(options, seededState);
    const decision = adapter.decide({ tick: 1, key: "round-1:1" });

    expect(decision.status).toBe("resolved");
    expect(decision.plan).toEqual(["gather", "spend"]);
    expect(decision.blackboard).toEqual({ energy: 2 });
    expect(decision.trace.map((entry) => `${entry.path} ${entry.previousState}->${entry.state}`)).toEqual([
      "root#0/sequence#0/condition:hasEnergy ready->succeeded",
      "root#0/sequence#1/action:gather ready->succeeded",
      "root#0/sequence#2/selector#0/action:unavailable ready->failed",
      "root#0/sequence#2/selector#1/action:spend ready->succeeded",
      "root#0/sequence#2/selector ready->succeeded",
      "root#0/sequence ready->succeeded",
      "root ready->succeeded",
    ]);
  });

  it("produces identical decisions for the same tick sequence after save and restore", () => {
    const fresh = BehaviorTreeAdapter.restore(options, seededState);
    for (const tick of [1, 2]) fresh.decide({ tick, key: `round-1:${tick}` });
    const checkpoint = fresh.exportState();
    const direct = fresh.decide({ tick: 3, key: "round-1:3" });

    const restored = BehaviorTreeAdapter.restore(options, checkpoint);
    const replayed = restored.decide({ tick: 3, key: "round-1:3" });

    expect(replayed).toEqual(direct);
    expect(decisionView(replayed)).toEqual(decisionView(direct));
    expect(restored.exportState()).toEqual(fresh.exportState());
    expect(replayed.trace.some((entry) => entry.path.includes("-"))).toBe(false);
  });

  it("round-trips an exported state without losing plan, blackboard or trace", () => {
    const adapter = BehaviorTreeAdapter.restore(options, seededState);
    adapter.decide({ tick: 1, key: "round-1:1" });
    const state = adapter.exportState();

    expect(Object.isFrozen(state)).toBe(true);
    expect(Object.isFrozen(state.blackboard)).toBe(true);
    expect(Object.isFrozen(state.trace)).toBe(true);
    expect(Object.isFrozen(state.appliedKeys)).toBe(true);
    expect(state).toEqual({
      tick: 1,
      blackboard: { energy: 2 },
      plan: ["gather", "spend"],
      trace: expect.any(Array),
      appliedKeys: ["round-1:1"],
      cooldownUntilTick: 0,
      activePlanId: null,
      inputVersion: "",
    });
    expect(BehaviorTreeAdapter.restore(options, state).exportState()).toEqual(state);
  });

  it("reports a repeated key as already applied without touching the blackboard", () => {
    const adapter = BehaviorTreeAdapter.restore(options, seededState);
    adapter.decide({ tick: 1, key: "round-1:1" });
    const before = adapter.exportState();

    const duplicate = adapter.decide({ tick: 1, key: "round-1:1" });
    expect(duplicate.status).toBe("already-applied");
    expect(duplicate.blackboard).toEqual(before.blackboard);
    expect(adapter.exportState()).toEqual(before);
  });

  it("refuses ticks that do not advance", () => {
    const adapter = BehaviorTreeAdapter.restore(options, seededState);
    adapter.decide({ tick: 4, key: "round-1:4" });
    expect(() => adapter.decide({ tick: 4, key: "round-2:4" })).toThrow(/does not advance/);
    expect(() => adapter.decide({ tick: 3, key: "round-2:3" })).toThrow(/does not advance/);
  });

  it("bounds the blackboard, rejects non-JSON values and leaves the state untouched on failure", () => {
    const growOptions: BehaviorTreeAdapterOptions = {
      definition: { type: "root", child: { type: "action", call: "grow" } },
      registry: {
        functions: {
          grow: (context) => {
            const count = (context.read("count") as number) ?? 0;
            context.write(`key-${count}`, count);
            context.write("count", count + 1);
            return "succeeded";
          },
        },
        predicates: {},
      },
      tickSeconds: 1,
      maxBlackboardKeys: 2,
    };
    const adapter = BehaviorTreeAdapter.create(growOptions);
    const first = adapter.decide({ tick: 1, key: "k1" });
    expect(first.blackboard).toEqual({ count: 1, "key-0": 0 });

    expect(() => adapter.decide({ tick: 2, key: "k2" })).toThrow(/limited to 2 keys/);
    expect(adapter.exportState().blackboard).toEqual({ count: 1, "key-0": 0 });
    expect(() => adapter.decide({ tick: 2, key: "k3" })).toThrow(/unusable/);

    const nonJson = BehaviorTreeAdapter.create({
      definition: { type: "root", child: { type: "action", call: "store" } },
      registry: { functions: { store: (context) => (context.write("bad", Number.NaN), "succeeded") }, predicates: {} },
      tickSeconds: 1,
    });
    expect(() => nonJson.decide({ tick: 1, key: "k1" })).toThrow(/not JSON/);
  });

  it("drives repeat to resolution inside one decision and reports exhaustion", () => {
    const repeatOptions: BehaviorTreeAdapterOptions = {
      definition: { type: "root", child: { type: "repeat", iterations: 3, child: { type: "action", call: "tick" } } },
      registry: {
        functions: {
          tick: (context) => {
            context.emit("tick");
            return "succeeded";
          },
        },
        predicates: {},
      },
      tickSeconds: 1,
    };
    expect(BehaviorTreeAdapter.create(repeatOptions).decide({ tick: 1, key: "k1" }).plan).toEqual([
      "tick",
      "tick",
      "tick",
    ]);

    const bounded = BehaviorTreeAdapter.create({ ...repeatOptions, maxStepsPerDecision: 2 });
    expect(() => bounded.decide({ tick: 1, key: "k1" })).toThrow(/did not resolve within 2 steps/);
  });

  it("resolves conditions, guards and callbacks from the registry", () => {
    const guarded: BehaviorTreeAdapterOptions = {
      definition: {
        type: "root",
        child: {
          type: "sequence",
          while: { call: "belowLimit" },
          children: [{ type: "action", call: "gather", entry: { call: "note", args: ["enter"] } }],
        },
      },
      registry,
      tickSeconds: 1,
    };

    const adapter = BehaviorTreeAdapter.restore(guarded, seededState);
    expect(adapter.decide({ tick: 1, key: "k1" }).plan).toEqual(["note:enter", "gather"]);
    expect(adapter.exportState().blackboard).toEqual({ energy: 3 });

    // A failing guard blocks the guarded subtree for the decision without drift.
    const blocked = BehaviorTreeAdapter.restore(guarded, { ...seededState, blackboard: { energy: 9 } });
    const decision = blocked.decide({ tick: 1, key: "k1" });
    expect(decision.plan).toEqual([]);
    expect(decision.blackboard).toEqual({ energy: 9 });
  });

  it("rejects MDSL text, excluded node kinds, unknown kinds and bad references", () => {
    const attempt = (candidate: unknown): string => {
      try {
        BehaviorTreeAdapter.create({ ...options, definition: candidate });
        return "accepted";
      } catch (error) {
        return (error as BehaviorTreeAdapterError).message;
      }
    };

    expect(attempt("root { sequence { action gather } }")).toMatch(/JSON object, not MDSL text/);
    expect(attempt({ type: "sequence", children: [] })).toMatch(/single root node/);
    expect(attempt({ type: "root", child: { type: "wait", duration: 5 } })).toMatch(
      /Unsupported node type wait.*accumulate duration internally/,
    );
    expect(attempt({ type: "root", child: { type: "lotto", children: [] } })).toMatch(/Unsupported node type lotto/);
    expect(attempt({ type: "root", child: { type: "branch", ref: "sub" } })).toMatch(/Unsupported node type branch/);
    expect(attempt({ type: "root", child: { type: "sprint" } })).toMatch(/Unknown node type sprint/);
    expect(attempt({ type: "root", child: { type: "action", call: "missing" } })).toMatch(
      /Function missing at root#0\/action:missing is not registered/,
    );
    expect(attempt({ type: "root", child: { type: "action", call: "gather", while: { call: "missing" } } })).toMatch(
      /Predicate missing at root#0\/action:gather\/while is not registered/,
    );
    expect(attempt({ type: "root", child: { type: "action", call: "gather", args: [{ $: "world" }] } })).toMatch(
      /Argument references are not permitted/,
    );
    expect(
      attempt({
        type: "root",
        child: { type: "repeat", iterations: [1, 3], child: { type: "action", call: "gather" } },
      }),
    ).toMatch(/random ranges are disabled/);
    expect(attempt({ type: "root", child: { type: "sequence", children: [] } })).toMatch(/needs children/);
    expect(attempt({ type: "root", child: { type: "action", call: "gather", entry: { call: "7" } } })).toMatch(
      /Function 7 at root#0\/action:gather\/entry is not registered/,
    );
  });

  it("keeps decision streams deterministic across independent adapter instances", () => {
    const record = (adapter: BehaviorTreeAdapter, ticks: readonly number[]): BehaviorDecision[] =>
      ticks.map((tick) => adapter.decide({ tick, key: `round-1:${tick}` }));

    const first = record(BehaviorTreeAdapter.restore(options, seededState), [1, 2, 3]);
    const second = record(BehaviorTreeAdapter.restore(options, seededState), [1, 2, 3]);

    expect(second.map(decisionView)).toEqual(first.map(decisionView));
  });
});
