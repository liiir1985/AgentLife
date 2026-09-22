import { asc, eq } from "drizzle-orm";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { Type, type TSchema } from "typebox";
import { Value } from "typebox/value";
import {
  RuntimeStoreProbe,
  parseStoredPayload,
  timelines,
  type FailurePoint,
  type VersionedPayload,
} from "./runtime-store-probe.js";
import { currentMigrationLevel } from "./migrations.js";

/**
 * Runtime store: the durable side of the configuration infrastructure.
 *
 * It owns the current runtime config version, the version history, evaluation
 * traces and the identities of effects that were already consumed, and it
 * refuses to continue a restore whose configuration version is missing.
 */

export const configs = sqliteTable("config_versions", {
  identity: text("identity").primaryKey(),
  namespace: text("namespace").notNull(),
  packVersion: text("pack_version").notNull(),
  documentJson: text("document_json").notNull(),
});

export const currentConfig = sqliteTable("current_config", {
  slot: integer("slot").primaryKey(),
  identity: text("identity").notNull(),
});

export const runTraces = sqliteTable("evaluation_traces", {
  id: integer("id").primaryKey(),
  idempotencyKey: text("idempotency_key").notNull(),
  requestId: text("request_id").notNull(),
  configIdentity: text("config_identity").notNull(),
  traceJson: text("trace_json").notNull(),
});

export const claimedChanges = sqliteTable("consumed_effects", {
  effectId: text("effect_id").primaryKey(),
  timelineId: text("timeline_id").notNull(),
  configIdentity: text("config_identity").notNull(),
});

export const RUNTIME_CONFIG_PAYLOAD_VERSION = "1";
export const RUNTIME_CONFIG_PAYLOAD_TYPE = "runtime-config";
export const SIMULATION_SAVE_VERSION = "1";
export const SIMULATION_SAVE_TYPE = "simulation-save";

export const simulationSaves = sqliteTable("simulation_saves", {
  saveId: text("save_id").primaryKey(),
  timelineId: text("timeline_id").notNull(),
  tick: integer("tick").notNull(),
  configIdentity: text("config_identity").notNull(),
  payloadJson: text("payload_json").notNull(),
});

/**
 * Payload of one explicit save, as stored. The simulation state itself is
 * decoded by the simulation layer, which owns its shape.
 */
export const simulationSavePayloadSchema: TSchema = Type.Object({
  saveId: Type.String(),
  timelineId: Type.String(),
  tick: Type.Number(),
  phase: Type.String(),
  configId: Type.String(),
  systems: Type.Array(Type.Object({ systemId: Type.String(), version: Type.String(), specHash: Type.String() })),
  settings: Type.Object({
    tickSeconds: Type.Number(),
    maxPropagationRounds: Type.Number(),
    maxEvents: Type.Number(),
  }),
  state: Type.Unknown(),
});

/** Envelope schema of a stored runtime config document. */
export const runtimeConfigPayloadSchema: TSchema = Type.Object({
  kernelVersion: Type.String(),
  systems: Type.Array(Type.Object({ systemId: Type.String(), version: Type.String(), specHash: Type.String() })),
  packs: Type.Array(
    Type.Object({
      namespace: Type.String(),
      manifest: Type.Object({
        namespace: Type.String(),
        version: Type.String(),
        kernel: Type.String(),
        dependencies: Type.Array(Type.String()),
        systems: Type.Array(Type.String()),
        sections: Type.Record(Type.String(), Type.String()),
      }),
      items: Type.Array(Type.Unknown()),
      rules: Type.Array(Type.Unknown()),
      formulas: Type.Array(Type.Unknown()),
    }),
  ),
});

export interface StoredRuntimeConfig {
  readonly configId: string;
  readonly namespace: string;
  readonly packVersion: string;
  readonly document: unknown;
}

/** Tables owned by the runtime store itself, as opposed to the stage 0 probe. */
export type StoreTable = "config_versions" | "current_config" | "evaluation_traces" | "consumed_effects";

export type SaveResult = "committed" | "duplicate";
export type ClaimResult = "claimed" | "duplicate";

export type RestoreCheck =
  { readonly ok: true } | { readonly ok: false; readonly reason: "missing-config"; readonly message: string };

export class RuntimeStore extends RuntimeStoreProbe {
  constructor(filename: string) {
    super(filename);
    this.registerPayloadSchema(RUNTIME_CONFIG_PAYLOAD_VERSION, RUNTIME_CONFIG_PAYLOAD_TYPE, runtimeConfigPayloadSchema);
  }

