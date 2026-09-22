import { describe, expect, it } from "vitest";
import type { BehaviorTraceEntry } from "../src/behavior/behavior-tree-adapter.js";
import { ContentPackLoader } from "../src/content/content-pack-loader.js";
import { CoreRuntime, packInput } from "../src/config/core-runtime.js";
import type { SimulationOrchestrator } from "../src/simulation/orchestrator.js";
import { createSystemSpecs } from "../src/systems/index.js";
import { copyDemoPack } from "./helpers/demo-pack.js";
import {
  DEMO_COMPANION,
  DEMO_KILN,
  DEMO_PLAYER,
  DEMO_SQUARE,
  DEMO_WARDEN,
  createSimulation,
  positionOf,
  publishDemoWith,
  removeDirectory,
  testPlan,
} from "./helpers/phase2.js";

/**
 * Phase 2 acceptance: the behaviour tree production adapter.
 *
 * The demo tree `agentlife.demo/warden-patrol` is content, so every expectation
 * below is derived from that file: nine declared nodes, one selector, three
 * branches and the plan step each branch records.
 */

/**
 * Every node path of content/demo/behaviourTrees/warden-patrol.yaml, in the
 * order the deterministic trace walks them.
 */
const DECLARED_NODES: readonly string[] = [
  "root",
  "root#0/selector",
  "root#0/selector#0/sequence",
  "root#0/selector#0/sequence#0/condition:view-below",
  "root#0/selector#0/sequence#1/action:idle",
  "root#0/selector#1/sequence",
  "root#0/selector#1/sequence#0/condition:view-equals",
  "root#0/selector#1/sequence#1/action:plan",
  "root#0/selector#2/action:plan",
];

const WALK_TO_KILN = '{"action":"agentlife.demo/walk","destination":"agentlife.demo/kiln"}';
const WAVE = '{"action":"agentlife.demo/wave"}';

/** The first decision, made at the lantern square: the retreat branch fails, the walk branch records the plan. */
const FIRST_DECISION: readonly (readonly [string, string])[] = [
  ["root#0/selector#0/sequence#0/condition:view-below", "failed"],
  ["root#0/selector#0/sequence", "failed"],
  ["root#0/selector#1/sequence#0/condition:view-equals", "failed"],
  ["root#0/selector#1/sequence", "failed"],
  ["root#0/selector#2/action:plan", "succeeded"],
  ["root#0/selector", "succeeded"],
  ["root", "succeeded"],
];

/** The second decision, made at the kiln: the located-at branch records the wave step. */
const SECOND_DECISION: readonly (readonly [string, string])[] = [
  ["root#0/selector#0/sequence#0/condition:view-below", "failed"],
  ["root#0/selector#0/sequence", "failed"],
  ["root#0/selector#1/sequence#0/condition:view-equals", "succeeded"],
  ["root#0/selector#1/sequence#1/action:plan", "succeeded"],
  ["root#0/selector#1/sequence", "succeeded"],
  ["root#0/selector", "succeeded"],
  ["root", "succeeded"],
];

interface Decision {
  readonly tick: number;
  readonly trace: readonly BehaviorTraceEntry[];
  readonly plan: readonly string[];
}

/** Drives ticks until the warden's tree has resolved `wanted` decisions. */
function driveDecisions(orchestrator: SimulationOrchestrator, wanted: number): readonly Decision[] {
  const decisions: Decision[] = [];
  let applied = 0;
  for (let tick = 1; tick <= 12 && decisions.length < wanted; tick += 1) {
    orchestrator.runTick();
    const behaviour = orchestrator.state().behaviours[DEMO_WARDEN];
    expect(behaviour).toBeDefined();
    if ((behaviour?.appliedKeys.length ?? 0) > applied) {
      applied = behaviour?.appliedKeys.length ?? 0;
      decisions.push({ tick, trace: behaviour?.trace ?? [], plan: behaviour?.plan ?? [] });
    }
  }
  return decisions;
}

/** Publishes the real demo pack with per-file overrides and reports the diagnostics. */
async function publishProblems(overrides: Readonly<Record<string, string | null>>): Promise<{
  readonly status: string;
  readonly codes: readonly string[];
  readonly subjects: readonly (string | undefined)[];
}> {
  const core = new CoreRuntime();
  for (const system of createSystemSpecs()) core.addSystem(system);
  const directory = copyDemoPack(overrides);
  try {
    const snapshot = await new ContentPackLoader().load(directory);
    const result = core.publish({ root: packInput(snapshot) });
    return {
      status: result.status,
      codes: result.diagnostics.map((diagnostic) => diagnostic.code),
      subjects: result.diagnostics.map((diagnostic) => diagnostic.subject),
    };
  } finally {
    removeDirectory(directory);
  }
}

