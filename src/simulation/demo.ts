import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { hashId } from "../config/canonical.js";
import { ContentPackLoader } from "../content/content-pack-loader.js";
import { CoreRuntime, packInput, type PublishResult } from "../config/core-runtime.js";
import type { RuntimeConfig } from "../config/config-builder.js";
import { RuntimeStore } from "../storage/runtime-store.js";
import { createSystemSpecs } from "../systems/index.js";
import { PiCognitionAgent } from "../agent/cognition-agent.js";
import { idleDecision } from "../agent/scripted-cognition.js";
import { SimulationRunner } from "./runner.js";
import { checkSnapshot, decodeSnapshot, encodeSnapshot, snapshotOf, type SaveSnapshot } from "./save.js";
import type { ActionPlan, ActionPolicy, ActionStep, SimulationState } from "./types.js";

/**
 * The phase 2 demonstration scenario.
 *
 * It drives the whole deterministic kernel without a model, a UI or a random
 * source: plans are submitted at fixed ticks, actions advance by simulated time,
 * the world adjudicates each impact through the content rules, the behaviour tree
 * of the degraded entity forms its own plans, and an explicit save is loaded and
 * continued for the same number of ticks as the original timeline.
 */

export const DEMO_PACK_PATH = fileURLToPath(new URL("../../content/demo", import.meta.url));

export interface DemoOptions {
  readonly ticks?: number;
  readonly saveAt?: number;
  readonly continueTicks?: number;
}

export interface DemoReport {
  readonly lines: readonly string[];
  readonly digest: string;
  readonly continuedDigest: string;
  readonly loadedDigest: string;
  readonly state: SimulationState;
  readonly saved: SaveSnapshot;
  readonly configId: string;
}

function step(action: string, target?: string, destination?: string): ActionStep {
  return {
    action,
    ...(target === undefined ? {} : { target }),
    ...(destination === undefined ? {} : { destination }),
  };
}

function plan(planId: string, entityId: string, conflict: ActionPolicy, ...steps: ActionStep[]): ActionPlan {
  return { planId, entityId, source: "diagnostic", formedVersion: "", conflict, steps };
}

const PLAYER = "agentlife.demo/player";

/** Plans submitted at the start of each scripted tick. */
function script(): Readonly<Record<number, readonly ActionPlan[]>> {
  return {
    1: [
      plan("player-move-out", PLAYER, "parallel", step("agentlife.demo/walk", undefined, "agentlife.demo/kiln")),
      plan("player-say", PLAYER, "parallel", step("agentlife.demo/say")),
    ],
    2: [
      plan("player-wave", PLAYER, "parallel", step("agentlife.demo/wave")),
      plan("player-grasp-early", PLAYER, "queue", step("agentlife.demo/grasp", "agentlife.demo/rope")),
    ],
    5: [
      plan(
        "player-return",
        PLAYER,
        "parallel",
        step("agentlife.demo/walk", undefined, "agentlife.demo/lantern-square"),
      ),
    ],
    8: [plan("player-grasp", PLAYER, "parallel", step("agentlife.demo/grasp", "agentlife.demo/rope"))],
    12: [
      plan(
        "player-place",
        PLAYER,
        "parallel",
        step("agentlife.demo/lay-down", "agentlife.demo/rope", "agentlife.demo/bench"),
      ),
    ],
    17: [plan("player-operate", PLAYER, "parallel", step("agentlife.demo/use", "agentlife.demo/lamp"))],
    20: [plan("player-move-home", PLAYER, "parallel", step("agentlife.demo/walk", undefined, "agentlife.demo/kiln"))],
    21: [plan("player-wave-again", PLAYER, "parallel", step("agentlife.demo/wave"))],
    22: [plan("player-wave-replace", PLAYER, "replace", step("agentlife.demo/wave"))],
  };
}

/** Publishes the demo pack, failing loudly with the diagnostics that refused it. */
export async function publishDemoConfig(): Promise<{ readonly core: CoreRuntime; readonly config: RuntimeConfig }> {
  const core = new CoreRuntime();
  for (const system of createSystemSpecs()) {
    const registration = core.addSystem(system);
    if (registration.status !== "registered")
      throw new Error(`System ${system.namespace} did not load: ${JSON.stringify(registration.diagnostics, null, 2)}`);
  }
  const snapshot = await new ContentPackLoader().load(DEMO_PACK_PATH);
  const applied: PublishResult = core.publish({ root: packInput(snapshot) });
  if (applied.status !== "valid" || applied.config === undefined)
    throw new Error(`Demo pack did not apply: ${JSON.stringify(applied.diagnostics, null, 2)}`);
  return { core, config: applied.config };
}

/**
 * An event identity without the timeline that minted it.
 *
 * Every loaded timeline is a new timeline by design and stamps its own prefix, while
 * the events it names are the same events. A canonical view therefore compares which
 * tick an identity points at, not which timeline wrote the string around it.
 */
