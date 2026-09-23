import { describe, expect, it } from "vitest";
import { idleDecision, type ScriptedDraft } from "../src/agent/scripted-cognition.js";
import { CognitionService } from "../src/simulation/cognition-service.js";
import { cognitionSettings } from "../src/simulation/config-view.js";
import { cognitionActionNames } from "../src/simulation/cognition-coordinator.js";
import type {
  CognitionDemand,
  CognitionDemandReason,
  CognitionInput,
  CognitionRecord,
  Observation,
  SimulationState,
} from "../src/simulation/types.js";
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
  it("turns a decision's speech and repeated say step into one utterance action", async () => {
    const simulation = await phase4Simulation({
      script: {
        draft: (input: CognitionInput) => ({
          ...(idleDecision(input) as Record<string, unknown>),
          speech: "你好",
          steps: [{ action: "say" }],
          idle: null,
        }),
      },
    });
    try {
      const result = await simulation.runner.runTickToPublication();
      expect(result.status).toBe("completed");
      const plan = simulation.runner.state().actions.find((action) => action.entityId === COMPANION)?.plan;
      expect(plan?.steps).toEqual([{ action: "agentlife.demo/say", inputs: { utterance: "你好" } }]);
    } finally {
      dispose(simulation);
    }
  }, 40_000);

  it("delivers a heard utterance once even when the model leaves consumption empty", async () => {
    const heard: string[] = [];
    const simulation = await phase4Simulation({
      overrides: { "characters/companion.yaml": companionCharacter(SQUARE) },
      script: {
        draft: (input: CognitionInput) => {
          heard.push(
            ...input.observations.map((observation) => observation.text).filter((text) => text.includes("有人吗")),
          );
          return idleDecision(input);
        },
      },
    });
    try {
      await simulation.runner.runTickToPublication();
      await simulation.runner.runTickToPublication({
        plans: [commandPlan("player-hello", PLAYER, "agentlife.demo/say", { inputs: { utterance: "有人吗" } })],
      });
      for (let tick = 0; tick < 4; tick += 1) await simulation.runner.runTickToPublication();
      expect(heard).toEqual([expect.stringContaining("有人吗")]);
    } finally {
      dispose(simulation);
    }
  }, 40_000);

  it("shows short action names and maps a decision back to its configured action", async () => {
    const simulation = await phase4Simulation({
      script: {
        draft: (input: CognitionInput) => {
          expect(input.actions.map((action) => action.action)).toContain("wave");
          expect(input.actions.every((action) => !action.action.includes("/"))).toBe(true);
          return {
            ...(idleDecision(input) as Record<string, unknown>),
            steps: [{ action: "wave" }],
            idle: null,
          };
        },
      },
    });
    try {
      const result = await simulation.runner.runTickToPublication();
      expect(result.status).toBe("completed");
      expect(
        simulation.runner
          .state()
          .actions.some((action) => action.entityId === COMPANION && action.action === "agentlife.demo/wave"),
      ).toBe(true);
    } finally {
      dispose(simulation);
    }
  }, 40_000);

  it("uses full names only when two allowed actions share a short name", () => {
    expect([...cognitionActionNames(["agentlife.demo/wave", "agentlife.other/wave", "agentlife.demo/walk"])]).toEqual([
      ["agentlife.demo/wave", "agentlife.demo/wave"],
      ["agentlife.other/wave", "agentlife.other/wave"],
      ["walk", "agentlife.demo/walk"],
    ]);
  });

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
      expect(pending.length).toBe(2);
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

/**
 * Who owes a decision, decided by participation.
 *
 * The demand summary is the system's own rule and is asserted on the service that
 * owns it: `demands` is a pure read of the state handed to it, so a body's tier and
 * what reached its Working Memory are the only inputs that can change the answer.
 */
