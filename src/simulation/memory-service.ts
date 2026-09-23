import type {
  IntentionRecord,
  Observation,
  WorkingMemoryEntry,
  WorkingMemoryRecord,
  WorkingMemoryState,
} from "./types.js";

/**
 * Working Memory: the only door into a cognition call.
 *
 * Observations and intentions become entries here and nowhere else. An entry
 * carries the rendered line the model reads, the observer-local reference it may
 * quote back and the protected anchor that quote is mapped onto, so the model can
 * act on what it was given without ever addressing the world directly.
 *
 * Capacity is a hard bound, not a hint: when more material arrives than fits, the
 * service keeps the entries a deterministic order ranks highest and drops the
 * rest, and an entry the entity confirmed it used leaves Working Memory entirely.
 */

export interface AdmissionInput {
  readonly characterId: string;
  readonly tick: number;
  /** How many observation entries this entity may hold at once. */
  readonly capacity: number;
  /** Observations the perception stream currently offers. */
  readonly observations: readonly Observation[];
  /** Observer-local reference per anchor, as perception allocated it. */
  readonly references: Readonly<Record<string, string>>;
}

export interface IntentionAdmissionInput {
  readonly characterId: string;
  readonly tick: number;
  /** How many intention references this entity may hold at once. */
  readonly reservation: number;
  readonly intentions: readonly IntentionRecord[];
}

export interface AdmissionResult {
  readonly state: WorkingMemoryState;
  readonly admitted: readonly WorkingMemoryEntry[];
  readonly evicted: readonly string[];
  readonly notes: readonly string[];
}

/** Ranking order of one entry: salience first, then recency, then stable identity. */
function rank(left: WorkingMemoryEntry, right: WorkingMemoryEntry): number {
  return (
    right.salience - left.salience ||
    right.admittedTick - left.admittedTick ||
    left.entryId.localeCompare(right.entryId)
  );
}

function bumpVersion(version: string): string {
  const separator = version.lastIndexOf("-");
  const count = separator < 0 ? Number.NaN : Number(version.slice(separator + 1));
  return Number.isFinite(count) ? `${version.slice(0, separator)}-${count + 1}` : `${version}-1`;
}

export class WorkingMemoryService {
  /** One empty Working Memory per entity that takes part in cognition at all. */
  create(characterIds: readonly string[]): WorkingMemoryState {
    const records: Record<string, WorkingMemoryRecord> = {};
    for (const characterId of [...characterIds].sort())
      records[characterId] = Object.freeze({ entries: Object.freeze([]), sequence: 0, consumed: Object.freeze([]) });
    return Object.freeze({ version: "memory-1", records: Object.freeze(records) });
  }

  record(state: WorkingMemoryState, characterId: string): WorkingMemoryRecord | undefined {
    return state.records[characterId];
  }

  /** What cognition of one entity may see: the admitted entries, in stable order. */
  contextFor(state: WorkingMemoryState, characterId: string): readonly WorkingMemoryEntry[] {
    return state.records[characterId]?.entries ?? [];
  }

  private keep(
    state: WorkingMemoryState,
    characterId: string,
    record: WorkingMemoryRecord,
    entries: readonly WorkingMemoryEntry[],
    limit: number,
    consumed: readonly string[],
  ): AdmissionResult {
    const ordered = [...entries].sort(rank);
    const kept = ordered.slice(0, limit).sort((left, right) => left.entryId.localeCompare(right.entryId));
    const evicted = ordered.slice(limit).map((entry) => entry.entryId);
    const next: WorkingMemoryState = Object.freeze({
      ...state,
      version: bumpVersion(state.version),
      records: Object.freeze({
        ...state.records,
        [characterId]: Object.freeze({ ...record, entries: Object.freeze(kept), consumed: Object.freeze(consumed) }),
      }),
    });
    return {
      state: next,
      admitted: Object.freeze(kept.filter((entry) => !record.entries.some((prior) => prior.entryId === entry.entryId))),
      evicted: Object.freeze(evicted),
      notes: Object.freeze(
        evicted.length === 0 ? [] : [`${characterId} dropped ${evicted.length} entr(ies) at capacity ${limit}`],
      ),
    };
  }