  migrationLevel(): number {
    return currentMigrationLevel(this.sqlite);
  }

  /** Row count of a store table, used as the observable state fingerprint. */
  countStored(table: StoreTable): number {
    const row = this.sqlite.prepare(`SELECT count(*) AS value FROM ${table}`).get();
    const value = row?.["value"];
    return typeof value === "number" ? value : Number(value ?? 0);
  }

  /**
   * Commits a new runtime config version and makes it current in one
   * transaction: a crash either leaves the previous version current or the
   * complete new one, never a partially applied update.
   */
  saveConfig(
    config: {
      readonly configId: string;
      readonly namespace: string;
      readonly packVersion: string;
      readonly document: unknown;
    },
    failurePoint?: FailurePoint,
  ): SaveResult {
    const payload: VersionedPayload = {
      schemaVersion: RUNTIME_CONFIG_PAYLOAD_VERSION,
      type: RUNTIME_CONFIG_PAYLOAD_TYPE,
      data: config.document,
    };
    if (!Value.Check(runtimeConfigPayloadSchema, config.document))
      throw new Error("Runtime config document does not match its declared envelope");
    if (failurePoint === "before-transaction") throw new Error("Injected failure before transaction");
    const documentJson = JSON.stringify(payload);
    const outcome = this.db.transaction((tx) => {
      const inserted = tx
        .insert(configs)
        .values({
          identity: config.configId,
          namespace: config.namespace,
          packVersion: config.packVersion,
          documentJson,
        })
        .onConflictDoNothing()
        .run();
      if (inserted.changes === 0) {
        const existing = tx
          .select({ documentJson: configs.documentJson })
          .from(configs)
          .where(eq(configs.identity, config.configId))
          .get();
        if (existing !== undefined && existing.documentJson !== documentJson)
          throw new Error(`Runtime config ${config.configId} already exists with different content`);
        if (existing === undefined) return "duplicate" as const;
      }
      tx.insert(currentConfig)
        .values({ slot: 1, identity: config.configId })
        .onConflictDoUpdate({ target: currentConfig.slot, set: { identity: config.configId } })
        .run();
      if (failurePoint === "inside-transaction") throw new Error("Injected failure inside transaction");
      return inserted.changes === 0 ? ("duplicate" as const) : ("committed" as const);
    });
    if (failurePoint === "after-commit") throw new Error("Injected failure after commit");
    return outcome;
  }

  currentConfig(): StoredRuntimeConfig | undefined {
    const row = this.db
      .select({
        identity: configs.identity,
        namespace: configs.namespace,
        packVersion: configs.packVersion,
        documentJson: configs.documentJson,
      })
      .from(currentConfig)
      .innerJoin(configs, eq(currentConfig.identity, configs.identity))
      .where(eq(currentConfig.slot, 1))
      .get();
    if (row === undefined) return undefined;
    const payload = parseStoredPayload(row.documentJson, this.payloadSchemas());
    return {
      configId: row.identity,
      namespace: row.namespace,
      packVersion: row.packVersion,
      document: payload.data,
    };
  }

  /** Every runtime config version this store has committed, in identity order. */
  configHistory(): readonly {
    readonly configId: string;
    readonly namespace: string;
    readonly packVersion: string;
  }[] {
    return this.db
      .select({
        configId: configs.identity,
        namespace: configs.namespace,
        packVersion: configs.packVersion,
      })
      .from(configs)
      .orderBy(asc(configs.identity))
      .all();
  }

  loadConfig(configId: string): unknown | undefined {
    const row = this.db
      .select({ documentJson: configs.documentJson })
      .from(configs)
      .where(eq(configs.identity, configId))
      .get();
    if (row === undefined) return undefined;
    return parseStoredPayload(row.documentJson, this.payloadSchemas()).data;
  }

  /** Restore preflight: the configuration version a saved state refers to. */
  checkRestore(configId: string): RestoreCheck {
    if (this.loadConfig(configId) === undefined)
      return {
        ok: false,
        reason: "missing-config",
        message: `Runtime config version ${configId} is missing from the store`,
      };
    return { ok: true };
  }

