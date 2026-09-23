import { describe, expect, it } from "vitest";
import { SimulationController, type TimerPort } from "../src/interaction/simulation-controller.js";
import { RuntimeStore } from "../src/storage/runtime-store.js";
import { createSimulation, DEMO_BENCH, DEMO_PLAYER, DEMO_ROPE } from "./helpers/phase2.js";
import { applyDemoPack, causeCodes, createRegistry, removeDirectory } from "./helpers/demo-pack.js";

class ManualTimer implements TimerPort {
  callbacks: (() => void)[] = [];
  schedule(callback: () => void): unknown {
    this.callbacks.push(callback);
    return callback;
  }
  cancel(handle: unknown): void {
    this.callbacks = this.callbacks.filter((callback) => callback !== handle);
  }
  next(): void {
    this.callbacks.shift()?.();
  }
}

async function controller(timer?: TimerPort): Promise<SimulationController> {
  const simulation = await createSimulation();
  return new SimulationController(simulation.runner, simulation.config, new RuntimeStore(":memory:"), {
    playerId: DEMO_PLAYER,
    ...(timer === undefined ? {} : { timer }),
  });
}

/**
 * Waits until the tick the controller started is published, its barrier resolved.
 *
 * The scripted cognition model of the harness answers on the microtask queue, so a
 * hop is enough for the controller's own barrier resolution to progress; nothing
 * here waits on wall-clock time.
 */
async function published(app: SimulationController, tick: number): Promise<void> {
  for (let hop = 0; hop < 2000; hop += 1) {
    const state = app.runner.state();
    if (state.tick === tick && state.phase === "publish" && app.runner.openRound() === null) return;
    await Promise.resolve();
  }
  throw new Error(`tick ${tick} was not published`);
}

/**
 * Runs one tick through the controller and waits for it.
 *
 * The demo companion is an AI participant, so a tick stops on the cognition
 * barrier; the controller resolves it on its own and only then publishes.
 */
async function step(app: SimulationController): Promise<void> {
  const next = app.runner.state().tick + 1;
  app.step();
  await published(app, next);
}

describe("phase 3 contextual interaction", () => {
  it("rejects duplicate content command words before publishing", async () => {
    const { result, directory } = await applyDemoPack(createRegistry(), {
      "commands/take.yaml": `id: command-take
type: agentlife.interaction/action-command
public: true
fields:
  name: 拿取
  description: 冲突命令测试。
  order: 20
  aliases: [move]
  action: agentlife.demo/grasp
  conflict: queue
  arguments: []
`,
    });
    try {
      expect(result.status).toBe("rejected");
      expect(causeCodes(result.diagnostics)).toContain("system-rejected");
    } finally {
      removeDirectory(directory);
    }
  });

  it("shows only actions with current candidates without changing simulation state", async () => {
    const app = await controller();
    // The candidates come from the player's authorized observations, so the player
    // has to have perceived the place once before anything is offered.
    await step(app);
    const before = JSON.stringify(app.runner.state());
    expect(app.availableActions().map((entry) => entry.command.name)).toEqual(["移动", "拿取", "操作", "挥手", "说话"]);
    expect(JSON.stringify(app.runner.state())).toBe(before);

    const take = app.beginAction("agentlife.demo/command-take");
    const rope = take?.choices()[0];
    if (take === undefined || rope === undefined) throw new Error("the rope was not offered");
    expect(take.choices().map((choice) => choice.anchor)).toEqual([DEMO_ROPE]);
    expect(take.acceptEntity(rope.reference).done).toBe(true);
    expect(app.queueAction(take).ok).toBe(true);
    // Queueing is not a tick: the plan waits for the next one.
    expect(app.runner.state().tick).toBe(1);
    for (let index = 0; index < 4; index += 1) await step(app);
    // The take completed, and the log shows it as the player's own result.
    expect(app.perceptionLog().map((observation) => observation.text)).toContain("你完成了「拿取」");
    expect(app.availableActions().map((entry) => entry.command.name)).toContain("放置");
    // The carried rope remains visible, but is no longer a candidate for taking.
    expect(app.availableActions().map((entry) => entry.command.name)).not.toContain("拿取");
    const put = app.beginAction("agentlife.demo/command-put");
    const heldRope = put?.choices()[0];
    if (put === undefined || heldRope === undefined) throw new Error("the carried rope was not offered");
    expect(put.choices().map((choice) => choice.anchor)).toEqual([DEMO_ROPE]);
    expect(put.acceptEntity(heldRope.reference).done).toBe(false);
    expect(put.choices().map((choice) => choice.anchor)).toEqual([DEMO_BENCH]);
    app.close();
  });

  it("keeps text as opaque action input and only accepts it on the next tick", async () => {
    const app = await controller();
    const say = app.beginAction("agentlife.demo/command-say");
    expect(say?.acceptText("你好，阿禾").done).toBe(true);
    expect(say === undefined ? undefined : app.queueAction(say).ok).toBe(true);
    expect(app.runner.state().actions).toHaveLength(0);
    await step(app);
    expect(app.runner.state().actions.find((action) => action.entityId === DEMO_PLAYER)?.plan.steps[0]?.inputs).toEqual(
      {
        utterance: "你好，阿禾",
      },
    );
    app.close();
  });

  it("uses one timer for continuous running and space-style toggling pauses it", async () => {
    const timer = new ManualTimer();
    const app = await controller(timer);
    app.toggleRunning();
    expect(app.status().mode).toBe("running");
    expect(timer.callbacks).toHaveLength(1);
    timer.next();
    expect(app.runner.state().tick).toBe(1);
    // The running tick stopped for the demo AI; once it is published the one timer
    // of the continuous run is rescheduled.
    await published(app, 1);
    expect(timer.callbacks).toHaveLength(1);
    app.toggleRunning();
    expect(app.status().mode).toBe("paused");
    expect(timer.callbacks).toHaveLength(0);
    app.close();
  });
});
