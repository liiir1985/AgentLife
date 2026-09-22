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
    const before = JSON.stringify(app.runner.state());
    expect(app.availableActions().map((entry) => entry.command.name)).toEqual(["移动", "拿取", "操作", "挥手", "说话"]);
    expect(JSON.stringify(app.runner.state())).toBe(before);

    const take = app.beginAction("agentlife.demo/command-take");
    expect(take?.choices().map((choice) => choice.entityId)).toEqual([DEMO_ROPE]);
    expect(take?.acceptEntity(DEMO_ROPE).done).toBe(true);
    expect(take === undefined ? undefined : app.queueAction(take).ok).toBe(true);
    expect(app.runner.state().tick).toBe(0);
    for (let index = 0; index < 4; index += 1) app.step();
    expect(app.observedEvents().map((event) => event.text)).toContain("你拿起了麻绳");
    expect(app.availableActions().map((entry) => entry.command.name)).toContain("放置");
    expect(app.availableActions().map((entry) => entry.command.name)).not.toContain("拿取");
    const put = app.beginAction("agentlife.demo/command-put");
    expect(put?.choices().map((choice) => choice.entityId)).toEqual([DEMO_ROPE]);
    expect(put?.acceptEntity(DEMO_ROPE).done).toBe(false);
    expect(put?.choices().map((choice) => choice.entityId)).toEqual([DEMO_BENCH]);
    app.close();
  });

  it("keeps text as opaque action input and only accepts it on the next tick", async () => {
    const app = await controller();
    const say = app.beginAction("agentlife.demo/command-say");
    expect(say?.acceptText("你好，阿禾").done).toBe(true);
    expect(say === undefined ? undefined : app.queueAction(say).ok).toBe(true);
    expect(app.runner.state().actions).toHaveLength(0);
    app.step();
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
    expect(timer.callbacks).toHaveLength(1);
    app.toggleRunning();
    expect(app.status().mode).toBe("paused");
    expect(timer.callbacks).toHaveLength(0);
    app.close();
  });
});
