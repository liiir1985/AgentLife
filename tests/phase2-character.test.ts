import { describe, expect, it } from "vitest";
import { applyDemoPack, causeCodes, createRegistry } from "./helpers/demo-pack.js";
import { localViewMembers } from "../src/simulation/config-view.js";
import {
  DEMO_COMPANION,
  DEMO_KILN,
  DEMO_LAMP,
  DEMO_PLAYER,
  DEMO_ROPE,
  DEMO_WARDEN,
  createSimulation,
  createSimulationWith,
  lastAction,
  positionOf,
  removeDirectory,
  runPublishedTick,
  testPlan,
  worldOf,
} from "./helpers/phase2.js";

/** Actions the demo body declares. */
const USE = "agentlife.demo/use";
const SAY = "agentlife.demo/say";
/** One character id and one content addition used by the tier association case. */
const DYNAMIC_CHARACTER = "agentlife.demo/drifting-leaf";
const DYNAMIC_CHARACTER_SOURCE = `id: drifting-leaf
type: agentlife.character/character
public: true
fields:
  name: 飘落的叶子
  identity: 一片被风推着走的叶子，只随环境变化移动。
  tier: dynamic
  main: false
  control:
    kind: none
  modules: []
  homeLocation: agentlife.demo/orchard
`;

/** A degraded entity marked as the main entity. */
const DEGRADED_MAIN_ENTITY = `id: gate-warden
type: agentlife.character/character
public: true
fields:
  name: 门口的护卫
  identity: 领一份口粮，守一段路。
  tier: degraded
  main: true
  control:
    kind: behaviour-tree
  modules:
    - behaviour-tree
  homeLocation: agentlife.demo/lantern-square
  bodyConfig: agentlife.demo/humanoid
  behaviourTree: agentlife.demo/warden-patrol
  localView: agentlife.demo/warden-view
`;

/** A normal entity that also points at a behaviour tree local view. */
const NORMAL_ENTITY_WITH_LOCAL_VIEW = `id: player
type: agentlife.character/character
public: true
templates:
  - agentlife.demo/normal-entity
fields:
  name: 旅人
  identity: 来自山谷外，靠替人跑腿换取住处。
  main: true
  control:
    kind: user
  homeLocation: agentlife.demo/lantern-square
  localView: agentlife.demo/warden-view
`;

/** A local view that tries to reach the character classification. */
const CLASSIFYING_LOCAL_VIEW = `id: warden-view
type: agentlife.world/local-view
public: true
fields:
  name: 护卫的局部执行视图
  description: 一个试图读取能力层级的局部视图。
  members:
    - agentlife.world/located-at.location
    - agentlife.character/schedule.tier
    - agentlife.character/schedule.main
`;

/** Declared runtime views one body-owning entity is projected with. */
const RUNTIME_VIEW_KEYS = [
  "agentlife.body/activity",
  "agentlife.body/channels",
  "agentlife.body/cognitive-participation",
  "agentlife.body/current-mode",
  "agentlife.body/process",
  "agentlife.body/values",
  "agentlife.world/attributes",
  "agentlife.world/held-by",
  "agentlife.world/located-at",
  "agentlife.world/participation",
  "agentlife.world/placed-on",
];

/** Every field name reachable in one projection, at any depth. */
function fieldNames(value: unknown): string[] {
  if (typeof value !== "object" || value === null) return [];
  return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) => [key, ...fieldNames(child)]);
}

