import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { ContentPackLoader } from "../content/content-pack-loader.js";
import { createDomainExtensions } from "../domains/index.js";
import { ConfigurationRegistry, contentPackInput, type ApplyResult } from "./registry.js";

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
  const registry = new ConfigurationRegistry();
  for (const extension of createDomainExtensions()) {
    const registration = registry.registerExtension(extension);
    if (registration.status !== "registered")
      throw new Error(`Extension ${extension.namespace} did not register: ${JSON.stringify(registration.diagnostics)}`);
  }
  const snapshot = await new ContentPackLoader().load(DEMO_PACK);
  const applied: ApplyResult = registry.apply({ root: contentPackInput(snapshot) });
  if (applied.status !== "valid" || applied.config === undefined)
    throw new Error(`Demo pack did not apply: ${JSON.stringify(applied.diagnostics, null, 2)}`);
  const config = applied.config;

  const lines: string[] = [];
  lines.push(`configId      ${config.identity}`);
  lines.push(`kernel        ${config.kernelVersion}`);
  lines.push(
    `packs         ${config.packs.map((pack) => `${pack.namespace}@${pack.version} (content ${pack.contentIdentity.slice(0, 12)})`).join(", ")}`,
  );
  for (const extension of config.extensions)
    lines.push(`extension     ${extension.ref}@${extension.version} fingerprint ${extension.fingerprint.slice(0, 12)}`);
  lines.push(
    `content       ${config.definitions.length} definitions, ${config.rules.length} rules, ${config.derivations.length} derivations`,
  );
  const indexed = Object.keys(config.triggerIndex)
    .sort()
    .map((trigger) => `${trigger} -> ${(config.triggerIndex[trigger] ?? []).length}`);
  lines.push(`triggerIndex  ${indexed.join(", ")}`);

  const traces: unknown[] = [];
  for (const trigger of TRIGGERS) {
    const evaluated = registry.evaluate({
      requestId: `demo-${trigger}`,
      trigger,
      snapshot: { stateVersion: "state-1", simulationTime: { tick: 3, seconds: 30 }, views: SNAPSHOT },
    });
    lines.push(`\nevaluate ${trigger}`);
    lines.push(`  status      ${evaluated.status}`);
    for (const composition of evaluated.trace.compositions) {
      const contributions = composition.contributions
        .map((contribution) => `${contribution.rule}=${render(contribution.value)}`)
        .join(", ");
      lines.push(
        `  ${composition.composition.padEnd(9)} ${composition.target} = ${render(composition.result)} [${contributions}]${composition.status === "composed" ? "" : ` (${composition.status})`}`,
      );
    }
    for (const rule of evaluated.trace.rules)
      if (rule.outcome !== "evaluated")
        lines.push(`  ${rule.outcome.padEnd(16)} ${rule.rule}${rule.message === undefined ? "" : `: ${rule.message}`}`);
    traces.push(evaluated.trace);
  }
  lines.push("");
  lines.push(`trace digest  ${digestOf(traces)}`);
  return { lines, digest: digestOf({ identity: config.identity, traces }) };
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
  console.log("same identity, same candidates, same trace.");
}

await main();
