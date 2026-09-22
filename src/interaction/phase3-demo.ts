import { digestOf, publishDemoConfig } from "../simulation/demo.js";
import { SimulationRunner } from "../simulation/runner.js";
import { RuntimeStore } from "../storage/runtime-store.js";
import { SimulationController } from "./simulation-controller.js";

const PLAYER = "agentlife.demo/player";

async function run(): Promise<void> {
  const { core, config } = await publishDemoConfig();
  const controller = new SimulationController(
    SimulationRunner.create(core, { timelineId: "timeline-phase3-demo" }),
    config,
    new RuntimeStore(":memory:"),
    { playerId: PLAYER },
  );
  const lines: string[] = [];
  const queue = (ref: string, entityIds: readonly string[] = [], text?: string): void => {
    const session = controller.beginAction(ref);
    if (session === undefined) throw new Error(`action unavailable: ${ref}`);
    for (const entityId of entityIds) {
      const result = session.acceptEntity(entityId);
      if (result.error !== undefined) throw new Error(result.error);
    }
    if (text !== undefined) {
      const result = session.acceptText(text);
      if (result.error !== undefined) throw new Error(result.error);
    }
    const result = controller.queueAction(session);
    if (!result.ok) throw new Error(result.message);
    lines.push(result.message);
  };
  const ticks = (count: number): void => {
    for (let index = 0; index < count; index += 1) controller.step();
  };

  queue("agentlife.demo/command-take", ["agentlife.demo/rope"]);
  ticks(4);
  queue("agentlife.demo/command-put", ["agentlife.demo/rope", "agentlife.demo/bench"]);
  ticks(5);
  queue("agentlife.demo/command-use", ["agentlife.demo/lamp"]);
  ticks(4);
  controller.save("phase3-demo");
  const savedDigest = digestOf(controller.runner.state());
  queue("agentlife.demo/command-move", ["agentlife.demo/kiln"]);
  ticks(4);
  const continuedDigest = digestOf(controller.runner.state());
  const loaded = controller.load("phase3-demo");
  if (!loaded.ok) throw new Error(loaded.message);
  queue("agentlife.demo/command-move", ["agentlife.demo/kiln"]);
  ticks(4);
  const loadedDigest = digestOf(controller.runner.state());
  lines.push(`saved ${savedDigest}`);
  lines.push(`continued ${continuedDigest}`);
  lines.push(`loaded+continued ${loadedDigest}`);
  if (continuedDigest !== loadedDigest) throw new Error("loaded timeline diverged from continued timeline");
  process.stdout.write(`${lines.join("\n")}\n`);
  controller.close();
}

await run();
