import { asc, eq } from "drizzle-orm";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { Type, type TSchema } from "typebox";
import { Value } from "typebox/value";
import {
  RuntimeStoreProbe,
  parseStoredPayload,
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

export const configVersions = sqliteTable("config_versions", {
  identity: text("identity").primaryKey(),
  namespace: text("namespace").notNull(),
  packVersion: text("pack_version").notNull(),
  documentJson: text("document_json").notNull(),
});

export const currentConfig = sqliteTable("current_config", {
  slot: integer("slot").primaryKey(),
  identity: text("identity").notNull(),
});

export const evaluationTraces = sqliteTable("evaluation_traces", {
  id: integer("id").primaryKey(),
  idempotencyKey: text("idempotency_key").notNull(),
  requestId: text("request_id").notNull(),
  configIdentity: text("config_identity").notNull(),
  traceJson: text("trace_json").notNull(),
});

export const consumedEffects = sqliteTable("consumed_effects", {
  effectId: text("effect_id").primaryKey(),
  timelineId: text("timeline_id").notNull(),
  configIdentity: text("config_identity").notNull(),
});

export const RUNTIME_CONFIG_PAYLOAD_VERSION = "1";
export const RUNTIME_CONFIG_PAYLOAD_TYPE = "runtime-config";

/** Envelope schema of a stored runtime config document. */
export const runtimeConfigPayloadSchema: TSchema = Type.Object({
  kernelVersion: Type.String(),
  extensions: Type.Array(Type.Object({ ref: Type.String(), version: Type.String(), fingerprint: Type.String() })),
  packs: Type.Array(
    Type.Object({
      namespace: Type.String(),
      manifest: Type.Object({
        namespace: Type.String(),
        version: Type.String(),
        kernel: Type.String(),
        dependencies: Type.Array(Type.String()),
        extensions: Type.Array(Type.String()),
        sections: Type.Record(Type.String(), Type.String()),
      }),
      definitions: Type.Array(Type.Unknown()),
      rules: Type.Array(Type.Unknown()),
      derivations: Type.Array(Type.Unknown()),
    }),
  ),
});

export interface StoredRuntimeConfig {
  readonly identity: string;
  readonly namespace: string;
  readonly packVersion: string;
  readonly document: unknown;
}

/** Tables owned by the runtime store itself, as opposed to the stage 0 probe. */
export type StoreTable = "config_versions" | "current_config" | "evaluation_traces" | "consumed_effects";

export type SaveOutcome = "committed" | "duplicate";
export type ConsumeOutcome = "consumed" | "duplicate";

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
  saveRuntimeConfig(
    config: {
      readonly identity: string;
      readonly namespace: string;
      readonly packVersion: string;
      readonly document: unknown;
    },
    failurePoint?: FailurePoint,
  ): SaveOutcome {
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
        .insert(configVersions)
        .values({
          identity: config.identity,
          namespace: config.namespace,
          packVersion: config.packVersion,
          documentJson,
        })
        .onConflictDoNothing()
        .run();
      if (inserted.changes === 0) {
        const existing = tx
          .select({ documentJson: configVersions.documentJson })
          .from(configVersions)
          .where(eq(configVersions.identity, config.identity))
          .get();
        if (existing !== undefined && existing.documentJson !== documentJson)
          throw new Error(`Runtime config identity ${config.identity} already exists with different content`);
        if (existing === undefined) return "duplicate" as const;
      }
      tx.insert(currentConfig)
        .values({ slot: 1, identity: config.identity })
        .onConflictDoUpdate({ target: currentConfig.slot, set: { identity: config.identity } })
        .run();
      if (failurePoint === "inside-transaction") throw new Error("Injected failure inside transaction");
      return inserted.changes === 0 ? ("duplicate" as const) : ("committed" as const);
    });
    if (failurePoint === "after-commit") throw new Error("Injected failure after commit");
    return outcome;
  }

  currentRuntimeConfig(): StoredRuntimeConfig | undefined {
    const row = this.db
      .select({
        identity: configVersions.identity,
        namespace: configVersions.namespace,
        packVersion: configVersions.packVersion,
        documentJson: configVersions.documentJson,
      })
      .from(currentConfig)
      .innerJoin(configVersions, eq(currentConfig.identity, configVersions.identity))
      .where(eq(currentConfig.slot, 1))
      .get();
    if (row === undefined) return undefined;
    const payload = parseStoredPayload(row.documentJson, this.payloadSchemas());
    return {
      identity: row.identity,
      namespace: row.namespace,
      packVersion: row.packVersion,
      document: payload.data,
    };
  }

  /** Every runtime config version this store has committed, in identity order. */
  runtimeConfigHistory(): readonly {
    readonly identity: string;
    readonly namespace: string;
    readonly packVersion: string;
  }[] {
    return this.db
      .select({
        identity: configVersions.identity,
        namespace: configVersions.namespace,
        packVersion: configVersions.packVersion,
      })
      .from(configVersions)
      .orderBy(asc(configVersions.identity))
      .all();
  }

  configDocument(identity: string): unknown | undefined {
    const row = this.db
      .select({ documentJson: configVersions.documentJson })
      .from(configVersions)
      .where(eq(configVersions.identity, identity))
      .get();
    if (row === undefined) return undefined;
    return parseStoredPayload(row.documentJson, this.payloadSchemas()).data;
  }

  /** Restore preflight: the configuration version a saved state refers to. */
  checkRestore(identity: string): RestoreCheck {
    if (this.configDocument(identity) === undefined)
      return {
        ok: false,
        reason: "missing-config",
        message: `Runtime config version ${identity} is missing from the store`,
      };
    return { ok: true };
  }

  /** Stores one evaluation trace under an idempotency key. */
  recordEvaluationTrace(
    entry: {
      readonly requestId: string;
      readonly configIdentity: string;
      readonly trace: unknown;
    },
    idempotencyKey: string,
    failurePoint?: FailurePoint,
  ): SaveOutcome {
    if (failurePoint === "before-transaction") throw new Error("Injected failure before transaction");
    const outcome = this.db.transaction((tx) => {
      const inserted = tx
        .insert(evaluationTraces)
        .values({
          idempotencyKey,
          requestId: entry.requestId,
          configIdentity: entry.configIdentity,
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

  evaluationTrace(idempotencyKey: string): unknown | undefined {
    const row = this.db
      .select({ traceJson: evaluationTraces.traceJson })
      .from(evaluationTraces)
      .where(eq(evaluationTraces.idempotencyKey, idempotencyKey))
      .get();
    if (row === undefined) return undefined;
    return JSON.parse(row.traceJson) as unknown;
  }

  /** Claims a candidate effect for a timeline; the second claim is a duplicate. */
  consumeEffect(
    effectId: string,
    timelineId: string,
    configIdentity: string,
    failurePoint?: FailurePoint,
  ): ConsumeOutcome {
    if (failurePoint === "before-transaction") throw new Error("Injected failure before transaction");
    const outcome = this.db.transaction((tx) => {
      const inserted = tx
        .insert(consumedEffects)
        .values({ effectId, timelineId, configIdentity })
        .onConflictDoNothing()
        .run();
      if (failurePoint === "inside-transaction") throw new Error("Injected failure inside transaction");
      return inserted.changes === 0 ? ("duplicate" as const) : ("consumed" as const);
    });
    if (failurePoint === "after-commit") throw new Error("Injected failure after commit");
    return outcome;
  }

  private payloadSchemas(): Map<string, TSchema> {
    return new Map([[`${RUNTIME_CONFIG_PAYLOAD_VERSION}:${RUNTIME_CONFIG_PAYLOAD_TYPE}`, runtimeConfigPayloadSchema]]);
  }
}
