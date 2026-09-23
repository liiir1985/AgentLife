import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Script } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import { idleDecision } from "../src/agent/scripted-cognition.js";
import { SessionInspector } from "../src/diagnostics/session-inspector.js";
import { SessionCost } from "../src/diagnostics/session-cost.js";
import { SessionLog, type SessionLogEntry } from "../src/diagnostics/session-trace.js";
import { SimulationController } from "../src/interaction/simulation-controller.js";
import type { CognitionInput } from "../src/simulation/types.js";
import { RuntimeStore } from "../src/storage/runtime-store.js";
import { TerminalApplication } from "../src/tui/terminal-application.js";
import { VirtualTerminal } from "../src/tui/virtual-terminal.js";
import { dispose, phase4Simulation } from "./helpers/phase4.js";

function rows(log: SessionLog): SessionLogEntry[] {
  return readFileSync(log.path, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as SessionLogEntry);
}

describe("TUI session log", () => {
  it("records two turns, including each observer and the complete model transcript", async () => {
    const directory = mkdtempSync(join(tmpdir(), "agentlife-session-"));
    const log = new SessionLog(directory);
    const sessionCost = new SessionCost();
    const simulation = await phase4Simulation({ trace: log, sessionCost });
    try {
      expect((await simulation.runner.runTickToPublication()).status).toBe("completed");
      expect((await simulation.runner.runTickToPublication()).status).toBe("completed");
      const entries = rows(log);
      expect(entries.filter((entry) => entry.kind === "turn-start").map((entry) => entry.turn)).toEqual([1, 2]);
      // Which turns ask the model is the content's business; the log's own duty is to
      // attribute every request to a turn that really ran.
      const turns = entries.filter((entry) => entry.kind === "turn-start").map((entry) => entry.turn);
      const requests = entries.filter((entry) => entry.kind === "llm-request");
      expect(requests.length).toBeGreaterThan(0);
      expect(requests.every((entry) => entry.turn !== null && turns.includes(entry.turn))).toBe(true);
      expect(entries.filter((entry) => entry.kind === "turn-end").map((entry) => entry.data)).toEqual([
        expect.objectContaining({ status: "completed" }),
        expect.objectContaining({ status: "completed" }),
      ]);
      expect(
        entries
          .filter((entry) => entry.kind === "perception-result" && entry.turn === 1)
          .map((entry) => entry.entityId),
      ).toContain("agentlife.demo/companion");
      expect(
        entries.some((entry) => entry.kind === "memory-admission" && entry.entityId === "agentlife.demo/companion"),
      ).toBe(true);
      expect(
        entries.some(
          (entry) => entry.kind === "cognition-attempt-start" && entry.entityId === "agentlife.demo/companion",
        ),
      ).toBe(true);
      const request = entries.find((entry) => entry.kind === "llm-request");
      expect((request?.data as { messages: { role: string }[] }).messages.map((message) => message.role)).toContain(
        "system",
      );
      const transcript = entries.find((entry) => entry.kind === "llm-transcript");
      expect(
        entries.some((entry) => entry.kind === "llm-usage" && (entry.data as { pricing: string }).pricing === "faux"),
      ).toBe(true);
      expect(sessionCost.totalUsd).toBe(0);
      expect((transcript?.data as { messages: { role: string }[] }).messages.map((message) => message.role)).toEqual(
        expect.arrayContaining(["system", "user", "assistant", "toolResult"]),
      );
      expect(
        entries.some((entry) => entry.kind === "stage" && (entry.data as { stage: string }).stage === "publish"),
      ).toBe(true);
    } finally {
      dispose(simulation);
      log.close();
      rmSync(directory, { recursive: true, force: true });
    }
  }, 40_000);

  it("keeps failed attempts separate from a retry of the same tick", async () => {
    const directory = mkdtempSync(join(tmpdir(), "agentlife-session-"));
    const log = new SessionLog(directory);
    let submissions = 0;
    const simulation = await phase4Simulation({
      trace: log,
      script: {
        draft: (input: CognitionInput) => {
          submissions += 1;
          return submissions <= 2
            ? { ...(idleDecision(input) as Record<string, unknown>), consumedObservations: ["o999"] }
            : idleDecision(input);
        },
      },
    });
    try {
      expect((await simulation.runner.runTickToPublication()).status).toBe("failed");
      expect((await simulation.runner.runTickToPublication()).status).toBe("completed");
      const starts = rows(log).filter((entry) => entry.kind === "turn-start");
      expect(starts.map((entry) => [entry.turn, entry.targetTick])).toEqual([
        [1, 1],
        [2, 1],
      ]);
      expect(
        rows(log)
          .filter((entry) => entry.kind === "turn-end")
          .map((entry) => (entry.data as { status: string }).status),
      ).toEqual(["failed", "completed"]);
      expect(
        rows(log)
          .filter((entry) => entry.kind === "cognition-attempt-end" && entry.turn === 1)
          .map((entry) => (entry.data as { status: string }).status),
      ).toEqual(["rejected", "rejected"]);
    } finally {
      dispose(simulation);
      log.close();
      rmSync(directory, { recursive: true, force: true });
    }
  }, 40_000);

  it("records a load and serves saved and live entries to the inspector", async () => {
    const directory = mkdtempSync(join(tmpdir(), "agentlife-session-"));
    const log = new SessionLog(directory);
    const simulation = await phase4Simulation({ trace: log });
    const controller = new SimulationController(simulation.runner, simulation.config, new RuntimeStore(":memory:"), {
      playerId: "agentlife.demo/player",
      trace: log,
    });
    const inspector = new SessionInspector(directory);
    try {
      expect((await simulation.runner.runTickToPublication()).status).toBe("completed");
      expect(controller.save("checkpoint").ok).toBe(true);
      expect(controller.load("checkpoint").ok).toBe(true);
      expect((await simulation.runner.runTickToPublication()).status).toBe("completed");
      const load = rows(log).find((entry) => entry.kind === "timeline-load");
      expect(load?.data).toMatchObject({
        saveId: "checkpoint",
        previous: "timeline-phase4",
        next: "timeline-phase4/load-1",
      });
      const url = await inspector.open(false);
      const page = await fetch(url);
      const html = await page.text();
      expect(html).toContain("Session Log");
      const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
      expect(script).toBeDefined();
      expect(() => new Script(script as string)).not.toThrow();
      const files = (await (await fetch(`${url}api/sessions`)).json()) as string[];
      expect(files).toContain(log.path.split(/[\\/]/).at(-1));
      const deepLink = await inspector.open(false, { session: files[0] as string, turn: 2 });
      expect(new URL(deepLink).searchParams.get("turn")).toBe("2");
      const served = (await (
        await fetch(`${url}api/session/${encodeURIComponent(files[0] as string)}`)
      ).json()) as SessionLogEntry[];
      expect(served.some((entry) => entry.kind === "timeline-load")).toBe(true);
    } finally {
      inspector.close();
      controller.close();
      dispose(simulation);
      log.close();
      rmSync(directory, { recursive: true, force: true });
    }
  }, 40_000);

  it("does not change simulation results when the log cannot be written", async () => {
    const directory = mkdtempSync(join(tmpdir(), "agentlife-session-"));
    const log = new SessionLog(directory);
    rmSync(log.path);
    mkdirSync(log.path);
    const simulation = await phase4Simulation({ trace: log });
    try {
      expect((await simulation.runner.runTickToPublication()).status).toBe("completed");
      expect(log.error).not.toBeNull();
    } finally {
      dispose(simulation);
      rmSync(directory, { recursive: true, force: true });
    }
  }, 40_000);

  it("shows a log failure in the TUI and exposes the inspector command", async () => {
    const directory = mkdtempSync(join(tmpdir(), "agentlife-session-"));
    const log = new SessionLog(directory);
    rmSync(log.path);
    mkdirSync(log.path);
    log.record("probe", {});
    const simulation = await phase4Simulation({ trace: log });
    const controller = new SimulationController(simulation.runner, simulation.config, new RuntimeStore(":memory:"), {
      playerId: "agentlife.demo/player",
      trace: log,
    });
    const inspector = new SessionInspector(directory);
    const opened = vi.spyOn(inspector, "open").mockResolvedValue("http://127.0.0.1:1234/");
    const terminal = new VirtualTerminal(140, 40);
    const app = new TerminalApplication(terminal, controller, { sessionLog: log, inspector });
    try {
      app.start();
      expect(terminal.screen().join("\n")).toContain("Session Log 写入失败");
      terminal.sendInput("/");
      terminal.sendInput("inspect");
      terminal.sendInput("\r");
      expect(opened).toHaveBeenCalledOnce();
    } finally {
      app.stop();
      dispose(simulation);
      rmSync(directory, { recursive: true, force: true });
    }
  }, 40_000);

  it("opens a chosen turn from the F2 Session Log tab", async () => {
    const directory = mkdtempSync(join(tmpdir(), "agentlife-session-"));
    const log = new SessionLog(directory);
    log.startTurn("timeline-one", 1);
    log.finishTurn("completed", {});
    log.startTurn("timeline-one", 2);
    log.finishTurn("failed", {});
    const simulation = await phase4Simulation();
    const controller = new SimulationController(simulation.runner, simulation.config, new RuntimeStore(":memory:"), {
      playerId: "agentlife.demo/player",
    });
    const inspector = new SessionInspector(directory);
    const opened = vi.spyOn(inspector, "open").mockResolvedValue("http://127.0.0.1:1234/");
    const terminal = new VirtualTerminal(140, 40);
    const app = new TerminalApplication(terminal, controller, { sessionLog: log, inspector });
    try {
      app.start();
      terminal.sendInput("\x1bOQ");
      const statusScreen = terminal.screen().join("\n");
      expect(statusScreen).toContain("[当前状态]");
      expect(statusScreen).toContain("┌─ 调试面板");
      expect(statusScreen).toContain("└────");
      terminal.resize(70, 20);
      app.tui.renderNow(true);
      expect(terminal.screen().join("\n")).toContain("└────");
      for (let index = 0; index < 15; index += 1) terminal.sendInput("\x1b[B");
      app.tui.renderNow(true);
      expect(terminal.screen().join("\n")).toContain("Cognition");
      expect(terminal.screen().join("\n")).toContain("└────");
      terminal.resize(140, 40);
      app.tui.renderNow(true);
      terminal.sendInput("\x1b[C");
      app.tui.renderNow(true);
      const screen = terminal.screen().join("\n");
      expect(screen).toContain("[Session Log]");
      expect(screen).toContain("Turn 2");
      expect(screen).toContain("Turn 1");
      terminal.sendInput("\x1b[B");
      terminal.sendInput("\r");
      expect(opened).toHaveBeenCalledWith(true, {
        session: log.path.split(/[\\/]/).at(-1),
        turn: 1,
      });
    } finally {
      app.stop();
      dispose(simulation);
      rmSync(directory, { recursive: true, force: true });
    }
  }, 40_000);
});
