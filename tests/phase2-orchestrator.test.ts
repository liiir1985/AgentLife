import { describe, expect, it } from "vitest";
import { TICK_STAGES } from "../src/simulation/orchestrator.js";
import type { StageRecord } from "../src/simulation/types.js";
import {
  DEMO_KILN,
  DEMO_LAMP,
  DEMO_PLAYER,
  DEMO_SQUARE,
  createSimulation,
  createSimulationWith,
  testPlan,
} from "./helpers/phase2.js";

/** The twelve stages of one tick, as the phase 2 plan fixes them. */
const TWELVE_PHASES: readonly string[] = [
  "fixed",
  "clock",
  "advance",
  "decide",
  "adjudicate",
  "propagate",
  "stability",
  "perception",
  "cognitive-demand",
  "cognitive-barrier",
  "memory",
  "publish",
];

/** The phases phase 2 always records as an explicit no-op. */
const PHASE_2_NO_OPS: readonly string[] = ["perception", "cognitive-demand", "cognitive-barrier", "memory"];

const OPERATE_LAMP = testPlan("player-operate", DEMO_PLAYER, "parallel", [
  { action: "agentlife.demo/use", target: DEMO_LAMP },
]);

/** Stage records collapsed to the phase order they were recorded in. */
function recordedPhases(stages: readonly StageRecord[]): readonly string[] {
  const phases: string[] = [];
  for (const stage of stages) if (phases.at(-1) !== stage.stage) phases.push(stage.stage);
  return phases;
}

