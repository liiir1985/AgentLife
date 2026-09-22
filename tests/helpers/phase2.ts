import type { RuntimeConfig } from "../../src/config/config-builder.js";
import { CoreRuntime, packInput, type PublishResult } from "../../src/config/core-runtime.js";
import { ContentPackLoader } from "../../src/content/content-pack-loader.js";
import { SimulationOrchestrator } from "../../src/simulation/orchestrator.js";
import type { SimulationSettings } from "../../src/simulation/types.js";
import type { SystemSpec } from "../../src/config/system-spec.js";
import { createSystemSpecs } from "../../src/systems/index.js";
import { copyDemoPack, loadPack, removeDirectory } from "./demo-pack.js";

/**
 * Phase 2 test helpers.
 *
 * Every phase 2 case starts from the real demo content pack: a service or the
 * orchestrator is only ever exercised through content that actually passed the
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
  readonly orchestrator: SimulationOrchestrator;
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

/** A running simulation over the untouched demo content. */
export async function createSimulation(options: SimulationOptions = {}): Promise<DemoSimulation> {
  const { core, config } = await publishDemo(options.systems);
  return {
    core,
    config,
    orchestrator: SimulationOrchestrator.create(core, {
      timelineId: options.timelineId ?? "timeline-test",
      settings: { ...PHASE2_SETTINGS, ...(options.settings ?? {}) },
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
    orchestrator: SimulationOrchestrator.create(core, {
      timelineId: options.timelineId ?? "timeline-test",
      settings: { ...PHASE2_SETTINGS, ...(options.settings ?? {}) },
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

export function worldOf(orchestrator: SimulationOrchestrator) {
  return orchestrator.state().world;
}

/** Position of one entity under whichever relation currently carries it. */
export function positionOf(orchestrator: SimulationOrchestrator, entityId: string): string | null {
  const entity = orchestrator.state().world.entities[entityId];
  if (entity === undefined) return null;
  return entity.locatedAt ?? entity.heldBy ?? entity.placedOn;
}

export function actionsOf(orchestrator: SimulationOrchestrator, entityId: string) {
  return orchestrator.state().actions.filter((action) => action.entityId === entityId);
}

export function lastAction(orchestrator: SimulationOrchestrator, planId: string) {
  return orchestrator
    .state()
    .actions.filter((action) => action.plan.planId === planId)
    .at(-1);
}

export { removeDirectory };
