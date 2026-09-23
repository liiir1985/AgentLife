import { describe, expect, it } from "vitest";
import { TICK_STAGES } from "../src/simulation/runner.js";
import type { ActionPlan, StageRecord } from "../src/simulation/types.js";
import {
  DEMO_KILN,
  DEMO_LAMP,
  DEMO_PLAYER,
  DEMO_SQUARE,
  createSimulation,
  createSimulationWith,
  removeDirectory,
  runPublishedTick,
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

/**
 * The stages phase 4 added to the tick: perception, the demand summary, the global
 * barrier and the working-memory confirmation. The demo pack declares perception and
 * cognition, so the companion really is perceived and really decides.
 */
const COGNITION_STAGES: readonly string[] = ["perception", "cognitive-demand", "cognitive-barrier", "memory"];

const OPERATE_LAMP = testPlan("player-operate", DEMO_PLAYER, "parallel", [
  { action: "agentlife.demo/use", target: DEMO_LAMP },
]);

/**
 * A body rule that can never reach a fixpoint once it wakes.
 *
 * Every round it flips the value it reads, so no round ever confirms the previous
 * one and the state keeps changing forever. Its condition keeps it out of
 * initialization - which has to settle for any simulation to start at all - and
 * the tick trigger lets it in on the first tick, where the demo content on its own
 * changes no body value at all.
 */
const DIVERGENT_INTEGRITY = `kind: rule
id: divergent-integrity
system: agentlife.body
triggers:
  - agentlife.body/value-changed
  - agentlife.body/tick-elapsed
inputs:
  - name: integrity
    state: agentlife.body/values.integrity
condition:
  op: simulation-time
  operator: at-or-after
  tick: 1
changes:
  - state: agentlife.body/values.integrity
    combine: priority
    priority: 1
    value:
      kind: select
      left:
        kind: read
        name: integrity
      right:
        kind: literal
        value: 1
        unit: ratio
      operator: eq
      then:
        kind: literal
        value: 0
        unit: ratio
      otherwise:
        kind: literal
        value: 1
        unit: ratio
`;

/**
 * A body rule that never settles, awake from the very first propagation.
 *
 * Its condition ignores the clock, so initialization selects it too: the value it
 * reads is the value it rewrites, and no round ever confirms the previous one. A
 * timeline whose initial state cannot be settled has no defined start, so creating
 * it fails rather than letting the simulation run on an undecided world.
 */
const UNSETTLED_INTEGRITY = `kind: rule
id: divergent-integrity
system: agentlife.body
triggers:
  - agentlife.body/value-changed
inputs:
  - name: integrity
    state: agentlife.body/values.integrity
condition:
  op: always
changes:
  - state: agentlife.body/values.integrity
    combine: priority
    priority: 1
    value:
      kind: select
      left:
        kind: read
        name: integrity
      right:
        kind: literal
        value: 1
        unit: ratio
      operator: eq
      then:
        kind: literal
        value: 0
        unit: ratio
      otherwise:
        kind: literal
        value: 1
        unit: ratio
`;

/** Stage records collapsed to the phase order they were recorded in. */
function recordedPhases(stages: readonly StageRecord[]): readonly string[] {
  const phases: string[] = [];
  for (const stage of stages) if (phases.at(-1) !== stage.stage) phases.push(stage.stage);
  return phases;
}

describe("phase 2 simulation runner", () => {
  it("records the fixed twelve phases in order, running the perception, cognition and memory stages", async () => {
    expect(TICK_STAGES).toEqual(TWELVE_PHASES);

    const simulation = await createSimulation({ timelineId: "timeline-phases" });
    const result = await simulation.runner.runTickToPublication();
    if (result.status !== "completed") throw new Error(`the first tick did not publish: ${result.status}`);
    const stages = result.summary.stages;

    expect(recordedPhases(stages)).toEqual(TWELVE_PHASES);
    expect(stages[0]?.stage).toBe("fixed");
    expect(stages.at(-1)?.stage).toBe("publish");
    expect(stages.every((stage) => stage.status !== "failed")).toBe(true);

    // Every phase is recorded with one of the three declared statuses.
    expect([...new Set(stages.map((stage) => stage.status))].sort()).toEqual(["done", "no-op"]);
    expect(stages.find((stage) => stage.stage === "stability")?.status).toBe("done");
    expect(stages.find((stage) => stage.stage === "publish")?.status).toBe("done");
    // The propagation phase is recorded every tick, even when it selects no rule: a
    // body at rest with full stamina has nothing to recompute until it moves.
    expect(stages.find((stage) => stage.stage === "propagate")?.status).toBe("no-op");

    // The demo content gives the companion perception and cognition modules, so the
    // stages that used to be explicit no-ops now carry the observations and the
    // decision of the one AI participant.
    for (const phase of COGNITION_STAGES) {
      const record = stages.find((stage) => stage.stage === phase);
      expect(record).toBeDefined();
      expect(record?.status).toBe("done");
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
    const runTick = async (plans: readonly ActionPlan[] = []): Promise<string[]> => {
      await runPublishedTick(simulation.runner, plans);
      const triggers = current;
      current = [];
      requested.push(triggers);
      return triggers;
    };

    // A body at rest changes nothing, so the tick rule is all the tick asks for.
    expect(await runTick()).toEqual(["agentlife.body/tick-elapsed"]);

    // The warden walks on its own, and the tick its action advances is the first tick
    // that changes a body value: the value trigger is re-evaluated in that same tick,
    // through the index and not by asking everything the content declares.
    let walking: string[] = [];
    for (let tick = 0; tick < 4 && !walking.includes("agentlife.body/value-changed"); tick += 1)
      walking = await runTick();
    expect(walking).toContain("agentlife.body/action-advanced");
    expect(walking).toContain("agentlife.body/value-changed");
    // No rule under the environment trigger ran: nothing changed the environment yet.
    expect(walking).not.toContain("agentlife.world/environment-changed");

    // Operating the lamp changes an environment value; the same tick re-evaluates that trigger.
    let environment: string[] = [];
    for (let tick = 0; tick < 6 && !environment.includes("agentlife.world/environment-changed"); tick += 1)
      environment = await runTick(tick === 0 ? [OPERATE_LAMP] : []);
    expect(environment).toContain("agentlife.world/environment-changed");
    expect(simulation.runner.state().world.environment["lamp-state"]).toBe(1);
    // The tick before the lamp was lit had nothing to re-evaluate either.
    const litAt = requested.lastIndexOf(environment);
    expect(requested[litAt - 1] ?? []).not.toContain("agentlife.world/environment-changed");
    expect(
      simulation.runner
        .state()
        .summary?.actionOutcomes.some((outcome) => outcome.startsWith("agentlife.world/environment-changed")),
    ).toBe(true);
  });

  it("fails the tick when propagation exceeds the configured round limit and publishes no stable tick", async () => {
    // Initialization has to settle before a tick can even be attempted, so a rule
    // that diverges has to stay out of it: this one only wakes inside a tick, and
    // once it wakes it never stops, because each round changes the value again.
    const limited = await createSimulationWith(
      { "rules/divergent-integrity.yaml": DIVERGENT_INTEGRITY },
      { timelineId: "timeline-limited", settings: { maxPropagationRounds: 3 } },
    );
    try {
      const failed = limited.runner.runTick();

      expect(failed.status).toBe("failed");
      if (failed.status !== "failed") return;
      expect(failed.summary.tick).toBe(0);
      expect(failed.summary.stages.find((stage) => stage.stage === "stability")?.status).toBe("failed");
      expect(limited.runner.state().failure).toEqual({
        stage: "stability",
        code: "propagation-limit",
        detail: expect.any(String),
      });
      expect(limited.runner.state().tick).toBe(0);
      expect(limited.runner.state().runMode).toBe("failed");
      expect(limited.runner.state().summary?.tick).toBe(0);
    } finally {
      removeDirectory(limited.directory);
    }

    // The same first tick settles when the tick is allowed enough rounds.
    const settled = await createSimulation({ timelineId: "timeline-limited" });
    await runPublishedTick(settled.runner);
    expect(settled.runner.state().tick).toBe(1);
    expect(settled.runner.state().failure).toBeNull();
  });

  it("refuses to start when the initial state cannot be settled", async () => {
    // The rule is awake during initialization and never reaches a fixpoint, so the
    // run has no defined start: the constructor says so instead of starting anyway.
    await expect(
      createSimulationWith(
        { "rules/divergent-integrity.yaml": UNSETTLED_INTEGRITY },
        { timelineId: "timeline-unsettled" },
      ),
    ).rejects.toThrow(/Initialization did not settle: propagation exceeded \d+ rounds/);
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
    // Nothing changes a body value while everyone stands still, so the run has to
    // reach the tick where the warden's own action advances: that change is the one
    // nothing in this content is indexed for any more.
    let result = await simulation.runner.runTickToPublication();
    for (let tick = 0; tick < 5 && result.status !== "rule-barrier"; tick += 1) {
      result = await simulation.runner.runTickToPublication();
    }
    const state = simulation.runner.state();

    expect(result.status).toBe("rule-barrier");
    if (result.status !== "rule-barrier")
      throw new Error(`the tick did not stop on the rule barrier: ${result.status}`);
    expect(state.failure).toBeNull();
    expect(state.runMode).toBe("barrier");
    expect(state.barrier?.kind).toBe("missing-rules");
    expect(state.barrier?.trigger).toBe("agentlife.body/value-changed");
    expect(state.barrier?.stateRef?.startsWith("agentlife.body/values")).toBe(true);
    // This tick was not published: the number stays where the last published tick left
    // it, and the barrier is recorded instead.
    expect(state.tick).toBe(3);
    expect(result.summary.tick).toBe(3);
    expect(result.summary.stages.find((stage) => stage.stage === "stability")?.status).toBe("failed");
    expect(result.summary.stages.find((stage) => stage.stage === "propagate")?.status).toBe("no-op");

    // Only the vocabulary the content declares was ever asked for.
    expect(requested.length).toBeGreaterThan(0);
    for (const trigger of requested) expect(declared.has(trigger)).toBe(true);
    // The tick never reached stage 8, so no observer received material; the stages
    // that follow are still recorded, each as an explicit no-op rather than work a
    // participant did.
    const recorded = result.summary.stages.map((stage) => stage.stage);
    expect(recorded).not.toContain("perception");
    for (const phase of ["cognitive-demand", "cognitive-barrier", "memory"]) {
      expect(result.summary.stages.find((stage) => stage.stage === phase)?.status).toBe("no-op");
    }
  });

  it("records a whole tick: rule evaluation, world request, adjudication and the resulting event", async () => {
    const simulation = await createSimulation({ timelineId: "timeline-whole" });
    const move = testPlan("player-move-out", DEMO_PLAYER, "parallel", [
      { action: "agentlife.demo/walk", destination: DEMO_KILN },
    ]);
    await runPublishedTick(simulation.runner, [move]);
    for (let tick = 2; tick <= 4; tick += 1) await runPublishedTick(simulation.runner);

    const result = simulation.runner.state().summary;
    const state = simulation.runner.state();
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
