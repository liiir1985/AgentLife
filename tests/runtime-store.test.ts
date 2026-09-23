import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getTableName } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { MIGRATIONS, STORE_TABLES } from "../src/storage/migrations.js";
import { configs, currentConfig, RuntimeStore } from "../src/storage/runtime-store.js";
import type { FailurePoint } from "../src/storage/runtime-store-probe.js";

const CONFIG_CRASH_WORKER = fileURLToPath(new URL("../src/storage/config-crash-worker.ts", import.meta.url));
const CRASH_POINTS: readonly FailurePoint[] = ["before-transaction", "inside-transaction", "after-commit"];

function loadConfig(version: string): unknown {
  return {
    kernelVersion: "1.0.0",
    systems: [{ systemId: "agentlife.world", version, specHash: `spec-${version}` }],
    packs: [
      {
        namespace: "agentlife.demo",
        root: true,
        contentId: `content-${version}`,
        manifest: {
          namespace: "agentlife.demo",
          version: "1.0.0",
          kernel: ">=1.0.0 <2.0.0",
          dependencies: [],
          systems: ["agentlife.world/system@1.0.0"],
          sections: {},
        },
        items: [],
        rules: [],
        formulas: [],
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
        [getTableName(configs), ["identity", "namespace", "pack_version", "document_json"]],
        [getTableName(currentConfig), ["slot", "identity"]],
      ]);
      for (const [table, columns] of expected) {
        const rows = store.sqlite.prepare("SELECT name FROM pragma_table_info(?)").all(table);
        expect(rows.map((row) => String(row["name"]))).toEqual(columns);
      }
    });
  });

  it("stores one current runtime config version and keeps the history", () => {
    withStore((store) => {
      expect(store.currentConfig()).toBeUndefined();
      expect(
        store.saveConfig({
          configId: "config-a",
          namespace: "agentlife.demo",
          packVersion: "1.0.0",
          document: loadConfig("1.0.0"),
        }),
      ).toBe("committed");
      expect(store.currentConfig()?.configId).toBe("config-a");
      expect(
        store.saveConfig({
          configId: "config-b",
          namespace: "agentlife.demo",
          packVersion: "1.0.1",
          document: loadConfig("1.0.1"),
        }),
      ).toBe("committed");
      expect(store.currentConfig()?.configId).toBe("config-b");
      expect(store.configHistory().map((entry) => entry.configId)).toEqual(["config-a", "config-b"]);
      expect(
        store.saveConfig({
          configId: "config-b",
          namespace: "agentlife.demo",
          packVersion: "1.0.1",
          document: loadConfig("1.0.1"),
        }),
      ).toBe("duplicate");
      expect(store.configHistory()).toHaveLength(2);
      expect(store.loadConfig("config-a")).toEqual(loadConfig("1.0.0"));
    });
  });

  it("refuses two different contents under one version identity", () => {
    withStore((store) => {
      store.saveConfig({
        configId: "config-a",
        namespace: "agentlife.demo",
        packVersion: "1.0.0",
        document: loadConfig("1.0.0"),
      });
      expect(() =>
        store.saveConfig({
          configId: "config-a",
          namespace: "agentlife.demo",
          packVersion: "2.0.0",
          document: loadConfig("2.0.0"),
        }),
      ).toThrow(/already exists with different content/);
      expect(store.currentConfig()?.configId).toBe("config-a");
      expect(store.configHistory()).toHaveLength(1);
    });
  });

  it("refuses a document that does not match the stored payload envelope", () => {
    withStore((store) => {
      expect(() =>
        store.saveConfig({
          configId: "config-bad",
          namespace: "agentlife.demo",
          packVersion: "1.0.0",
          document: { kernelVersion: "1.0.0" },
        }),
      ).toThrow(/envelope/);
      expect(store.currentConfig()).toBeUndefined();
    });
  });

  it("blocks a restore whose configuration version is missing", () => {
    withStore((store) => {
      expect(store.checkRestore("config-a")).toEqual({
        ok: false,
        reason: "missing-config",
        message: expect.stringContaining("missing from the store"),
      });
      store.saveConfig({
        configId: "config-a",
        namespace: "agentlife.demo",
        packVersion: "1.0.0",
        document: loadConfig("1.0.0"),
      });
      expect(store.checkRestore("config-a")).toEqual({ ok: true });
    });
  });

  describe("crash recovery", () => {
    it.each(CRASH_POINTS)(
      "exposes only whole states after crashing at %s",
      (point) => {
        const directory = mkdtempSync(path.join(tmpdir(), "agent-life-config-crash-"));
        const filename = path.join(directory, "state.sqlite");
        try {
          const before = new RuntimeStore(filename);
          expect(
            before.saveConfig({
              configId: "config-a",
              namespace: "agentlife.demo",
              packVersion: "1.0.0",
              document: loadConfig("1.0.0"),
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
          expect(after.currentConfig()?.configId).toBe(committed ? "config-b" : "config-a");
          expect(after.configHistory().map((entry) => entry.configId)).toEqual(
            committed ? ["config-a", "config-b"] : ["config-a"],
          );
          expect(after.loadConfig("config-a")).toEqual(loadConfig("1.0.0"));
          if (committed) {
            const stored: unknown = after.loadConfig("config-b");
            expect(stored).toBeDefined();
            expect(Reflect.get(stored as object, "kernelVersion")).toBe("1.0.0");
          }
          after.close();
        } finally {
          rmSync(directory, { recursive: true, force: true });
        }
        // Each case starts a real process with tsx, which costs seconds under a loaded suite.
      },
      60_000,
    );
  });
});
