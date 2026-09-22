import { describe, expect, it } from "vitest";
import type { StateChangeRequest } from "../src/config/rule-engine.js";
import type { SimpleValue } from "../src/config/value-expr.js";
import type { ProjectionSources } from "../src/simulation/projection.js";
import type { WorldInfluenceRequest, WorldState } from "../src/simulation/types.js";
import type { TickContext, WorldService } from "../src/simulation/world-service.js";
import {
  DEMO_BENCH,
  DEMO_KILN,
  DEMO_LAMP,
  DEMO_PLAYER,
  DEMO_ROPE,
  DEMO_SQUARE,
  DEMO_WARDEN,
  createSimulation,
  type DemoSimulation,
} from "./helpers/phase2.js";

/** Influence kinds, relations and ids the demo content declares. */
const HOLD = "agentlife.demo/hold";
const PUT_ON = "agentlife.demo/put-on";
const OPERATE = "agentlife.demo/operate-item";
const RELOCATE = "agentlife.demo/relocate";
const LOCATED_AT = "agentlife.world/located-at";
const HELD_BY = "agentlife.world/held-by";
const PLACED_ON = "agentlife.world/placed-on";
const TIMELINE = "timeline-test";
const MISSING_ENTITY = "agentlife.demo/nobody";
const DEMO_ORCHARD = "agentlife.demo/orchard";

function sourcesOf(sim: DemoSimulation, world: WorldState): ProjectionSources {
  const state = sim.orchestrator.state();
  return { config: sim.config, world, characters: state.characters, body: state.body };
}

/** A world influence request formed against exactly this world version. */
function influenceAgainst(
  world: WorldState,
  influenceId: string,
  kind: string,
  actor: string,
  subject: string,
  destination: string | null = null,
): WorldInfluenceRequest {
  return {
    influenceId,
    timelineId: TIMELINE,
    kind,
    actor,
    subject,
    destination,
    baseVersion: world.version,
    tick: 1,
  };
}

/** One hand-built world state change, as a rule result would carry it. */
function worldChange(
  baseVersion: string,
  changeId: string,
  entityId: string | null,
  stateRef: string,
  newValue: SimpleValue,
): StateChangeRequest {
  return {
    changeId,
    entityId,
    stateRef,
    system: "agentlife.world",
    newValue,
    sourceRules: ["test/rule"],
    runId: `test/${changeId}`,
    baseVersion,
    simTime: { tick: 1, seconds: 0 },
  };
}

function commitRequest(world: WorldService, state: WorldState, changes: readonly StateChangeRequest[]) {
  const context: TickContext = { timelineId: TIMELINE, tick: 1, command: "test-commit" };
  return world.commit(state, context, changes, [], { kind: "influence", actor: null, subject: null });
}

