import { visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it } from "vitest";
import { SpikeApp } from "../src/tui/spike-app.js";
import { VirtualTerminal } from "../src/tui/virtual-terminal.js";

interface Harness {
  readonly app: SpikeApp;
  readonly terminal: VirtualTerminal;
}

const harnesses: Harness[] = [];

function startSpike(cols: number, rows: number): Harness {
  const terminal = new VirtualTerminal(cols, rows);
  const app = new SpikeApp(terminal, { mouse: true, wheelScrollLines: 3 });
  app.start();
  app.model.startRound("timeline-1", "round-7", 42);
  app.model.setLocation("中央广场", [
    { id: "npc-1", name: "铁匠", detail: "正在打铁" },
    { id: "npc-2", name: "商人", detail: "整理货物" },
  ]);
  const harness = { app, terminal };
  harnesses.push(harness);
  return harness;
}

afterEach(() => {
  while (harnesses.length > 0) harnesses.pop()?.app.stop();
});

function row(harness: Harness, index: number): string {
  return harness.terminal.screen()[index] ?? "";
}

describe("SpikeApp layout", () => {
  it("splits location and entity panes side by side at 120 columns", () => {
    const harness = startSpike(120, 30);
    harness.app.render();
    const lines = harness.terminal.screen();

    expect(row(harness, 0)).toContain("时间线 timeline-1");
    expect(row(harness, 0)).toContain("Tick 42");
    const paneRow = lines.find((line) => line.includes("地点") && line.includes("实体"));
    expect(paneRow).toBeDefined();
    expect(paneRow!.indexOf("实体")).toBeGreaterThan(paneRow!.indexOf("地点"));
    expect(lines.some((line) => line.includes("中央广场"))).toBe(true);
    expect(lines.some((line) => line.includes("· 铁匠 — 正在打铁"))).toBe(true);
    expect(lines.at(-1)).toContain(">");
    expect(lines.every((line) => visibleWidth(line) <= 120)).toBe(true);
  });

  it("switches to tabs below 120 columns and toggles them with the tab key", () => {
    const harness = startSpike(80, 24);
    harness.app.render();

    expect(row(harness, 1)).toContain("[地点]");
    expect(row(harness, 1)).not.toContain("[实体]");
    expect(harness.terminal.screen().some((line) => line.includes("铁匠"))).toBe(false);

    harness.terminal.sendInput("\t");
    harness.app.render();
    expect(harness.app.viewModel().activeTab).toBe("entities");
    expect(row(harness, 1)).toContain("[实体]");
    expect(harness.terminal.screen().some((line) => line.includes("· 铁匠 — 正在打铁"))).toBe(true);

    harness.terminal.sendInput("\t");
    harness.app.render();
    expect(harness.app.viewModel().activeTab).toBe("location");
    expect(row(harness, 1)).toContain("[地点]");
    expect(harness.terminal.screen().some((line) => line.includes("铁匠"))).toBe(false);
  });

  it("follows window resizes in both directions", () => {
    const harness = startSpike(140, 30);
    harness.app.render();
    expect(harness.app.viewModel().layout).toBe("wide");

    harness.terminal.resize(80, 24);
    harness.app.render();
    expect(harness.app.viewModel().layout).toBe("narrow");
    expect(row(harness, 1)).toContain("[地点]");
    expect(harness.terminal.screen().every((line) => visibleWidth(line) <= 80)).toBe(true);

    harness.terminal.resize(120, 30);
    harness.app.render();
    expect(harness.app.viewModel().layout).toBe("wide");
    expect(harness.terminal.screen().some((line) => line.includes("地点") && line.includes("实体"))).toBe(true);
  });

  it("keeps the header and the input bar visible under a long log", () => {
    const harness = startSpike(120, 30);
    harness.app.model.beginStream();
    for (let index = 0; index < 600; index += 1) harness.app.model.appendLog(`轮次 6 结束 ${index}`);
    harness.app.render();

    expect(harness.app.tui.isFollowingOutput).toBe(true);
    expect(row(harness, 0)).toContain("时间线 timeline-1");
    expect(harness.terminal.screen().at(-1)).toContain(">");
    expect(harness.terminal.screen().some((line) => line.includes("轮次 6 结束 599"))).toBe(true);

    harness.terminal.sendInput("abc");
    harness.app.render();
    expect(harness.terminal.screen().at(-1)).toContain("> abc");

    harness.terminal.sendInput("\x1b[5~");
    harness.app.render();
    expect(row(harness, 0)).toContain("时间线 timeline-1");
    expect(harness.terminal.screen().at(-1)).toContain("> abc");
    expect(harness.app.tui.isFollowingOutput).toBe(false);
  });

  it("keeps wide characters inside the frame", () => {
    const harness = startSpike(80, 24);
    harness.app.model.setLocation("中央广场东侧的钟楼", [
      { id: "npc-1", name: "铁匠王师傅", detail: "正在打铁，汗流浃背" },
    ]);
    harness.app.appendLog("甲在中央广场遇到了正在打铁的铁匠王师傅，两人交谈了很久。");
    harness.app.render();

    const lines = harness.terminal.screen();
    expect(lines.some((line) => line.includes("中央广场东侧的钟楼"))).toBe(true);
    expect(lines.some((line) => line.includes("甲在中央广场遇到了正在打铁的铁匠王师傅"))).toBe(true);
    expect(lines.every((line) => visibleWidth(line) <= 80)).toBe(true);
  });
});

