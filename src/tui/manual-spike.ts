import { matchesKey, ProcessTerminal } from "@earendil-works/pi-tui";
import { DemoScript } from "./demo-script.js";
import { SpikeApp } from "./spike-app.js";

/**
 * Manual acceptance entry for Windows Terminal:
 *
 *   pnpm tui:manual            # terminal keeps the mouse (native selection + right-click)
 *   pnpm tui:manual -- --mouse # app captures the mouse (wheel scroll, hover, Shift+drag to select)
 *   (if `pnpm` is not on PATH: node node_modules/tsx/dist/cli.mjs src/tui/manual-spike.ts)
 *
 * The demo plays a few rounds of scripted activity and then goes quiet, so the operator
 * can type without a moving screen. `Ctrl+R` replays it, `Esc` cancels the running stream.
 *
 * Checklist (record the result in docs/phase-0-spike-report.md):
 *  1. Type with Microsoft Pinyin (Win+Space): the candidate window must stay next to the
 *     caret in the input bar. If no caret is visible while the input is focused, record
 *     that first — it is the precondition for candidate-window placement.
 *     Check the input bar is empty before typing: in this project's own pty/ConPTY smoke
 *     runs the terminal injected one F3 legacy sequence (`ESC [ [ C`) at startup, which
 *     leaves a stray character behind when the sequence is split across reads. If that
 *     happens in Windows Terminal too, clear it with Backspace and record it — it is a
 *     terminal injection, not an IME defect.
 *  2. Submit Chinese text with Enter; the log must show "> <text>" and the input must clear.
 *  3. Paste single-line text with Ctrl+V; the frame must survive and Enter must submit it.
 *     Then paste a MULTI-LINE block with Ctrl+V and with a right click: the input must show
 *     a token `[粘贴 #N]` with a card above the input bar (`#N 粘贴 · M 行 · K 字 · 预览`),
 *     and Enter must write the whole block, line breaks intact, to the log. Delete the token
 *     (Backspace) and the card must disappear with it — nothing from the paste is submitted.
 *  4. Home/End must move the input caret to line start/end (Ctrl+A / Ctrl+E also work);
 *     Ctrl+Home / Ctrl+End jump the transcript to top/bottom, PageUp/PageDown page it.
 *  5. Scroll the log with PageUp/PageDown and with the mouse wheel; a scrollbar appears,
 *     follow stops while scrolled back, and resumes when scrolled back to the end. The
 *     header and the input bar must stay visible the whole time. The wheel works in both
 *     modes by different routes: without `--mouse` Windows Terminal's alternate-scroll
 *     mode (on by default since 1.20) sends Up/Down for each notch, which this app maps to
 *     the one-line scroll; with `--mouse` the wheel arrives as an SGR wheel event. Record
 *     which route the terminal actually used if the wheel does not move the log.
 *  6. Resize across 120 columns (drag the window border, or Ctrl+scroll to change the font
 *     size); the side-by-side panes must turn into tabs below 120 columns. Open F2 to read
 *     the live column count and layout from the monitor pane.
 *  7. Press F2 for the monitor overlay and F2 again; typing afterwards must reach the input.
 *  8. Press Esc while text is streaming; the stream must stop and log "流式输出已取消".
 *     Ctrl+R replays the demo.
 *  9. Ctrl+C to quit; the cursor and the normal screen buffer must be restored.
 *
 * Selection, mouse mode:
 *  - Without `--mouse` the terminal owns the mouse: drag-select, right-click paste and
 *    clearing the selection are Windows Terminal's own, exactly as in OMP (its `tui.mouse`
 *    defaults to false) — no app highlight is left behind. The app receives no mouse event
 *    at all, so there is no hover or click-to-place caret; the wheel still scrolls the log
 *    because the terminal forwards it as arrow keys (see item 5).
 *  - With `--mouse` the app owns selection and scrolls the log with the wheel. Then native
 *    selection moves to Shift+drag, a left click in the log clears the app's highlight, and
 *    a release copies the selection ("Copied") because `copyOnSelect` defaults to true.
 */
const NARRATIVE =
  "他抬起头，看了看天色，然后慢慢走向广场中央。风从钟楼方向吹来，带着一点铁锈味，" +
  "他停下来，听见远处传来锤子敲打铁砧的声音。";

const STREAM_INTERVAL_MS = 40;
const ROUND_GAP_MS = 1_200;
const ROUND_COUNT = 5;

const app = new SpikeApp(new ProcessTerminal(), {
  mouse: process.argv.includes("--mouse"),
  wheelScrollLines: 3,
});

const script = new DemoScript({
  narrative: NARRATIVE,
  roundCount: ROUND_COUNT,
  tokenIntervalMs: STREAM_INTERVAL_MS,
  roundGapMs: ROUND_GAP_MS,
  onRoundStart: (round) => {
    app.model.startRound("timeline-1", `round-${round}`, round);
    app.model.setLocation(round % 2 === 0 ? "铁匠铺" : "中央广场东侧的钟楼", [
      { id: "npc-1", name: "铁匠", detail: round % 2 === 0 ? "正在淬火" : "收摊打烊" },
    ]);
    app.model.beginStream();
    app.appendLog(`第 ${round} 轮开始`);
  },
  onToken: (token) => app.appendStreamToken(token),
  onStreamEnd: (round, cancelled) => {
    app.model.finishStream(cancelled ? "cancelled" : "idle");
    app.appendLog(cancelled ? "流式输出已取消（Ctrl+R 重新演示）" : `轮次 ${round} 结束`);
  },
  onFinish: () => {
    app.appendLog("自动演示结束：可直接输入、滚动、F2 监视；Ctrl+R 重新演示，Ctrl+C 退出");
  },
});

app.model.startRound("timeline-1", "round-0", 0);
app.model.setLocation("中央广场", [
  { id: "npc-1", name: "铁匠", detail: "正在打铁" },
  { id: "npc-2", name: "商人", detail: "整理货物" },
]);
app.appendLog(
  `提示：F2 监视 · Tab 切换标签 · PageUp/PageDown 或滚轮滚动 · 多行粘贴生成 [粘贴 #N] 标记 · Esc 取消流式 · Ctrl+R 重播 · Ctrl+C 退出 · 鼠标：${
    process.argv.includes("--mouse")
      ? "应用捕获（滚轮走 SGR；原生框选需 Shift+拖拽）"
      : "终端原生（框选/右键由 Windows Terminal 处理，滚轮由终端转成方向键）"
  }`,
);

let unsubscribe = (): void => {};

function shutdown(): void {
  script.stop();
  unsubscribe();
  app.stop();
  process.exit(0);
}

app.start();
unsubscribe = app.tui.addInputListener((data) => {
  if (data === "\x03" || matchesKey(data, "ctrl+c")) {
    shutdown();
    return { consume: true };
  }
  if (matchesKey(data, "escape")) {
    script.cancel();
    app.render();
    return { consume: true };
  }
  if (matchesKey(data, "ctrl+r")) {
    script.start();
    return { consume: true };
  }
  return undefined;
});
script.start();

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