describe("WorldService", () => {
  it("takes an item its content marks portable and refuses one it does not", async () => {
    const sim = await createSimulation();
    const world = sim.orchestrator.world;
    const initial = sim.orchestrator.state().world;

    const taken = world.adjudicate(
      sourcesOf(sim, initial),
      influenceAgainst(initial, "take-rope", HOLD, DEMO_PLAYER, DEMO_ROPE),
      initial.version,
    );
    expect(taken.outcome.status).toBe("applied");
    expect(taken.state.entities[DEMO_ROPE]?.heldBy).toBe(DEMO_PLAYER);
    expect(taken.state.version).not.toBe(initial.version);

    const refused = world.adjudicate(
      sourcesOf(sim, initial),
      influenceAgainst(initial, "take-bench", HOLD, DEMO_PLAYER, DEMO_BENCH),
      initial.version,
    );
    expect(refused.outcome.status).toBe("rejected");
    expect(refused.applied).toHaveLength(0);
    expect(refused.state.version).toBe(initial.version);
    expect(refused.state.entities[DEMO_BENCH]?.heldBy).toBeNull();
    expect(refused.state.entities[DEMO_BENCH]?.locatedAt).toBe(DEMO_SQUARE);
  });

  it("places an item on a target its content marks as support and refuses one it does not", async () => {
    const sim = await createSimulation();
    const world = sim.orchestrator.world;
    const initial = sim.orchestrator.state().world;
    const held = world.adjudicate(
      sourcesOf(sim, initial),
      influenceAgainst(initial, "take-rope", HOLD, DEMO_PLAYER, DEMO_ROPE),
      initial.version,
    );

    const onLamp = world.adjudicate(
      sourcesOf(sim, held.state),
      influenceAgainst(held.state, "put-on-lamp", PUT_ON, DEMO_PLAYER, DEMO_ROPE, DEMO_LAMP),
      held.state.version,
    );
    expect(onLamp.outcome.status).toBe("rejected");
    expect(onLamp.applied).toHaveLength(0);
    expect(onLamp.state.entities[DEMO_ROPE]?.placedOn).toBeNull();
    expect(onLamp.state.entities[DEMO_ROPE]?.heldBy).toBe(DEMO_PLAYER);

    const onBench = world.adjudicate(
      sourcesOf(sim, held.state),
      influenceAgainst(held.state, "put-on-bench", PUT_ON, DEMO_PLAYER, DEMO_ROPE, DEMO_BENCH),
      held.state.version,
    );
    expect(onBench.outcome.status).toBe("applied");
    expect(onBench.state.entities[DEMO_ROPE]?.placedOn).toBe(DEMO_BENCH);
    expect(onBench.state.entities[DEMO_ROPE]?.heldBy).toBeNull();
    expect(onBench.events.some((event) => event.stateRef === PLACED_ON && event.subject === DEMO_ROPE)).toBe(true);
  });

  it("operates an item its content marks operable and refuses one it does not", async () => {
    const sim = await createSimulation();
    const world = sim.orchestrator.world;
    const initial = sim.orchestrator.state().world;

    const onRope = world.adjudicate(
      sourcesOf(sim, initial),
      influenceAgainst(initial, "operate-rope", OPERATE, DEMO_PLAYER, DEMO_ROPE),
      initial.version,
    );
    expect(onRope.outcome.status).toBe("rejected");
    expect(onRope.applied).toHaveLength(0);
    expect(onRope.state.version).toBe(initial.version);
    expect(onRope.state.environment["lamp-state"]).toBe(0);

    const onLamp = world.adjudicate(
      sourcesOf(sim, initial),
      influenceAgainst(initial, "operate-lamp", OPERATE, DEMO_PLAYER, DEMO_LAMP),
      initial.version,
    );
    expect(onLamp.outcome.status).toBe("applied");
    expect(onLamp.state.environment["lamp-state"]).toBe(1);
    expect(onLamp.events.some((event) => event.kind === "environment-changed")).toBe(true);
  });

  it("never lets one item be taken a second time while someone carries it", async () => {
    const sim = await createSimulation();
    const world = sim.orchestrator.world;
    const initial = sim.orchestrator.state().world;
    const held = world.adjudicate(
      sourcesOf(sim, initial),
      influenceAgainst(initial, "take-rope", HOLD, DEMO_PLAYER, DEMO_ROPE),
      initial.version,
    );

    // The rope is already carried, so it is nowhere to be taken from: the second
    // holder must be refused without applying anything or moving the version.
    // (The returned candidate still carries the staged relation; that leak of a
    // refused change is reported with the phase 2 findings.)
    const alsoTaken = world.adjudicate(
      sourcesOf(sim, held.state),
      influenceAgainst(held.state, "take-rope-again", HOLD, DEMO_WARDEN, DEMO_ROPE),
      held.state.version,
    );
    expect(alsoTaken.outcome.status).toBe("rejected");
    expect(alsoTaken.applied).toHaveLength(0);
    expect(alsoTaken.events).toHaveLength(0);
    expect(alsoTaken.state.version).toBe(held.state.version);
  });

  it("refuses to put an item on a support when nobody carries it", async () => {
    const sim = await createSimulation();
    const world = sim.orchestrator.world;
    const initial = sim.orchestrator.state().world;
    expect(initial.entities[DEMO_ROPE]?.heldBy).toBeNull();

    const placed = world.adjudicate(
      sourcesOf(sim, initial),
      influenceAgainst(initial, "put-on-bench", PUT_ON, DEMO_PLAYER, DEMO_ROPE, DEMO_BENCH),
      initial.version,
    );

    expect(placed.outcome.status).toBe("rejected");
    expect(placed.applied).toHaveLength(0);
    expect(placed.events).toHaveLength(0);
    expect(placed.state.version).toBe(initial.version);
  });

  it("commits no part of a batch whose change breaks a relation invariant", async () => {
    const sim = await createSimulation();
    const world = sim.orchestrator.world;
    const initial = sim.orchestrator.state().world;

    const result = commitRequest(world, initial, [
      worldChange(initial.version, "change-lamp", DEMO_LAMP, HELD_BY, DEMO_PLAYER),
      worldChange(initial.version, "change-player", DEMO_PLAYER, HELD_BY, DEMO_WARDEN),
    ]);

    expect(result.applied).toHaveLength(0);
    expect(result.events).toHaveLength(0);
    expect(result.state.version).toBe(initial.version);
    expect(result.state.entities[DEMO_LAMP]?.heldBy).toBeNull();
    expect(result.state.entities[DEMO_LAMP]?.locatedAt).toBe(DEMO_SQUARE);
    expect(result.state.entities[DEMO_PLAYER]?.locatedAt).toBe(DEMO_SQUARE);
  });

  it("commits no part of a batch whose change references an entity the world does not know", async () => {
    const sim = await createSimulation();
    const world = sim.orchestrator.world;
    const initial = sim.orchestrator.state().world;

    const result = commitRequest(world, initial, [
      worldChange(initial.version, "change-lamp", DEMO_LAMP, HELD_BY, DEMO_PLAYER),
      worldChange(initial.version, "change-rope", DEMO_ROPE, LOCATED_AT, MISSING_ENTITY),
    ]);

    expect(result.applied).toHaveLength(0);
    expect(result.state.version).toBe(initial.version);
    expect(result.state.entities[DEMO_LAMP]?.heldBy).toBeNull();
    expect(result.state.entities[DEMO_ROPE]?.locatedAt).toBe(DEMO_SQUARE);
  });

  it("commits no part of a batch in which an item would hold itself", async () => {
    const sim = await createSimulation();
    const world = sim.orchestrator.world;
    const initial = sim.orchestrator.state().world;

    const result = commitRequest(world, initial, [
      worldChange(initial.version, "change-lamp", DEMO_LAMP, HELD_BY, DEMO_PLAYER),
      worldChange(initial.version, "change-rope", DEMO_ROPE, HELD_BY, DEMO_ROPE),
    ]);

    expect(result.applied).toHaveLength(0);
    expect(result.state.version).toBe(initial.version);
    expect(result.state.entities[DEMO_LAMP]?.heldBy).toBeNull();
    expect(result.state.entities[DEMO_ROPE]?.heldBy).toBeNull();
  });

  it("commits no part of a batch in which an item would be placed on itself", async () => {
    const sim = await createSimulation();
    const world = sim.orchestrator.world;
    const initial = sim.orchestrator.state().world;

    // Nobody carries the rope, so it cannot support itself: the batch is refused
    // and the unrelated change of the lamp must stay out of the world as well.
    const result = commitRequest(world, initial, [
      worldChange(initial.version, "change-lamp", DEMO_LAMP, HELD_BY, DEMO_PLAYER),
      worldChange(initial.version, "change-rope", DEMO_ROPE, PLACED_ON, DEMO_ROPE),
    ]);

    expect(result.applied).toHaveLength(0);
    expect(result.events).toHaveLength(0);
    expect(result.state.version).toBe(initial.version);
    expect(result.state.entities[DEMO_LAMP]?.heldBy).toBeNull();
  });

  it("reports an entity that carries two position relations and a support cycle", async () => {
    // The relation vocabulary holds one relation per entity and staging a change
    // replaces the others, so these two cases are asserted on the state the guard
    // must refuse rather than on a request that could build it.
    const sim = await createSimulation();
    const world = sim.orchestrator.world;
    const initial = sim.orchestrator.state().world;
    const rope = initial.entities[DEMO_ROPE];
    const bench = initial.entities[DEMO_BENCH];
    const lamp = initial.entities[DEMO_LAMP];
    if (rope === undefined || bench === undefined || lamp === undefined) throw new Error("demo world is incomplete");

    const stacked: WorldState = {
      ...initial,
      entities: {
        ...initial.entities,
        [DEMO_ROPE]: { ...rope, locatedAt: DEMO_SQUARE, heldBy: DEMO_PLAYER },
      },
    };
    expect(world.invariantProblems(stacked).some((problem) => problem.includes(DEMO_ROPE))).toBe(true);

    const cycle: WorldState = {
      ...initial,
      entities: {
        ...initial.entities,
        [DEMO_ROPE]: { ...rope, locatedAt: null, placedOn: DEMO_BENCH },
        [DEMO_BENCH]: { ...bench, locatedAt: null, placedOn: DEMO_LAMP },
        [DEMO_LAMP]: { ...lamp, locatedAt: null, placedOn: DEMO_ROPE },
      },
    };
    expect(world.invariantProblems(cycle).some((problem) => problem.includes(DEMO_ROPE))).toBe(true);
  });

  it("moves a character to a declared exit and records the world event", async () => {
    const sim = await createSimulation();
    const world = sim.orchestrator.world;
    const initial = sim.orchestrator.state().world;

    const moved = world.adjudicate(
      sourcesOf(sim, initial),
      influenceAgainst(initial, "move-out", RELOCATE, DEMO_PLAYER, DEMO_PLAYER, DEMO_KILN),
      initial.version,
    );

    expect(moved.outcome.status).toBe("applied");
    expect(moved.state.entities[DEMO_PLAYER]?.locatedAt).toBe(DEMO_KILN);
    const event = moved.events.find((entry) => entry.stateRef === LOCATED_AT && entry.subject === DEMO_PLAYER);
    expect(event?.kind).toBe("relation-changed");
    expect(event?.from).toBe(DEMO_SQUARE);
    expect(event?.to).toBe(DEMO_KILN);
  });

  it("refuses a move whose destination is not an exit of the place the actor is in", async () => {
    const sim = await createSimulation();
    const world = sim.orchestrator.world;
    const initial = sim.orchestrator.state().world;
    const moved = world.adjudicate(
      sourcesOf(sim, initial),
      influenceAgainst(initial, "move-out", RELOCATE, DEMO_PLAYER, DEMO_PLAYER, DEMO_KILN),
      initial.version,
    );
    expect(moved.state.entities[DEMO_PLAYER]?.locatedAt).toBe(DEMO_KILN);
    expect(world.locationExits(DEMO_KILN)).toEqual([DEMO_SQUARE]);

    const refused = world.adjudicate(
      sourcesOf(sim, moved.state),
      influenceAgainst(moved.state, "move-across", RELOCATE, DEMO_PLAYER, DEMO_PLAYER, DEMO_ORCHARD),
      moved.state.version,
    );

    expect(refused.outcome.status).toBe("rejected");
    expect(refused.applied).toHaveLength(0);
    expect(refused.events).toHaveLength(0);
    expect(refused.state.version).toBe(moved.state.version);
  });

  it("refuses a request formed against an earlier world version without touching the state", async () => {
    const sim = await createSimulation();
    const world = sim.orchestrator.world;
    const initial = sim.orchestrator.state().world;
    const held = world.adjudicate(
      sourcesOf(sim, initial),
      influenceAgainst(initial, "take-rope", HOLD, DEMO_PLAYER, DEMO_ROPE),
      initial.version,
    );
    expect(held.state.version).not.toBe(initial.version);

    // The request still names the version the world had before the rope was taken.
    const stale = world.adjudicate(
      sourcesOf(sim, held.state),
      influenceAgainst(initial, "move-stale", RELOCATE, DEMO_PLAYER, DEMO_PLAYER, DEMO_KILN),
      held.state.version,
    );

    expect(stale.outcome.status).toBe("stale");
    expect(stale.applied).toHaveLength(0);
    expect(stale.events).toHaveLength(0);
    expect(stale.state.version).toBe(held.state.version);
    expect(stale.state.entities[DEMO_PLAYER]?.locatedAt).toBe(DEMO_SQUARE);
  });
});
