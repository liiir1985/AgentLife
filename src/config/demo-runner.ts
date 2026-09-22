import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { ContentPackLoader } from "../content/content-pack-loader.js";
import { createSystemSpecs } from "../systems/index.js";
import { CoreRuntime, packInput, type PublishResult } from "./core-runtime.js";

/**
 * Readable evidence for the stage 1 exit condition: the demo pack builds one
 * content-addressed runtime config version, and the same config, snapshot and
 * simulated time produce the same candidates and trace.
 *
 * Two independent runs (fresh registries, fresh load) must agree on every byte of
 * the digest; a mismatch exits non-zero so the runner can be used as a check.
 */

const DEMO_PACK = fileURLToPath(new URL("../../content/demo", import.meta.url));

const TRIGGERS: readonly string[] = [
  "agentlife.body/value-changed",
  "agentlife.body/tick-elapsed",
  "agentlife.world/environment-changed",
];

/** The read-only projections the demo rules are written against. */
const SNAPSHOT: Readonly<Record<string, unknown>> = {
  "agentlife.world/environment": {
    "light-level": 40,
    "fog-density": 0.9,
    "sun-angle": 130,
    slope: 0.3,
    "lamp-state": 1,
  },
  "agentlife.body/values": { stamina: 25, integrity: 1, wakefulness: 40, load: 12 },
  "agentlife.body/channels": { "vision.available": true, "vision.efficiency": 0.8 },
};

function digestOf(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16);
}

function render(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

interface Run {
  readonly lines: readonly string[];
  readonly digest: string;
}

async function run(): Promise<Run> {
  const registry = new CoreRuntime();
  for (const system of createSystemSpecs()) {
    const registration = registry.addSystem(system);
    if (registration.status !== "registered")
      throw new Error(`System ${system.namespace} did not load: ${JSON.stringify(registration.diagnostics)}`);
  }
  const snapshot = await new ContentPackLoader().load(DEMO_PACK);
  const applied: PublishResult = registry.publish({ root: packInput(snapshot) });
  if (applied.status !== "valid" || applied.config === undefined)
    throw new Error(`Demo pack did not apply: ${JSON.stringify(applied.diagnostics, null, 2)}`);
  const config = applied.config;

  const lines: string[] = [];
  lines.push(`configId      ${config.configId}`);
  lines.push(`kernel        ${config.kernelVersion}`);
  lines.push(
    `packs         ${config.packs.map((pack) => `${pack.namespace}@${pack.version} (content ${pack.contentId.slice(0, 12)})`).join(", ")}`,
  );
  for (const system of config.systems)
    lines.push(`system        ${system.systemId}@${system.version} spec ${system.specHash.slice(0, 12)}`);
  lines.push(
    `content       ${config.items.length} items, ${config.rules.length} rules, ${config.formulas.length} formulas`,
  );
  const indexed = Object.keys(config.triggerIndex)
    .sort()
    .map((trigger) => `${trigger} -> ${(config.triggerIndex[trigger] ?? []).length}`);
  lines.push(`triggerIndex  ${indexed.join(", ")}`);

  const traces: unknown[] = [];
  for (const trigger of TRIGGERS) {
    const evaluated = registry.runRules({
      runId: `demo-${trigger}`,
      trigger,
      input: { stateVersion: "state-1", simTime: { tick: 3, seconds: 30 }, inputs: SNAPSHOT },
    });
    lines.push(`\nevaluate ${trigger}`);
    lines.push(`  status      ${evaluated.status}`);
    for (const combine of evaluated.trace.combines) {
      const ruleValues = combine.ruleValues
        .map((ruleValue) => `${ruleValue.ruleId}=${render(ruleValue.value)}`)
        .join(", ");
      lines.push(
        `  ${combine.combine.padEnd(9)} ${combine.stateRef} = ${render(combine.result)} [${ruleValues}]${combine.status === "composed" ? "" : ` (${combine.status})`}`,
      );
    }
    for (const rule of evaluated.trace.rules)
      if (rule.status !== "evaluated")
        lines.push(
          `  ${rule.status.padEnd(16)} ${rule.ruleId}${rule.message === undefined ? "" : `: ${rule.message}`}`,
        );
    traces.push(evaluated.trace);
  }
  lines.push("");
  lines.push(`trace digest  ${digestOf(traces)}`);
  return { lines, digest: digestOf({ configId: config.configId, traces }) };
}

async function main(): Promise<void> {
  const first = await run();
  const second = await run();
  for (const line of first.lines) console.log(line);
  console.log("");
  console.log(`determinism   ${first.digest} (run 1) vs ${second.digest} (run 2)`);
  if (first.digest !== second.digest) {
    console.error("Two runs produced different candidates or traces; the runtime config is not deterministic.");
    process.exit(1);
  }
  console.log("same config id, same changes, same trace.");
}

await main();
