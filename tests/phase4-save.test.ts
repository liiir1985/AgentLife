import { describe, expect, it } from "vitest";
import { SimulationController, type TimerPort } from "../src/interaction/simulation-controller.js";
import { answeringDecision } from "../src/agent/scripted-cognition.js";
import { checkSnapshot, decodeSnapshot, encodeSnapshot, snapshotOf } from "../src/simulation/save.js";
import type { RuntimeConfig } from "../src/config/config-builder.js";
import type { SimulationState } from "../src/simulation/types.js";
import { RuntimeStore } from "../src/storage/runtime-store.js";
import { companionCharacter, commandPlan, dispose, gatedModel, phase4Simulation } from "./helpers/phase4.js";

/**
 * Phase 4 acceptance: saving behind a barrier, and continuing from a save.
 *
 * A save is only ever taken at a published boundary, and everything the barrier
 * fixed — observations, admitted material, decisions — has to be exactly there
 * again when the save is loaded and continued.
 */

const PLAYER = "agentlife.demo/player";
const SQUARE = "agentlife.demo/lantern-square";

class ManualTimer implements TimerPort {
  callbacks: (() => void)[] = [];
  schedule(callback: () => void): unknown {
    this.callbacks.push(callback);
    return callback;
  }
  cancel(handle: unknown): void {
    this.callbacks = this.callbacks.filter((callback) => callback !== handle);
  }
}

/** Lets the controller's own barrier resolution progress until it settles. */
async function settled(app: SimulationController): Promise<void> {
  for (let hop = 0; hop < 4000; hop += 1) {
    if (app.runner.openRound() === null && app.runner.state().phase === "publish") return;
    await Promise.resolve();
  }
  throw new Error("the controller never published the held tick");
}

/**
 * Registers the run config, which an explicit save references.
 *
 * The controller does this when it is constructed; a test that writes through the
 * store directly has to do it too, because a save without its config row is exactly
 * the foreign-key refusal the schema is there to produce.
 */
function registerConfig(store: RuntimeStore, config: RuntimeConfig, namespace = "agentlife.demo"): void {
  const pack = config.packs[0];
  store.saveConfig({
    configId: config.configId,
    namespace: pack?.namespace ?? namespace,
    packVersion: pack?.version ?? "0.0.0",
    document: config.sourceData,
  });
}

/** Everything a save has to carry, in a comparable form. */
function comparable(state: SimulationState): unknown {
  return {
    tick: state.tick,
    world: state.world,
    body: state.body,
    perception: Object.fromEntries(
      Object.entries(state.perception.observers).map(([observer, value]) => [
        observer,
        { subjects: value.subjects, pending: value.pending, references: value.references },
      ]),
    ),
    memory: state.memory,
    cognition: state.cognition,
    actions: state.actions,
  };
}

describe("saving across a cognition barrier", () => {
  it("defers a save made while the barrier stands until the tick is published", async () => {
    const gated = gatedModel();
    const simulation = await phase4Simulation({ models: gated.port });
    const store = new RuntimeStore(":memory:");
    const app = new SimulationController(simulation.runner, simulation.config, store, {
      playerId: PLAYER,
      timer: new ManualTimer(),
    });
    try {
      app.step();
      expect(gated.waiting()).toBe(true);
      expect(app.runner.openRound()?.status).toBe("open");

      const deferred = app.save("during-barrier");
      expect(deferred.ok).toBe(true);
      expect(app.status().pendingSave).toBe("during-barrier");
      // Nothing is written while the tick is still held.
      expect(store.listSaves()).toEqual([]);
      // A second request is refused and the first one stays.
      expect(app.save("second").ok).toBe(false);
      expect(app.status().pendingSave).toBe("during-barrier");

      gated.release();
      await settled(app);
      const saves = store.listSaves();
      expect(saves.map((save) => save.saveId)).toEqual(["during-barrier"]);
      // The deferral happened after the tick was published, not instead of it.
      expect(saves[0]?.tick).toBe(simulation.runner.state().tick);
      expect(app.status().pendingSave).toBeNull();
    } finally {
      app.close();
      dispose(simulation);
    }
  }, 40_000);

  it("continues a loaded save with the same perception, cognition and actions", async () => {
    const overrides = { "characters/companion.yaml": companionCharacter(SQUARE) };
    const original = await phase4Simulation({ overrides, script: { draft: answeringDecision } });
    const restored = await phase4Simulation({ overrides, script: { draft: answeringDecision } });
    const store = new RuntimeStore(":memory:");
    try {
      // A spoken word makes the companion hear, decide and answer, so the save holds
      // a real round, real observations and a real plan.
      await original.runner.runTickToPublication({
        plans: [commandPlan("say", PLAYER, "agentlife.demo/say", { inputs: { utterance: "有人吗？" } })],
      });
      await original.runner.runTickToPublication();
      registerConfig(store, original.config);
      const saved = snapshotOf(original.runner.state(), "phase4-boundary", original.config);
      expect(
        store.saveSimulation({
          saveId: saved.saveId,
          timelineId: saved.timelineId,
          tick: saved.tick,
          configId: saved.configId,
          payload: encodeSnapshot(saved),
        }),
      ).toBe("committed");

      for (let tick = 0; tick < 3; tick += 1) await original.runner.runTickToPublication();
      const continued = comparable(original.runner.state());

      const document = store.loadSimulation("phase4-boundary");
      const decoded = decodeSnapshot(document);
      expect(decoded.ok).toBe(true);
      if (!decoded.ok) return;
      const check = checkSnapshot(decoded.snapshot, restored.config);
      expect(check.ok).toBe(true);
      restored.runner.load(decoded.snapshot.state);
      // The restored timeline starts exactly where the save was taken.
      expect(comparable(restored.runner.state())).toEqual(comparable(saved.state));
      for (let tick = 0; tick < 3; tick += 1) await restored.runner.runTickToPublication();
      expect(comparable(restored.runner.state())).toEqual(continued);
    } finally {
      store.close();
      dispose(original);
      dispose(restored);
    }
  }, 60_000);

  it("keeps a version 2 payload out instead of guessing its shape", async () => {
    const simulation = await phase4Simulation();
    const store = new RuntimeStore(":memory:");
    const app = new SimulationController(simulation.runner, simulation.config, store, {
      playerId: PLAYER,
      timer: new ManualTimer(),
    });
    try {
      await simulation.runner.runTickToPublication();
      const snapshot = snapshotOf(simulation.runner.state(), "legacy", simulation.config);
      registerConfig(store, simulation.config);
      store.saveSimulation({
        saveId: "legacy",
        timelineId: snapshot.timelineId,
        tick: snapshot.tick,
        configId: snapshot.configId,
        payload: { ...encodeSnapshot(snapshot), schemaVersion: "2" },
      });
      const loaded = app.load("legacy");
      expect(loaded.ok).toBe(false);
      expect(loaded.message).toContain("2:simulation-save");
      // The refused save changed nothing about the running timeline.
      expect(simulation.runner.state().tick).toBe(1);
    } finally {
      app.close();
    }
  }, 40_000);
});
