import { runDemoScenario } from "./demo.js";

/**
 * Phase 2 acceptance runner.
 *
 * It drives the demonstration scenario twice from scratch and proves that the
 * same content, the same plan inputs and the same number of ticks produce the
 * same final objective state, events, action results and summary digest — twice
 * over, and again after loading an explicit save. A mismatch exits non-zero.
 */

const first = await runDemoScenario();
const second = await runDemoScenario();

for (const line of first.lines) console.log(line);
console.log("");
console.log(`determinism     ${first.digest} (run 1) vs ${second.digest} (run 2)`);
console.log(`save continuity ${first.continuedDigest} (continued) vs ${first.loadedDigest} (loaded)`);

const problems: string[] = [];
if (first.digest !== second.digest) problems.push("two runs of the same scenario produced different summaries");
if (first.continuedDigest !== second.continuedDigest)
  problems.push("two runs produced different continuation summaries");
if (first.continuedDigest !== first.loadedDigest)
  problems.push("continuing the original timeline and continuing a loaded save diverged");
if (problems.length > 0) {
  for (const problem of problems) console.error(problem);
  process.exit(1);
}
console.log("same config id, same world, same actions, same trace.");
