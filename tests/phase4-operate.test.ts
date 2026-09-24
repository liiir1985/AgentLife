import { describe, expect, it } from "vitest";
import { perceivedView } from "../src/interaction/context-actions.js";
import type { ActionInstance, Observation, SimulationState } from "../src/simulation/types.js";
import {
  companionCharacter,
  commandPlan,
  dispose,
  phase4Simulation,
  runUntil,
  type Phase4Simulation,
} from "./helpers/phase4.js";

/**
 * Operating the same thing twice.
 *
 * The engine has no notion of "the same state operated again": an effect is what a
 * rule declares for the state the operation finds, so a lamp that is already lit is
 * answered by another rule, in the pack's own words. These cases run the real demo
 * content end to end, so what is asserted is what a player would see.
 */

const PLAYER = "agentlife.demo/player";
const COMPANION = "agentlife.demo/companion";
const LAMP = "agentlife.demo/lamp";
const SQUARE = "agentlife.demo/lantern-square";
const USE = "agentlife.demo/use";

/**
 * The same rule with its second branch mapped onto the opposite effect.
 *
 * Nothing in the engine changed to allow this: the demo simply does not configure
 * its lamp as closeable, and an author who wanted one writes that branch this way.
 * Its guards are the demo's, including the influence kind: without that one the rule
 * would answer every accepted influence while the lamp is off, including a walk.
 */
const TURNS_OFF = `kind: rule
id: operate-influence
system: agentlife.world
triggers:
  - agentlife.world/influence-accepted
inputs:
  - name: kind
    state: agentlife.world/influence.kind
  - name: accepted
    state: agentlife.world/influence.accepted
  - name: lamp
    state: agentlife.world/environment.lamp-state
branches:
  - when:
      op: all
      operands:
        - op: compare
          left:
            kind: read
            name: kind
          right:
            kind: literal
            value: agentlife.demo/operate-item
          operator: eq
        - op: compare
          left:
            kind: read
            name: accepted
          right:
            kind: literal
            value: true
          operator: eq
        - op: compare
          left:
            kind: read
            name: lamp
          right:
            kind: literal
            value: 0
            unit: state
          operator: eq
    changes:
      - state: agentlife.world/environment.lamp-state
        combine: priority
        priority: 1
        value:
          kind: literal
          value: 1
          unit: state
    notice: 灯亮了起来
  - when:
      op: all
      operands:
        - op: compare
          left:
            kind: read
            name: kind
          right:
            kind: literal
            value: agentlife.demo/operate-item
          operator: eq
        - op: compare
          left:
            kind: read
            name: accepted
          right:
            kind: literal
            value: true
          operator: eq
        - op: compare
          left:
            kind: read
            name: lamp
          right:
            kind: literal
            value: 1
            unit: state
          operator: eq
    changes:
      - state: agentlife.world/environment.lamp-state
        combine: priority
        priority: 1
        value:
          kind: literal
          value: 0
          unit: state
    notice: 灯灭了
`;

function observationsOf(state: SimulationState, observer: string): readonly Observation[] {
  return state.perception.observers[observer]?.pending ?? [];
}

function actionOf(state: SimulationState, planId: string): ActionInstance | undefined {
  return state.actions.find((entry) => entry.plan.planId === planId);
}

function settled(state: SimulationState, planId: string): boolean {
  const status = actionOf(state, planId)?.status;
  return status === "completed" || status === "failed" || status === "interrupted";
}

/** Queues one operation of the lamp and runs until the action is settled. */
async function operate(simulation: Phase4Simulation, planId: string): Promise<SimulationState> {
  await simulation.runner.runTickToPublication({
    plans: [commandPlan(planId, PLAYER, USE, { target: LAMP })],
  });
  await runUntil(simulation.runner, (state) => settled(state, planId), 8);
  return simulation.runner.state();
}

/** The player's view of one entity in the current state. */
function seen(simulation: Phase4Simulation, anchor: string) {
  return perceivedView(simulation.config, simulation.runner.state(), PLAYER).entities.find(
    (entity) => entity.anchor === anchor,
  );
}

