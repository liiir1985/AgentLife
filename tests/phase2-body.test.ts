import { describe, expect, it } from "vitest";
import type { PrerequisiteCheck } from "../src/simulation/body-service.js";
import type { SimulationOrchestrator, TickResult } from "../src/simulation/orchestrator.js";
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

function run(orchestrator: SimulationOrchestrator, plans: readonly ActionPlan[] = []): TickResult {
  const result = orchestrator.runTick({ plans });
  expect(result.status).toBe("completed");
  return result;
}

describe("BodyService", () => {
  it("starts a plan accepted in one tick only from the next tick", async () => {
    const sim = await createSimulation();
    const orchestrator = sim.orchestrator;
    run(orchestrator, [testPlan("p-say", DEMO_PLAYER, "parallel", [{ action: SAY }])]);

    const accepted = lastAction(orchestrator, "p-say");
    expect(accepted?.status).toBe("running");
    expect(accepted?.acceptedTick).toBe(1);
    expect(accepted?.eligibleTick).toBe(2);
    expect(accepted?.stageIndex).toBe(0);
    expect(accepted?.stageTicks).toBe(0);

    run(orchestrator);
    expect(lastAction(orchestrator, "p-say")?.status).toBe("running");
    expect(lastAction(orchestrator, "p-say")?.stageTicks).toBe(1);
  });

  it("runs speaking and moving in parallel for one entity", async () => {
    const sim = await createSimulation();
    const orchestrator = sim.orchestrator;
    run(orchestrator, [
      testPlan("p-walk", DEMO_PLAYER, "parallel", [{ action: WALK, destination: DEMO_KILN }]),
      testPlan("p-say", DEMO_PLAYER, "parallel", [{ action: SAY }]),
    ]);
    expect(lastAction(orchestrator, "p-walk")?.status).toBe("running");
    expect(lastAction(orchestrator, "p-say")?.status).toBe("running");

    run(orchestrator);
    run(orchestrator);
    expect(lastAction(orchestrator, "p-say")?.status).toBe("completed");
    expect(lastAction(orchestrator, "p-walk")?.status).toBe("running");
    expect(positionOf(orchestrator, DEMO_PLAYER)).toBe(DEMO_SQUARE);

    run(orchestrator);
    expect(lastAction(orchestrator, "p-walk")?.status).toBe("completed");
    expect(positionOf(orchestrator, DEMO_PLAYER)).toBe(DEMO_KILN);
  });

  it("refuses a gesture and a take that need the same arms under the parallel policy", async () => {
    const sim = await createSimulation();
    const orchestrator = sim.orchestrator;
    run(orchestrator, [
      testPlan("p-wave", DEMO_PLAYER, "parallel", [{ action: WAVE }]),
      testPlan("p-grasp", DEMO_PLAYER, "parallel", [{ action: GRASP, target: DEMO_ROPE }]),
    ]);

    expect(lastAction(orchestrator, "p-wave")?.status).toBe("running");
    expect(lastAction(orchestrator, "p-grasp")).toBeUndefined();
    expect(actionsOf(orchestrator, DEMO_PLAYER)).toHaveLength(1);
    expect(worldOf(orchestrator).entities[DEMO_ROPE]?.heldBy).toBeNull();
    expect(worldOf(orchestrator).entities[DEMO_ROPE]?.locatedAt).toBe(DEMO_SQUARE);
  });

  it("queues a conflicting take and starts it once the gesture has ended", async () => {
    const sim = await createSimulation();
    const orchestrator = sim.orchestrator;
    run(orchestrator, [
      testPlan("p-wave", DEMO_PLAYER, "parallel", [{ action: WAVE }]),
      testPlan("p-grasp", DEMO_PLAYER, "queue", [{ action: GRASP, target: DEMO_ROPE }]),
    ]);
    expect(lastAction(orchestrator, "p-wave")?.status).toBe("running");
    expect(lastAction(orchestrator, "p-grasp")?.status).toBe("queued");

    run(orchestrator);
    run(orchestrator);
    expect(lastAction(orchestrator, "p-wave")?.status).toBe("completed");
    expect(lastAction(orchestrator, "p-grasp")?.status).toBe("queued");

    run(orchestrator);
    expect(lastAction(orchestrator, "p-grasp")?.status).toBe("running");
    expect(worldOf(orchestrator).entities[DEMO_ROPE]?.heldBy).toBeNull();

    run(orchestrator);
    run(orchestrator);
    run(orchestrator);
    expect(lastAction(orchestrator, "p-grasp")?.status).toBe("completed");
    expect(worldOf(orchestrator).entities[DEMO_ROPE]?.heldBy).toBe(DEMO_PLAYER);
  });

  it("replaces the running gesture with a take under the replace policy", async () => {
    const sim = await createSimulation();
    const orchestrator = sim.orchestrator;
    run(orchestrator, [testPlan("p-wave", DEMO_PLAYER, "parallel", [{ action: WAVE }])]);
    run(orchestrator, [testPlan("p-grasp", DEMO_PLAYER, "replace", [{ action: GRASP, target: DEMO_ROPE }])]);

    expect(lastAction(orchestrator, "p-wave")?.status).toBe("interrupted");
    expect(lastAction(orchestrator, "p-wave")?.outcome?.status).toBe("interrupted");
    expect(lastAction(orchestrator, "p-grasp")?.status).toBe("running");
    expect(lastAction(orchestrator, "p-grasp")?.eligibleTick).toBe(3);

    run(orchestrator);
    run(orchestrator);
    run(orchestrator);
    expect(lastAction(orchestrator, "p-grasp")?.status).toBe("completed");
    expect(worldOf(orchestrator).entities[DEMO_ROPE]?.heldBy).toBe(DEMO_PLAYER);
  });

  it("does not start a queued move whose destination is no longer an exit", async () => {
    const sim = await createSimulationWith({ "resources/locomotion.yaml": EXCLUSIVE_LOCOMOTION });
    try {
      const orchestrator = sim.orchestrator;
      run(orchestrator, [
        testPlan("p-out", DEMO_PLAYER, "parallel", [{ action: WALK, destination: DEMO_KILN }]),
        testPlan("p-away", DEMO_PLAYER, "queue", [{ action: WALK, destination: DEMO_ORCHARD }]),
      ]);
      expect(lastAction(orchestrator, "p-out")?.status).toBe("running");
      expect(lastAction(orchestrator, "p-away")?.status).toBe("queued");

      run(orchestrator);
      run(orchestrator);
      run(orchestrator);
      expect(positionOf(orchestrator, DEMO_PLAYER)).toBe(DEMO_KILN);
      expect(lastAction(orchestrator, "p-away")?.status).toBe("queued");

      // The kiln is not next to the orchard, so the queued move has no premise left.
      expect(orchestrator.world.locationExits(DEMO_KILN)).toEqual([DEMO_SQUARE]);
      run(orchestrator);
      expect(lastAction(orchestrator, "p-away")?.status).toBe("queued");
      expect(lastAction(orchestrator, "p-away")?.worldRequest).toBeNull();
      expect(positionOf(orchestrator, DEMO_PLAYER)).toBe(DEMO_KILN);
    } finally {
      removeDirectory(sim.directory);
    }
  });

  it("leaves the previous action running when a replace is refused", async () => {
    const sim = await createSimulationWith({ "actions/wave.yaml": UNINTERRUPTIBLE_WAVE });
    try {
      const orchestrator = sim.orchestrator;
      run(orchestrator, [testPlan("p-wave", DEMO_PLAYER, "parallel", [{ action: WAVE }])]);
      run(orchestrator, [testPlan("p-grasp", DEMO_PLAYER, "replace", [{ action: GRASP, target: DEMO_ROPE }])]);

      const wave = lastAction(orchestrator, "p-wave");
      expect(wave?.status).toBe("running");
      expect(wave?.outcome).toBeNull();
      expect(wave?.stageTicks).toBe(1);
      expect(lastAction(orchestrator, "p-grasp")).toBeUndefined();
      expect(worldOf(orchestrator).entities[DEMO_ROPE]?.heldBy).toBeNull();

      run(orchestrator);
      expect(lastAction(orchestrator, "p-wave")?.status).toBe("completed");
    } finally {
      removeDirectory(sim.directory);
    }
  });

  it("completes an action the world accepted", async () => {
    const sim = await createSimulation();
    const orchestrator = sim.orchestrator;
    run(orchestrator, [testPlan("p-use", DEMO_PLAYER, "parallel", [{ action: USE, target: DEMO_LAMP }])]);
    run(orchestrator);
    run(orchestrator);

    expect(lastAction(orchestrator, "p-use")?.status).toBe("completed");
    expect(lastAction(orchestrator, "p-use")?.outcome?.status).toBe("completed");
    expect(worldOf(orchestrator).environment["lamp-state"]).toBe(1);
  });

  it("fails an action the world refused", async () => {
    const sim = await createSimulation();
    const orchestrator = sim.orchestrator;
    run(orchestrator, [testPlan("p-take-bench", DEMO_PLAYER, "parallel", [{ action: GRASP, target: DEMO_BENCH }])]);
    run(orchestrator);
    run(orchestrator);
    run(orchestrator);

    expect(lastAction(orchestrator, "p-take-bench")?.status).toBe("failed");
    expect(lastAction(orchestrator, "p-take-bench")?.outcome?.status).toBe("failed");
    expect(worldOf(orchestrator).entities[DEMO_BENCH]?.heldBy).toBeNull();
    expect(worldOf(orchestrator).entities[DEMO_BENCH]?.locatedAt).toBe(DEMO_SQUARE);
  });

  it("fails an action whose request reached a world that had already moved", async () => {
    const sim = await createSimulation();
    const orchestrator = sim.orchestrator;
    const start = orchestrator.state();
    const allowEveryAction: PrerequisiteCheck = () => ({ ok: true });
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

    const accepted = orchestrator.body.acceptPlan(
      { body: start.body, actions: start.actions },
      start.characters,
      testPlan("p-use", DEMO_PLAYER, "parallel", [{ action: USE, target: DEMO_LAMP }]),
      contextOf(1),
      allowEveryAction,
    );
    expect(accepted.outcome.status).toBe("running");

    let runtime = orchestrator.body.advance(
      accepted.runtime,
      sourcesFor(start.world, accepted.runtime.body),
      start.characters,
      contextOf(2),
      allowEveryAction,
    ).runtime;
    runtime = orchestrator.body.advance(
      runtime,
      sourcesFor(start.world, runtime.body),
      start.characters,
      contextOf(3),
      allowEveryAction,
    ).runtime;
    const pending = runtime.actions.find((action) => action.status === "waiting-world");
    if (pending === undefined) throw new Error("no action reached its world impact point");
    const request = pending.worldRequest;
    if (request === null) throw new Error("the waiting action carries no world request");

    // Another influence commits first, so the frame the request waits for moved on.
    const hold = orchestrator.world.adjudicate(
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
    const stale = orchestrator.world.adjudicate(sourcesFor(hold.state, runtime.body), request, hold.state.version);
    expect(stale.outcome.status).toBe("stale");

    const absorbed = orchestrator.body.absorb(runtime, stale.outcome, contextOf(3));
    const failed = absorbed.actions.find((action) => action.actionId === pending.actionId);
    expect(failed?.status).toBe("failed");
    expect(failed?.outcome?.status).toBe("failed");
    expect(hold.state.environment["lamp-state"]).toBe(0);
  });

  it("keeps a change that was already committed when a later step of the action fails", async () => {
    const sim = await createSimulation();
    const orchestrator = sim.orchestrator;
    run(orchestrator, [
      testPlan("p-take-then-place", DEMO_PLAYER, "parallel", [
        { action: GRASP, target: DEMO_ROPE },
        { action: LAY_DOWN, target: DEMO_ROPE, destination: DEMO_LAMP },
      ]),
    ]);

    // Ticks 2 to 8: the take commits, then the place is refused by the lamp.
    for (let tick = 0; tick < 7; tick += 1) run(orchestrator);

    const action = lastAction(orchestrator, "p-take-then-place");
    expect(action?.action).toBe(LAY_DOWN);
    expect(action?.stepIndex).toBe(1);
    expect(action?.status).toBe("failed");
    expect(
      worldOf(orchestrator).events.some(
        (event) => event.stateRef === HELD_BY && event.subject === DEMO_ROPE && event.to === DEMO_PLAYER,
      ),
    ).toBe(true);
    expect(worldOf(orchestrator).entities[DEMO_ROPE]?.heldBy).toBe(DEMO_PLAYER);
    expect(worldOf(orchestrator).entities[DEMO_ROPE]?.placedOn).toBeNull();
  });
});
