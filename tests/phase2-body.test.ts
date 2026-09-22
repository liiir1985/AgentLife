import { describe, expect, it } from "vitest";
import type { SimulationRunner, TickResult } from "../src/simulation/runner.js";
import type { ProjectionSources } from "../src/simulation/projection.js";
import type { ActionPlan, BodyState, WorldState } from "../src/simulation/types.js";
import type { TickContext } from "../src/simulation/world-service.js";
import {
  DEMO_BENCH,
  DEMO_KILN,
  DEMO_LAMP,
  DEMO_PLAYER,
  DEMO_ROPE,
  DEMO_SQUARE,
  actionsOf,
  createSimulation,
  createSimulationWith,
  lastAction,
  positionOf,
  removeDirectory,
  testPlan,
  worldOf,
} from "./helpers/phase2.js";

/** Actions, relations and ids the demo content declares. */
const WALK = "agentlife.demo/walk";
const SAY = "agentlife.demo/say";
const WAVE = "agentlife.demo/wave";
const GRASP = "agentlife.demo/grasp";
const LAY_DOWN = "agentlife.demo/lay-down";
const USE = "agentlife.demo/use";
const HOLD = "agentlife.demo/hold";
const HELD_BY = "agentlife.world/held-by";
const DEMO_ORCHARD = "agentlife.demo/orchard";
const TIMELINE = "timeline-test";

/** Walking made exclusive, so two moves of one body collide on the resource. */
const EXCLUSIVE_LOCOMOTION = `id: locomotion
type: agentlife.body/resource
public: true
fields:
  name: 行走
  description: 同一时刻只能被一个动作占用的行走资源
  exclusive: true
`;

/** A gesture that refuses to be interrupted by a replacement. */
const UNINTERRUPTIBLE_WAVE = `id: wave
type: agentlife.body/action
public: true
fields:
  name: 挥手
  description: 一旦抬手就不再允许被打断的挥手动作。
  ability: agentlife.demo/gesture
  interruptible: false
  stages:
    - name: 抬手
      ticks: 2
      resource: agentlife.demo/hands
`;

function run(runner: SimulationRunner, plans: readonly ActionPlan[] = []): TickResult {
  const result = runner.runTick({ plans });
  expect(result.status).toBe("completed");
  return result;
}

