import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getTableName } from "drizzle-orm";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import {
  idempotencyCommits,
  parseStoredPayload,
  phaseRecords,
  RuntimeStoreProbe,
  snapshots,
  timelines,
  type FailurePoint,
  type SnapshotEnvelope,
} from "../src/storage/runtime-store-probe.js";

const CRASH_WORKER = fileURLToPath(new URL("../src/storage/crash-worker.ts", import.meta.url));
const PROBE_SCHEMA = Type.Object({ value: Type.Number() });

function withStore<T>(run: (store: RuntimeStoreProbe, directory: string) => T): T {
  const directory = mkdtempSync(path.join(tmpdir(), "agent-life-store-"));
  const store = new RuntimeStoreProbe(path.join(directory, "state.sqlite"));
  store.registerPayloadSchema("1", "probe", PROBE_SCHEMA);
  try {
    return run(store, directory);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

function envelope(tick: number, value: number, phase = "stable"): SnapshotEnvelope {
  return {
    timelineId: "timeline-a",
    tick,
    phase,
    payload: { schemaVersion: "1", type: "probe", data: { value } },
  };
}

describe("RuntimeStoreProbe", () => {
  it("validates versioned payloads on write and on read", () => {
    withStore((store) => {
      store.initializeTimeline("timeline-a");
      expect(() => store.commitSnapshot(envelope(1, 1), "k")).not.toThrow();
      expect(() =>
        store.commitSnapshot(
          {
            timelineId: "timeline-a",
            tick: 2,
            phase: "stable",
            payload: { schemaVersion: "9", type: "probe", data: { value: 1 } },
          },
          "unknown-version",
        ),
      ).toThrow(/Unknown payload schema/);
      expect(() =>
        store.commitSnapshot(
          {
            timelineId: "timeline-a",
            tick: 2,
            phase: "stable",
            payload: { schemaVersion: "1", type: "probe", data: { value: "no" } },
          },
          "wrong-shape",
        ),
      ).toThrow(/Invalid payload/);

      store.db
        .insert(snapshots)
        .values({
          timelineId: "timeline-a",
          tick: 99,
          phase: "stable",
          payloadJson: JSON.stringify({ schemaVersion: "9", type: "probe", data: { value: 1 } }),
        })
        .run();
      expect(() => store.latestSnapshot("timeline-a")).toThrow(/Unknown payload schema/);
    });
  });

  it("fails loudly on corrupt stored payloads and prevents persisting invalid JSON", () => {
    withStore((store) => {
      expect(() => parseStoredPayload("{not json", new Map())).toThrow(/not valid JSON/);
      expect(() => parseStoredPayload('{"schemaVersion":1}', new Map())).toThrow(/envelope is invalid/);
      store.initializeTimeline("timeline-a");
      expect(() =>
        store.sqlite.exec(
          "INSERT INTO snapshots (timeline_id, tick, phase, payload_json) VALUES ('timeline-a', 1, 'stable', 'not json')",
        ),
      ).toThrow();
      expect(store.count("snapshots")).toBe(0);
    });
  });

  it("commits snapshot, phase record and idempotency identity together", () => {
    withStore((store) => {
      store.initializeTimeline("timeline-a");
      expect(store.commitSnapshot(envelope(1, 42), "round-1:tick-1")).toBe("committed");
      expect(store.latestSnapshot("timeline-a")).toEqual(envelope(1, 42));
      expect(store.count("payloads")).toBe(1);
      expect(store.count("snapshots")).toBe(1);
      expect(store.count("phase_records")).toBe(1);
      expect(store.count("idempotency_commits")).toBe(1);
      expect(store.commitSnapshot(envelope(1, 42), "round-1:tick-1")).toBe("duplicate");
      expect(store.count("snapshots")).toBe(1);
      expect(store.count("phase_records")).toBe(1);
    });
  });

  it("keeps WAL, foreign keys and busy timeout enabled", () => {
    withStore((store) => {
      expect(store.sqlite.prepare("PRAGMA journal_mode").get()).toEqual({ journal_mode: "wal" });
      expect(store.sqlite.prepare("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
      expect(Object.values(store.sqlite.prepare("PRAGMA busy_timeout").get() as Record<string, number>)[0]).toBe(1000);
    });
  });

  it("keeps the Drizzle table definitions aligned with the SQLite schema", () => {
    withStore((store) => {
      for (const table of [timelines, snapshots, idempotencyCommits, phaseRecords]) {
        const rows = store.sqlite.prepare(`PRAGMA table_info(${getTableName(table)})`).all() as { name: string }[];
        const actual = rows.map((row) => row.name).sort();
        const declared = Object.values(table)
          .map((column) => column.name)
          .sort();
        expect(actual).toEqual(declared);
      }
    });
  });

  it("restores a snapshot into a new timeline without replaying applied commits", () => {
    withStore((store) => {
      store.initializeTimeline("timeline-a");
      store.commitSnapshot(envelope(1, 7), "round-1:tick-1");
      store.commitSnapshot(envelope(2, 9), "round-1:tick-2");

      const restored = store.restoreAsNewTimeline("timeline-a");
      expect(restored.timelineId).not.toBe("timeline-a");
      expect(store.latestSnapshot(restored.timelineId)).toEqual(restored);
      expect(restored.tick).toBe(2);
      expect(restored.payload.data).toEqual({ value: 9 });

      const parent = store.db.select().from(timelines).all();
      expect(parent.find((row) => row.timelineId === restored.timelineId)?.parentTimelineId).toBe("timeline-a");

      expect(store.commitSnapshot({ ...envelope(3, 9), timelineId: restored.timelineId }, "round-1:tick-2")).toBe(
        "duplicate",
      );
      expect(store.count("snapshots")).toBe(3);

      store.commitSnapshot({ ...envelope(3, 11), timelineId: restored.timelineId }, "round-2:tick-3");
      expect(store.latestSnapshot(restored.timelineId)?.payload.data).toEqual({ value: 11 });
      expect(store.count("snapshots")).toBe(4);
    });
  });

  describe("crash recovery", () => {
    const points: FailurePoint[] = ["before-transaction", "inside-transaction", "after-commit"];

    it.each(points)(
      "exposes only whole states after crashing at %s",
      (point) => {
        const directory = mkdtempSync(path.join(tmpdir(), "agent-life-crash-"));
        const filename = path.join(directory, "state.sqlite");
        try {
          const crashed = spawnSync(process.execPath, ["--import", "tsx", CRASH_WORKER, filename, point], {
            cwd: fileURLToPath(new URL("..", import.meta.url)),
            encoding: "utf8",
          });
          expect(crashed.status, crashed.stderr).toBe(point === "after-commit" ? 3 : 1);

          const store = new RuntimeStoreProbe(filename);
          store.registerPayloadSchema("1", "probe", PROBE_SCHEMA);
          const committed = point === "after-commit";
          expect(store.count("snapshots")).toBe(committed ? 1 : 0);
          expect(store.count("payloads")).toBe(committed ? 1 : 0);
          expect(store.count("idempotency_commits")).toBe(committed ? 1 : 0);
          expect(store.count("phase_records")).toBe(committed ? 1 : 0);
          expect(store.latestSnapshot("timeline-a")).toEqual(committed ? envelope(1, 1) : undefined);
          store.close();
        } finally {
          rmSync(directory, { recursive: true, force: true });
        }
        // Each case starts a real process with tsx, which costs seconds under a loaded suite.
      },
      60_000,
    );
  });
});