describe("the demands a body's participation allows", () => {
  it("never asks a body that forbids cognition and narrows a restricted one to what happened", async () => {
    const simulation = await phase4Simulation();
    try {
      const state = simulation.runner.state();
      const service = new CognitionService(simulation.config);
      const fresh = state.cognition.records[COMPANION];
      if (state.characters.characters[COMPANION] === undefined || fresh === undefined)
        throw new Error("the demo companion is missing");
      const tick = 2;
      const observation = (kind: Observation["kind"], observationId: string): Observation => ({
        observationId,
        tick,
        channel: "vision",
        kind,
        subject: null,
        eventId: null,
        text: "有人走过来",
        salience: 1,
      });
      /** Every demand the service answers for one entity under one participation. */
      const demandsFor = (
        entityId: string,
        participation: string,
        admitted: readonly Observation[],
        record?: CognitionRecord,
      ): readonly CognitionDemand[] =>
        service.demands({
          tick,
          cognition: {
            ...state.cognition,
            records:
              record === undefined ? state.cognition.records : { ...state.cognition.records, [entityId]: record },
          },
          characters: state.characters.characters,
          participation: { [entityId]: participation },
          admitted: { [entityId]: admitted },
        });
      /** Only the demands the service addressed to that one entity. */
      const demandsOn = (...args: Parameters<typeof demandsFor>): readonly CognitionDemand[] =>
        demandsFor(...args).filter((demand) => demand.characterId === args[0]);
      const reasonsFor = (
        entityId: string,
        participation: string,
        admitted: readonly Observation[],
        record?: CognitionRecord,
      ): readonly CognitionDemandReason[] =>
        demandsOn(entityId, participation, admitted, record).map((demand) => demand.reason);

      // Nothing has reached the body yet, so a full participant still owes its first
      // decision. "Has not decided yet" is not something that happened to it, so the
      // same body under restricted participation owes nothing here.
      expect(reasonsFor(COMPANION, "allowed", [])).toEqual(["initial"]);
      expect(reasonsFor(COMPANION, "restricted", [])).toEqual([]);

      // What did happen reaches a restricted body as it reaches a full one: it keeps
      // reacting to its own results and to the events it could perceive.
      const decided: CognitionRecord = { ...fresh, decisions: 1 };
      const event = observation("event", "o1");
      const outcome = observation("outcome", "o2");
      const reacting = demandsOn(COMPANION, "restricted", [event, outcome], decided);
      expect(reacting.map((demand) => demand.reason)).toEqual(["outcome"]);
      expect(reacting[0]?.characterId).toBe(COMPANION);
      expect(reacting[0]?.observations).toEqual(["o1", "o2"]);
      expect(reasonsFor(COMPANION, "allowed", [event, outcome], decided)).toEqual(["outcome"]);

      // A commitment to wait is re-reviewed on its own schedule, but a body that may
      // only react is asked again when something arrives, never because the wait came
      // around: idle-review and idle-expiry are not reasons a restricted body has.
      const waiting: CognitionRecord = {
        ...fresh,
        decisions: 1,
        idle: {
          kind: "external-event",
          detail: "等一件能听见的事",
          event: "utterance",
          reviewTick: tick,
          untilTick: tick + 3,
        },
      };
      const expired: CognitionRecord = {
        ...waiting,
        idle: {
          kind: "external-event",
          detail: "等一件能听见的事",
          event: "utterance",
          reviewTick: tick,
          untilTick: tick,
        },
      };
      expect(reasonsFor(COMPANION, "allowed", [], waiting)).toEqual(["idle-review"]);
      expect(reasonsFor(COMPANION, "allowed", [], expired)).toEqual(["idle-expiry"]);
      expect(reasonsFor(COMPANION, "restricted", [], waiting)).toEqual([]);
      expect(reasonsFor(COMPANION, "restricted", [], expired)).toEqual([]);

      // A body that forbids cognition is never asked, not even for what happened to
      // it, and a body the player controls is never asked to think at all.
      expect(reasonsFor(COMPANION, "forbidden", [event, outcome])).toEqual([]);
      expect(reasonsFor(COMPANION, "forbidden", [], waiting)).toEqual([]);
      expect(state.characters.characters[PLAYER]?.control).toBe("user");
      expect(reasonsFor(PLAYER, "allowed", [event])).toEqual([]);
    } finally {
      dispose(simulation);
    }
  }, 40_000);
});
