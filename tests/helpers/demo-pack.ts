import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse, stringify } from "yaml";
import { ContentPackLoader } from "../../src/content/content-pack-loader.js";
import { CoreRuntime, packInput, type PublishResult } from "../../src/config/core-runtime.js";
import { createSystemSpecs } from "../../src/systems/index.js";
import type { SystemSpec } from "../../src/config/system-spec.js";

/**
 * Test helpers around the stage 1 demo content.
 *
 * Negative cases are produced by copying the real pack and overriding single
 * files, so every refusal is exercised against full content rather than against
 * a hand-built document that could drift from the pack format.
 */

export const DEMO_PACK = fileURLToPath(new URL("../../content/demo", import.meta.url));

/** System pins the shipped demo manifest declares, in manifest order. */
export function demoSystemPins(): readonly string[] {
  const manifest = parse(readFileSync(path.join(DEMO_PACK, "manifest.yaml"), "utf8")) as {
    readonly systems: readonly string[];
  };
  return [...manifest.systems];
}

/** Shipped system pins with one system's version replaced. */
export function withSystemVersion(pins: readonly string[], systemId: string, version: string): readonly string[] {
  return pins.map((pin) => (pin === systemId || pin.startsWith(`${systemId}@`) ? `${systemId}@${version}` : pin));
}

/**
 * The shipped demo manifest with selected parts replaced. Fixtures derive from
 * the real manifest, so adding a section to the pack never leaves a test
 * override silently describing an older pack.
 */
export function demoManifest(
  changes: {
    readonly systems?: readonly string[];
    readonly version?: string;
    readonly kernel?: string;
  } = {},
): string {
  const document = parse(readFileSync(path.join(DEMO_PACK, "manifest.yaml"), "utf8")) as Record<string, unknown>;
  if (changes.systems !== undefined) document.systems = [...changes.systems];
  if (changes.version !== undefined) document.version = changes.version;
  if (changes.kernel !== undefined) document.kernel = changes.kernel;
  return stringify(document);
}

/** Fully qualified refs of the demo vocabulary, so tests never spell them twice. */
export const REFS = {
  bodyValues: "agentlife.body/values",
  bodyChannels: "agentlife.body/channels",
  participation: "agentlife.body/cognitive-participation",
  worldEnvironment: "agentlife.world/environment",
  stamina: "agentlife.body/values.stamina",
  wakefulness: "agentlife.body/values.wakefulness",
  moveCost: "agentlife.body/values.move-cost",
  moveCostFactor: "agentlife.body/values.move-cost-factor",
  visibility: "agentlife.world/environment.visibility",
  visionEfficiency: "agentlife.body/channels.vision.efficiency",
  visionAvailable: "agentlife.body/channels.vision.available",
} as const;

/** Default world settings every fixture pack needs to satisfy the world system. */
export const FIXTURE_WORLD = `id: settings
type: agentlife.world/world
fields:
  name: 测试地
  description: 仅用于验证。
`;

export function createRegistry(extraExtensions: readonly SystemSpec[] = []): CoreRuntime {
  const registry = new CoreRuntime();
  for (const system of [...createSystemSpecs(), ...extraExtensions]) {
    const result = registry.addSystem(system);
    if (result.status !== "registered")
      throw new Error(`system ${system.namespace} failed to register: ${JSON.stringify(result.diagnostics)}`);
  }
  return registry;
}

export async function withTempDirectory<T>(run: (directory: string) => Promise<T> | T): Promise<T> {
  const directory = mkdtempSync(path.join(tmpdir(), "agent-life-config-"));
  try {
    return await run(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

export function writePack(directory: string, files: Readonly<Record<string, string>>): void {
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(directory, relative);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, content, "utf8");
  }
}

/** Copies the demo pack and applies per-file overrides; `null` deletes a file. */
export function copyDemoPack(overrides: Readonly<Record<string, string | null>> = {}): string {
  const directory = mkdtempSync(path.join(tmpdir(), "agent-life-demo-"));
  cpSync(DEMO_PACK, directory, { recursive: true });
  for (const [relative, content] of Object.entries(overrides)) {
    const target = path.join(directory, relative);
    if (content === null) {
      rmSync(target, { force: true });
      continue;
    }
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, content, "utf8");
  }
  return directory;
}

export function removeDirectory(directory: string): void {
  rmSync(directory, { recursive: true, force: true });
}

export async function loadPack(registry: CoreRuntime, directory: string): Promise<PublishResult> {
  const input = await new ContentPackLoader().load(directory);
  return registry.publish({ root: packInput(input) });
}

export async function applyDemoPack(
  registry: CoreRuntime,
  overrides: Readonly<Record<string, string | null>> = {},
): Promise<{ readonly result: PublishResult; readonly directory: string }> {
  const directory = copyDemoPack(overrides);
  try {
    return { result: await loadPack(registry, directory), directory };
  } catch (failure) {
    removeDirectory(directory);
    throw failure;
  }
}

export const DEMO_ENTITY_IDS = ["agentlife.demo/companion", "agentlife.demo/player"] as const;

/** Shared inputs and per-entity projections used by the demo rules. */
export const DEMO_SHARED: Readonly<Record<string, unknown>> = {
  [REFS.worldEnvironment]: { "light-level": 40, "fog-density": 0.9, "sun-angle": 130, slope: 0.3, "lamp-state": 1 },
  "agentlife.world/influence": {
    kind: "agentlife.demo/relocate",
    actor: "agentlife.demo/player",
    subject: "agentlife.demo/player",
    destination: "agentlife.demo/kiln",
    accepted: true,
  },
  "agentlife.world/process": { process: "", gain: 200 },
};

export const DEMO_ENTITY: Readonly<Record<string, unknown>> = {
  [REFS.bodyValues]: {
    stamina: 25,
    integrity: 1,
    wakefulness: 40,
    load: 12,
    "move-cost": 0,
    "move-cost-factor": 1,
  },
  [REFS.bodyChannels]: { "vision.available": true, "vision.efficiency": 0.8 },
  "agentlife.world/attributes": { portable: false, support: false, operable: false },
  "agentlife.world/participation": { role: "actor" },
  "agentlife.world/located-at": { location: "agentlife.demo/lantern-square" },
  "agentlife.world/held-by": { holder: "" },
  "agentlife.world/placed-on": { support: "" },
  "agentlife.body/activity": { action: "", stage: "", status: "" },
  "agentlife.body/current-mode": { mode: "agentlife.demo/awake" },
  "agentlife.body/process": { process: "", rate: 5 },
};

export function demoRequest(trigger: string, runId = "request-1") {
  return {
    runId,
    trigger,
    entityIds: [...DEMO_ENTITY_IDS],
    input: {
      stateVersion: "state-1",
      simTime: { tick: 3, seconds: 30 },
      shared: DEMO_SHARED,
      entities: Object.fromEntries(DEMO_ENTITY_IDS.map((entityId) => [entityId, DEMO_ENTITY])),
    },
  };
}

export function causeCodes(diagnostics: readonly { readonly code: string }[]): readonly string[] {
  return [...new Set(diagnostics.map((diagnostic) => diagnostic.code))].sort();
}

export function messages(diagnostics: readonly { readonly message: string }[]): string {
  return diagnostics.map((diagnostic) => diagnostic.message).join(" | ");
}
