import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { digestOf } from "../src/simulation/demo.js";
import { SimulationRunner } from "../src/simulation/runner.js";
import { checkSnapshot, decodeSnapshot, encodeSnapshot, snapshotOf } from "../src/simulation/save.js";
import type { ActionPlan } from "../src/simulation/types.js";
import { RuntimeStore, SIMULATION_SAVE_TYPE, SIMULATION_SAVE_VERSION } from "../src/storage/runtime-store.js";
import {
  DEMO_KILN,
  DEMO_LAMP,
  DEMO_PLAYER,
  DEMO_ROPE,
  DEMO_SQUARE,
  DEMO_WARDEN,
  createSimulation,
  publishDemoWith,
  testPlan,
} from "./helpers/phase2.js";

/**
 * Phase 2 acceptance: explicit save and load.
 *
 * A save is a copy of the authoritative state at a stable tick; loading it back
 * over the same published config must continue the very same simulation, and a
 * save that does not belong to the running config must be refused whole.
 */

/** The plans one run supplies, keyed by the tick they are submitted in. */
const SCRIPT: Readonly<Record<number, readonly ActionPlan[]>> = Object.freeze({
  1: [testPlan("player-out", DEMO_PLAYER, "parallel", [{ action: "agentlife.demo/walk", destination: DEMO_KILN }])],
  2: [testPlan("player-say", DEMO_PLAYER, "parallel", [{ action: "agentlife.demo/say" }])],
  5: [testPlan("player-back", DEMO_PLAYER, "parallel", [{ action: "agentlife.demo/walk", destination: DEMO_SQUARE }])],
  9: [testPlan("player-operate", DEMO_PLAYER, "parallel", [{ action: "agentlife.demo/use", target: DEMO_LAMP }])],
  12: [testPlan("player-grasp", DEMO_PLAYER, "parallel", [{ action: "agentlife.demo/grasp", target: DEMO_ROPE }])],
});

function runTicks(runner: SimulationRunner, from: number, count: number): void {
  for (let tick = from; tick < from + count; tick += 1)
    expect(runner.runTick({ plans: SCRIPT[tick] ?? [] }).status).toBe("completed");
}

