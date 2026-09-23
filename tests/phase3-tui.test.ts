import { setImmediate as nextTurn } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SimulationController, type TimerPort } from "../src/interaction/simulation-controller.js";
import { walkingDecision } from "../src/agent/scripted-cognition.js";
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

  it("starts a run asked for while a decision is still being made, once it lands", async () => {
    const gate = gatedModel();
    const { terminal, controller, app } = startTui(await phase4Simulation({ models: gate.port }));
    const screen = (): string => terminal.screen().join("\n");

    controller.step();
    await rendered();
    expect(controller.status().mode).toBe("cognition");
    expect(gate.waiting()).toBe(true);
    const held = controller.status().tick;
    expect(screen()).toContain("等待 AI");

    // Space is the player's clock, not the round's: it is remembered, never refused,
    // and the world does not move while the decision is still open.
    terminal.sendInput(" ");
    expect(controller.status().running).toBe(true);
    expect(controller.status().tick).toBe(held);
    expect(screen()).not.toContain("屏障");

    gate.release();
    await published(controller, held);
    // The remembered request was applied by the tick that closed the round.
    expect(controller.status().mode).toBe("running");
    expect(controller.status().tick).toBe(held);

    app.stop();
  });

  it("applies a pause asked for during a decision when the tick lands", async () => {
    const gate = gatedModel();
    const { terminal, controller, app } = startTui(await phase4Simulation({ models: gate.port }));
    const screen = (): string => terminal.screen().join("\n");

    controller.run();
    controller.step();
    await rendered();
    const held = controller.status().tick;
    expect(controller.status().mode).toBe("cognition");
    expect(controller.status().running).toBe(true);

    terminal.sendInput(" ");
    expect(controller.status().running).toBe(false);
    expect(screen()).toContain("已暂停");
    expect(screen()).not.toContain("屏障");

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

    gate.release();
    await published(controller, held);
    expect(controller.status().mode).toBe("ready");
    expect(controller.status().tick).toBe(held);

    app.stop();
  });

  it("keeps a run going while the player chooses an action for a decision still being made", async () => {
    const gate = gatedModel();
    const { terminal, controller, app } = startTui(await phase4Simulation({ models: gate.port }));
    const screen = (): string => terminal.screen().join("\n");

    controller.run();
    controller.step();
    await rendered();
    expect(controller.status().mode).toBe("cognition");
    const held = controller.status().tick;

    // Choosing an action inside the round must not consume the request to run: the
    // parameter wizard pauses the clock, and filling it in hands the request back.
    terminal.sendInput("\r");
    expect(screen()).toContain("选择要前往的地点");
    // Opening the wizard stands the requested run down, and filling it in hands the
    // request back.
    expect(controller.status().running).toBe(false);
    terminal.sendInput("\r");
    expect(controller.status().running).toBe(true);

    gate.release();
    await published(controller, held);
    expect(controller.status().mode).toBe("running");

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

  it("keeps the place and its exits usable after a decision fails", async () => {
    const { terminal, controller, app } = startTui(
      await phase4Simulation({
        script: { tokensPerSecond: 0, draft: (input) => (input.tick >= 3 ? null : walkingDecision(input)) },
      }),
    );
    const screen = (): string => terminal.screen().join("\n");

    for (let tick = 0; tick < 6 && controller.status().mode !== "failed"; tick += 1) {
      controller.step();
      for (let turn = 0; turn < 200; turn += 1) {
        await nextTurn();
        if (controller.status().mode === "failed") break;
        if (controller.runner.state().phase === "publish") break;
      }
      await rendered();
    }
    expect(controller.status().mode).toBe("failed");

    // A failed tick is not published: the world stays where the barrier found it, so
    // what the player may act on is still the last consistent state.
    expect(screen()).toContain("[移动]");
    terminal.sendInput("\r");
    expect(screen()).toContain("选择要前往的地点");
    terminal.sendInput("\r");
    expect(screen()).toContain("已排入下一 Tick");

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
    // The player is told what to do about it, in their own terms, and the ordinary view
    // never carries the words of the barrier machinery.
    expect(screen()).toContain("按空格再试一次");
    expect(screen()).not.toContain("屏障");
    const failure = controller.managementSnapshot().state.failure?.detail ?? "";
    expect(failure.length).toBeGreaterThan(0);
    expect(screen()).not.toContain(failure.slice(0, 30));
    expect(screen()).not.toContain("agentlife.demo/");

    terminal.sendInput(F2);
    expect(screen()).toContain(failure.slice(0, 30));

    app.stop();
  });
});
