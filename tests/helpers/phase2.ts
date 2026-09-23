import type { RuntimeConfig } from "../../src/config/config-builder.js";
import { CoreRuntime, packInput, type PublishResult } from "../../src/config/core-runtime.js";
import { ContentPackLoader } from "../../src/content/content-pack-loader.js";
import { SimulationRunner } from "../../src/simulation/runner.js";
import type { ActionPlan, SimulationSettings, TickSummary } from "../../src/simulation/types.js";
import type { SystemSpec } from "../../src/config/system-spec.js";
import { createSystemSpecs } from "../../src/systems/index.js";
import { scriptedModel, type CognitionScript } from "./cognition.js";
import { copyDemoPack, loadPack, removeDirectory } from "./demo-pack.js";

/**
 * Phase 2 test helpers.
 *
 * Every phase 2 case starts from the real demo content pack: a service or the
 * runner is only ever exercised through content that actually passed the
 * seven stage configuration pipeline.
 */

export const DEMO_PLAYER = "agentlife.demo/player";
export const DEMO_WARDEN = "agentlife.demo/gate-warden";
export const DEMO_COMPANION = "agentlife.demo/companion";
export const DEMO_ROPE = "agentlife.demo/rope";
export const DEMO_BENCH = "agentlife.demo/bench";
export const DEMO_LAMP = "agentlife.demo/lamp";
export const DEMO_SQUARE = "agentlife.demo/lantern-square";
export const DEMO_KILN = "agentlife.demo/kiln";

const PHASE2_SETTINGS: SimulationSettings = Object.freeze({
  tickSeconds: 1,
  maxPropagationRounds: 8,
  maxEvents: 256,
});

export interface DemoSimulation {
  readonly core: CoreRuntime;
  readonly config: RuntimeConfig;
  readonly runner: SimulationRunner;
}

function buildRegistry(systems: readonly SystemSpec[] = createSystemSpecs()): CoreRuntime {
  const core = new CoreRuntime();
  for (const system of systems) {
    const registration = core.addSystem(system);
    if (registration.status !== "registered")
      throw new Error(`system ${system.namespace} did not load: ${JSON.stringify(registration.diagnostics)}`);
  }
  return core;
}

function requireConfig(result: PublishResult): RuntimeConfig {
  if (result.status !== "valid" || result.config === undefined)
    throw new Error(`demo pack did not publish: ${JSON.stringify(result.diagnostics, null, 2)}`);
  return result.config;
}

/** Publishes the untouched demo pack. */
export async function publishDemo(
  systems?: readonly SystemSpec[],
): Promise<{ readonly core: CoreRuntime; readonly config: RuntimeConfig }> {
  const core = buildRegistry(systems);
  const result = await loadPack(core, copyDemoPack());
  return { core, config: requireConfig(result) };
}

/** Publishes a copy of the demo pack with per-file overrides applied. */
export async function publishDemoWith(
  overrides: Readonly<Record<string, string | null>>,
  systems?: readonly SystemSpec[],
): Promise<{ readonly core: CoreRuntime; readonly config: RuntimeConfig; readonly directory: string }> {
  const core = buildRegistry(systems);
  const directory = copyDemoPack(overrides);
  const result: PublishResult = await (async () => {
    const snapshot = await new ContentPackLoader().load(directory);
    return core.publish({ root: packInput(snapshot) });
  })();
  return { core, config: requireConfig(result), directory };
}

export interface SimulationOptions {
  readonly timelineId?: string;
  readonly settings?: Partial<SimulationSettings>;
  /** System declarations of the run; the demo systems when omitted. */
  readonly systems?: readonly SystemSpec[];
}

/**
 * The scripted cognition model of a phase 2/3 timeline.
 *
 * The faux provider streams its answer chunk by chunk, and with a token rate every
 * chunk costs a timer: one tick of the demo timeline resolves one cognition round
 * and would spend most of a second inside the provider. A rate of zero makes the
 * provider hand the answer back on the microtask queue, so these tests stay about
 * the simulation rather than about streaming.
 */
const PHASE2_COGNITION: CognitionScript = Object.freeze({ tokensPerSecond: 0 });

/** A running simulation over the untouched demo content. */
export async function createSimulation(options: SimulationOptions = {}): Promise<DemoSimulation> {
  const { core, config } = await publishDemo(options.systems);
  return {
    core,
    config,
    runner: SimulationRunner.create(core, {
      timelineId: options.timelineId ?? "timeline-test",
      settings: { ...PHASE2_SETTINGS, ...(options.settings ?? {}) },
      models: scriptedModel(PHASE2_COGNITION),
    }),
  };
}

/** A running simulation over a copy of the demo content with per-file overrides. */
export async function createSimulationWith(
  overrides: Readonly<Record<string, string | null>>,
  options: SimulationOptions = {},
): Promise<DemoSimulation & { readonly directory: string }> {
  const { core, config, directory } = await publishDemoWith(overrides, options.systems);
  return {
    core,
    config,
    directory,
    runner: SimulationRunner.create(core, {
      timelineId: options.timelineId ?? "timeline-test",
      settings: { ...PHASE2_SETTINGS, ...(options.settings ?? {}) },
      models: scriptedModel(PHASE2_COGNITION),
    }),
  };
}

export interface TestStep {
  readonly action: string;
  readonly target?: string;
  readonly destination?: string;
}

export function testPlan(
  planId: string,
  entityId: string,
  conflict: "parallel" | "queue" | "replace",
  steps: readonly TestStep[],
) {
  return { planId, entityId, source: "diagnostic" as const, formedVersion: "", conflict, steps };
}

/**
 * Runs one tick to its publication and hands back what it published.
 *
 * A tick may stop on a cognition barrier - the demo companion is an AI participant
 * - and `runTickToPublication` resolves it with the scripted model, so the tick a
 * test asks for is a tick that really happened. Anything else than a published tick
 * is a test failure, not a state to assert on.
 */
export async function runPublishedTick(
  runner: SimulationRunner,
  plans: readonly ActionPlan[] = [],
): Promise<TickSummary> {
  const result = await runner.runTickToPublication({ plans });
  if (result.status !== "completed") throw new Error(`the tick did not publish: ${result.status}`);
  return result.summary;
}

export function worldOf(runner: SimulationRunner) {
  return runner.state().world;
}

/** Position of one entity under whichever relation currently carries it. */
export function positionOf(runner: SimulationRunner, entityId: string): string | null {
  const entity = runner.state().world.entities[entityId];
  if (entity === undefined) return null;
  return entity.locatedAt ?? entity.heldBy ?? entity.placedOn;
}

export function actionsOf(runner: SimulationRunner, entityId: string) {
  return runner.state().actions.filter((action) => action.entityId === entityId);
}

export function lastAction(runner: SimulationRunner, planId: string) {
  return runner
    .state()
    .actions.filter((action) => action.plan.planId === planId)
    .at(-1);
}

export { removeDirectory };
