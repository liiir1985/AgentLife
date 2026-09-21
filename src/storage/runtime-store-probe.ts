import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { desc, eq, sql } from "drizzle-orm";
import { drizzle, type NodeSQLiteDatabase } from "drizzle-orm/node-sqlite";
import { integer, sqliteTable, text, type AnySQLiteColumn, type SQLiteTable } from "drizzle-orm/sqlite-core";
import type { TSchema } from "typebox";
import { Value } from "typebox/value";

export const timelines = sqliteTable("timelines", {
  timelineId: text("timeline_id").primaryKey(),
  parentTimelineId: text("parent_timeline_id").references((): AnySQLiteColumn => timelines.timelineId),
});

export const payloads = sqliteTable("payloads", {
  id: integer("id").primaryKey(),
  schemaVersion: text("schema_version").notNull(),
  payloadType: text("payload_type").notNull(),
  payloadJson: text("payload_json").notNull(),
});

export const snapshots = sqliteTable("snapshots", {
  id: integer("id").primaryKey(),
  timelineId: text("timeline_id")
    .notNull()
    .references(() => timelines.timelineId),
  tick: integer("tick").notNull(),
  phase: text("phase").notNull(),
  payloadJson: text("payload_json").notNull(),
});

export const idempotencyCommits = sqliteTable("idempotency_commits", {
  idempotencyKey: text("idempotency_key").primaryKey(),
  timelineId: text("timeline_id")
    .notNull()
    .references(() => timelines.timelineId),
});

export const phaseRecords = sqliteTable("phase_records", {
  id: integer("id").primaryKey(),
  timelineId: text("timeline_id")
    .notNull()
    .references(() => timelines.timelineId),
  tick: integer("tick").notNull(),
  phase: text("phase").notNull(),
  idempotencyKey: text("idempotency_key")
    .notNull()
    .unique()
    .references(() => idempotencyCommits.idempotencyKey),
});

export type ProbeTable = "snapshots" | "phase_records" | "idempotency_commits" | "payloads" | "timelines";

export interface VersionedPayload<T = unknown> {
  readonly schemaVersion: string;
  readonly type: string;
  readonly data: T;
}

export interface SnapshotEnvelope {
  readonly timelineId: string;
  readonly tick: number;
  readonly phase: string;
  readonly payload: VersionedPayload;
}

export type CommitOutcome = "committed" | "duplicate";

/** Injected crash points used to prove that recovery only ever exposes whole states. */
export type FailurePoint = "before-transaction" | "inside-transaction" | "after-commit";

export type PayloadSchemas = ReadonlyMap<string, TSchema>;

/**
 * Parse a stored payload and validate it against the registered TypeBox schema.
 * Unknown schema versions, malformed JSON and schema violations all fail loudly.
 */
