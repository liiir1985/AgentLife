import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { ProcessTerminal } from "@earendil-works/pi-tui";
import { PiCognitionAgent } from "../agent/cognition-agent.js";
import { idleDecision } from "../agent/scripted-cognition.js";
import { resolveModel } from "../config/system-config.js";
import { SimulationController } from "../interaction/simulation-controller.js";
import { publishDemoConfig } from "../simulation/demo.js";
import { SimulationRunner } from "../simulation/runner.js";
import { RuntimeStore } from "../storage/runtime-store.js";
import { TerminalApplication } from "./terminal-application.js";

/**
 * The terminal, and the only way in.
 *
 * The model the AI characters think with comes from `config/agentlife.yaml`;
 * `--use_faux` switches to the scripted provider, which needs neither
 * credentials nor that file. `--mouse` hands the mouse to the application
 * instead of leaving it to the terminal.
 */

const runtimeDirectory = join(process.cwd(), ".agentlife");
mkdirSync(runtimeDirectory, { recursive: true });

const { core, config } = await publishDemoConfig();
const target = resolveModel("cognition", process.argv.includes("--use_faux") ? { mode: "faux" } : {});
const agent = new PiCognitionAgent({
  provider: target.provider,
  model: target.model,
  ...(target.provider === "faux" ? { draft: idleDecision, tokensPerSecond: 100_000 } : {}),
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
  model: target.reference,
  onExit: () => process.exit(0),
});
app.start();
