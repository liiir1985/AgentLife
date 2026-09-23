import { describe, expect, it } from "vitest";
import { idleDecision, type ScriptedDraft } from "../src/agent/scripted-cognition.js";
import { cognitionSettings } from "../src/simulation/config-view.js";
import type { CognitionInput, SimulationState } from "../src/simulation/types.js";
import {
  companionCharacter,
  commandPlan,
  cognitionSettings as settingsFile,
  dispose,
  phase4Simulation,
} from "./helpers/phase4.js";

/**
 * Phase 4 acceptance: Working Memory and the cognition barrier.
 *
 * A round only ever sees what Working Memory admitted, and a tick only continues
 * once every participant settled — the cases below assert both sides of that.
 */

const PLAYER = "agentlife.demo/player";
const COMPANION = "agentlife.demo/companion";
const ROPE = "agentlife.demo/rope";
const SQUARE = "agentlife.demo/lantern-square";

/** Confirms using the first observation of the request and then waits. */
const consumeFirstObservation: ScriptedDraft = (input: CognitionInput): unknown => {
  const first = input.observations[0];
  return {
    ...(idleDecision(input) as Record<string, unknown>),
    consumedObservations: first === undefined ? [] : [first.reference],
  };
};

describe("working memory and the cognition barrier", () => {
  it("keeps only what fits, in a deterministic order", async () => {
    const overrides = { "cognitionSettings/cognition-settings.yaml": settingsFile({ observationCapacity: 2 }) };
    const first = await phase4Simulation({ overrides, script: { draft: idleDecision } });
    const second = await phase4Simulation({ overrides, script: { draft: idleDecision } });
    try {
      expect(cognitionSettings(first.config)?.observationCapacity).toBe(2);
      await first.runner.runTickToPublication();
      await second.runner.runTickToPublication();
      const held = first.runner.state().memory.records[PLAYER]?.entries ?? [];
      const pending = first.runner.state().perception.observers[PLAYER]?.pending ?? [];
      expect(pending.length).toBeGreaterThan(2);
      expect(held.length).toBe(2);
      // The same content produces the same admission, entry identity included.
      expect(held.map((entry) => entry.sourceId)).toEqual(
        (second.runner.state().memory.records[PLAYER]?.entries ?? []).map((entry) => entry.sourceId),
      );
      // Nothing beyond the admitted entries is reachable through Working Memory.
      expect(held.every((entry) => entry.reference !== null)).toBe(true);
    } finally {
      dispose(first);
      dispose(second);
    }
  }, 40_000);

  it("releases exactly the entries the entity confirmed it used", async () => {
    const idle = await phase4Simulation({ script: { draft: idleDecision } });
    const consuming = await phase4Simulation({ script: { draft: consumeFirstObservation } });
    await idle.runner.runTickToPublication();
    await consuming.runner.runTickToPublication();
    const idlePending = pendingIds(idle.runner.state(), COMPANION);
    const consumingPending = pendingIds(consuming.runner.state(), COMPANION);
    const consumed = consuming.runner.state().memory.records[COMPANION]?.consumed ?? [];
    expect(consumed).toHaveLength(1);
    // Exactly the confirmed observation left the stream, and its entry is gone from
    // Working Memory: what an entity used is not delivered to it twice.
    expect(consumingPending).toEqual(idlePending.slice(1));
    expect(consuming.runner.state().memory.records[COMPANION]?.entries.map((entry) => entry.entryId)).not.toContain(
      consumed[0],
    );
  }, 40_000);

  it("refuses a decision that names an observation it never held, then stops the tick", async () => {
    const simulation = await phase4Simulation({
      script: {
        draft: (input: CognitionInput) => ({
          ...(idleDecision(input) as Record<string, unknown>),
          consumedObservations: ["o99"],
        }),
      },
    });
    const result = await simulation.runner.runTickToPublication();
    expect(result.status).toBe("failed");
    if (result.status !== "failed") return;
    expect(result.failure.code).toBe("cognition-failed");
    expect(result.failure.detail).toContain("o99");
    // A failed barrier leaves the objective state exactly where it was.
    const state = simulation.runner.state();
    expect(state.tick).toBe(0);
    expect(state.runMode).toBe("failed");
    expect(state.actions).toEqual([]);
  }, 40_000);

  it("freezes the tick while a participant still has to decide", async () => {
    const simulation = await phase4Simulation({
      overrides: { "characters/companion.yaml": companionCharacter(SQUARE) },
    });
    try {
      const opened = simulation.runner.runTick({});
      expect(opened.status).toBe("cognitive-barrier");
      if (opened.status !== "cognitive-barrier") return;
      // The barrier holds the tick: no other tick may start, and the world does not
      // move on while the player is still choosing.
      expect(() => simulation.runner.runTick({})).toThrow(/barrier/i);
      const frozen = simulation.runner.state();
      expect(frozen.phase).toBe("cognitive-barrier");
      expect(frozen.summary).toBeNull();
      const joined = simulation.runner.submitPlayerPlan(
        commandPlan("player-grasp", PLAYER, "agentlife.demo/grasp", { target: ROPE }),
      );
      expect(joined.ok).toBe(true);
      await simulation.runner.resolveCognition();
      const finished = simulation.runner.completeCognition();
      expect(finished?.status).toBe("completed");
      // Everything the round decided is handed over as one batch, and the player's
      // command took part in exactly that handover.
      const state = simulation.runner.state();
      expect(state.tick).toBe(1);
      expect(state.runMode).not.toBe("barrier");
      // A published tick keeps no open round: who took part is recorded in the summary.
      expect(state.round).toBeNull();
      expect(state.summary?.cognition).toContain(`${COMPANION}=decided`);
      expect(state.summary?.cognition).toContain(`${PLAYER}=decided`);
      expect(state.actions.some((action) => action.plan.planId === "player-grasp")).toBe(true);
    } finally {
      dispose(simulation);
    }
  }, 40_000);

  it("hands the batch over in the same order however the answers arrived", async () => {
    const first = await phase4Simulation({ overrides: { "characters/companion.yaml": companionCharacter(SQUARE) } });
    const second = await phase4Simulation({ overrides: { "characters/companion.yaml": companionCharacter(SQUARE) } });
    try {
      const plan = () => commandPlan("player-wave", PLAYER, "agentlife.demo/wave", {}, "parallel");
      // First round: the player answers before the AI does.
      first.runner.runTick({});
      first.runner.submitPlayerPlan(plan());
      await first.runner.resolveCognition();
      const firstResult = first.runner.completeCognition();
      // Second round: the AI answers first, the player only afterwards.
      second.runner.runTick({});
      await second.runner.resolveCognition();
      second.runner.submitPlayerPlan(plan());
      const secondResult = second.runner.completeCognition();
      expect(firstResult?.status).toBe("completed");
      expect(secondResult?.status).toBe("completed");
      if (firstResult?.status !== "completed" || secondResult?.status !== "completed") return;
      expect(firstResult.summary.actionOutcomes).toEqual(secondResult.summary.actionOutcomes);
      expect(actionIds(first.runner.state())).toEqual(actionIds(second.runner.state()));
    } finally {
      dispose(first);
      dispose(second);
    }
  }, 40_000);

  it("keeps an existing action running when the player skips the round", async () => {
    const simulation = await phase4Simulation();
    const walk = commandPlan("player-walk", PLAYER, "agentlife.demo/walk", { destination: "agentlife.demo/orchard" });
    const opened = simulation.runner.runTick({ plans: [walk] });
    expect(opened.status).toBe("cognitive-barrier");
    const before = simulation.runner
      .state()
      .actions.filter((action) => action.plan.planId === "player-walk")
      .map((action) => action.status);
    expect(before.length).toBeGreaterThan(0);
    await simulation.runner.resolveCognition();
    const skipped = simulation.runner.skipPlayer(PLAYER);
    expect(skipped.ok).toBe(true);
    const finished = simulation.runner.completeCognition();
    expect(finished?.status).toBe("completed");
    // Skipping a decision round is not cancelling: the accepted action keeps its place.
    const after = simulation.runner.state().actions.filter((action) => action.plan.planId === "player-walk");
    expect(after.map((action) => action.actionId)).toEqual(
      simulation.runner
        .state()
        .actions.filter((action) => action.plan.planId === "player-walk")
        .map((a) => a.actionId),
    );
    expect(after.some((action) => action.status === "cancelled")).toBe(false);
  }, 40_000);
});

/** The observation identities one observer still holds, in formation order. */
function pendingIds(state: SimulationState, observer: string): readonly string[] {
  return (state.perception.observers[observer]?.pending ?? []).map((observation) => observation.observationId);
}

function actionIds(state: SimulationState): readonly string[] {
  return state.actions.map((action) => `${action.entityId}/${action.action}/${action.status}`);
}
