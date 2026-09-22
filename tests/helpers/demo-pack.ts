import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
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

/** The read-only inputs the demo rules are written against. */
export const DEMO_VIEWS: Readonly<Record<string, unknown>> = {
  [REFS.worldEnvironment]: { "light-level": 40, "fog-density": 0.9, "sun-angle": 130, slope: 0.3, "lamp-state": 1 },
  [REFS.bodyValues]: { stamina: 25, integrity: 1, wakefulness: 40, load: 12 },
  [REFS.bodyChannels]: { "vision.available": true, "vision.efficiency": 0.8 },
};

export function demoRequest(trigger: string, runId = "request-1") {
  return {
    runId,
    trigger,
    input: { stateVersion: "state-1", simTime: { tick: 3, seconds: 30 }, inputs: DEMO_VIEWS },
  };
}

export function causeCodes(diagnostics: readonly { readonly code: string }[]): readonly string[] {
  return [...new Set(diagnostics.map((diagnostic) => diagnostic.code))].sort();
}

export function messages(diagnostics: readonly { readonly message: string }[]): string {
  return diagnostics.map((diagnostic) => diagnostic.message).join(" | ");
}
