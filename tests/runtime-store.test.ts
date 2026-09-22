import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getTableName } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { MIGRATIONS, STORE_TABLES } from "../src/storage/migrations.js";
import {
  configVersions,
  consumedEffects,
  currentConfig,
  evaluationTraces,
  RuntimeStore,
} from "../src/storage/runtime-store.js";
import type { FailurePoint } from "../src/storage/runtime-store-probe.js";

const CONFIG_CRASH_WORKER = fileURLToPath(new URL("../src/storage/config-crash-worker.ts", import.meta.url));
const CRASH_POINTS: readonly FailurePoint[] = ["before-transaction", "inside-transaction", "after-commit"];

function configDocument(version: string): unknown {
  return {
    kernelVersion: "1.0.0",
    extensions: [{ ref: "agentlife.world/extension", version, fingerprint: `fingerprint-${version}` }],
    packs: [
      {
        namespace: "agentlife.demo",
        root: true,
        identity: `content-${version}`,
        manifest: {
          namespace: "agentlife.demo",
          version: "1.0.0",
          kernel: ">=1.0.0 <2.0.0",
          dependencies: [],
          extensions: ["agentlife.world/extension@1.0.0"],
          sections: {},
        },
        definitions: [],
        rules: [],
        derivations: [],
      },
    ],
  };
}

