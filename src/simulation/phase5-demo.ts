import { PiCognitionAgent } from "../agent/cognition-agent.js";
import { ScriptedEmbeddingProvider } from "../agent/embedding-provider.js";
import { ScriptedMemoryAgent } from "../agent/memory-agent.js";
import { idleDecision } from "../agent/scripted-cognition.js";
import { FAUX_MODEL_TARGET } from "../config/system-config.js";
import type { CognitionInput } from "./types.js";
import { digestOf, publishDemoConfig } from "./demo.js";
import { SimulationRunner } from "./runner.js";
import { checkSnapshot, decodeSnapshot, encodeSnapshot, snapshotOf } from "./save.js";

const COMPANION = "agentlife.demo/companion";
let rememberedText = "";
let encoded = false;

const cognition = new PiCognitionAgent({
  provider: FAUX_MODEL_TARGET.provider,
  model: FAUX_MODEL_TARGET.model,
  tokensPerSecond: 100_000,
  fauxMemoryQuery: (input) => (input.tick >= 7 ? rememberedText : null),
  draft: (input: CognitionInput): unknown => {
    if (input.tick >= 7)
      return {
        ...(idleDecision(input) as Record<string, unknown>),
        speech: "我还记得我们第一次相遇的地方。",
        idle: null,
        usedMemories: [`${COMPANION}/memory-2`],
      };
    const first = input.observations.find((entry) => entry.reference !== null);
    if (encoded || first === undefined || first.reference === null) return idleDecision(input);
    encoded = true;
    rememberedText = `我记得${first.text}`;
    return {
      ...(idleDecision(input) as Record<string, unknown>),
      consumedObservations: [first.reference],
      memoryEncoding: [{ sourceReferences: [first.reference], text: rememberedText }],
    };
  },
});

const { core, config } = await publishDemoConfig();
const runner = SimulationRunner.create(core, {
  timelineId: "phase5-demo",
  models: cognition,
  embeddings: new ScriptedEmbeddingProvider(),
  memoryAgent: new ScriptedMemoryAgent(),
});
for (let tick = 1; tick <= 6; tick += 1) {
  const result = await runner.runTickToPublication();
  if (result.status !== "completed") throw new Error(`phase 5 demonstration stopped at tick ${tick}: ${result.status}`);
}
const saved = decodeSnapshot(encodeSnapshot(snapshotOf(runner.state(), "phase5-demo", config)));
if (!saved.ok || !checkSnapshot(saved.snapshot, config).ok) throw new Error("phase 5 demonstration save did not load");
runner.load(saved.snapshot.state);
const recalled = await runner.runTickToPublication();
if (recalled.status !== "completed") throw new Error("phase 5 demonstration did not complete its recalled response");
const memory = runner.state().memory.records[COMPANION];
if (memory?.longTerm.length !== 1 || memory.longTerm[0]?.lastUsedTick !== 7)
  throw new Error("the companion did not consolidate and later use its memory");
process.stdout.write(
  JSON.stringify(
    {
      tick: runner.state().tick,
      recent: memory.recent.length,
      longTerm: memory.longTerm.length,
      recalledAt: memory.longTerm[0].lastUsedTick,
      digest: digestOf(runner.state()),
    },
    null,
    2,
  ) + "\n",
);