/** Opens one store over a temporary database; the host may still hold the file briefly. */
function withStore<T>(run: (store: RuntimeStore) => T): T {
  const directory = mkdtempSync(join(tmpdir(), "agent-life-phase2-save-"));
  const store = new RuntimeStore(join(directory, "runtime.db"));
  try {
    return run(store);
  } finally {
    store.close();
    try {
      rmSync(directory, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      // ignored on purpose: a closed sqlite file can still be held by the host
    }
  }
}

describe("phase 2 save and load", () => {
  it("stores one snapshot and restores exactly the saved world, bodies, characters, plans and processes", async () => {
    const simulation = await createSimulation({ timelineId: "timeline-save" });
    runTicks(simulation.runner, 1, 13);
    const state = simulation.runner.state();
    expect(state.world.processes.map((process) => process.processRef)).toEqual(["agentlife.world/lamp-glow"]);
    expect(state.body.bodies[DEMO_PLAYER]?.values["wakefulness"]).toBe(40);
    expect(state.actions.length).toBeGreaterThan(0);
    expect(state.behaviours[DEMO_WARDEN]).toBeDefined();

    const saved = snapshotOf(state, "save-stable-tick", simulation.config);
    expect(saved.tick).toBe(13);
    expect(saved.timelineId).toBe("timeline-save");
    expect(saved.phase).toBe("publish");
    expect(saved.simTime).toEqual({ tick: 13, seconds: 13 });
    expect(saved.configId).toBe(simulation.config.configId);
    expect(saved.systems).toEqual(simulation.config.systems);

    withStore((store) => {
      store.saveConfig({
        configId: simulation.config.configId,
        namespace: "agentlife.demo",
        packVersion: "1.1.0",
        document: simulation.config.sourceData,
      });
      expect(store.checkRestore(simulation.config.configId)).toEqual({ ok: true });

      const outcome = store.saveSimulation({
        saveId: saved.saveId,
        timelineId: saved.timelineId,
        tick: saved.tick,
        configId: saved.configId,
        payload: encodeSnapshot(saved),
      });
      expect(outcome).toBe("committed");
      expect(store.listSaves()).toEqual([
        { saveId: "save-stable-tick", timelineId: "timeline-save", tick: 13, configId: simulation.config.configId },
      ]);

      const decoded = decodeSnapshot(store.loadSimulation(saved.saveId));
      expect(decoded.ok).toBe(true);
      if (!decoded.ok) throw new Error(`the stored save did not decode: ${decoded.reason}`);
      const snapshot = decoded.snapshot;
      expect(checkSnapshot(snapshot, simulation.config)).toEqual({ ok: true });

      const restored = SimulationRunner.create(simulation.core, { timelineId: "timeline-restored" });
      restored.load({ ...snapshot.state, timelineId: "timeline-restored" });
      const before = snapshot.state;
      const after = restored.state();

      expect(after.tick).toBe(before.tick);
      expect(after.simTime).toEqual(before.simTime);
      expect(after.phase).toBe(before.phase);
      expect(after.configId).toBe(before.configId);
      expect(after.settings).toEqual(before.settings);
      expect(after.runMode).toBe(before.runMode);

      // Every authoritative state the save carries comes back byte for byte.
      expect(after.world).toEqual(before.world);
      expect(after.world.environment).toEqual(before.world.environment);
      expect(after.world.processes).toEqual(before.world.processes);
      expect(after.world.events).toEqual(before.world.events);
      expect(after.body).toEqual(before.body);
      expect(after.characters).toEqual(before.characters);
      expect(after.behaviours).toEqual(before.behaviours);
      expect(after.activity).toEqual(before.activity);
      expect(after.actions).toEqual(before.actions);
      expect(after.actions.map((action) => action.plan)).toEqual(before.actions.map((action) => action.plan));
      expect(after.barrier).toBeNull();
      expect(after.failure).toBeNull();
    });
  });

  it("continues the same number of ticks from the original run and from the loaded save to the same summary", async () => {
    // Two boundaries: one right after the entity decided, and one where the
    // entity does not reach a decision point again in the first continued tick,
    // so a save that dropped the restored behaviour record would diverge.
    for (const boundary of [4, 7]) {
      const original = await createSimulation({ timelineId: `timeline-continue-${boundary}` });
      runTicks(original.runner, 1, boundary);
      const saved = snapshotOf(original.runner.state(), `save-continue-${boundary}`, original.config);

      const loaded = await createSimulation({ timelineId: `timeline-loaded-${boundary}` });
      loaded.runner.load({ ...saved.state, timelineId: `timeline-loaded-${boundary}` });
      const loadedAgain = await createSimulation({ timelineId: `timeline-loaded-again-${boundary}` });
      loadedAgain.runner.load({ ...saved.state, timelineId: `timeline-loaded-again-${boundary}` });

      const remaining = 12 - boundary;
      runTicks(original.runner, boundary + 1, remaining);
      runTicks(loaded.runner, boundary + 1, remaining);
      runTicks(loadedAgain.runner, boundary + 1, remaining);

      const continued = digestOf(original.runner.state());
      expect(loaded.runner.state().tick, `boundary ${boundary}`).toBe(12);
      expect(digestOf(loaded.runner.state()), `boundary ${boundary}`).toBe(continued);
      expect(digestOf(loadedAgain.runner.state()), `boundary ${boundary}`).toBe(continued);
      // The continuation really moved on from the saved boundary.
      expect(continued, `boundary ${boundary}`).not.toBe(digestOf(saved.state));
    }
  });

  it("refuses a save made against another config or other system versions and keeps the running state", async () => {
    const simulation = await createSimulation({ timelineId: "timeline-save" });
    runTicks(simulation.runner, 1, 7);
    const saved = snapshotOf(simulation.runner.state(), "save-checked", simulation.config);
    const other = await publishDemoWith({ "rules/daylight-wakefulness.yaml": null });
    expect(other.config.configId).not.toBe(simulation.config.configId);

    expect(checkSnapshot(saved, other.config).ok).toBe(false);
    expect(checkSnapshot({ ...saved, configId: other.config.configId }, simulation.config).ok).toBe(false);
    expect(checkSnapshot({ ...saved, systems: saved.systems.slice(0, 1) }, simulation.config).ok).toBe(false);
    expect(
      checkSnapshot(
        { ...saved, systems: saved.systems.map((system) => ({ ...system, version: "9.9.9" })) },
        simulation.config,
      ).ok,
    ).toBe(false);
    expect(
      checkSnapshot(
        { ...saved, systems: saved.systems.map((system) => ({ ...system, specHash: "0".repeat(64) })) },
        simulation.config,
      ).ok,
    ).toBe(false);

    // The same save only loads while the timeline still runs the config it was made with.
    const kept = simulation.runner.state();
    const keptDigest = digestOf(kept);
    expect(() => simulation.runner.load({ ...saved.state, configId: other.config.configId })).toThrow();
    expect(digestOf(simulation.runner.state())).toBe(keptDigest);
    expect(simulation.runner.state().tick).toBe(kept.tick);

    // An unreadable or incomplete payload is refused rather than half loaded.
    const encoded = encodeSnapshot(saved);
    const incomplete = {
      saveId: saved.saveId,
      timelineId: saved.timelineId,
      tick: saved.tick,
      phase: saved.phase,
      configId: saved.configId,
      systems: saved.systems,
      settings: saved.settings,
      state: { timelineId: saved.state.timelineId, tick: saved.state.tick },
    };
    expect(decodeSnapshot(undefined).ok).toBe(false);
    expect(decodeSnapshot({ ...encoded, schemaVersion: "0" }).ok).toBe(false);
    expect(decodeSnapshot({ ...encoded, type: "runtime-config" }).ok).toBe(false);
    expect(
      decodeSnapshot({ schemaVersion: SIMULATION_SAVE_VERSION, type: SIMULATION_SAVE_TYPE, data: incomplete }).ok,
    ).toBe(false);
    withStore((store) => {
      // The save cannot be continued here: the store holds no config version for it.
      expect(store.checkRestore(saved.configId).ok).toBe(false);
      expect(store.loadSimulation(saved.saveId)).toBeUndefined();
      expect(decodeSnapshot(store.loadSimulation(saved.saveId)).ok).toBe(false);
    });
  });
});