describe("operating the lamp", () => {
  it("starts dark, with the seeded facts replaced by what the rules derive", async () => {
    const simulation = await phase4Simulation();
    try {
      await simulation.runner.runTickToPublication();
      const state = simulation.runner.state();
      // `initial` is a seed, not a truth: initialization runs the one propagation
      // that lets the rules own these facts, so the values are the derived ones.
      // 40 lux and 0.2 fog: 0.3 * 40/50 = 0.24 coarseness, 0.35 * 40/50 = 0.28 vision,
      // and the carried load costs 2 points a move instead of the seeded 0.
      expect(state.world.environment["visibility"]).toBe(0.24);
      expect(state.body.bodies[PLAYER]?.channels["vision.efficiency"]).toBe(0.28);
      expect(state.body.bodies[PLAYER]?.values["move-cost"]).toBe(2);
      expect(state.body.bodies[PLAYER]?.values["move-cost-factor"]).toBe(1.5);
      // Dark and dim: the sight channel drops twice, from detail to the coarsest level.
      expect(seen(simulation, LAMP)?.name).toBe("一个矮墩墩的东西");
      expect(seen(simulation, LAMP)?.recognisable).toBe(false);
    } finally {
      dispose(simulation);
    }
  });

  it("lights the lamp: the level rises to detail and the log names what it looked like before", async () => {
    const simulation = await phase4Simulation({
      // Put the companion where the player stands, so both the lamp and a person are
      // in view and the level change can be read on both.
      overrides: { "characters/companion.yaml": companionCharacter(SQUARE) },
    });
    try {
      await simulation.runner.runTickToPublication();
      expect(seen(simulation, COMPANION)?.name).toBe("一个人影");
      expect(seen(simulation, COMPANION)?.detail).toBe("一个人影");
      expect(seen(simulation, COMPANION)?.recognisable).toBe(false);

      await operate(simulation, "operate-lamp");
      expect(simulation.runner.state().world.environment["lamp-state"]).toBe(1);
      // The glow is a world process: the lamp's state changes when the world accepts
      // the influence, and the light it gives off reaches the environment next tick.
      await runUntil(simulation.runner, (state) => state.world.environment["light-level"] === 240, 8);

      const changes = observationsOf(simulation.runner.state(), PLAYER).filter(
        (observation) => observation.kind === "change",
      );
      // A change is legible only against what it changed from: the left side is the
      // appearance the observer already held, the right side is the new one.
      const lamp = changes.find((observation) => observation.subject?.anchor === LAMP);
      expect(lamp?.text).toContain("（一个矮墩墩的东西）变了：一盏黄铜油灯");
      const companion = changes.find((observation) => observation.subject?.anchor === COMPANION);
      expect(companion?.text).toContain("（一个人影）变了：一个挽着袖子、手上带着修剪痕迹的人");
      // The environment reads as a value with a name, not as the number the world
      // stores: this is the line that tells the player the lamp did something.
      const environment = changes.find(
        (observation) => observation.subject?.anchor === SQUARE && observation.text.includes("环境变了"),
      );
      expect(environment?.text).toContain("环境光照：240");
      expect(environment?.text).toContain("可辨识度：0.596");
      // The level rose for the place and its exits too, but their descriptions are the
      // same words at every level: reporting those as changes would say something
      // happened and then show the observer nothing that happened. Only the
      // environment line about the place survives, because its value did change.
      expect(changes.filter((observation) => observation.subject?.role === "exit")).toEqual([]);
      expect(
        changes.filter(
          (observation) => observation.subject?.anchor === SQUARE && !observation.text.includes("环境变了"),
        ),
      ).toEqual([]);

      // Detail is the level the appearance declares as recognisable, so the name it
      // projects is available now and was not a moment ago.
      expect(seen(simulation, LAMP)?.name).toBe("一盏黄铜油灯");
      expect(seen(simulation, COMPANION)?.name).toBe("一个挽着袖子、手上带着修剪痕迹的人");
      expect(seen(simulation, COMPANION)?.recognisable).toBe(true);
    } finally {
      dispose(simulation);
    }
  });

  it("operates the same lamp again: the world answers with words instead of refusing", async () => {
    const simulation = await phase4Simulation();
    try {
      await simulation.runner.runTickToPublication();
      await operate(simulation, "operate-lamp");
      await runUntil(simulation.runner, (state) => state.world.environment["lamp-state"] === 1, 8);

      const state = await operate(simulation, "operate-again");
      const action = actionOf(state, "operate-again");
      expect(action?.status).toBe("completed");
      expect(action?.outcome?.status).toBe("completed");
      // The pack declared an effect that changes nothing, so nothing changed and the
      // action still completed: the state was mapped, not compared.
      expect(action?.outcome?.changes).toEqual([]);
      expect(action?.outcome?.notice).toBe("灯没有任何变化");
      const adjudications = state.summary?.influenceOutcomes ?? [];
      expect(adjudications).toHaveLength(1);
      expect(adjudications[0]).toMatchObject({
        status: "applied",
        changes: 0,
        notice: "灯没有任何变化",
      });
      // The second operation's own report: the first one is still pending, unconsumed.
      const outcome = observationsOf(state, PLAYER).find(
        (observation) => observation.kind === "outcome" && observation.tick === state.tick,
      );
      expect(outcome?.text).toBe("你完成了「操作」：灯没有任何变化");
      // The lamp is still lit and the light it gives off was never taken back.
      expect(state.world.environment["lamp-state"]).toBe(1);
    } finally {
      dispose(simulation);
    }
  });

  it("can be configured to map a lit lamp onto putting it out", async () => {
    const simulation = await phase4Simulation({
      overrides: { "rules/operate-influence.yaml": TURNS_OFF },
    });
    try {
      await simulation.runner.runTickToPublication();
      await operate(simulation, "operate-lamp");
      await runUntil(simulation.runner, (state) => state.world.environment["lamp-state"] === 1, 8);

      const state = await operate(simulation, "put-out-lamp");
      expect(actionOf(state, "put-out-lamp")?.status).toBe("completed");
      expect(actionOf(state, "put-out-lamp")?.outcome?.notice).toBe("灯灭了");
      expect(state.world.environment["lamp-state"]).toBe(0);
      // Only the lamp's own state is asserted: the glow the first operation lit is a
      // world process that only ever adds light, so darkening takes other content.
      expect(observationsOf(state, PLAYER).some((observation) => observation.text === "你完成了「操作」：灯灭了")).toBe(
        true,
      );
    } finally {
      dispose(simulation);
    }
  });

  it("keeps a loaded state as it was instead of deriving it again", async () => {
    const simulation = await phase4Simulation();
    try {
      await simulation.runner.runTickToPublication();
      const state = simulation.runner.state();
      // A save is a settled state, not a seed: restoring it may not re-run the
      // initialization that produced it, so a value the save disagrees with is kept.
      simulation.runner.load({
        ...state,
        world: Object.freeze({
          ...state.world,
          environment: Object.freeze({ ...state.world.environment, visibility: 0.5 }),
        }),
      });
      await simulation.runner.runTickToPublication();
      expect(simulation.runner.state().world.environment["visibility"]).toBe(0.5);
    } finally {
      dispose(simulation);
    }
  });
});