describe("phase 2 simulation orchestrator", () => {
  it("records the fixed twelve phases in order and keeps the phase-2 stages as explicit no-ops", async () => {
    expect(TICK_STAGES).toEqual(TWELVE_PHASES);

    const simulation = await createSimulation({ timelineId: "timeline-phases" });
    const result = simulation.orchestrator.runTick();
    const stages = result.summary.stages;

    expect(result.status).toBe("completed");
    expect(recordedPhases(stages)).toEqual(TWELVE_PHASES);
    expect(stages[0]?.stage).toBe("fixed");
    expect(stages.at(-1)?.stage).toBe("publish");
    expect(stages.every((stage) => stage.status !== "failed")).toBe(true);

    // Every phase is recorded with one of the three declared statuses.
    expect([...new Set(stages.map((stage) => stage.status))].sort()).toEqual(["done", "no-op"]);
    expect(stages.find((stage) => stage.stage === "stability")?.status).toBe("done");
    expect(stages.find((stage) => stage.stage === "publish")?.status).toBe("done");
    // The propagation phase is recorded every tick, even when it selects no trigger.
    expect(stages.find((stage) => stage.stage === "propagate")?.status).toBe("done");

    for (const phase of PHASE_2_NO_OPS) {
      const record = stages.find((stage) => stage.stage === phase);
      expect(record).toBeDefined();
      expect(record?.status).toBe("no-op");
    }
  });

  it("re-evaluates rules only through the trigger index, including a change made in the same tick", async () => {
    const simulation = await createSimulation({ timelineId: "timeline-index" });
    const requested: string[][] = [];
    let current: string[] = [];
    const call = simulation.core.runRules.bind(simulation.core);
    simulation.core.runRules = (request) => {
      current.push(request.trigger);
      return call(request);
    };

    // Tick 1 wakes the standing tick rules, whose body value changes are re-evaluated in the same tick.
    const first = simulation.orchestrator.runTick();
    requested.push(current);
    current = [];
    expect(requested[0]).toContain("agentlife.body/value-changed");
    // No rule under the environment trigger ran: nothing changed the environment yet.
    expect(requested[0]).not.toContain("agentlife.world/environment-changed");
    expect(first.summary.stages.find((stage) => stage.stage === "propagate")?.detail).toContain(
      "agentlife.body/value-changed",
    );

    simulation.orchestrator.runTick();
    requested.push(current);
    current = [];
    expect(requested[1]).not.toContain("agentlife.world/environment-changed");

    // Operating the lamp changes an environment value; the same tick re-evaluates that trigger.
    let environmentTick = 0;
    for (let tick = 3; tick <= 8 && environmentTick === 0; tick += 1) {
      simulation.orchestrator.runTick({ plans: tick === 3 ? [OPERATE_LAMP] : [] });
      requested.push(current);
      current = [];
      if (requested.at(-1)?.includes("agentlife.world/environment-changed")) environmentTick = tick;
    }
    expect(environmentTick).toBeGreaterThan(0);
    expect(simulation.orchestrator.state().world.environment["lamp-state"]).toBe(1);
    expect(requested.at(-2)).not.toContain("agentlife.world/environment-changed");
    expect(
      simulation.orchestrator
        .state()
        .summary?.actionOutcomes.some((outcome) => outcome.startsWith("agentlife.world/environment-changed")),
    ).toBe(true);
  });

  it("fails the tick when propagation exceeds the configured round limit and publishes no stable tick", async () => {
    const limited = await createSimulation({ timelineId: "timeline-limited", settings: { maxPropagationRounds: 1 } });
    const failed = limited.orchestrator.runTick();

    expect(failed.status).toBe("failed");
    expect(failed.summary.tick).toBe(0);
    expect(failed.summary.stages.find((stage) => stage.stage === "stability")?.status).toBe("failed");
    expect(limited.orchestrator.state().failure).toEqual({
      stage: "stability",
      code: "propagation-limit",
      detail: expect.any(String),
    });
    expect(limited.orchestrator.state().tick).toBe(0);
    expect(limited.orchestrator.state().runMode).toBe("failed");
    expect(limited.orchestrator.state().summary?.tick).toBe(0);

    // The same first tick settles when the tick is allowed enough rounds.
    const settled = await createSimulation({ timelineId: "timeline-limited" });
    expect(settled.orchestrator.runTick().status).toBe("completed");
    expect(settled.orchestrator.state().tick).toBe(1);
    expect(settled.orchestrator.state().failure).toBeNull();
  });

  it("records a barrier for an unindexed trigger without asking for anything outside the declared vocabulary", async () => {
    // Every rule under the body value trigger is removed from the demo pack.
    const removed: Record<string, null> = {
      "rules/base-move-cost.yaml": null,
      "rules/cognitive-participation.yaml": null,
      "rules/exhaustion-move-cost-factor.yaml": null,
      "rules/load-move-cost-factor.yaml": null,
      "rules/mode-selection.yaml": null,
      "rules/terrain-move-cost-factor.yaml": null,
    };
    const simulation = await createSimulationWith(removed, { timelineId: "timeline-barrier" });
    const declared = new Set(simulation.config.rules.flatMap((rule) => rule.triggers));
    expect(declared.has("agentlife.body/value-changed")).toBe(false);

    const requested: string[] = [];
    const call = simulation.core.runRules.bind(simulation.core);
    simulation.core.runRules = (request) => {
      requested.push(request.trigger);
      return call(request);
    };
    const result = simulation.orchestrator.runTick();
    const state = simulation.orchestrator.state();

    expect(result.status).toBe("barrier");
    expect(state.failure).toBeNull();
    expect(state.runMode).toBe("barrier");
    expect(state.barrier?.kind).toBe("missing-rules");
    expect(state.barrier?.trigger).toBe("agentlife.body/value-changed");
    expect(state.barrier?.stateRef?.startsWith("agentlife.body/values")).toBe(true);
    // No stable tick was published: the tick number stays and the barrier is recorded.
    expect(state.tick).toBe(0);
    expect(result.summary.tick).toBe(0);
    expect(result.summary.stages.find((stage) => stage.stage === "stability")?.status).toBe("failed");
    expect(result.summary.stages.find((stage) => stage.stage === "propagate")?.status).toBe("no-op");

    // Only the vocabulary the content declares was ever asked for.
    expect(requested.length).toBeGreaterThan(0);
    for (const trigger of requested) expect(declared.has(trigger)).toBe(true);
    for (const phase of PHASE_2_NO_OPS)
      expect(result.summary.stages.some((stage) => stage.stage === phase)).toBe(false);
  });

  it("records a whole tick: rule evaluation, world request, adjudication and the resulting event", async () => {
    const simulation = await createSimulation({ timelineId: "timeline-whole" });
    const move = testPlan("player-move-out", DEMO_PLAYER, "parallel", [
      { action: "agentlife.demo/walk", destination: DEMO_KILN },
    ]);
    simulation.orchestrator.runTick({ plans: [move] });
    for (let tick = 2; tick <= 4; tick += 1) simulation.orchestrator.runTick();

    const result = simulation.orchestrator.state().summary;
    const state = simulation.orchestrator.state();
    expect(result?.tick).toBe(4);
    expect(recordedPhases(result?.stages ?? [])).toEqual(TWELVE_PHASES);
    expect(result?.stages.find((stage) => stage.stage === "adjudicate")?.status).toBe("done");
    expect(result?.stages.find((stage) => stage.stage === "propagate")?.status).toBe("done");

    // The action that reached its world impact point asked the world and was adjudicated.
    const action = state.actions.find((entry) => entry.plan.planId === "player-move-out");
    expect(action?.status).toBe("completed");
    expect(action?.outcome?.status).toBe("completed");
    expect(action?.worldRequest?.kind).toBe("agentlife.demo/relocate");
    expect(action?.worldRequest?.actor).toBe(DEMO_PLAYER);
    expect(action?.worldRequest?.destination).toBe(DEMO_KILN);
    expect(result?.influenceOutcomes.some((outcome) => outcome.status === "applied")).toBe(true);

    // The committed world change is a recorded objective event and the new position is authoritative.
    const moved = state.world.events.find((event) => event.subject === DEMO_PLAYER);
    expect(moved?.kind).toBe("relation-changed");
    expect(moved?.stateRef).toBe("agentlife.world/located-at");
    expect(moved?.from).toBe(DEMO_SQUARE);
    expect(moved?.to).toBe(DEMO_KILN);
    expect(result?.eventCount).toBe(state.world.events.length);
  });
});
