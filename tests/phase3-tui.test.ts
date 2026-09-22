import { afterEach, describe, expect, it, vi } from "vitest";
import { SimulationController, type TimerPort } from "../src/interaction/simulation-controller.js";
import { RuntimeStore } from "../src/storage/runtime-store.js";
import { TerminalApplication } from "../src/tui/terminal-application.js";
import { VirtualTerminal } from "../src/tui/virtual-terminal.js";
import { createSimulation, DEMO_PLAYER } from "./helpers/phase2.js";

const idleTimer: TimerPort = {
  schedule: () => "timer",
  cancel: () => undefined,
};

describe("phase 3 terminal application", () => {
  afterEach(() => vi.useRealTimers());

  it("renders contextual actions and resumes after the temporary parameter pause", async () => {
    vi.useFakeTimers();
    const simulation = await createSimulation();
    const controller = new SimulationController(simulation.runner, simulation.config, new RuntimeStore(":memory:"), {
      playerId: DEMO_PLAYER,
      timer: idleTimer,
    });
    const terminal = new VirtualTerminal(120, 30);
    const app = new TerminalApplication(terminal, controller);
    app.start();
    expect(terminal.screen().join("\n")).toContain("[移动]");
    terminal.sendInput(" ");
    expect(controller.status().mode).toBe("running");
    terminal.sendInput("\r");
    expect(controller.status().mode).toBe("paused");
    expect(terminal.screen().join("\n")).toContain("选择要前往的地点");
    terminal.sendInput("\r");
    expect(controller.status().mode).toBe("running");
    vi.advanceTimersByTime(1_500);
    expect(terminal.screen().join("\n")).toContain("已排入下一 Tick");
    terminal.sendInput(" ");
    expect(controller.status().mode).toBe("paused");
    expect(terminal.screen().join("\n")).toContain("已暂停");
    vi.advanceTimersByTime(501);
    expect(terminal.screen().join("\n")).toContain("已暂停");
    vi.advanceTimersByTime(1_500);
    const screen = terminal.screen().join("\n");
    expect(screen).not.toContain("已排入下一 Tick");
    expect(screen).not.toContain("已暂停");
    app.stop();
  });
});