describe("phase 2 behaviour tree adapter", () => {
  it("resolves the gate-warden tree in the declared node order and records the plan it hands over", async () => {
    const simulation = await createSimulation({ timelineId: "timeline-behaviour" });
    const decisions = driveDecisions(simulation.orchestrator, 2);
    const walked = decisions.map((decision) => decision.trace.map((entry) => [entry.path, entry.state] as const));

    expect(decisions.map((decision) => decision.tick)).toEqual([1, 5]);
    expect(walked[0]).toEqual(FIRST_DECISION);
    expect(walked[1]).toEqual(SECOND_DECISION);

    // Every recorded node is one of the nine nodes the demo tree declares.
    for (const decision of decisions) for (const entry of decision.trace) expect(DECLARED_NODES).toContain(entry.path);

    expect(decisions[0]?.plan).toEqual([WALK_TO_KILN]);
    expect(decisions[1]?.plan).toEqual([WAVE]);

    const behaviour = simulation.orchestrator.state().behaviours[DEMO_WARDEN];
    expect(behaviour?.blackboard).toEqual({});
    expect(behaviour?.activePlanId).toBe(`${DEMO_WARDEN}/tick-5`);
    expect(behaviour?.cooldownUntilTick).toBe(6);
    // The recorded plan is a real plan: the warden actually walked to the kiln.
    expect(positionOf(simulation.orchestrator, DEMO_WARDEN)).toBe(DEMO_KILN);
  });

  it("rejects a local view that names a view no system is granted", async () => {
    const untouched = await publishDemoWith({});
    expect(untouched.config.items.length).toBeGreaterThan(0);
    removeDirectory(untouched.directory);

    const problems = await publishProblems({
      "localViews/warden-view.yaml": `id: warden-view
type: agentlife.world/local-view
public: true
fields:
  name: 护卫的局部执行视图
  description: 只包含护卫当前能直接确认的地点、光照与自身身体状态。
  members:
    - agentlife.world/located-at.location
    - agentlife.character/schedule.tier
`,
    });
    expect(problems.status).toBe("rejected");
    expect(problems.codes).toContain("unauthorized-read");
    expect(problems.subjects).toContain("agentlife.demo/warden-view");
  });

  it("rejects a behaviour tree that calls a function outside the fixed vocabulary", async () => {
    const problems = await publishProblems({
      "behaviourTrees/warden-patrol.yaml": `id: warden-patrol
type: agentlife.character/behaviour-tree
public: true
fields:
  name: 护卫巡守
  description: 调用一个未登记的函数。
  decisionCooldown: 1
  blackboard: {}
  definition:
    type: root
    child:
      type: action
      call: read-the-whole-world
      args: []
`,
    });
    expect(problems.status).toBe("rejected");
    expect(problems.codes).toContain("system-rejected");
    expect(problems.subjects).toContain("agentlife.demo/warden-patrol");
  });

  it("produces the same tick whatever order the entity plans are supplied in", async () => {
    const first = await createSimulation({ timelineId: "timeline-order-a" });
    const second = await createSimulation({ timelineId: "timeline-order-b" });
    const say = testPlan("player-say", DEMO_PLAYER, "parallel", [{ action: "agentlife.demo/say" }]);
    const wave = testPlan("companion-wave", DEMO_COMPANION, "parallel", [{ action: "agentlife.demo/wave" }]);

    const forward = first.orchestrator.runTick({ plans: [say, wave] });
    const reversed = second.orchestrator.runTick({ plans: [wave, say] });

    expect(second.orchestrator.state().world).toEqual(first.orchestrator.state().world);
    expect(second.orchestrator.state().body).toEqual(first.orchestrator.state().body);
    expect(second.orchestrator.state().characters).toEqual(first.orchestrator.state().characters);
    expect(second.orchestrator.state().actions).toEqual(first.orchestrator.state().actions);
    expect(second.orchestrator.state().behaviours).toEqual(first.orchestrator.state().behaviours);
    expect(second.orchestrator.state().activity).toEqual(first.orchestrator.state().activity);

    const observable = (result: typeof forward) => ({
      stages: result.summary.stages.map((stage) => `${stage.stage}:${stage.status}`),
      outcomes: [...result.summary.actionOutcomes].sort(),
      influence: result.summary.influenceOutcomes,
      events: result.summary.eventCount,
      stateVersion: result.summary.stateVersion,
      tick: result.summary.tick,
    });
    expect(observable(reversed)).toEqual(observable(forward));

    // Only the order the plans were supplied in differs, and it is visible there alone.
    expect(forward.summary.actionOutcomes[0]).toContain("player-say");
    expect(reversed.summary.actionOutcomes[0]).toContain("companion-wave");
    expect(positionOf(second.orchestrator, DEMO_PLAYER)).toBe(DEMO_SQUARE);
  });

  it("accepts a behaviour tree plan for the next tick without progressing it in the submitting tick", async () => {
    const simulation = await createSimulation({ timelineId: "timeline-lazy" });
    const submitting = simulation.orchestrator.runTick();

    const planned = simulation.orchestrator.state().actions.find((action) => action.plan.source === "behaviour-tree");
    expect(planned?.status).toBe("running");
    expect(planned?.acceptedTick).toBe(1);
    expect(planned?.eligibleTick).toBe(2);
    expect(planned?.stageIndex).toBe(0);
    expect(planned?.stageTicks).toBe(0);
    // Nothing the plan asks for happened in the tick that accepted it.
    expect(submitting.summary.eventCount).toBe(0);
    expect(positionOf(simulation.orchestrator, DEMO_WARDEN)).toBe(DEMO_SQUARE);

    simulation.orchestrator.runTick();
    const progressed = simulation.orchestrator.state().actions.find((action) => action.actionId === planned?.actionId);
    expect(progressed?.stageTicks).toBe(1);
    expect(progressed?.stepIndex).toBe(0);
  });
});