describe("BodyService", () => {
  it("starts a plan accepted in one tick only from the next tick", async () => {
    const sim = await createSimulation();
    const runner = sim.runner;
    run(runner, [testPlan("p-say", DEMO_PLAYER, "parallel", [{ action: SAY }])]);

    const accepted = lastAction(runner, "p-say");
    expect(accepted?.status).toBe("running");
    expect(accepted?.acceptedTick).toBe(1);
    expect(accepted?.eligibleTick).toBe(2);
    expect(accepted?.stageIndex).toBe(0);
    expect(accepted?.stageTicks).toBe(0);

    run(runner);
    expect(lastAction(runner, "p-say")?.status).toBe("running");
    expect(lastAction(runner, "p-say")?.stageTicks).toBe(1);
  });

  it("runs speaking and moving in parallel for one entity", async () => {
    const sim = await createSimulation();
    const runner = sim.runner;
    run(runner, [
      testPlan("p-walk", DEMO_PLAYER, "parallel", [{ action: WALK, destination: DEMO_KILN }]),
      testPlan("p-say", DEMO_PLAYER, "parallel", [{ action: SAY }]),
    ]);
    expect(lastAction(runner, "p-walk")?.status).toBe("running");
    expect(lastAction(runner, "p-say")?.status).toBe("running");

    run(runner);
    run(runner);
    expect(lastAction(runner, "p-say")?.status).toBe("completed");
    expect(lastAction(runner, "p-walk")?.status).toBe("running");
    expect(positionOf(runner, DEMO_PLAYER)).toBe(DEMO_SQUARE);

    run(runner);
    expect(lastAction(runner, "p-walk")?.status).toBe("completed");
    expect(positionOf(runner, DEMO_PLAYER)).toBe(DEMO_KILN);
  });

  it("refuses a gesture and a take that need the same arms under the parallel policy", async () => {
    const sim = await createSimulation();
    const runner = sim.runner;
    run(runner, [
      testPlan("p-wave", DEMO_PLAYER, "parallel", [{ action: WAVE }]),
      testPlan("p-grasp", DEMO_PLAYER, "parallel", [{ action: GRASP, target: DEMO_ROPE }]),
    ]);

    expect(lastAction(runner, "p-wave")?.status).toBe("running");
    expect(lastAction(runner, "p-grasp")).toBeUndefined();
    expect(actionsOf(runner, DEMO_PLAYER)).toHaveLength(1);
    expect(worldOf(runner).entities[DEMO_ROPE]?.heldBy).toBeNull();
    expect(worldOf(runner).entities[DEMO_ROPE]?.locatedAt).toBe(DEMO_SQUARE);
  });

  it("queues a conflicting take and starts it once the gesture has ended", async () => {
    const sim = await createSimulation();
    const runner = sim.runner;
    run(runner, [
      testPlan("p-wave", DEMO_PLAYER, "parallel", [{ action: WAVE }]),
      testPlan("p-grasp", DEMO_PLAYER, "queue", [{ action: GRASP, target: DEMO_ROPE }]),
    ]);
    expect(lastAction(runner, "p-wave")?.status).toBe("running");
    expect(lastAction(runner, "p-grasp")?.status).toBe("queued");

    run(runner);
    run(runner);
    expect(lastAction(runner, "p-wave")?.status).toBe("completed");
    expect(lastAction(runner, "p-grasp")?.status).toBe("queued");

    run(runner);
    expect(lastAction(runner, "p-grasp")?.status).toBe("running");
    expect(worldOf(runner).entities[DEMO_ROPE]?.heldBy).toBeNull();

    run(runner);
    run(runner);
    run(runner);
    expect(lastAction(runner, "p-grasp")?.status).toBe("completed");
    expect(worldOf(runner).entities[DEMO_ROPE]?.heldBy).toBe(DEMO_PLAYER);
  });

  it("replaces the running gesture with a take under the replace policy", async () => {
    const sim = await createSimulation();
    const runner = sim.runner;
    run(runner, [testPlan("p-wave", DEMO_PLAYER, "parallel", [{ action: WAVE }])]);
    run(runner, [testPlan("p-grasp", DEMO_PLAYER, "replace", [{ action: GRASP, target: DEMO_ROPE }])]);

    expect(lastAction(runner, "p-wave")?.status).toBe("interrupted");
    expect(lastAction(runner, "p-wave")?.outcome?.status).toBe("interrupted");
    expect(lastAction(runner, "p-grasp")?.status).toBe("running");
    expect(lastAction(runner, "p-grasp")?.eligibleTick).toBe(3);

    run(runner);
    run(runner);
    run(runner);
    expect(lastAction(runner, "p-grasp")?.status).toBe("completed");
    expect(worldOf(runner).entities[DEMO_ROPE]?.heldBy).toBe(DEMO_PLAYER);
  });

  it("does not start a queued move whose destination is no longer an exit", async () => {
    const sim = await createSimulationWith({ "resources/locomotion.yaml": EXCLUSIVE_LOCOMOTION });
    try {
      const runner = sim.runner;
      run(runner, [
        testPlan("p-out", DEMO_PLAYER, "parallel", [{ action: WALK, destination: DEMO_KILN }]),
        testPlan("p-away", DEMO_PLAYER, "queue", [{ action: WALK, destination: DEMO_ORCHARD }]),
      ]);
      expect(lastAction(runner, "p-out")?.status).toBe("running");
      expect(lastAction(runner, "p-away")?.status).toBe("queued");

      run(runner);
      run(runner);
      run(runner);
      expect(positionOf(runner, DEMO_PLAYER)).toBe(DEMO_KILN);
      expect(lastAction(runner, "p-away")?.status).toBe("queued");

      // The kiln is not next to the orchard, so the queued move has no premise left.
      expect(runner.world.locationExits(DEMO_KILN)).toEqual([DEMO_SQUARE]);
      run(runner);
      expect(lastAction(runner, "p-away")?.status).toBe("queued");
      expect(lastAction(runner, "p-away")?.worldRequest).toBeNull();
      expect(positionOf(runner, DEMO_PLAYER)).toBe(DEMO_KILN);
    } finally {
      removeDirectory(sim.directory);
    }
  });

  it("leaves the previous action running when a replace is refused", async () => {
    const sim = await createSimulationWith({ "actions/wave.yaml": UNINTERRUPTIBLE_WAVE });
    try {
      const runner = sim.runner;
      run(runner, [testPlan("p-wave", DEMO_PLAYER, "parallel", [{ action: WAVE }])]);
      run(runner, [testPlan("p-grasp", DEMO_PLAYER, "replace", [{ action: GRASP, target: DEMO_ROPE }])]);

      const wave = lastAction(runner, "p-wave");
      expect(wave?.status).toBe("running");
      expect(wave?.outcome).toBeNull();
      expect(wave?.stageTicks).toBe(1);
      expect(lastAction(runner, "p-grasp")).toBeUndefined();
      expect(worldOf(runner).entities[DEMO_ROPE]?.heldBy).toBeNull();

      run(runner);
      expect(lastAction(runner, "p-wave")?.status).toBe("completed");
    } finally {
      removeDirectory(sim.directory);
    }
  });

  it("completes an action the world accepted", async () => {
    const sim = await createSimulation();
    const runner = sim.runner;
    run(runner, [testPlan("p-use", DEMO_PLAYER, "parallel", [{ action: USE, target: DEMO_LAMP }])]);
    run(runner);
    run(runner);

    expect(lastAction(runner, "p-use")?.status).toBe("completed");
    expect(lastAction(runner, "p-use")?.outcome?.status).toBe("completed");
    expect(worldOf(runner).environment["lamp-state"]).toBe(1);
  });

  it("fails an action the world refused", async () => {
    const sim = await createSimulation();
    const runner = sim.runner;
    run(runner, [testPlan("p-take-bench", DEMO_PLAYER, "parallel", [{ action: GRASP, target: DEMO_BENCH }])]);
    run(runner);
    run(runner);
    run(runner);

    expect(lastAction(runner, "p-take-bench")?.status).toBe("failed");
    expect(lastAction(runner, "p-take-bench")?.outcome?.status).toBe("failed");
    expect(worldOf(runner).entities[DEMO_BENCH]?.heldBy).toBeNull();
    expect(worldOf(runner).entities[DEMO_BENCH]?.locatedAt).toBe(DEMO_SQUARE);
  });

  it("fails an action whose request reached a world that had already moved", async () => {
    const sim = await createSimulation();
    const runner = sim.runner;
    const start = runner.state();
    const contextOf = (tick: number): TickContext => ({
      timelineId: TIMELINE,
      tick,
      command: "tick",
    });
    const sourcesFor = (world: WorldState, body: BodyState): ProjectionSources => ({
      config: sim.config,
      world,
      characters: start.characters,
      body,
    });

    const accepted = runner.body.acceptPlan(
      { body: start.body, actions: start.actions },
      start.characters,
      testPlan("p-use", DEMO_PLAYER, "parallel", [{ action: USE, target: DEMO_LAMP }]),
      start.world,
      contextOf(1),
    );
    expect(accepted.outcome.status).toBe("running");

    let runtime = runner.body.advance(
      accepted.runtime,
      sourcesFor(start.world, accepted.runtime.body),
      start.characters,
      contextOf(2),
    ).runtime;
    runtime = runner.body.advance(
      runtime,
      sourcesFor(start.world, runtime.body),
      start.characters,
      contextOf(3),
    ).runtime;
    const pending = runtime.actions.find((action) => action.status === "waiting-world");
    if (pending === undefined) throw new Error("no action reached its world impact point");
    const request = pending.worldRequest;
    if (request === null) throw new Error("the waiting action carries no world request");

    // Another influence commits first, so the frame the request waits for moved on.
    const hold = runner.world.adjudicate(
      sourcesFor(start.world, runtime.body),
      {
        influenceId: "peer-take",
        timelineId: TIMELINE,
        kind: HOLD,
        actor: DEMO_PLAYER,
        subject: DEMO_ROPE,
        destination: null,
        baseVersion: start.world.version,
        tick: 3,
      },
      start.world.version,
    );
    expect(hold.outcome.status).toBe("applied");
    const stale = runner.world.adjudicate(sourcesFor(hold.state, runtime.body), request, hold.state.version);
    expect(stale.outcome.status).toBe("stale");

    const absorbed = runner.body.absorb(runtime, stale.outcome, contextOf(3));
    const failed = absorbed.actions.find((action) => action.actionId === pending.actionId);
    expect(failed?.status).toBe("failed");
    expect(failed?.outcome?.status).toBe("failed");
    expect(hold.state.environment["lamp-state"]).toBe(0);
  });

  it("keeps a change that was already committed when a later step of the action fails", async () => {
    const sim = await createSimulation();
    const runner = sim.runner;
    run(runner, [
      testPlan("p-take-then-place", DEMO_PLAYER, "parallel", [
        { action: GRASP, target: DEMO_ROPE },
        { action: LAY_DOWN, target: DEMO_ROPE, destination: DEMO_LAMP },
      ]),
    ]);

    // Ticks 2 to 8: the take commits, then the place is refused by the lamp.
    for (let tick = 0; tick < 7; tick += 1) run(runner);

    const action = lastAction(runner, "p-take-then-place");
    expect(action?.action).toBe(LAY_DOWN);
    expect(action?.stepIndex).toBe(1);
    expect(action?.status).toBe("failed");
    expect(
      worldOf(runner).events.some(
        (event) => event.stateRef === HELD_BY && event.subject === DEMO_ROPE && event.to === DEMO_PLAYER,
      ),
    ).toBe(true);
    expect(worldOf(runner).entities[DEMO_ROPE]?.heldBy).toBe(DEMO_PLAYER);
    expect(worldOf(runner).entities[DEMO_ROPE]?.placedOn).toBeNull();
  });
});