export function parseStoredPayload(text: string, schemas: PayloadSchemas): VersionedPayload {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("Stored payload is not valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null) throw new Error("Stored payload envelope is invalid");
  const envelope = parsed as { schemaVersion?: unknown; type?: unknown; data?: unknown };
  if (typeof envelope.schemaVersion !== "string" || typeof envelope.type !== "string") {
    throw new Error("Stored payload envelope is invalid");
  }
  const schema = schemas.get(`${envelope.schemaVersion}:${envelope.type}`);
  if (schema === undefined) throw new Error(`Unknown payload schema: ${envelope.schemaVersion}:${envelope.type}`);
  if (!Value.Check(schema, envelope.data)) {
    throw new Error(`Stored payload violates schema: ${envelope.schemaVersion}:${envelope.type}`);
  }
  return { schemaVersion: envelope.schemaVersion, type: envelope.type, data: envelope.data };
}

/**
 * SQLite probe built on `node:sqlite` with the Drizzle Node SQLite driver.
 *
 * Foreign keys, WAL and a busy timeout are enabled up front; the probe's whole
 * point is that snapshot, phase record and idempotency identity commit together.
 */
export class RuntimeStoreProbe {
  readonly sqlite: DatabaseSync;
  readonly db: NodeSQLiteDatabase;
  private readonly schemas = new Map<string, TSchema>();

  constructor(readonly filename: string) {
    this.sqlite = new DatabaseSync(filename);
    this.sqlite.exec("PRAGMA foreign_keys = ON");
    this.sqlite.exec("PRAGMA journal_mode = WAL");
    this.sqlite.exec("PRAGMA busy_timeout = 1000");
    this.db = drizzle({ client: this.sqlite });
    this.migrate();
  }

  registerPayloadSchema(schemaVersion: string, type: string, schema: TSchema): void {
    this.schemas.set(`${schemaVersion}:${type}`, schema);
  }

  initializeTimeline(timelineId: string = randomUUID()): string {
    this.db.insert(timelines).values({ timelineId }).onConflictDoNothing().run();
    return timelineId;
  }

  /** Commit a snapshot, its phase record and its idempotency identity atomically. */
  commitSnapshot(envelope: SnapshotEnvelope, idempotencyKey: string, failurePoint?: FailurePoint): CommitOutcome {
    this.assertPayload(envelope.payload);
    if (failurePoint === "before-transaction") throw new Error("Injected failure before transaction");
    const payloadJson = JSON.stringify(envelope.payload);
    const outcome = this.db.transaction((tx) => {
      const claim = tx
        .insert(idempotencyCommits)
        .values({ idempotencyKey, timelineId: envelope.timelineId })
        .onConflictDoNothing()
        .run();
      if (claim.changes === 0) return "duplicate" as const;
      tx.insert(payloads)
        .values({ schemaVersion: envelope.payload.schemaVersion, payloadType: envelope.payload.type, payloadJson })
        .run();
      tx.insert(snapshots)
        .values({ timelineId: envelope.timelineId, tick: envelope.tick, phase: envelope.phase, payloadJson })
        .run();
      tx.insert(phaseRecords)
        .values({ timelineId: envelope.timelineId, tick: envelope.tick, phase: envelope.phase, idempotencyKey })
        .run();
      if (failurePoint === "inside-transaction") throw new Error("Injected failure inside transaction");
      return "committed" as const;
    });
    if (failurePoint === "after-commit") throw new Error("Injected failure after commit");
    return outcome;
  }

  latestSnapshot(timelineId: string): SnapshotEnvelope | undefined {
    const row = this.db
      .select({
        timelineId: snapshots.timelineId,
        tick: snapshots.tick,
        phase: snapshots.phase,
        payloadJson: snapshots.payloadJson,
      })
      .from(snapshots)
      .where(eq(snapshots.timelineId, timelineId))
      .orderBy(desc(snapshots.tick), desc(snapshots.id))
      .limit(1)
      .get();
    if (row === undefined) return undefined;
    return {
      timelineId: row.timelineId,
      tick: row.tick,
      phase: row.phase,
      payload: parseStoredPayload(row.payloadJson, this.schemas),
    };
  }

  /** Restore the latest snapshot of a timeline into a brand new child timeline. */
  restoreAsNewTimeline(sourceTimelineId: string): SnapshotEnvelope {
    const source = this.latestSnapshot(sourceTimelineId);
    if (source === undefined) throw new Error(`No snapshot for timeline ${sourceTimelineId}`);
    const timelineId = randomUUID();
    const payloadJson = JSON.stringify(source.payload);
    this.db.transaction((tx) => {
      tx.insert(timelines).values({ timelineId, parentTimelineId: sourceTimelineId }).run();
      tx.insert(snapshots).values({ timelineId, tick: source.tick, phase: source.phase, payloadJson }).run();
    });
    return { timelineId, tick: source.tick, phase: source.phase, payload: source.payload };
  }

  /** Number of rows in a probe table, used as the observable state fingerprint. */
  count(table: ProbeTable): number {
    const row = this.db
      .select({ value: sql<number>`count(*)` })
      .from(TABLE_BY_NAME[table])
      .get();
    return row?.value ?? 0;
  }

  close(): void {
    this.sqlite.close();
  }

  private assertPayload(payload: VersionedPayload): void {
    const schema = this.schemas.get(`${payload.schemaVersion}:${payload.type}`);
    if (schema === undefined) {
      throw new Error(`Unknown payload schema: ${payload.schemaVersion}:${payload.type}`);
    }
    if (!Value.Check(schema, payload.data)) {
      throw new Error(`Invalid payload: ${payload.schemaVersion}:${payload.type}`);
    }
  }

  private migrate(): void {
    this.sqlite.exec(`
      CREATE TABLE IF NOT EXISTS timelines (
        timeline_id TEXT PRIMARY KEY,
        parent_timeline_id TEXT REFERENCES timelines(timeline_id)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS payloads (
        id INTEGER PRIMARY KEY,
        schema_version TEXT NOT NULL,
        payload_type TEXT NOT NULL,
        payload_json TEXT NOT NULL CHECK(json_valid(payload_json))
      ) STRICT;
      CREATE TABLE IF NOT EXISTS snapshots (
        id INTEGER PRIMARY KEY,
        timeline_id TEXT NOT NULL REFERENCES timelines(timeline_id),
        tick INTEGER NOT NULL,
        phase TEXT NOT NULL,
        payload_json TEXT NOT NULL CHECK(json_valid(payload_json))
      ) STRICT;
      CREATE TABLE IF NOT EXISTS idempotency_commits (
        idempotency_key TEXT PRIMARY KEY,
        timeline_id TEXT NOT NULL REFERENCES timelines(timeline_id)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS phase_records (
        id INTEGER PRIMARY KEY,
        timeline_id TEXT NOT NULL REFERENCES timelines(timeline_id),
        tick INTEGER NOT NULL,
        phase TEXT NOT NULL,
        idempotency_key TEXT NOT NULL UNIQUE REFERENCES idempotency_commits(idempotency_key)
      ) STRICT;
    `);
  }
}

const TABLE_BY_NAME: Record<ProbeTable, SQLiteTable> = {
  timelines,
  payloads,
  snapshots,
  idempotency_commits: idempotencyCommits,
  phase_records: phaseRecords,
};
