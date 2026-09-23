import { PiCognitionAgent } from "../agent/cognition-agent.js";
import { answeringDecision } from "../agent/scripted-cognition.js";
import { RuntimeStore } from "../storage/runtime-store.js";
import { digestOf, publishDemoConfig, semanticView } from "../simulation/demo.js";
import { SimulationRunner, type TickResult } from "../simulation/runner.js";
import { SimulationController } from "./simulation-controller.js";

/**
 * The phase 4 demonstration scenario.
 *
 * It drives the whole phase 4 chain with the scripted faux model: the AI takes its
 * initial decision, the player walks to where the other role stands, says something,
 * and the spoken word wakes that role — the world freezes while it decides, the
 * player joins the same round with its own action, one batch reaches the body, the
 * save requested during the barrier runs once the tick is published, and a timeline
 * continued from that save ends exactly where the original one ends.
 */

const PLAYER = "agentlife.demo/player";
const ORCHARD = "agentlife.demo/orchard";

/** Waits until the barrier the controller opened has been resolved and published. */
async function settled(app: SimulationController, tick: number): Promise<void> {
  for (let hop = 0; hop < 20_000; hop += 1) {
    const state = app.runner.state();
    if (state.tick === tick && state.phase === "publish" && app.runner.openRound() === null) return;
    await Promise.resolve();
  }
  const state = app.runner.state();
  throw new Error(
    `tick ${tick} was never published: ${state.runMode} ${state.failure?.detail ?? ""} ${app.runner.roundNotes().join("; ")}`,
  );
}

interface QueueOptions {
  readonly references?: readonly string[];
  readonly text?: string;
}

/** Fulfils one content command and submits it, exactly as the action bar does. */
function queue(app: SimulationController, commandRef: string, options: QueueOptions = {}): string {
  const session = app.beginAction(commandRef);
  if (session === undefined) throw new Error(`command ${commandRef} is not available right now`);
  for (const reference of options.references ?? []) {
    const accepted = session.acceptEntity(reference);
    if (accepted.error !== undefined) throw new Error(accepted.error);
  }
  if (options.text !== undefined) {
    const accepted = session.acceptText(options.text);
    if (accepted.error !== undefined) throw new Error(accepted.error);
  }
  const queued = app.queueAction(session);
  if (!queued.ok) throw new Error(queued.message);
  return queued.message;
}

/** The observer-local reference the player's own view gives to one object. */
function referenceOf(app: SimulationController, anchor: string): string {
  const view = app.view();
  const subjects = [...(view.place === null ? [] : [view.place]), ...view.exits, ...view.entities];
  const subject = subjects.find((candidate) => candidate.anchor === anchor);
  if (subject === undefined) throw new Error(`the player does not perceive ${anchor} right now`);
  return subject.reference;
}

function describeView(app: SimulationController): readonly string[] {
  const view = app.view();
  return [
    `地点       ${view.place?.name ?? "不明"}${view.place === null ? "" : `（${view.place.detail}）`}`,
    `出口       ${view.exits.map((exit) => exit.name).join("、") || "无"}`,
    `看到的人   ${
      view.entities
        .filter((entity) => entity.kind === "character")
        .map((entity) => `${entity.name}${entity.recognisable ? "" : "（未识别）"}`)
        .join("、") || "无"
    }`,
    `看到的物   ${
      view.entities
        .filter((entity) => entity.kind === "item")
        .map((entity) => entity.name)
        .join("、") || "无"
    }`,
  ];
}

/** The paths at which two states differ, so a divergence names itself. */
function differingPaths(left: unknown, right: unknown, prefix = ""): readonly string[] {
  if (JSON.stringify(left) === JSON.stringify(right)) return [];
  if (typeof left !== "object" || left === null || typeof right !== "object" || right === null)
    return [`${prefix}: ${JSON.stringify(left)} != ${JSON.stringify(right)}`];
  const keys = [...new Set([...Object.keys(left), ...Object.keys(right)])].sort();
  return keys.flatMap((key) =>
    differingPaths(Reflect.get(left as object, key), Reflect.get(right as object, key), `${prefix}/${key}`),
  );
}