describe("SpikeApp log viewport", () => {
  it("follows new output and scrolls back without losing the position", () => {
    const harness = startSpike(80, 24);
    for (let index = 0; index < 120; index += 1) harness.app.appendLog(`日志 ${index}`);
    harness.app.render();

    const visible = (needle: string): boolean => harness.terminal.screen().some((line) => line.includes(needle));
    const visibleIndexes = (): number[] =>
      harness.terminal
        .screen()
        .map((line) => /日志 (\d+)/.exec(line)?.[1])
        .filter((index) => index !== undefined)
        .map(Number);

    expect(harness.app.tui.isFollowingOutput).toBe(true);
    expect(visible("日志 119")).toBe(true);
    expect(visible("日志 0")).toBe(false);
    const followingTop = harness.app.tui.viewportTop;

    harness.terminal.sendInput("\x1b[5~");
    harness.app.render();
    expect(harness.app.tui.isFollowingOutput).toBe(false);
    const scrolledTop = harness.app.tui.viewportTop;
    expect(scrolledTop).toBeLessThan(followingTop);
    expect(Math.min(...visibleIndexes())).toBe(scrolledTop);
    expect(Math.max(...visibleIndexes())).toBeLessThan(119);

    harness.app.appendLog("新的一行");
    harness.app.render();
    expect(harness.app.tui.viewportTop).toBe(scrolledTop);
    expect(visible("新的一行")).toBe(false);

    for (let attempt = 0; attempt < 10 && !harness.app.tui.isFollowingOutput; attempt += 1) {
      harness.terminal.sendInput("\x1b[6~");
    }
    harness.app.render();
    expect(harness.app.tui.isFollowingOutput).toBe(true);
    expect(visible("新的一行")).toBe(true);
  });

  it("scrolls the log with the mouse wheel", () => {
    const harness = startSpike(80, 24);
    for (let index = 0; index < 120; index += 1) harness.app.appendLog(`日志 ${index}`);
    harness.app.render();
    expect(harness.app.tui.isFollowingOutput).toBe(true);
    const followingTop = harness.app.tui.viewportTop;

    harness.terminal.sendInput("\x1b[<64;20;12M");
    harness.app.render();
    expect(harness.app.tui.isFollowingOutput).toBe(false);
    expect(harness.app.tui.viewportTop).toBeLessThan(followingTop);
    expect(harness.terminal.screen().some((line) => line.includes("日志 119"))).toBe(false);
    expect(harness.terminal.screen().some((line) => /日志 \d+/.test(line))).toBe(true);
  });
});

