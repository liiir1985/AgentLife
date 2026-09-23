import { setImmediate as nextTurn } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SimulationController, type TimerPort } from "../src/interaction/simulation-controller.js";
import { RuntimeStore } from "../src/storage/runtime-store.js";
import { TerminalApplication } from "../src/tui/terminal-application.js";
import { VirtualTerminal } from "../src/tui/virtual-terminal.js";
import { DEMO_PLAYER } from "./helpers/phase2.js";
import { gatedModel, phase4Simulation, type Phase4Simulation } from "./helpers/phase4.js";

/**
 * The phase 4 terminal: the ordinary view and the log carry the player's own
 * authorized perception, the header reports what the barrier waits for, and the
 * management snapshot stays in the monitor panel.
 *
 * Every case drives the real controller and the real demo pack; the cognition model
 * is scripted, so a barrier is held open exactly as long as a case needs it.
 */

/** Longer than any case runs: the run loop is driven by the cases themselves. */
const idleTimer: TimerPort = { schedule: () => "timer", cancel: () => undefined };
const F2 = "\x1bOQ";
const RIGHT = "\x1b[C";

interface Harness {
  readonly terminal: VirtualTerminal;
  readonly controller: SimulationController;
  readonly app: TerminalApplication;
}

function startTui(simulation: Phase4Simulation, rows = 30): Harness {
  const controller = new SimulationController(simulation.runner, simulation.config, new RuntimeStore(":memory:"), {
    playerId: DEMO_PLAYER,
    timer: idleTimer,
  });
  const terminal = new VirtualTerminal(120, rows);
  const app = new TerminalApplication(terminal, controller);
  app.start();
  return { terminal, controller, app };
}

/** Yields a few turns: a turn settles the barrier's promises, the next draws its frame. */
async function rendered(turns = 2): Promise<void> {
  for (let turn = 0; turn < turns; turn += 1) await nextTurn();
}

/** Yields until the controller published the tick its barrier was holding, then draws it. */
async function published(controller: SimulationController, tick: number): Promise<void> {
  for (let turn = 0; turn < 200; turn += 1) {
    const state = controller.runner.state();
    if (state.phase === "publish" && state.tick === tick) break;
    if (turn === 199) throw new Error(`tick ${tick} was never published`);
    await nextTurn();
  }
  await rendered();
}

