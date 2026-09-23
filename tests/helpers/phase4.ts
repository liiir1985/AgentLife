import type { RuntimeConfig } from "../../src/config/config-builder.js";
import { CoreRuntime, packInput, type PublishResult } from "../../src/config/core-runtime.js";
import { ContentPackLoader } from "../../src/content/content-pack-loader.js";
import type { CognitionModelPort } from "../../src/agent/cognition-agent.js";
import { SimulationRunner, type TickResult } from "../../src/simulation/runner.js";
import { createSystemSpecs } from "../../src/systems/index.js";
import type {
  ActionPlan,
  CognitionInput,
  CognitionModelResult,
  CognitiveDecision,
  SimulationState,
} from "../../src/simulation/types.js";
import type { SimpleValue } from "../../src/config/value-expr.js";
import { scriptedModel, type CognitionScript } from "./cognition.js";
import { DEMO_PACK, copyDemoPack, removeDirectory } from "./demo-pack.js";

/**
 * Phase 4 test helpers.
 *
 * A phase 4 simulation always runs a scripted model: the AI participants decide
 * through the same Pi adapter the runtime uses, and the content is the real demo
 * pack — untouched, or copied with single files replaced.
 */

export interface Phase4Simulation {
  readonly core: CoreRuntime;
  readonly config: RuntimeConfig;
  readonly runner: SimulationRunner;
  /** Temporary pack directory when the run needed overrides; clean it up with `dispose`. */
  readonly directory: string | null;
}

export interface Phase4Options {
  readonly overrides?: Readonly<Record<string, string | null>>;
  readonly script?: CognitionScript;
  readonly timelineId?: string;
  /** A model the test drives itself; the scripted faux model is used when omitted. */
  readonly models?: CognitionModelPort;
}

/** Releases the temporary pack of a run that needed overrides. */
export function dispose(simulation: Phase4Simulation): void {
  if (simulation.directory !== null) removeDirectory(simulation.directory);
}

export async function phase4Simulation(options: Phase4Options = {}): Promise<Phase4Simulation> {
  const overrides = options.overrides ?? {};
  const directory = Object.keys(overrides).length === 0 ? null : copyDemoPack(overrides);
  const core = new CoreRuntime();
  for (const system of createSystemSpecs()) {
    const registration = core.addSystem(system);
    if (registration.status !== "registered")
      throw new Error(`system ${system.namespace} did not load: ${JSON.stringify(registration.diagnostics)}`);
  }
  const snapshot = await new ContentPackLoader().load(directory ?? DEMO_PACK);
  const result: PublishResult = core.publish({ root: packInput(snapshot) });
  if (result.status !== "valid" || result.config === undefined)
    throw new Error(`demo pack did not publish: ${JSON.stringify(result.diagnostics, null, 2)}`);
  return {
    core,
    config: result.config,
    directory,
    runner: SimulationRunner.create(core, {
      timelineId: options.timelineId ?? "timeline-phase4",
      models: options.models ?? scriptedModel(options.script ?? {}),
    }),
  };
}

export interface GatedModel {
  readonly port: CognitionModelPort;
  /** Answers the request that is currently waiting, exactly as a scripted model would. */
  release: () => void;
  readonly waiting: () => boolean;
}

/**
 * A model whose answers the test decides.
 *
 * Holding a request open is the only way to look at a tick while its barrier is
 * still standing: the runtime may not advance until the participant answered.
 */
export function gatedModel(): GatedModel {
  let pending: { readonly input: CognitionInput; readonly resolve: (result: CognitionModelResult) => void } | null =
    null;
  return {
    port: {
      request: (input) =>
        new Promise<CognitionModelResult>((resolve) => {
          pending = { input, resolve };
        }),
      cancel: () => {
        pending = null;
      },
    },
    release: () => {
      const held = pending;
      if (held === null) return;
      pending = null;
      held.resolve({ status: "decided", detail: "released by the test", decision: waitingDecision(held.input) });
    },
    waiting: () => pending !== null,
  };
}