describe("SpikeApp monitor overlay", () => {
  it("opens with F2, keeps input from leaking through, and restores focus", () => {
    const harness = startSpike(120, 30);
    harness.app.render();
    expect(harness.app.focusedComponent).toBe(harness.app.inputField);

    harness.terminal.sendInput("\x1b[12~");
    expect(harness.app.isMonitorOpen).toBe(true);
    const monitorLines = harness.terminal.screen().filter((line) => line.includes("时间线") || line.includes("监视"));
    expect(monitorLines.some((line) => line.includes("监视 (F2)"))).toBe(true);
    expect(monitorLines.some((line) => line.includes("phase") || line.includes("idle"))).toBe(true);

    harness.terminal.sendInput("secret");
    harness.app.render();
    expect(harness.app.inputField.getValue()).toBe("");

    harness.terminal.resize(80, 24);
    harness.app.render();
    expect(harness.terminal.screen().some((line) => line.includes("narrow"))).toBe(true);

    harness.terminal.sendInput("\x1b[12~");
    harness.app.render();
    expect(harness.app.isMonitorOpen).toBe(false);
    expect(harness.app.focusedComponent).toBe(harness.app.inputField);
    expect(harness.terminal.screen().some((line) => line.includes("监视 (F2)"))).toBe(false);

    harness.terminal.sendInput("hi 中文");
    harness.app.render();
    expect(harness.app.inputField.getValue()).toBe("hi 中文");
    expect(harness.terminal.screen().some((line) => line.includes("hi 中文"))).toBe(true);
  });

  it("moves the caret with Home and End and leaves the transcript on Ctrl+Home/End", () => {
    const harness = startSpike(80, 24);
    for (let index = 0; index < 120; index += 1) harness.app.appendLog(`日志 ${index}`);
    harness.app.render();

    harness.terminal.sendInput("abc");
    harness.terminal.sendInput("\x1b[H");
    harness.terminal.sendInput("X");
    expect(harness.app.inputField.getValue()).toBe("Xabc");

    harness.terminal.sendInput("\x1b[F");
    harness.terminal.sendInput("Y");
    expect(harness.app.inputField.getValue()).toBe("XabcY");

    expect(harness.app.tui.isFollowingOutput).toBe(true);
    harness.terminal.sendInput("\x1b[1;5H");
    expect(harness.app.tui.viewportTop).toBe(0);
    harness.terminal.sendInput("\x1b[1;5F");
    expect(harness.app.tui.isFollowingOutput).toBe(true);
    expect(harness.app.inputField.getValue()).toBe("XabcY");
  });

  it("stages a multi-line paste behind a token and expands it on submit", () => {
    const harness = startSpike(80, 24);
    const block = ["第一行", "第二行", "第三行"];

    harness.terminal.sendInput(`\x1b[200~${block.join("\n")}\x1b[201~`);
    harness.app.render();

    expect(harness.app.inputField.getValue()).toBe("[粘贴 #1]");
    expect(harness.app.viewModel().pastes).toEqual([
      { n: 1, label: "[粘贴 #1]", lines: 3, chars: 11, preview: "第一行" },
    ]);
    const card = harness.terminal.screen().find((line) => line.includes("粘贴 ·"));
    expect(card).toBeDefined();
    expect(card).toContain("3 行");
    expect(card).toContain("第一行");

    harness.terminal.sendInput("\r");
    harness.app.render();
    const lines = harness.terminal.screen();
    expect(lines.some((line) => line.includes("> 第一行"))).toBe(true);
    expect(lines.some((line) => line.includes("第二行"))).toBe(true);
    expect(lines.some((line) => line.includes("第三行"))).toBe(true);
    expect(harness.app.inputField.getValue()).toBe("");
    expect(harness.terminal.screen().some((line) => line.includes("粘贴 ·"))).toBe(false);
  });

  it("joins a paste split across reads into one chip and drops it with its token", () => {
    const harness = startSpike(80, 24);

    harness.terminal.sendInput("\x1b[200~第一行\n第二");
    harness.app.render();
    expect(harness.app.inputField.getValue()).toBe("");
    expect(harness.app.viewModel().pastes).toHaveLength(0);

    harness.terminal.sendInput("行\x1b[201~");
    harness.app.render();
    expect(harness.app.inputField.getValue()).toBe("[粘贴 #1]");
    expect(harness.app.viewModel().pastes[0]?.lines).toBe(2);

    // Deleting the token detaches the paste: the card goes and nothing is submitted.
    harness.terminal.sendInput("\x7f".repeat("[粘贴 #1]".length));
    harness.app.render();
    expect(harness.app.inputField.getValue()).toBe("");
    expect(harness.terminal.screen().some((line) => line.includes("粘贴 ·"))).toBe(false);

    harness.terminal.sendInput("\r");
    harness.app.render();
    expect(harness.terminal.screen().some((line) => line.includes("第一行"))).toBe(false);
  });

  it("keeps a short single-line paste inline and never captures the mouse by default", () => {
    const terminal = new VirtualTerminal(80, 24);
    const app = new SpikeApp(terminal);
    app.start();
    harnesses.push({ app, terminal });

    terminal.sendInput("\x1b[200~单行文本\x1b[201~");
    app.render();
    expect(app.inputField.getValue()).toBe("单行文本");
    expect(app.viewModel().pastes).toHaveLength(0);
    expect(terminal.raw).not.toContain("\x1b[?1006h");
  });

  it("strips escape bytes and controls out of a pasted block", () => {
    const harness = startSpike(80, 24);

    harness.terminal.sendInput("\x1b[200~\u001b[31m红\u001b[0m\n第二行\t制表\u0007\x1b[201~");
    harness.app.render();
    expect(harness.app.viewModel().pastes[0]).toMatchObject({ lines: 2, chars: 18, preview: "[31m红[0m" });

    harness.terminal.sendInput("\r");
    harness.app.render();
    expect(harness.app.model.snapshot(80, "").log.at(-1)).toBe("> [31m红[0m\n第二行    制表");
  });

  it("cuts an over-long paste with an explicit note", () => {
    const harness = startSpike(80, 24);

    harness.terminal.sendInput(`\x1b[200~${"a".repeat(200_001)}\x1b[201~`);
    harness.app.render();
    expect(harness.app.viewModel().pastes[0]?.chars).toBeGreaterThan(200_000);

    harness.terminal.sendInput("\r");
    harness.app.render();
    expect(harness.terminal.screen().some((line) => line.includes("已截断"))).toBe(true);
  });

  it.skipIf(process.platform !== "win32")("pastes the clipboard on a right-click", async () => {
    const terminal = new VirtualTerminal(80, 24);
    const app = new SpikeApp(terminal, { mouse: true, readClipboard: async () => "一\r\n二\t三\n" });
    app.start();
    harnesses.push({ app, terminal });
    expect(terminal.raw).toContain("\x1b[?1006h");

    terminal.sendInput("\x1b[<2;20;12M");
    await Promise.resolve();
    await Promise.resolve();

    // A multi-line clipboard cannot fit the single-line buffer: it becomes a chip.
    expect(app.inputField.getValue()).toBe("[粘贴 #1]");
    expect(app.focusedComponent).toBe(app.inputField);

    app.render();
    expect(terminal.screen().some((line) => line.includes("3 行"))).toBe(true);

    terminal.sendInput("\r");
    app.render();
    expect(terminal.screen().some((line) => line.includes("> 一"))).toBe(true);
    expect(terminal.screen().some((line) => line.includes("二    三"))).toBe(true);
  });

  it("submits typed, pasted and coalesced input lines", () => {
    const harness = startSpike(80, 24);

    // A real terminal can deliver text and Enter in one read.
    harness.terminal.sendInput("走向钟楼\r");
    harness.app.render();
    expect(harness.app.inputField.getValue()).toBe("");
    expect(harness.terminal.screen().some((line) => line.includes("> 走向钟楼"))).toBe(true);

    harness.terminal.sendInput("\x1b[200~粘贴的中文文本\x1b[201~");
    expect(harness.app.inputField.getValue()).toBe("粘贴的中文文本");
    harness.terminal.sendInput("\r");
    harness.app.render();
    expect(harness.terminal.screen().some((line) => line.includes("> 粘贴的中文文本"))).toBe(true);

    // IME delivery: each code point arrives in its own read.
    harness.terminal.sendInput("中");
    harness.terminal.sendInput("文");
    harness.terminal.sendInput("\r");
    harness.app.render();
    expect(harness.terminal.screen().some((line) => line.includes("> 中文"))).toBe(true);
  });
});

