import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { ProcessTerminal } from "@earendil-works/pi-tui";
import { SimulationController } from "../interaction/simulation-controller.js";
import { publishDemoConfig } from "../simulation/demo.js";
import { SimulationRunner } from "../simulation/runner.js";
import { RuntimeStore } from "../storage/runtime-store.js";
import { TerminalApplication } from "./terminal-application.js";

const runtimeDirectory = join(process.cwd(), ".agentlife");
mkdirSync(runtimeDirectory, { recursive: true });

const { core, config } = await publishDemoConfig();
const runner = SimulationRunner.create(core, { timelineId: "timeline-phase3" });
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
