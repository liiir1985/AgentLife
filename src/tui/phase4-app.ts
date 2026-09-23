import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { ProcessTerminal } from "@earendil-works/pi-tui";
import { PiCognitionAgent } from "../agent/cognition-agent.js";
import { idleDecision } from "../agent/scripted-cognition.js";
import { SimulationController } from "../interaction/simulation-controller.js";
import { cognitionSettings } from "../simulation/config-view.js";
import { publishDemoConfig } from "../simulation/demo.js";
import { SimulationRunner } from "../simulation/runner.js";
import { RuntimeStore } from "../storage/runtime-store.js";
import { TerminalApplication } from "./terminal-application.js";

/**
 * The phase 4 terminal: the demo pack against a real cognition provider.
 *
 * `--provider` and `--model` select who the AI characters think with; without them
 * the choice the content declared is used, so the demo starts with no arguments at
 * all. Only the scripted provider needs a policy from here - a real provider brings
 * its own reasoning, and every answer still passes the same submission validation.
 */

/** The value of one `--name value` argument, or `undefined` when it was not given. */
function argument(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index < 0 ? undefined : process.argv[index + 1];
}

const runtimeDirectory = join(process.cwd(), ".agentlife");
mkdirSync(runtimeDirectory, { recursive: true });

const { core, config } = await publishDemoConfig();
const declared = cognitionSettings(config);
const provider = argument("provider") ?? declared?.provider ?? "faux";
const model = argument("model") ?? declared?.model ?? "";
if (model === "") throw new Error("没有可用的模型：请用 --model 指定，或在内容中声明 cognition settings 的 model");

const agent = new PiCognitionAgent({
  provider,
  model,
  ...(provider === "faux" ? { draft: idleDecision, tokensPerSecond: 100_000 } : {}),
});
const runner = SimulationRunner.create(core, { timelineId: "timeline-phase4", models: agent });
const controller = new SimulationController(
  runner,
  config,
  new RuntimeStore(join(runtimeDirectory, "runtime.sqlite")),
  {
    playerId: "agentlife.demo/player",
  },
);
const app = new TerminalApplication(new ProcessTerminal(), controller, {
  mouse: process.argv.includes("--mouse"),
  onExit: () => process.exit(0),
});
app.start();
