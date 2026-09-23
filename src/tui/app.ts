import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { ProcessTerminal } from "@earendil-works/pi-tui";
import { PiCognitionAgent } from "../agent/cognition-agent.js";
import { idleDecision } from "../agent/scripted-cognition.js";
import { resolveModel } from "../config/system-config.js";
import { SessionInspector } from "../diagnostics/session-inspector.js";
import { SessionCost } from "../diagnostics/session-cost.js";
import { SessionLog } from "../diagnostics/session-trace.js";
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
const sessionDirectory = join(runtimeDirectory, "session-logs");
const sessionLog = new SessionLog(sessionDirectory);
const inspector = new SessionInspector(sessionDirectory);

const { core, config } = await publishDemoConfig();
const target = resolveModel("cognition", process.argv.includes("--use_faux") ? { mode: "faux" } : {});
const sessionCost = new SessionCost(target.cost);
const agent = new PiCognitionAgent({
  provider: target.provider,
  model: target.model,
  trace: sessionLog,
  sessionCost,
  ...(target.provider === "faux" ? { draft: idleDecision, tokensPerSecond: 100_000 } : {}),
});
const runner = SimulationRunner.create(core, { timelineId: "timeline-phase4", models: agent, trace: sessionLog });
const controller = new SimulationController(
  runner,
  config,
  new RuntimeStore(join(runtimeDirectory, "runtime.sqlite")),
  {
    playerId: "agentlife.demo/player",
    trace: sessionLog,
  },
);
const app = new TerminalApplication(new ProcessTerminal(), controller, {
  mouse: process.argv.includes("--mouse"),
  model: target.reference,
  sessionLog,
  sessionCost,
  inspector,
  onExit: () => process.exit(0),
});
app.start();