/** A decision that acts on nothing and waits for something it can hear. */
function waitingDecision(input: CognitionInput): CognitiveDecision {
  return {
    characterId: input.characterId,
    requestId: input.requestId,
    attention: [],
    understanding: "还没有需要立刻处理的事",
    questions: [],
    persistence: "",
    intentionChanges: [],
    speech: null,
    steps: [],
    idle: {
      kind: "external-event",
      detail: "等一件能听见的事",
      event: "utterance",
      reviewTick: input.tick + 1,
      untilTick: input.tick + input.idleWaitLimitTicks,
    },
    consumedObservations: [],
    consideredIntentions: [],
  };
}

/** One plan exactly as the interaction layer submits it. */
export function commandPlan(
  planId: string,
  entityId: string,
  action: string,
  values: {
    readonly target?: string;
    readonly destination?: string;
    readonly inputs?: Readonly<Record<string, string>>;
  } = {},
  conflict: "parallel" | "queue" | "replace" = "queue",
): ActionPlan {
  return Object.freeze({
    planId,
    entityId,
    source: "player-command" as const,
    formedVersion: "",
    conflict,
    steps: Object.freeze([
      Object.freeze({
        action,
        ...(values.target === undefined ? {} : { target: values.target }),
        ...(values.destination === undefined ? {} : { destination: values.destination }),
        ...(values.inputs === undefined ? {} : { inputs: Object.freeze({ ...values.inputs }) }),
      }),
    ]),
  });
}

/** Runs ticks until the state satisfies the condition, or fails after `limit` ticks. */
export async function runUntil(
  runner: SimulationRunner,
  holds: (state: SimulationState) => boolean,
  limit = 8,
): Promise<TickResult> {
  let result = await runner.runTickToPublication();
  for (let tick = 0; tick < limit && !holds(runner.state()); tick += 1) result = await runner.runTickToPublication();
  if (!holds(runner.state())) throw new Error(`the simulation did not reach the expected state within ${limit} ticks`);
  return result;
}

/**
 * The demo light fact at another starting value.
 *
 * The unit and the numeric policy are part of the demo content and are declared by
 * the rules that map this fact, so an override has to keep them.
 */
export function lightFact(initial: number): string {
  return `id: light-level
type: agentlife.world/fact
public: true
fields:
  name: 环境光照
  type: number
  initial: ${String(initial)}
  unit: lux
  policy:
    rounding:
      mode: half-away-from-zero
      precision: 1
    range:
      min: 0
      max: 1000
      boundary: inclusive
    overflow: saturate
`;
}

/** The demo companion, optionally starting somewhere else or carrying another name. */
export function companionCharacter(
  homeLocation: string,
  name = "阿禾",
  identity = "texts/companion-identity.md",
): string {
  return `id: companion
type: agentlife.character/character
public: true
templates:
  - agentlife.demo/normal-entity
fields:
  name: ${name}
  identity: ${identity}
  main: true
  homeLocation: ${homeLocation}
`;
}

/** The demo cognition settings with different bounds. */
export function cognitionSettings(fields: Readonly<Record<string, SimpleValue>>): string {
  const base: Record<string, SimpleValue> = {
    name: "演示认知设置",
    description: "阶段 4 的认知边界。",
    observationCapacity: 6,
    intentionReservation: 2,
    attentionCapacity: 3,
    maxPlanSteps: 3,
    maxAttempts: 2,
    requestTimeoutSeconds: 60,
    idleReviewTicks: 3,
    idleWaitLimitTicks: 12,
  };
  const merged = { ...base, ...fields };
  const lines = Object.entries(merged).map(([key, value]) => `${key}: ${String(value)}`);
  return `id: cognition-settings
type: agentlife.cognition/settings
public: true
fields:
  ${lines.join("\n  ")}
  allowedActions:
    - agentlife.demo/walk
    - agentlife.demo/grasp
    - agentlife.demo/lay-down
    - agentlife.demo/use
    - agentlife.demo/wave
    - agentlife.demo/say
`;
}