describe("phase 4 terminal application", () => {
  afterEach(() => vi.useRealTimers());

  it("renders the contextual action bar and completes the entity parameter wizard", async () => {
    vi.useFakeTimers();
    const { terminal, controller, app } = startTui(await phase4Simulation({ script: { tokensPerSecond: 0 } }));
    const screen = (): string => terminal.screen().join("\n");

    // Nothing is perceived before the first tick, and the empty view says so.
    expect(screen()).toContain("还没有观察到任何事情");
    expect(screen()).toContain("地点：未知");
    controller.step();
    await published(controller, 1);

    expect(screen()).toContain("[移动]");
    terminal.sendInput(" ");
    expect(controller.status().mode).toBe("running");

    terminal.sendInput("\r");
    expect(controller.status().mode).toBe("paused");
    expect(screen()).toContain("选择要前往的地点");
    expect(screen()).toContain("老果园");

    terminal.sendInput("\r");
    expect(controller.status().mode).toBe("running");
    vi.advanceTimersByTime(1_500);
    expect(screen()).toContain("移动已排入下一 Tick");

    terminal.sendInput(" ");
    expect(controller.status().mode).toBe("paused");
    expect(screen()).toContain("已暂停");
    vi.advanceTimersByTime(501);
    expect(screen()).toContain("已暂停");
    vi.advanceTimersByTime(1_500);
    expect(screen()).not.toContain("已暂停");
    expect(screen()).not.toContain("移动已排入下一 Tick");

    app.stop();
  });

  it("completes a text parameter command and lets Esc cancel the form alone", async () => {
    const { terminal, controller, app } = startTui(await phase4Simulation({ script: { tokensPerSecond: 0 } }));
    const screen = (): string => terminal.screen().join("\n");

    controller.step();
    await published(controller, 1);
    for (let step = 0; step < 8; step += 1) {
      if (screen().includes("[说话]")) break;
      terminal.sendInput(RIGHT);
      await rendered();
    }
    expect(screen()).toContain("[说话]");

    terminal.sendInput("\r");
    expect(screen()).toContain("输入要说的话");
    terminal.sendInput("\x1b");
    expect(screen()).not.toContain("输入要说的话");
    expect(controller.status().pendingPlans).toBe(0);

    terminal.sendInput("\r");
    expect(screen()).toContain("输入要说的话");
    terminal.sendInput("你好");
    terminal.sendInput("\r");
    expect(screen()).toContain("说话已排入下一 Tick");
    expect(controller.status().pendingPlans).toBe(1);

    app.stop();
  });

  it("reports the barrier wait and never lets space bypass it", async () => {
    const gate = gatedModel();
    const { terminal, controller, app } = startTui(await phase4Simulation({ models: gate.port }));
    const screen = (): string => terminal.screen().join("\n");

    controller.step();
    await rendered();
    expect(controller.status().mode).toBe("cognition");
    expect(gate.waiting()).toBe(true);
    const held = controller.status().tick;
    expect(screen()).toContain("等待 AI");

    terminal.sendInput(" ");
    expect(screen()).toContain("认知屏障未解除");
    expect(controller.status().mode).toBe("cognition");
    expect(controller.status().tick).toBe(held);

    // The player may still decide inside the round; Esc leaves the form only.
    terminal.sendInput("\r");
    expect(screen()).toContain("选择要前往的地点");
    terminal.sendInput("\x1b");
    expect(screen()).not.toContain("选择要前往的地点");

    terminal.sendInput("/");
    terminal.sendInput("skip");
    terminal.sendInput("\r");
    expect(screen()).toContain("本轮");
    expect(controller.status().mode).toBe("cognition");
    expect(controller.status().tick).toBe(held);

    app.stop();
  });

  it("keeps the ordinary log to the player's own observations and moves the rest to the monitor", async () => {
    const { terminal, controller, app } = startTui(await phase4Simulation({ script: { tokensPerSecond: 0 } }), 40);
    const screen = (): string => terminal.screen().join("\n");

    controller.step();
    await published(controller, 1);
    expect(controller.status().mode).toBe("ready");
    const firstTick = controller.perceptionLog().map((observation) => ({
      observationId: observation.observationId,
      prefix: observation.text.slice(0, 12),
    }));
    expect(firstTick.length).toBeGreaterThan(0);
    controller.step();
    await published(controller, 2);
    controller.step();
    await published(controller, 3);

    // The pending list repeats every observation each tick; the log writes each one once.
    for (const observation of firstTick) {
      expect(controller.perceptionLog().some((entry) => entry.observationId === observation.observationId)).toBe(true);
      expect(terminal.screen().filter((line) => line.startsWith(observation.prefix)).length).toBe(1);
    }

    // Nothing the ordinary screen must not carry: no entity identity, no management text.
    expect(screen()).not.toContain("agentlife.demo/");
    expect(screen()).not.toContain("管理员");
    expect(screen()).not.toContain("Diagnostics");

    terminal.sendInput(F2);
    const monitor = screen();
    expect(monitor).toContain("管理员视图");
    expect(monitor).toContain("agentlife.demo/");
    expect(monitor).toContain("Perception");
    expect(monitor).toContain("Cognition");
    expect(monitor).toContain("Working Memory");
    expect(monitor).toContain("Diagnostics");

    terminal.sendInput(F2);
    expect(screen()).not.toContain("管理员视图");

    app.stop();
  });

  it("reports a cognition failure without leaking the model's own words into the ordinary view", async () => {
    const { terminal, controller, app } = startTui(
      await phase4Simulation({ script: { tokensPerSecond: 0, draft: () => null } }),
    );
    const screen = (): string => terminal.screen().join("\n");

    controller.step();
    for (let turn = 0; turn < 200 && controller.status().mode !== "failed"; turn += 1) await nextTurn();
    await rendered();

    expect(controller.status().mode).toBe("failed");
    expect(screen()).toContain("认知失败");
    const failure = controller.managementSnapshot().state.failure?.detail ?? "";
    expect(failure.length).toBeGreaterThan(0);
    expect(screen()).not.toContain(failure.slice(0, 30));
    expect(screen()).not.toContain("agentlife.demo/");

    terminal.sendInput(F2);
    expect(screen()).toContain(failure.slice(0, 30));

    app.stop();
  });
});