describe("CharacterService", () => {
  it("reads the capability tier, control source and main flag of every character from content", async () => {
    const sim = await createSimulationWith({ "characters/drifting-leaf.yaml": DYNAMIC_CHARACTER_SOURCE });
    try {
      const state = sim.runner.state();
      const characters = sim.runner.characters;
      const view = characters.managementView(state.characters);

      expect(view).toContainEqual(
        expect.objectContaining({ entityId: DEMO_PLAYER, tier: "normal", control: "user", main: true }),
      );
      expect(view).toContainEqual(
        expect.objectContaining({ entityId: DEMO_COMPANION, tier: "normal", control: "cognition", main: true }),
      );
      expect(view).toContainEqual(
        expect.objectContaining({ entityId: DEMO_WARDEN, tier: "degraded", control: "behaviour-tree", main: false }),
      );
      expect(view).toContainEqual(
        expect.objectContaining({ entityId: DYNAMIC_CHARACTER, tier: "dynamic", control: "none", main: false }),
      );

      const warden = characters.get(state.characters, DEMO_WARDEN);
      expect(warden?.behaviourTree).toBe("agentlife.demo/warden-patrol");
      expect(warden?.localView).toBe("agentlife.demo/warden-view");
      expect(warden?.bodyConfig).toBe("agentlife.demo/humanoid");
      expect(characters.behaviorOwners(state.characters).map((record) => record.entityId)).toEqual([DEMO_WARDEN]);
      expect(characters.bodyOwners(state.characters)).toEqual([DEMO_COMPANION, DEMO_WARDEN, DEMO_PLAYER]);
      expect(characters.get(state.characters, DYNAMIC_CHARACTER)?.bodyConfig).toBeNull();
    } finally {
      removeDirectory(sim.directory);
    }
  });

  it("creates every character running and pauses and resumes one through the service", async () => {
    const sim = await createSimulation();
    const state = sim.runner.state();
    const characters = sim.runner.characters;

    expect(characters.sorted(state.characters).map((record) => record.entityId)).toEqual([
      DEMO_COMPANION,
      DEMO_WARDEN,
      DEMO_PLAYER,
    ]);
    expect(characters.sorted(state.characters).every((record) => record.lifecycle === "running")).toBe(true);
    expect(characters.acceptsNewPlans(state.characters, DEMO_PLAYER)).toBe(true);

    const paused = characters.pause(state.characters, DEMO_PLAYER);
    expect(characters.get(paused, DEMO_PLAYER)?.lifecycle).toBe("paused");
    expect(characters.acceptsNewPlans(paused, DEMO_PLAYER)).toBe(false);
    expect(characters.acceptsNewPlans(paused, DEMO_WARDEN)).toBe(true);
    expect(paused.version).not.toBe(state.characters.version);

    const resumed = characters.resume(paused, DEMO_PLAYER);
    expect(characters.get(resumed, DEMO_PLAYER)?.lifecycle).toBe("running");
    expect(characters.acceptsNewPlans(resumed, DEMO_PLAYER)).toBe(true);
  });

  it("refuses a degraded character that is declared as a main entity", async () => {
    const { result, directory } = await applyDemoPack(createRegistry(), {
      "characters/gate-warden.yaml": DEGRADED_MAIN_ENTITY,
    });
    try {
      expect(result.status).toBe("rejected");
      expect(causeCodes(result.diagnostics)).toContain("system-rejected");
      expect(
        result.diagnostics.some(
          (diagnostic) =>
            diagnostic.severity === "error" &&
            diagnostic.code === "system-rejected" &&
            diagnostic.subject === DEMO_WARDEN,
        ),
      ).toBe(true);
    } finally {
      removeDirectory(directory);
    }
  });

  it("refuses a normal character that also references a behaviour tree local view", async () => {
    const { result, directory } = await applyDemoPack(createRegistry(), {
      "characters/player.yaml": NORMAL_ENTITY_WITH_LOCAL_VIEW,
    });
    try {
      expect(result.status).toBe("rejected");
      expect(causeCodes(result.diagnostics)).toContain("system-rejected");
      expect(
        result.diagnostics.some(
          (diagnostic) =>
            diagnostic.severity === "error" &&
            diagnostic.code === "system-rejected" &&
            diagnostic.subject === DEMO_PLAYER,
        ),
      ).toBe(true);
    } finally {
      removeDirectory(directory);
    }
  });

  it("stops new plans when paused while the running action, the world process and other entities go on", async () => {
    const sim = await createSimulation();
    const runner = sim.runner;
    await runPublishedTick(runner, [
      testPlan("use-lamp", DEMO_PLAYER, "parallel", [{ action: USE, target: DEMO_LAMP }]),
    ]);

    const paused = runner.characters.pause(runner.state().characters, DEMO_PLAYER);
    expect(runner.characters.acceptsNewPlans(paused, DEMO_PLAYER)).toBe(false);
    // Phase 2 has no management command, so the paused character state is handed
    // to the running simulation through the documented restore entry point.
    runner.load({ ...runner.state(), characters: paused });

    // Tick 2: the paused character may not start anything new, but the action it
    // already ran keeps advancing.
    await runPublishedTick(runner, [testPlan("paused-say", DEMO_PLAYER, "parallel", [{ action: SAY }])]);
    expect(lastAction(runner, "paused-say")).toBeUndefined();
    expect(lastAction(runner, "use-lamp")?.stageTicks).toBe(1);

    // Tick 3: the running action reaches its world impact and the world accepts it.
    await runPublishedTick(runner);
    expect(lastAction(runner, "use-lamp")?.status).toBe("completed");
    expect(worldOf(runner).environment["lamp-state"]).toBe(1);

    // Tick 4: the lamp glow process advances and the warden moves, both outside
    // the paused character.
    await runPublishedTick(runner);
    expect(worldOf(runner).environment["light-level"]).toBe(520);
    expect(positionOf(runner, DEMO_WARDEN)).toBe(DEMO_KILN);
  });

  it("keeps the capability tier, control source and main flag out of the runtime views", async () => {
    const sim = await createSimulation();
    const state = sim.runner.state();
    const sources = { config: sim.config, world: state.world, characters: state.characters, body: state.body };

    const projection = sim.runner.world.projection(
      sources,
      [DEMO_PLAYER, DEMO_WARDEN, DEMO_ROPE],
      { kind: "agentlife.demo/hold", actor: DEMO_PLAYER, subject: DEMO_ROPE, destination: "", accepted: false },
      { [DEMO_PLAYER]: "actor", [DEMO_ROPE]: "subject" },
    );
    const bodyProjection = sim.runner.body.projection(sources, state.body, [DEMO_PLAYER], {
      entityId: DEMO_PLAYER,
    });

    // The classification is readable through the management view and nowhere else.
    const management = sim.runner.characters.managementView(state.characters);
    expect(management.map((entry) => entry.entityId)).toContain(DEMO_WARDEN);
    expect(fieldNames(management)).toContain("tier");
    expect(fieldNames(management)).toContain("main");
    expect(fieldNames(management)).toContain("control");

    expect(Object.keys(projection.entities[DEMO_WARDEN] ?? {}).sort()).toEqual(RUNTIME_VIEW_KEYS);
    expect(Object.keys(projection.entities[DEMO_ROPE] ?? {}).sort()).toEqual([
      "agentlife.world/attributes",
      "agentlife.world/held-by",
      "agentlife.world/located-at",
      "agentlife.world/participation",
      "agentlife.world/placed-on",
    ]);
    expect(Object.keys(bodyProjection.entities[DEMO_PLAYER] ?? {}).sort()).toEqual(RUNTIME_VIEW_KEYS);
    for (const view of [projection, bodyProjection]) {
      expect(fieldNames(view)).not.toContain("tier");
      expect(fieldNames(view)).not.toContain("main");
      expect(fieldNames(view)).not.toContain("control");
      expect(fieldNames(view)).not.toContain("lifecycle");
    }

    const members = localViewMembers(sim.config, "agentlife.demo/warden-view");
    expect(members).toContain("agentlife.body/values.stamina");
    expect(members).toContain("agentlife.world/environment.light-level");
    expect(members).not.toContain("agentlife.character/schedule.tier");
    expect(members).not.toContain("agentlife.character/schedule.main");
  });

  it("refuses a behaviour tree local view that names the character classification", async () => {
    const { result, directory } = await applyDemoPack(createRegistry(), {
      "localViews/warden-view.yaml": CLASSIFYING_LOCAL_VIEW,
    });
    try {
      expect(result.status).toBe("rejected");
      expect(causeCodes(result.diagnostics)).toContain("unauthorized-read");
      expect(
        result.diagnostics.some(
          (diagnostic) =>
            diagnostic.code === "unauthorized-read" && diagnostic.subject === "agentlife.demo/warden-view",
        ),
      ).toBe(true);
    } finally {
      removeDirectory(directory);
    }
  });
});