function withStore<T>(run: (store: RuntimeStore, directory: string) => T): T {
  const directory = mkdtempSync(path.join(tmpdir(), "agent-life-runtime-store-"));
  const store = new RuntimeStore(path.join(directory, "state.sqlite"));
  try {
    return run(store, directory);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

describe("runtime store", () => {
  it("brings a fresh database to the current migration level", () => {
    withStore((store, directory) => {
      expect(store.migrationLevel()).toBe(MIGRATIONS.length);
      const rows = store.sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all();
      const names = rows.map((row) => String(row["name"]));
      for (const table of STORE_TABLES) expect(names).toContain(table);
      expect(store.filename).toBe(path.join(directory, "state.sqlite"));
      store.initializeTimeline("timeline-a");
      expect(store.count("timelines")).toBe(1);
    });
  });

  it("keeps the Drizzle definitions aligned with the migrated schema", () => {
    withStore((store) => {
      const expected = new Map([
        [getTableName(configVersions), ["identity", "namespace", "pack_version", "document_json"]],
        [getTableName(currentConfig), ["slot", "identity"]],
        [getTableName(evaluationTraces), ["id", "idempotency_key", "request_id", "config_identity", "trace_json"]],
        [getTableName(consumedEffects), ["effect_id", "timeline_id", "config_identity"]],
      ]);
      for (const [table, columns] of expected) {
        const rows = store.sqlite.prepare("SELECT name FROM pragma_table_info(?)").all(table);
        expect(rows.map((row) => String(row["name"]))).toEqual(columns);
      }
    });
  });

  it("stores one current runtime config version and keeps the history", () => {
    withStore((store) => {
      expect(store.currentRuntimeConfig()).toBeUndefined();
      expect(
        store.saveRuntimeConfig({
          identity: "config-a",
          namespace: "agentlife.demo",
          packVersion: "1.0.0",
          document: configDocument("1.0.0"),
        }),
      ).toBe("committed");
      expect(store.currentRuntimeConfig()?.identity).toBe("config-a");
      expect(
        store.saveRuntimeConfig({
          identity: "config-b",
          namespace: "agentlife.demo",
          packVersion: "1.0.1",
          document: configDocument("1.0.1"),
        }),
      ).toBe("committed");
      expect(store.currentRuntimeConfig()?.identity).toBe("config-b");
      expect(store.runtimeConfigHistory().map((entry) => entry.identity)).toEqual(["config-a", "config-b"]);
      expect(
        store.saveRuntimeConfig({
          identity: "config-b",
          namespace: "agentlife.demo",
          packVersion: "1.0.1",
          document: configDocument("1.0.1"),
        }),
      ).toBe("duplicate");
      expect(store.runtimeConfigHistory()).toHaveLength(2);
      expect(store.configDocument("config-a")).toEqual(configDocument("1.0.0"));
    });
  });

  it("refuses two different contents under one version identity", () => {
    withStore((store) => {
      store.saveRuntimeConfig({
        identity: "config-a",
        namespace: "agentlife.demo",
        packVersion: "1.0.0",
        document: configDocument("1.0.0"),
      });
      expect(() =>
        store.saveRuntimeConfig({
          identity: "config-a",
          namespace: "agentlife.demo",
          packVersion: "2.0.0",
          document: configDocument("2.0.0"),
        }),
      ).toThrow(/already exists with different content/);
      expect(store.currentRuntimeConfig()?.identity).toBe("config-a");
      expect(store.runtimeConfigHistory()).toHaveLength(1);
    });
  });

  it("refuses a document that does not match the stored payload envelope", () => {
    withStore((store) => {
      expect(() =>
        store.saveRuntimeConfig({
          identity: "config-bad",
          namespace: "agentlife.demo",
          packVersion: "1.0.0",
          document: { kernelVersion: "1.0.0" },
        }),
      ).toThrow(/envelope/);
      expect(store.currentRuntimeConfig()).toBeUndefined();
    });
  });

  it("blocks a restore whose configuration version is missing", () => {
    withStore((store) => {
      expect(store.checkRestore("config-a")).toEqual({
        ok: false,
        reason: "missing-config",
        message: expect.stringContaining("missing from the store"),
      });
      store.saveRuntimeConfig({
        identity: "config-a",
        namespace: "agentlife.demo",
        packVersion: "1.0.0",
        document: configDocument("1.0.0"),
      });
      expect(store.checkRestore("config-a")).toEqual({ ok: true });
    });
  });

  it("records one evaluation trace per idempotency key", () => {
    withStore((store) => {
      const entry = { requestId: "request-1", configIdentity: "config-a", trace: { status: "candidates" } };
      expect(store.recordEvaluationTrace(entry, "tick-1:request-1")).toBe("committed");
      expect(store.recordEvaluationTrace(entry, "tick-1:request-1")).toBe("duplicate");
      expect(store.recordEvaluationTrace(entry, "tick-2:request-1")).toBe("committed");
      expect(store.evaluationTrace("tick-1:request-1")).toEqual({ status: "candidates" });
      expect(store.evaluationTrace("tick-9")).toBeUndefined();
    });
  });

  it("consumes a candidate effect exactly once", () => {
    withStore((store, directory) => {
      store.initializeTimeline("timeline-a");
      expect(store.consumeEffect("effect-1", "timeline-a", "config-a")).toBe("consumed");
      expect(store.consumeEffect("effect-1", "timeline-a", "config-a")).toBe("duplicate");
      expect(store.countStored("consumed_effects")).toBe(1);
      expect(directory).toContain("agent-life-runtime-store-");
    });
  });

  describe("crash recovery", () => {
    it.each(CRASH_POINTS)("exposes only whole states after crashing at %s", (point) => {
      const directory = mkdtempSync(path.join(tmpdir(), "agent-life-config-crash-"));
      const filename = path.join(directory, "state.sqlite");
      try {
        const before = new RuntimeStore(filename);
        expect(
          before.saveRuntimeConfig({
            identity: "config-a",
            namespace: "agentlife.demo",
            packVersion: "1.0.0",
            document: configDocument("1.0.0"),
          }),
        ).toBe("committed");
        before.close();

        const crashed = spawnSync(
          process.execPath,
          ["--import", "tsx", CONFIG_CRASH_WORKER, filename, point, "config-b"],
          { cwd: fileURLToPath(new URL("..", import.meta.url)), encoding: "utf8" },
        );
        expect(crashed.status, crashed.stderr).toBe(point === "after-commit" ? 3 : 1);

        const after = new RuntimeStore(filename);
        const committed = point === "after-commit";
        expect(after.currentRuntimeConfig()?.identity).toBe(committed ? "config-b" : "config-a");
        expect(after.runtimeConfigHistory().map((entry) => entry.identity)).toEqual(
          committed ? ["config-a", "config-b"] : ["config-a"],
        );
        expect(after.configDocument("config-a")).toEqual(configDocument("1.0.0"));
        if (committed) {
          const stored: unknown = after.configDocument("config-b");
          expect(stored).toBeDefined();
          expect(Reflect.get(stored as object, "kernelVersion")).toBe("1.0.0");
        }
        after.close();
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    });
  });
});
