import { describe, expect, it } from "vitest";
import { SimulationController, type TimerPort } from "../src/interaction/simulation-controller.js";
import { RuntimeStore } from "../src/storage/runtime-store.js";
import { DEMO_PLAYER, DEMO_ROPE, DEMO_SQUARE } from "./helpers/phase2.js";
import { companionCharacter, dispose, phase4Simulation, runUntil } from "./helpers/phase4.js";

/**
 * Phase 4 acceptance: the authorized player interface.
 *
 * The action bar only ever offers what the player's own perception holds, and the
 * ordinary surface stays free of everything the management view keeps.
 */

const WARDEN = "agentlife.demo/gate-warden";
const BENCH = "agentlife.demo/bench";
const ORCHARD = "agentlife.demo/orchard";

class ManualTimer implements TimerPort {
  schedule(): unknown {
    return undefined;
  }
  cancel(): void {}
}

/**
 * Waits until the controller published the tick its barrier opened.
 *
 * `step` hands the round to the model and the controller keeps resolving it in the
 * background, so the wait has to let real time pass: an answer takes as long as the
 * model takes, and a loop that only drains microtasks can never observe a model that
 * streams over an interval. The budget below is far above any scripted answer.
 */
async function settled(app: SimulationController, tick: number): Promise<void> {
  for (let hop = 0; hop < 200; hop += 1) {
    const state = app.runner.state();
    if (state.tick === tick && state.phase === "publish") return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`tick ${tick} was never published`);
}

async function application(simulation: Awaited<ReturnType<typeof phase4Simulation>>): Promise<SimulationController> {
  return new SimulationController(simulation.runner, simulation.config, new RuntimeStore(":memory:"), {
    playerId: DEMO_PLAYER,
    timer: new ManualTimer(),
  });
}

describe("the authorized player interface", () => {
  it("offers only the objects the player's own perception holds", async () => {
    const simulation = await phase4Simulation();
    const app = await application(simulation);
    try {
      await simulation.runner.runTickToPublication();
      const view = app.view();
      const move = app.availableActions().find((entry) => entry.command.ref === "agentlife.demo/command-move");
      const take = app.availableActions().find((entry) => entry.command.ref === "agentlife.demo/command-take");
      // The exits the player perceives are the only destinations offered.
      expect(move?.firstChoices.map((choice) => choice.anchor).sort()).toEqual(
        view.exits.map((exit) => exit.anchor).sort(),
      );
      expect(move?.firstChoices.map((choice) => choice.anchor).sort()).toEqual([ORCHARD, "agentlife.demo/kiln"].sort());
      // Only an item the player can see and that content declares portable is offered,
      // and a character is never a candidate for taking.
      expect(take?.firstChoices.map((choice) => choice.anchor)).toEqual([DEMO_ROPE]);
      expect(take?.firstChoices.map((choice) => choice.anchor)).not.toContain(WARDEN);
      expect(take?.firstChoices.map((choice) => choice.anchor)).not.toContain(BENCH);
      // Everything offered carries an observer-local reference and the observed text.
      for (const choice of move?.firstChoices ?? []) {
        expect(choice.reference).toMatch(/^o\d+$/);
        expect(choice.name.length).toBeGreaterThan(0);
      }
    } finally {
      app.close();
    }
  }, 40_000);

  it("does not offer an item already held by the player for taking again", async () => {
    const simulation = await phase4Simulation();
    const app = await application(simulation);
    try {
      await simulation.runner.runTickToPublication();
      const take = app.beginAction("agentlife.demo/command-take");
      expect(take?.choices().map((choice) => choice.anchor)).toContain(DEMO_ROPE);
      if (take === undefined) return;
      expect(take.acceptEntity(take.choices()[0]?.reference ?? "").done).toBe(true);
      expect(app.queueAction(take).ok).toBe(true);
      app.step();
      await settled(app, 2);
      await runUntil(simulation.runner, (state) => state.world.entities[DEMO_ROPE]?.heldBy === DEMO_PLAYER, 8);
      expect(app.view().heldItems.map((item) => item.anchor)).toContain(DEMO_ROPE);
      expect(
        app.availableActions().find((entry) => entry.command.ref === "agentlife.demo/command-take"),
      ).toBeUndefined();
    } finally {
      app.close();
    }
  }, 40_000);

  it("turns a chosen reference back into the object the services act on", async () => {
    const simulation = await phase4Simulation();
    const app = await application(simulation);
    try {
      await simulation.runner.runTickToPublication();
      const session = app.beginAction("agentlife.demo/command-move");
      expect(session).toBeDefined();
      if (session === undefined) return;
      const orchard = session.choices().find((choice) => choice.anchor === ORCHARD);
      expect(orchard).toBeDefined();
      expect(session.acceptEntity(orchard?.reference ?? "").done).toBe(true);
      const queued = app.queueAction(session);
      expect(queued.ok).toBe(true);
      // A command chosen at a stable boundary is fixed at the start of the next tick,
      // exactly as it was in phase 3.
      app.step();
      await settled(app, 2);
      const walk = simulation.runner.state().actions.find((action) => action.plan.planId.startsWith(DEMO_PLAYER));
      expect(walk?.destination).toBe(ORCHARD);
      expect(walk?.plan.source).toBe("player-command");
      // The player's own view reports the action it started, in content terms.
      expect(app.view().playerActions.map((action) => action.action)).toContain("行走");
    } finally {
      app.close();
    }
  }, 40_000);

  it("keeps the ordinary surface and the management view apart", async () => {
    const simulation = await phase4Simulation({
      overrides: { "characters/companion.yaml": companionCharacter(DEMO_SQUARE) },
    });
    const app = await application(simulation);
    try {
      await simulation.runner.runTickToPublication();
      const view = app.view();
      const log = app.perceptionLog();
      for (const key of ["tier", "control", "main", "identityVersion", "behaviourTree", "localView"])
        expect(Object.keys(view)).not.toContain(key);
      // The ordinary log is exactly the observations the player formed, nothing else.
      const pending = simulation.runner.state().perception.observers[DEMO_PLAYER]?.pending ?? [];
      expect(log.map((entry) => entry.observationId)).toEqual(pending.map((observation) => observation.observationId));
      expect(log.map((entry) => entry.text)).toEqual(pending.map((observation) => observation.text));
      expect(view.cognition).toBeNull();
      expect(view.barrier).toBeNull();

      const management = app.managementSnapshot();
      expect(management.perception.map((row) => row.characterId)).toEqual(
        [DEMO_PLAYER, "agentlife.demo/companion"].sort(),
      );
      expect(management.perception.every((row) => row.subjects > 0)).toBe(true);
      expect(management.cognition.length).toBe(2);
      expect(management.workingMemory.every((row) => row.entries > 0)).toBe(true);
      expect(management.workingMemory.every((row) => row.capacity > 0)).toBe(true);
      // The management rows carry counts and identities, never the private text.
      for (const row of management.workingMemory) expect(Object.keys(row)).not.toContain("text");
    } finally {
      app.close();
      dispose(simulation);
    }
  }, 40_000);
});