describe("SpikeApp streaming", () => {
  it("coalesces a token burst into a single frame", () => {
    const harness = startSpike(120, 30);
    harness.app.model.beginStream();
    harness.app.render();
    const framesBefore = harness.terminal.frames;

    const tokens = Array.from({ length: 200 }, (_, index) => `${index % 10}`);
    for (const token of tokens) harness.app.appendStreamToken(token);
    expect(harness.terminal.frames).toBe(framesBefore);
    expect(harness.app.viewModel().stream).toHaveLength(200);

    harness.app.render();
    expect(harness.terminal.frames).toBe(framesBefore + 1);
    expect(harness.terminal.screen().some((line) => line.includes("0123456789012345"))).toBe(true);
    expect(harness.terminal.screen().join("\n")).toContain("…");

    harness.app.model.finishStream();
    harness.app.render();
    expect(harness.app.viewModel().stream).toBe("");
    expect(harness.app.viewModel().phase).toBe("idle");
    expect(harness.terminal.screen().some((line) => line.includes("0123456789"))).toBe(true);
  });

  it("shows the streaming phase and the final log line", () => {
    const harness = startSpike(120, 30);
    harness.app.model.beginStream();
    harness.app.appendStreamToken("他抬起头，看向广场中央。");
    harness.app.render();
    expect(row(harness, 0)).toContain("streaming");

    harness.app.model.setPhase("cancelled");
    harness.app.model.finishStream("cancelled");
    harness.app.render();
    expect(row(harness, 0)).toContain("cancelled");
    expect(harness.terminal.screen().some((line) => line.includes("他抬起头，看向广场中央。"))).toBe(true);
  });
});
