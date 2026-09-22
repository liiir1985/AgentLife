import type { DatabaseSync } from "node:sqlite";

/**
 * Versioned migrations for the runtime store.
 *
 * Migration 1 is exactly the schema the phase 0 spike proved (snapshot, phase
 * record and idempotency identity commit together); later stages add their own
 * tables on top. `PRAGMA user_version` records the applied level, and every
 * migration runs in its own transaction, so a crash can only leave the database
 * at a complete earlier level.
 */
export interface Migration {
  readonly version: number;
  readonly name: string;
  readonly statements: string;
}

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: "snapshot-and-idempotency",
    statements: `
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
    `,
  },
  {
    version: 2,
    name: "runtime-configuration",
    statements: `
      CREATE TABLE IF NOT EXISTS config_versions (
        identity TEXT PRIMARY KEY,
        namespace TEXT NOT NULL,
        pack_version TEXT NOT NULL,
        document_json TEXT NOT NULL CHECK(json_valid(document_json))
      ) STRICT;
      CREATE TABLE IF NOT EXISTS current_config (
        slot INTEGER PRIMARY KEY CHECK(slot = 1),
        identity TEXT NOT NULL REFERENCES config_versions(identity)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS evaluation_traces (
        id INTEGER PRIMARY KEY,
        idempotency_key TEXT NOT NULL UNIQUE,
        request_id TEXT NOT NULL,
        config_identity TEXT NOT NULL,
        trace_json TEXT NOT NULL CHECK(json_valid(trace_json))
      ) STRICT;
      CREATE TABLE IF NOT EXISTS consumed_effects (
        effect_id TEXT PRIMARY KEY,
        timeline_id TEXT NOT NULL REFERENCES timelines(timeline_id),
        config_identity TEXT NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS evaluation_traces_request ON evaluation_traces(request_id);
    `,
  },
];

export function currentMigrationLevel(sqlite: DatabaseSync): number {
  const row = sqlite.prepare("PRAGMA user_version").get() as { user_version?: number } | undefined;
  return row?.user_version ?? 0;
}

/**
 * Applies every migration above the recorded level, in version order.
 * Returns the level the database now has.
 */
export function applyMigrations(sqlite: DatabaseSync): number {
  let level = currentMigrationLevel(sqlite);
  for (const migration of MIGRATIONS) {
    if (migration.version <= level) continue;
    sqlite.exec("BEGIN");
    try {
      sqlite.exec(migration.statements);
      sqlite.exec(`PRAGMA user_version = ${migration.version}`);
      sqlite.exec("COMMIT");
    } catch (failure) {
      sqlite.exec("ROLLBACK");
      throw failure;
    }
    level = migration.version;
  }
  return level;
}

/** Tables owned by the runtime store, used by schema alignment tests. */
export const STORE_TABLES: readonly string[] = [
  "timelines",
  "payloads",
  "snapshots",
  "idempotency_commits",
  "phase_records",
  "config_versions",
  "current_config",
  "evaluation_traces",
  "consumed_effects",
];