async function main(): Promise<void> {
  const { core, config } = await publishDemoConfig();
  const runner = SimulationRunner.create(core, {
    timelineId: "timeline-phase4-demo",
    models: new PiCognitionAgent({
      provider: "faux",
      model: "faux-cognition",
      tokensPerSecond: 0,
      draft: answeringDecision,
    }),
  });
  const store = new RuntimeStore(":memory:");
  const app = new SimulationController(runner, config, store, { playerId: PLAYER });
  const lines: string[] = [];
  lines.push(`configId   ${config.configId}`);
  lines.push(`systems    ${config.systems.map((system) => `${system.systemId}@${system.version}`).join(", ")}`);

  // 1. The AI takes its initial decision; the player is not part of that round.
  app.step();
  await settled(app, 1);
  lines.push("");
  lines.push(`tick 1     认知轮次 ${runner.state().summary?.cognition ?? "无"}`);

  // 2. The player walks to the orchard, one command per stable boundary.
  queue(app, "agentlife.demo/command-move", { references: [referenceOf(app, ORCHARD)] });
  for (let tick = 2; tick <= 8 && runner.state().world.entities[PLAYER]?.locatedAt !== ORCHARD; tick += 1) {
    app.step();
    await settled(app, tick);
  }
  lines.push("");
  lines.push(`tick ${runner.state().tick}     玩家到达 ${runner.state().world.entities[PLAYER]?.locatedAt}`);
  for (const line of describeView(app)) lines.push(`  ${line}`);

  // 3. The player speaks; the spoken word only becomes audible once the action ends.
  queue(app, "agentlife.demo/command-say", { text: "有人吗？" });
  let barrier: TickResult | null = null;
  for (let tick = runner.state().tick + 1; tick <= runner.state().tick + 8 && barrier === null; tick += 1) {
    const result = app.step();
    if (result.status === "cognitive-barrier") {
      barrier = result;
      break;
    }
    await settled(app, tick);
  }
  if (barrier === null || barrier.status !== "cognitive-barrier") throw new Error("the spoken word never woke the AI");

  // 4. The world is frozen while the other role decides; the player joins the round
  //    with its own action, and the save requested now waits for the published tick.
  lines.push("");
  lines.push(
    `tick ${barrier.round.tick}     世界冻结，等待 AI：${barrier.round.participants.map((p) => p.characterId).join(", ")}`,
  );
  lines.push(
    `  玩家可用候选 ${app
      .availableActions()
      .map((entry) => entry.command.name)
      .join("、")}`,
  );
  lines.push(`  屏障期间保存 ${app.save("phase4-demo-barrier").message}`);
  // 挥手 takes no argument, so the player simply joins the round with its own action.
  lines.push(`  玩家加入本轮 ${queue(app, "agentlife.demo/command-wave")}`);
  const frozenTick = barrier.round.tick;
  await settled(app, frozenTick);
  const published = runner.state();
  lines.push(`tick ${published.tick}     统一交接完成：${published.summary?.cognition ?? "无"}`);
  for (const outcome of published.summary?.actionOutcomes ?? []) lines.push(`  ${outcome}`);
  lines.push(`  屏障后的保存 ${app.status().pendingSave === null ? "已执行" : "仍待处理"}`);
  lines.push(
    `  存放档     ${store
      .listSaves()
      .map((save) => `${save.saveId}@tick-${save.tick}`)
      .join(", ")}`,
  );

  // 5. The expression the AI decided on goes through its body before anyone hears it.
  lines.push("");
  lines.push("AI 的回应");
  const replyDeadline = runner.state().tick + 4;
  for (let tick = runner.state().tick + 1; tick <= replyDeadline; tick += 1) {
    app.step();
    await settled(app, tick);
    const spoken = runner.state().world.events.filter((event) => event.kind === "utterance" && event.actor !== PLAYER);
    if (spoken.length === 0) continue;
    const heard = app
      .perceptionLog()
      .filter((observation) => observation.text.includes("说：") && !observation.text.startsWith("你说"));
    lines.push(`  tick ${tick} 同地点的玩家听见：${heard.at(-1)?.text ?? "（没有听见）"}`);
    break;
  }

  // 6. What the player actually perceived, in the order it happened.
  lines.push("");
  lines.push("玩家的感知记录（只包含玩家自己实际获得的内容）");
  for (const observation of app.perceptionLog()) lines.push(`  ${observation.text}`);

  // 7. Continue the original timeline, then continue the save, and compare.
  const boundary = app.save("phase4-demo-boundary");
  lines.push("");
  lines.push(`存档       ${boundary.message}`);
  const savedDigest = digestOf(runner.state());
  for (let index = 0; index < 3; index += 1) {
    const next = runner.state().tick + 1;
    app.step();
    await settled(app, next);
  }
  const continuedView = semanticView(runner.state());
  const continuedDigest = digestOf(runner.state());
  const loaded = app.load("phase4-demo-boundary");
  if (!loaded.ok) throw new Error(loaded.message);
  for (let index = 0; index < 3; index += 1) {
    const next = runner.state().tick + 1;
    app.step();
    await settled(app, next);
  }
  const loadedView = semanticView(runner.state());
  const loadedDigest = digestOf(runner.state());
  const differences = differingPaths(continuedView, loadedView);
  lines.push(`保存时摘要 ${savedDigest}`);
  lines.push(`原时间线继续 ${continuedDigest}`);
  lines.push(`加载后继续   ${loadedDigest}`);
  if (continuedDigest !== loadedDigest)
    throw new Error(`the loaded timeline diverged from the continued one:\n${differences.slice(0, 12).join("\n")}`);

  process.stdout.write(`${lines.join("\n")}\n`);
  app.close();
}

await main();
