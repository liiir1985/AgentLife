import { describe, expect, it } from "vitest";
import { perceivedView } from "../src/interaction/context-actions.js";
import { perceptionSettings } from "../src/simulation/config-view.js";
import type { Observation, SimulationState } from "../src/simulation/types.js";
import { idleDecision, walkingFrom } from "../src/agent/scripted-cognition.js";
import type { CognitionInput } from "../src/simulation/types.js";
import { companionCharacter, commandPlan, dispose, lightFact, phase4Simulation, runUntil } from "./helpers/phase4.js";

/**
 * Phase 4 acceptance: the perception chain.
 *
 * Every case runs the real demo content through the real runner, so what is
 * asserted is what a character actually holds — never what the world contains.
 */

const PLAYER = "agentlife.demo/player";
const COMPANION = "agentlife.demo/companion";
const WARDEN = "agentlife.demo/gate-warden";
const ROPE = "agentlife.demo/rope";
const SQUARE = "agentlife.demo/lantern-square";
const ORCHARD = "agentlife.demo/orchard";
const KILN = "agentlife.demo/kiln";

function observationsOf(state: SimulationState, observer: string): readonly Observation[] {
  return state.perception.observers[observer]?.pending ?? [];
}

describe("perception", () => {
  it("describes an unrecognised person without any name and names a recognised one", async () => {
    const lit = await phase4Simulation();
    const dark = await phase4Simulation({
      overrides: { "environment/light-level.yaml": lightFact(20) },
    });
    try {
      await lit.runner.runTickToPublication();
      await dark.runner.runTickToPublication();
      const seenLit = perceivedView(lit.config, lit.runner.state(), PLAYER).entities.find(
        (entity) => entity.anchor === WARDEN,
      );
      const seenDark = perceivedView(dark.config, dark.runner.state(), PLAYER).entities.find(
        (entity) => entity.anchor === WARDEN,
      );
      // The default demo light reaches the finest declared level, so the warden's
      // projected identity is what the observer names him by.
      expect(seenLit?.recognisable).toBe(true);
      expect(seenLit?.name).toBe("门口的护卫");
      // Below the declared dark threshold one level of detail is lost, and the
      // projection for that level carries no identity at all.
      expect(seenDark?.recognisable).toBe(false);
      expect(seenDark?.name).toBe("一个一动不动的人影");
    } finally {
      dispose(lit);
      dispose(dark);
    }
  });

  it("never lets an observer see a character's declared name, background or classification", async () => {
    const simulation = await phase4Simulation({
      overrides: {
        "characters/companion.yaml": companionCharacter(SQUARE, "秘密姓名", "一段秘密身世"),
        // Put the companion where the player stands, so she is in view at all.
        "characters/player.yaml": `id: player
type: agentlife.character/character
public: true
templates:
  - agentlife.demo/normal-entity
fields:
  name: 旅人
  identity: 旅人的私密身世
  main: true
  control:
    kind: user
  homeLocation: agentlife.demo/lantern-square
`,
      },
    });
    try {
      await simulation.runner.runTickToPublication();
      const view = perceivedView(simulation.config, simulation.runner.state(), PLAYER);
      const seen = view.entities.find((entity) => entity.anchor === COMPANION);
      // The appearance content declares the only name an observer may ever see.
      expect(seen?.name).toBe("阿禾");
      const rendered = JSON.stringify(view) + JSON.stringify(observationsOf(simulation.runner.state(), PLAYER));
      expect(rendered).not.toContain("秘密姓名");
      expect(rendered).not.toContain("一段秘密身世");
      expect(rendered).not.toContain("旅人的私密身世");
      for (const management of ["tier", "control", "main", "identityVersion", "behaviourTree"])
        expect(Object.keys(view)).not.toContain(management);
    } finally {
      dispose(simulation);
    }
  });

  it("keeps an entity that stands elsewhere out of the view", async () => {
    const simulation = await phase4Simulation();
    await simulation.runner.runTickToPublication();
    const view = perceivedView(simulation.config, simulation.runner.state(), PLAYER);
    expect(view.place?.anchor).toBe(SQUARE);
    expect(view.entities.map((entity) => entity.anchor)).not.toContain(COMPANION);
    expect(view.exits.map((exit) => exit.anchor).sort()).toEqual([ORCHARD, "agentlife.demo/kiln"].sort());
  });

  it("reports a stable scene once and reports what changes about it", async () => {
    const simulation = await phase4Simulation();
    const settings = perceptionSettings(simulation.config);
    expect(settings).toBeDefined();
    await simulation.runner.runTickToPublication();
    const first = observationsOf(simulation.runner.state(), PLAYER);
    expect(first.length).toBeGreaterThan(0);
    // A second and third tick of an unchanged scene add nothing: the same subjects
    // are neither re-announced nor re-described while nothing about them changed.
    await simulation.runner.runTickToPublication();
    await simulation.runner.runTickToPublication();
    const repeated = observationsOf(simulation.runner.state(), PLAYER).filter(
      (observation) => observation.tick >= 2 && observation.kind !== "outcome",
    );
    expect(repeated).toEqual([]);

    // Taking the rope changes what the observer holds, and that is reported.
    await simulation.runner.runTickToPublication({
      plans: [commandPlan("take-rope", PLAYER, "agentlife.demo/grasp", { target: ROPE })],
    });
    await runUntil(simulation.runner, (state) => state.world.entities[ROPE]?.heldBy === PLAYER, 8);
    const change = observationsOf(simulation.runner.state(), PLAYER).find(
      (observation) => observation.kind === "change" && observation.subject?.anchor === ROPE,
    );
    expect(change?.text).toContain("你手上");
    const view = perceivedView(simulation.config, simulation.runner.state(), PLAYER);
    expect(view.heldItems.map((item) => item.anchor)).toContain(ROPE);
  });

  it("reports an object that leaves the place as a disappearance", async () => {
    const simulation = await phase4Simulation({
      overrides: { "characters/companion.yaml": companionCharacter(SQUARE) },
      // She stays for the first tick, so the player observes her before she leaves.
      script: { draft: walkingFrom(2) },
    });
    try {
      await simulation.runner.runTickToPublication();
      const before = perceivedView(simulation.config, simulation.runner.state(), PLAYER);
      expect(before.entities.map((entity) => entity.anchor)).toContain(COMPANION);
      // She walks to whichever exit she saw first, so the test asserts the leaving.
      await runUntil(simulation.runner, (state) => state.world.entities[COMPANION]?.locatedAt !== SQUARE, 14);
      const gone = observationsOf(simulation.runner.state(), PLAYER).find(
        (observation) => observation.kind === "disappearance" && observation.subject?.anchor === COMPANION,
      );
      expect(gone?.text).toContain("不见了");
      expect(
        perceivedView(simulation.config, simulation.runner.state(), PLAYER).entities.map((entity) => entity.anchor),
      ).not.toContain(COMPANION);
    } finally {
      dispose(simulation);
    }
  }, 40_000);

  it("drops an exit the observer has walked away from", async () => {
    const simulation = await phase4Simulation();
    try {
      await simulation.runner.runTickToPublication();
      const square = perceivedView(simulation.config, simulation.runner.state(), PLAYER);
      expect(square.place?.anchor).toBe(SQUARE);
      expect(square.exits.map((exit) => exit.anchor)).toEqual([KILN, ORCHARD]);
      // The kiln's own content declares the square as its only exit, so the orchard
      // stops being something the player could walk to the moment the player leaves.
      await simulation.runner.runTickToPublication({
        plans: [commandPlan("walk-kiln", PLAYER, "agentlife.demo/walk", { destination: KILN })],
      });
      await runUntil(simulation.runner, (state) => state.world.entities[PLAYER]?.locatedAt === KILN, 8);
      const kiln = perceivedView(simulation.config, simulation.runner.state(), PLAYER);
      expect(kiln.place?.anchor).toBe(KILN);
      expect(kiln.exits.map((exit) => exit.anchor)).toEqual([SQUARE]);
    } finally {
      dispose(simulation);
    }
  }, 40_000);

  it("makes an utterance audible only once it is finished, and only at that place", async () => {
    const heardByCompanion: string[] = [];
    const simulation = await phase4Simulation({
      overrides: { "characters/companion.yaml": companionCharacter(SQUARE) },
      script: {
        draft: (input: CognitionInput) => {
          heardByCompanion.push(...input.observations.map((observation) => observation.text));
          return idleDecision(input);
        },
      },
    });
    try {
      await simulation.runner.runTickToPublication();
      // Queued, not spoken: an unexecuted plan is never a world utterance.
      await simulation.runner.runTickToPublication({
        plans: [commandPlan("say-hello", PLAYER, "agentlife.demo/say", { inputs: { utterance: "有人吗？" } })],
      });
      expect(simulation.runner.state().world.events.filter((event) => event.kind === "utterance")).toEqual([]);
      const heard = await runUntil(
        simulation.runner,
        (state) => state.world.events.some((event) => event.kind === "utterance"),
        8,
      );
      expect(heard.status).toBe("completed");
      expect(heardByCompanion.some((text) => text.includes("说：有人吗？"))).toBe(true);
      // The speaker sees its own words as its own, never as another person.
      const own = observationsOf(simulation.runner.state(), PLAYER).find((observation) => observation.kind === "event");
      expect(own?.text).toBe("你说：有人吗？");
    } finally {
      dispose(simulation);
    }
  });

  it("leaves an utterance unheard by a character standing elsewhere", async () => {
    const simulation = await phase4Simulation();
    await simulation.runner.runTickToPublication();
    await simulation.runner.runTickToPublication({
      plans: [commandPlan("say-alone", PLAYER, "agentlife.demo/say", { inputs: { utterance: "有人吗？" } })],
    });
    await runUntil(simulation.runner, (state) => state.world.events.some((event) => event.kind === "utterance"), 8);
    expect(observationsOf(simulation.runner.state(), COMPANION).filter((o) => o.kind === "event")).toEqual([]);
  });
});