function canonicalEventId(eventId: string): string {
  const tick = /\/(\d+)\//.exec(eventId);
  return tick === null ? eventId : eventId.slice(tick.index);
}

/** A canonical view of what the simulation produced, independent of run identity. */
export function semanticView(state: SimulationState): unknown {
  return {
    tick: state.tick,
    runMode: state.runMode,
    world: {
      entities: state.world.entities,
      environment: state.world.environment,
      processes: state.world.processes,
      events: state.world.events.map((event) => ({
        tick: event.tick,
        kind: event.kind,
        actor: event.actor,
        subject: event.subject,
        stateRef: event.stateRef,
        from: event.from,
        to: event.to,
      })),
    },
    characters: state.characters.characters,
    body: state.body.bodies,
    actions: state.actions.map((action) => ({
      entityId: action.entityId,
      action: action.action,
      status: action.status,
      stageIndex: action.stageIndex,
      stepIndex: action.stepIndex,
      target: action.target,
      destination: action.destination,
      outcome: action.outcome,
      waitingWorld: action.worldRequest !== null,
    })),
    perception: Object.fromEntries(
      Object.entries(state.perception.observers).map(([observer, value]) => [
        observer,
        {
          subjects: value.subjects,
          pending: value.pending.map((observation) => ({
            ...observation,
            eventId: observation.eventId === null ? null : canonicalEventId(observation.eventId),
          })),
          references: value.references,
          referencesUsed: value.referencesUsed,
          suppressedUntil: value.suppressedUntil,
          // A set of events already turned into observations: order carries nothing.
          processedEvents: value.processedEvents.map((eventId) => canonicalEventId(eventId)).sort(),
          materialVersion: value.materialVersion,
          attentionVersion: value.attentionVersion,
        },
      ]),
    ),
    memory: state.memory,
    cognition: state.cognition,
    behaviours: state.behaviours,
    barrier: state.barrier,
    failure: state.failure,
  };
}

export function digestOf(state: SimulationState): string {
  return hashId(semanticView(state)).slice(0, 16);
}

/**
 * The demo runs the scripted faux model: a decision needs a model port, and the
 * vocabulary policy acts on nothing and waits for something it can hear.
 */
function cognitionModel(): PiCognitionAgent {
  return new PiCognitionAgent({
    provider: "faux",
    model: "faux-cognition",
    tokensPerSecond: 100_000,
    draft: idleDecision,
  });
}

async function runTicks(runner: SimulationRunner, from: number, count: number, lines: string[]): Promise<void> {
  const scripted = script();
  for (let tick = from; tick < from + count; tick += 1) {
    const plans = scripted[tick] ?? [];
    const result = await runner.runTickToPublication({ plans });
    lines.push(`  continued tick ${tick} -> ${result.status}`);
    if (result.status !== "completed") break;
  }
}

function describe(lines: string[], state: SimulationState): void {
  lines.push("");
  lines.push(
    `tick ${state.tick} (${state.runMode}) state ${state.world.version}/${state.characters.version}/${state.body.version}`,
  );
  lines.push("world entities");
  for (const entity of Object.values(state.world.entities).sort((left, right) =>
    left.entityId < right.entityId ? -1 : 1,
  )) {
    const relation =
      entity.locatedAt !== null
        ? `at ${entity.locatedAt}`
        : entity.heldBy !== null
          ? `held by ${entity.heldBy}`
          : entity.placedOn !== null
            ? `on ${entity.placedOn}`
            : "nowhere";
    lines.push(`  ${entity.entityId} (${entity.kind}) ${relation}`);
  }
  lines.push(
    `environment ${Object.entries(state.world.environment)
      .sort()
      .map(([key, value]) => `${key}=${String(value)}`)
      .join(", ")}`,
  );
  lines.push("bodies");
  for (const body of Object.values(state.body.bodies).sort((left, right) =>
    left.entityId < right.entityId ? -1 : 1,
  )) {
    lines.push(
      `  ${body.entityId} mode=${body.mode} participation=${body.participation} stamina=${String(body.values["stamina"])} wakefulness=${String(body.values["wakefulness"])} processes=${body.processes.map((process) => process.processRef).join(",") || "none"}`,
    );
  }
  lines.push("actions");
  for (const action of state.actions) {
    lines.push(
      `  ${action.entityId} ${action.action} [${action.status}] step ${action.stepIndex} stage ${action.stageIndex}${action.outcome === null ? "" : ` (${action.outcome.reason})`}`,
    );
  }
  lines.push(`world events ${state.world.events.length}`);
  for (const event of state.world.events) {
    lines.push(
      `  t${event.tick} ${event.kind} ${event.subject ?? ""} ${event.stateRef ?? ""} ${String(event.from ?? "")} -> ${String(event.to ?? "")}`,
    );
  }
  lines.push("behaviour decisions");
  for (const [entityId, behaviour] of Object.entries(state.behaviours).sort())
    lines.push(
      `  ${entityId} last tick ${behaviour.tick}, cooldown until ${behaviour.cooldownUntilTick}, plan ${behaviour.activePlanId ?? "none"}, blackboard ${JSON.stringify(behaviour.blackboard)}`,
    );
}