  /** Stores one evaluation trace under an idempotency key. */
  saveRunTrace(
    entry: {
      readonly runId: string;
      readonly configId: string;
      readonly trace: unknown;
    },
    idempotencyKey: string,
    failurePoint?: FailurePoint,
  ): SaveResult {
    if (failurePoint === "before-transaction") throw new Error("Injected failure before transaction");
    const outcome = this.db.transaction((tx) => {
      const inserted = tx
        .insert(runTraces)
        .values({
          idempotencyKey,
          requestId: entry.runId,
          configIdentity: entry.configId,
          traceJson: JSON.stringify(entry.trace),
        })
        .onConflictDoNothing()
        .run();
      if (failurePoint === "inside-transaction") throw new Error("Injected failure inside transaction");
      return inserted.changes === 0 ? ("duplicate" as const) : ("committed" as const);
    });
    if (failurePoint === "after-commit") throw new Error("Injected failure after commit");
    return outcome;
  }

  loadRunTrace(idempotencyKey: string): unknown | undefined {
    const row = this.db
      .select({ traceJson: runTraces.traceJson })
      .from(runTraces)
      .where(eq(runTraces.idempotencyKey, idempotencyKey))
      .get();
    if (row === undefined) return undefined;
    return JSON.parse(row.traceJson) as unknown;
  }

  /** Claims a candidate effect for a timeline; the second claim is a duplicate. */
  claimChange(changeId: string, timelineId: string, configId: string, failurePoint?: FailurePoint): ClaimResult {
    if (failurePoint === "before-transaction") throw new Error("Injected failure before transaction");
    const outcome = this.db.transaction((tx) => {
      const inserted = tx
        .insert(claimedChanges)
        .values({ effectId: changeId, timelineId, configIdentity: configId })
        .onConflictDoNothing()
        .run();
      if (failurePoint === "inside-transaction") throw new Error("Injected failure inside transaction");
      return inserted.changes === 0 ? ("duplicate" as const) : ("claimed" as const);
    });
    if (failurePoint === "after-commit") throw new Error("Injected failure after commit");
    return outcome;
  }

  /**
   * Commits one explicit save. The whole save — its timeline row, its payload and
   * its index row — lands in one SQLite transaction, so a crash leaves either the
   * complete save or no save at all.
   */
  saveSimulation(save: {
    readonly saveId: string;
    readonly timelineId: string;
    readonly tick: number;
    readonly configId: string;
    readonly payload: VersionedPayload;
  }): SaveResult {
    if (!Value.Check(simulationSavePayloadSchema, save.payload.data))
      throw new Error("Simulation save does not match its declared payload");
    const payloadJson = JSON.stringify(save.payload);
    return this.db.transaction((tx) => {
      const existing = tx
        .select({ payloadJson: simulationSaves.payloadJson })
        .from(simulationSaves)
        .where(eq(simulationSaves.saveId, save.saveId))
        .get();
      if (existing !== undefined) {
        if (existing.payloadJson !== payloadJson)
          throw new Error(`Save ${save.saveId} already exists with different content`);
        return "duplicate" as const;
      }
      tx.insert(timelines).values({ timelineId: save.timelineId }).onConflictDoNothing().run();
      tx.insert(simulationSaves)
        .values({
          saveId: save.saveId,
          timelineId: save.timelineId,
          tick: save.tick,
          configIdentity: save.configId,
          payloadJson,
        })
        .run();
      return "committed" as const;
    });
  }

  /** Reads one explicit save back; `undefined` when the save does not exist. */
  loadSimulation(saveId: string): VersionedPayload | undefined {
    const row = this.db
      .select({ payloadJson: simulationSaves.payloadJson })
      .from(simulationSaves)
      .where(eq(simulationSaves.saveId, saveId))
      .get();
    if (row === undefined) return undefined;
    return parseStoredPayload(
      row.payloadJson,
      new Map([[`${SIMULATION_SAVE_VERSION}:${SIMULATION_SAVE_TYPE}`, simulationSavePayloadSchema]]),
    );
  }

  /** Every explicit save this store holds, in save-id order. */
  listSaves(): readonly {
    readonly saveId: string;
    readonly timelineId: string;
    readonly tick: number;
    readonly configId: string;
  }[] {
    return this.db
      .select({
        saveId: simulationSaves.saveId,
        timelineId: simulationSaves.timelineId,
        tick: simulationSaves.tick,
        configId: simulationSaves.configIdentity,
      })
      .from(simulationSaves)
      .orderBy(asc(simulationSaves.saveId))
      .all();
  }

  private payloadSchemas(): Map<string, TSchema> {
    return new Map([[`${RUNTIME_CONFIG_PAYLOAD_VERSION}:${RUNTIME_CONFIG_PAYLOAD_TYPE}`, runtimeConfigPayloadSchema]]);
  }
}