  /**
   * Admits the observations that are not yet in Working Memory.
   *
   * Only what was actually admitted may reach a model: the pending stream of one
   * observer is the input, the capacity is the bound, and material that does not
   * fit is dropped by the deterministic order rather than kept as a hidden backlog.
   */
  admitObservations(state: WorkingMemoryState, input: AdmissionInput): AdmissionResult {
    const record = state.records[input.characterId];
    if (record === undefined)
      return { state, admitted: Object.freeze([]), evicted: Object.freeze([]), notes: Object.freeze([]) };
    const known = new Set(record.entries.map((entry) => entry.sourceId));
    let sequence = record.sequence;
    const added: WorkingMemoryEntry[] = [];
    for (const observation of input.observations) {
      if (known.has(observation.observationId)) continue;
      known.add(observation.observationId);
      sequence += 1;
      const anchor = observation.subject?.anchor ?? null;
      added.push(
        Object.freeze({
          entryId: `${input.characterId}/wm-${sequence}`,
          kind: "observation" as const,
          sourceId: observation.observationId,
          admittedTick: input.tick,
          salience: observation.salience,
          text: observation.text,
          anchor,
          reference: observation.subject?.reference ?? null,
          role: observation.subject?.role ?? null,
        }),
      );
    }
    const observationEntries = record.entries.filter((entry) => entry.kind === "observation");
    const intentionEntries = record.entries.filter((entry) => entry.kind === "intention");
    const result = this.keep(
      state,
      input.characterId,
      { ...record, sequence },
      [...observationEntries, ...added, ...intentionEntries],
      input.capacity + intentionEntries.length,
      record.consumed,
    );
    return {
      ...result,
      notes: Object.freeze([
        ...result.notes,
        ...(added.length === 0 ? [] : [`${input.characterId} admitted ${added.length} observation(s)`]),
      ]),
    };
  }

  /** Keeps the active intentions of one entity as quotable references. */
  admitIntentions(state: WorkingMemoryState, input: IntentionAdmissionInput): AdmissionResult {
    const record = state.records[input.characterId];
    if (record === undefined)
      return { state, admitted: Object.freeze([]), evicted: Object.freeze([]), notes: Object.freeze([]) };
    const observationEntries = record.entries.filter((entry) => entry.kind === "observation");
    let sequence = record.sequence;
    const entries: WorkingMemoryEntry[] = [];
    for (const intention of [...input.intentions].sort((left, right) =>
      left.intentionId.localeCompare(right.intentionId),
    )) {
      if (intention.status !== "active" && intention.status !== "paused") continue;
      sequence += 1;
      entries.push(
        Object.freeze({
          entryId: `${input.characterId}/wm-${sequence}`,
          kind: "intention" as const,
          sourceId: intention.intentionId,
          admittedTick: input.tick,
          salience: Number.MAX_SAFE_INTEGER,
          text: `${intention.intentionId}（${intention.content}）`,
          anchor: null,
          reference: intention.intentionId,
          role: null,
        }),
      );
    }
    return this.keep(
      state,
      input.characterId,
      { ...record, sequence },
      [...observationEntries, ...entries],
      observationEntries.length + input.reservation,
      record.consumed,
    );
  }

  /**
   * Records what the entity confirmed it used and releases those entries.
   *
   * A confirmation names entry identities, never content: an entity cannot free an
   * entry it was not admitted, and an unknown identity is ignored rather than
   * treated as a consumption.
   */
  confirmUsage(
    state: WorkingMemoryState,
    input: { readonly characterId: string; readonly entryIds: readonly string[] },
  ): { readonly state: WorkingMemoryState; readonly confirmed: readonly string[] } {
    const record = state.records[input.characterId];
    if (record === undefined || input.entryIds.length === 0) return { state, confirmed: Object.freeze([]) };
    const named = new Set(input.entryIds);
    const confirmed = record.entries.filter((entry) => named.has(entry.entryId)).map((entry) => entry.entryId);
    if (confirmed.length === 0) return { state, confirmed: Object.freeze([]) };
    const released = new Set(confirmed);
    return {
      state: Object.freeze({
        ...state,
        version: bumpVersion(state.version),
        records: Object.freeze({
          ...state.records,
          [input.characterId]: Object.freeze({
            ...record,
            entries: Object.freeze(record.entries.filter((entry) => !released.has(entry.entryId))),
            consumed: Object.freeze([...confirmed].sort()),
          }),
        }),
      }),
      confirmed: Object.freeze(confirmed),
    };
  }

  /** The entry of one observer-local reference, so a model quote maps onto an anchor. */
  entryForReference(state: WorkingMemoryState, characterId: string, reference: string): WorkingMemoryEntry | undefined {
    return state.records[characterId]?.entries.find((entry) => entry.reference === reference);
  }

  /** The entry that stands for one observation, if it was admitted at all. */
  entryForObservation(
    state: WorkingMemoryState,
    characterId: string,
    observationId: string,
  ): WorkingMemoryEntry | undefined {
    return state.records[characterId]?.entries.find(
      (entry) => entry.kind === "observation" && entry.sourceId === observationId,
    );
  }
}