export async function runDemoScenario(options: DemoOptions = {}): Promise<DemoReport> {
  const ticks = options.ticks ?? 26;
  const saveAt = options.saveAt ?? ticks;
  const continueTicks = options.continueTicks ?? 4;
  const { core, config } = await publishDemoConfig();
  const lines: string[] = [];
  lines.push(`configId        ${config.configId}`);
  lines.push(`systems         ${config.systems.map((system) => `${system.systemId}@${system.version}`).join(", ")}`);
  lines.push(
    `content         ${config.items.length} items, ${config.rules.length} rules, ${config.formulas.length} formulas`,
  );

  const runner = SimulationRunner.create(core, { timelineId: "timeline-demo", models: cognitionModel() });
  const scripted = script();
  let savedState: SimulationState = runner.state();
  for (let tick = 1; tick <= ticks; tick += 1) {
    const plans = scripted[tick] ?? [];
    const result = await runner.runTickToPublication({ plans });
    if (result.status === "cognitive-barrier") {
      lines.push(
        `tick ${tick} waits for ${result.round.participants.map((participant) => participant.characterId).join(", ")}`,
      );
      break;
    }
    if (plans.length > 0) lines.push(`tick ${tick}: ${plans.map((entry) => entry.planId).join(", ")}`);
    for (const outcome of result.summary.actionOutcomes) lines.push(`  ${outcome}`);
    for (const outcome of result.summary.influenceOutcomes)
      lines.push(`  influence ${outcome.status}: ${outcome.reason}`);
    if (result.status !== "completed") {
      lines.push(`tick ${tick} ended ${result.status}: ${result.summary.stages.at(-1)?.detail ?? ""}`);
      break;
    }
    if (tick === saveAt) savedState = runner.state();
  }
  const stages = runner.state().summary?.stages ?? [];
  lines.push("");
  lines.push(`last tick stages: ${stages.map((stage) => `${stage.stage}=${stage.status}`).join(" ")}`);
  for (const stage of stages) lines.push(`  ${stage.stage.padEnd(18)} ${stage.status.padEnd(6)} ${stage.detail}`);

  describe(lines, runner.state());
  const digest = digestOf(runner.state());

  // Continue the original timeline for a fixed number of ticks.
  await runTicks(runner, ticks + 1, continueTicks, lines);
  const continuedDigest = digestOf(runner.state());

  // Save explicitly, then load that save into a fresh timeline and continue.
  const directory = mkdtempSync(join(tmpdir(), "agent-life-phase2-"));
  let loadedDigest = "";
  let saved: SaveSnapshot = snapshotOf(savedState, "phase2-demo", config);
  try {
    const store = new RuntimeStore(join(directory, "runtime.db"));
    store.saveConfig({
      configId: config.configId,
      namespace: "agentlife.demo",
      packVersion: "1.1.0",
      document: config.sourceData,
    });
    store.saveSimulation({
      saveId: saved.saveId,
      timelineId: saved.timelineId,
      tick: saved.tick,
      configId: saved.configId,
      payload: encodeSnapshot(saved),
    });
    lines.push("");
    lines.push(
      `saves           ${store
        .listSaves()
        .map((entry) => `${entry.saveId}@tick-${entry.tick}`)
        .join(", ")}`,
    );
    const document = store.loadSimulation(saved.saveId);
    const decoded = decodeSnapshot(document);
    if (!decoded.ok) throw new Error(`Save did not decode: ${decoded.reason}`);
    saved = decoded.snapshot;
    const check = checkSnapshot(saved, config);
    if (!check.ok) throw new Error(`Save is not compatible with the current config: ${check.reason}`);
    const restored = SimulationRunner.create(core, {
      timelineId: "timeline-demo-restored",
      models: cognitionModel(),
    });
    restored.load({ ...saved.state, timelineId: "timeline-demo-restored" });
    lines.push(`loaded save     tick ${saved.state.tick}, ${store.listSaves().length} save(s) in the store`);
    await runTicks(restored, ticks + 1, continueTicks, lines);
    loadedDigest = digestOf(restored.state());
    store.close();
  } finally {
    // A closed SQLite file can still be briefly held by the host; the demo must
    // not fail because a temporary directory could not be removed.
    try {
      rmSync(directory, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      // ignored on purpose
    }
  }

  lines.push("");
  lines.push(`summary digest  ${digest}`);
  lines.push(`continued       ${continuedDigest}`);
  lines.push(`loaded+continued ${loadedDigest}`);
  if (continuedDigest !== loadedDigest)
    lines.push("MISMATCH: continuing the original timeline and continuing the loaded save diverged");
  return {
    lines,
    digest,
    continuedDigest,
    loadedDigest,
    state: runner.state(),
    saved,
    configId: config.configId,
  };
}
