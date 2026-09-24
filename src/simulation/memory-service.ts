import type {
  IntentionRecord,
  MemoryTrace,
  Observation,
  ProfileAssertion,
  ProfileClaim,
  SubjectiveProfile,
  WorkingMemoryEntry,
  WorkingMemoryRecord,
  WorkingMemoryState,
} from "./types.js";
import { cosineSimilarity } from "../agent/embedding-provider.js";

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
  constructor(
    private readonly loads: Readonly<Record<WorkingMemoryEntry["kind"], number>> = {
      observation: 1,
      intention: 1,
      recollection: 1,
      reflection: 1,
    },
  ) {}

  private load(entry: WorkingMemoryEntry): number {
    return this.loads[entry.kind];
  }

  /** One empty Working Memory per entity that takes part in cognition at all. */
  create(characterIds: readonly string[]): WorkingMemoryState {
    const records: Record<string, WorkingMemoryRecord> = {};
    for (const characterId of [...characterIds].sort())
      records[characterId] = Object.freeze({
        entries: Object.freeze([]),
        sequence: 0,
        consumed: Object.freeze([]),
        recent: Object.freeze([]),
        longTerm: Object.freeze([]),
        profiles: Object.freeze([]),
        traceSequence: 0,
        archived: Object.freeze([]),
      });
    return Object.freeze({ version: "memory-1", records: Object.freeze(records) });
  }

  record(state: WorkingMemoryState, characterId: string): WorkingMemoryRecord | undefined {
    return state.records[characterId];
  }

  /** What cognition of one entity may see: the admitted entries, in stable order. */
  contextFor(state: WorkingMemoryState, characterId: string): readonly WorkingMemoryEntry[] {
    return state.records[characterId]?.entries ?? [];
  }

  /** A new subjective reflection must fit before it can become a persistent trace. */
  admitReflection(
    state: WorkingMemoryState,
    characterId: string,
    tick: number,
    references: readonly string[],
    text: string,
    generalCapacity: number,
  ): { readonly state: WorkingMemoryState; readonly admitted: boolean } {
    const record = state.records[characterId];
    if (record === undefined) return { state, admitted: false };
    const sources = references.map((reference) =>
      record.entries.find((entry) => entry.kind === "observation" && entry.reference === reference),
    );
    if (sources.length === 0 || sources.some((entry) => entry === undefined) || text.trim() === "")
      return { state, admitted: false };
    const sequence = record.sequence + 1;
    const entry: WorkingMemoryEntry = Object.freeze({
      entryId: `${characterId}/wm-${sequence}`,
      kind: "reflection",
      sourceId: sources
        .map((source) => source!.sourceId)
        .sort()
        .join("|"),
      admittedTick: tick,
      salience: Number.MAX_SAFE_INTEGER - 1,
      text,
      anchor: sources[0]?.anchor ?? null,
      reference: null,
      role: null,
    });
    const intentions = record.entries.filter((candidate) => candidate.kind === "intention");
    const focused = new Set(sources.map((source) => source!.entryId));
    const candidates = record.entries.map((candidate) =>
      focused.has(candidate.entryId)
        ? Object.freeze({ ...candidate, salience: Number.MAX_SAFE_INTEGER - 2 })
        : candidate,
    );
    const result = this.keep(
      state,
      characterId,
      { ...record, sequence },
      [...candidates, entry],
      generalCapacity + intentions.reduce((total, candidate) => total + this.load(candidate), 0),
      record.consumed,
    );
    const kept = result.state.records[characterId]?.entries ?? [];
    return {
      state: result.state,
      admitted:
        kept.some((candidate) => candidate.entryId === entry.entryId) &&
        sources.every((source) => kept.some((candidate) => candidate.entryId === source!.entryId)),
    };
  }

  /** A search hit becomes recall only if general Working Memory has room for it. */
  admitRecollections(
    state: WorkingMemoryState,
    characterId: string,
    tick: number,
    traces: readonly MemoryTrace[],
    generalCapacity: number,
  ): {
    readonly state: WorkingMemoryState;
    readonly admittedTraceIds: readonly string[];
    readonly evictedObservationIds: readonly string[];
  } {
    const record = state.records[characterId];
    if (record === undefined) return { state, admittedTraceIds: [], evictedObservationIds: [] };
    const intentionEntries = record.entries.filter((entry) => entry.kind === "intention");
    let sequence = record.sequence;
    const added: WorkingMemoryEntry[] = traces
      .filter(
        (trace) => !record.entries.some((entry) => entry.kind === "recollection" && entry.sourceId === trace.traceId),
      )
      .map((trace) => {
        sequence += 1;
        return Object.freeze({
          entryId: `${characterId}/wm-${sequence}`,
          kind: "recollection" as const,
          sourceId: trace.traceId,
          admittedTick: tick,
          salience: 1,
          text: trace.text,
          anchor: null,
          reference: trace.traceId,
          role: null,
        });
      });
    const result = this.keep(
      state,
      characterId,
      { ...record, sequence },
      [...record.entries.filter((entry) => entry.kind !== "intention"), ...added, ...intentionEntries],
      generalCapacity + intentionEntries.reduce((total, entry) => total + this.load(entry), 0),
      record.consumed,
    );
    const current = result.state.records[characterId]?.entries ?? [];
    return {
      state: result.state,
      admittedTraceIds: Object.freeze(
        traces
          .filter((trace) => current.some((entry) => entry.kind === "recollection" && entry.sourceId === trace.traceId))
          .map((trace) => trace.traceId),
      ),
      evictedObservationIds: Object.freeze(
        record.entries
          .filter((entry) => entry.kind === "observation" && result.evicted.includes(entry.entryId))
          .map((entry) => entry.sourceId),
      ),
    };
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
    let occupied = 0;
    const keptByRank = ordered.filter((entry) => {
      const load = this.load(entry);
      if (occupied + load > limit) return false;
      occupied += load;
      return true;
    });
    const kept = keptByRank.sort((left, right) => left.entryId.localeCompare(right.entryId));
    const keptIds = new Set(kept.map((entry) => entry.entryId));
    const evicted = ordered.filter((entry) => !keptIds.has(entry.entryId)).map((entry) => entry.entryId);
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
          admittedTick: observation.tick,
          salience: observation.salience,
          text: observation.text,
          anchor,
          reference: observation.subject?.reference ?? null,
          role: observation.subject?.role ?? null,
        }),
      );
    }
    const observationEntries = record.entries.filter((entry) => entry.kind !== "intention");
    const intentionEntries = record.entries.filter((entry) => entry.kind === "intention");
    const result = this.keep(
      state,
      input.characterId,
      { ...record, sequence },
      [...observationEntries, ...added, ...intentionEntries],
      input.capacity + intentionEntries.reduce((total, entry) => total + this.load(entry), 0),
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
    const observationEntries = record.entries.filter((entry) => entry.kind !== "intention");
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
      observationEntries.reduce((total, entry) => total + this.load(entry), 0) + input.reservation,
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

  /** Releases one-shot observations after their decision opportunity, without recording use. */
  releaseUnretained(
    state: WorkingMemoryState,
    characterId: string,
    observationIds: readonly string[],
  ): WorkingMemoryState {
    const record = state.records[characterId];
    if (record === undefined || observationIds.length === 0) return state;
    const released = new Set(observationIds);
    const entries = record.entries.filter((entry) => entry.kind !== "observation" || !released.has(entry.sourceId));
    if (entries.length === record.entries.length) return state;
    return Object.freeze({
      ...state,
      version: bumpVersion(state.version),
      records: Object.freeze({
        ...state.records,
        [characterId]: Object.freeze({ ...record, entries: Object.freeze(entries) }),
      }),
    });
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

  /** Creates one recent trace only from references this decision actually used. */
  encode(
    state: WorkingMemoryState,
    input: {
      readonly characterId: string;
      readonly tick: number;
      readonly references: readonly string[];
      readonly text: string;
      readonly sourceKind?: MemoryTrace["sourceKind"];
      readonly vector: readonly number[];
      readonly embeddingVersion: string;
    },
  ): { readonly state: WorkingMemoryState; readonly trace: MemoryTrace } {
    const record = state.records[input.characterId];
    if (record === undefined) throw new Error(`character ${input.characterId} has no subjective memory`);
    const sources = [...new Set(input.references)].map((reference) =>
      record.entries.find((entry) => entry.reference === reference),
    );
    if (sources.length === 0 || sources.some((entry) => entry === undefined || entry.kind !== "observation"))
      throw new Error("memory encoding must cite admitted observations actually used by this character");
    if (input.text.trim() === "") throw new Error("memory encoding has no subjective content");
    const sourceIds = sources.map((entry) => entry!.sourceId).sort();
    if (
      sources.map((entry) => entry!.text).join("；") !== input.text &&
      !record.entries.some(
        (entry) => entry.kind === "reflection" && entry.text === input.text && entry.sourceId === sourceIds.join("|"),
      )
    )
      throw new Error("new subjective content must enter Working Memory before encoding");
    if (
      [...record.recent, ...record.longTerm].some(
        (trace) => trace.sourceIds.join("|") === sourceIds.join("|") && trace.text === input.text,
      )
    )
      throw new Error("this experience was already encoded");
    const trace: MemoryTrace = Object.freeze({
      traceId: `${input.characterId}/memory-${record.traceSequence + 1}`,
      characterId: input.characterId,
      text: input.text,
      sourceKind: input.sourceKind ?? "reflected",
      sourceIds: Object.freeze(sourceIds),
      subjectAnchor: sources.find((entry) => entry?.anchor !== null)?.anchor ?? null,
      formedTick: input.tick,
      lastUsedTick: input.tick,
      lastDecayTick: input.tick,
      accessibility: 0.5,
      suppression: 0,
      vector: Object.freeze([...input.vector]),
      embeddingVersion: input.embeddingVersion,
    });
    return {
      trace,
      state: this.updateRecord(state, input.characterId, {
        ...record,
        recent: Object.freeze([...record.recent, trace]),
        traceSequence: record.traceSequence + 1,
      }),
    };
  }

  /** A profile assertion is a belief; mutually exclusive values remain side by side. */
  claimProfile(
    state: WorkingMemoryState,
    characterId: string,
    claim: ProfileClaim,
    supportingTraceId: string,
  ): WorkingMemoryState {
    const record = state.records[characterId];
    const trace = [...(record?.recent ?? []), ...(record?.longTerm ?? [])].find(
      (candidate) => candidate.traceId === supportingTraceId,
    );
    if (record === undefined || trace === undefined)
      throw new Error("a subjective profile claim needs a current memory trace");
    const observation = record.entries.find((entry) => entry.reference === claim.subjectReference);
    if (observation?.anchor === undefined || observation.anchor === null || trace.subjectAnchor !== observation.anchor)
      throw new Error("a subjective profile claim needs an observed subject supported by that trace");
    const profileId = `${characterId}/profile/${observation.anchor}`;
    const existing = record.profiles.find((profile) => profile.profileId === profileId);
    const assertion: ProfileAssertion = Object.freeze({
      assertionId: `${profileId}/assertion-${(existing?.assertions.length ?? 0) + 1}`,
      field: claim.field,
      value: claim.value,
      confidence: claim.confidence,
      supportingTraceIds: Object.freeze([supportingTraceId]),
    });
    const profile: SubjectiveProfile = Object.freeze({
      profileId,
      subjectAnchor: observation.anchor,
      assertions: Object.freeze([...(existing?.assertions ?? []), assertion]),
    });
    return this.updateRecord(state, characterId, {
      ...record,
      profiles: Object.freeze([...record.profiles.filter((candidate) => candidate.profileId !== profileId), profile]),
    });
  }

  /** Only current traces and this character's own profile can justify recognition. */
  recognize(
    state: WorkingMemoryState,
    characterId: string,
    anchor: string,
    resolution: number,
    threshold: number,
  ): { readonly profileId: string; readonly name: string; readonly confidence: number } | null {
    const record = state.records[characterId];
    const profile = record?.profiles.find((candidate) => candidate.subjectAnchor === anchor);
    const active = new Map(
      [...(record?.recent ?? []), ...(record?.longTerm ?? [])].map((trace) => [trace.traceId, trace]),
    );
    const name = profile?.assertions
      .filter(
        (assertion) =>
          (assertion.field === "name" || assertion.field === "nickname") &&
          assertion.supportingTraceIds.some((id) => active.has(id)),
      )
      .sort(
        (left, right) => right.confidence - left.confidence || left.assertionId.localeCompare(right.assertionId),
      )[0];
    if (name === undefined || profile === undefined) return null;
    const accessibility = Math.max(0, ...name.supportingTraceIds.map((id) => active.get(id)?.accessibility ?? 0));
    const confidence = Math.min(1, Math.max(0, resolution)) * name.confidence * (0.5 + 0.5 * accessibility);
    return confidence >= threshold ? { profileId: profile.profileId, name: name.value, confidence } : null;
  }

  /** Reconnects an existing belief only after a new observed, encoded encounter. */
  reconnectProfile(
    state: WorkingMemoryState,
    characterId: string,
    profileId: string,
    subjectReference: string,
    supportingTraceId: string,
  ): WorkingMemoryState {
    const record = state.records[characterId];
    const profile = record?.profiles.find((candidate) => candidate.profileId === profileId);
    const observation = record?.entries.find(
      (entry) => entry.kind === "observation" && entry.reference === subjectReference,
    );
    const trace = record?.recent.find((candidate) => candidate.traceId === supportingTraceId);
    if (
      record === undefined ||
      profile === undefined ||
      observation?.anchor === undefined ||
      observation.anchor === null ||
      trace?.subjectAnchor !== observation.anchor ||
      record.profiles.some(
        (candidate) => candidate.profileId !== profileId && candidate.subjectAnchor === observation.anchor,
      ) ||
      !profile.assertions.some((assertion) =>
        assertion.supportingTraceIds.some((id) =>
          [...record.recent, ...record.longTerm].some((candidate) => candidate.traceId === id),
        ),
      )
    )
      throw new Error("profile reconnection needs an active belief and a newly encoded observed subject");
    return this.updateRecord(state, characterId, {
      ...record,
      profiles: Object.freeze(
        record.profiles.map((candidate) =>
          candidate.profileId === profileId
            ? Object.freeze({ ...candidate, subjectAnchor: observation.anchor! })
            : candidate,
        ),
      ),
    });
  }

  /** A bounded, observer-private search over active traces. */
  search(
    state: WorkingMemoryState,
    input: {
      readonly characterId: string;
      readonly text: string;
      readonly vector: readonly number[];
      readonly embeddingVersion: string;
      readonly threshold: number;
      readonly candidateLimit: number;
      readonly resultLimit: number;
      readonly contextAnchors?: readonly string[];
      readonly weights?: {
        readonly structure: number;
        readonly association: number;
        readonly semantic: number;
        readonly context: number;
        readonly accessibility: number;
      };
    },
  ): readonly MemoryTrace[] {
    const record = state.records[input.characterId];
    if (record === undefined) return [];
    const words = new Set(input.text.toLocaleLowerCase().match(/[\p{Script=Han}]|[\p{L}\p{N}]+/gu) ?? []);
    const traces = [...record.recent, ...record.longTerm].filter(
      (trace) => trace.embeddingVersion === input.embeddingVersion,
    );
    const direct = traces.filter((trace) => [...words].some((word) => trace.text.toLocaleLowerCase().includes(word)));
    const associatedAnchors = new Set(
      direct.map((trace) => trace.subjectAnchor).filter((anchor): anchor is string => anchor !== null),
    );
    const associatedSources = new Set(direct.flatMap((trace) => trace.sourceIds));
    const weights = input.weights ?? {
      structure: 0.45,
      association: 0,
      semantic: 0.55,
      context: 0,
      accessibility: 0.25,
    };
    return traces
      .map((trace) => {
        const matching = [...words].filter((word) => trace.text.toLocaleLowerCase().includes(word)).length;
        const structure = words.size === 0 ? 0 : matching / words.size;
        const association =
          (trace.subjectAnchor !== null && associatedAnchors.has(trace.subjectAnchor)) ||
          trace.sourceIds.some((id) => associatedSources.has(id))
            ? 1
            : 0;
        const semantic = Math.max(0, cosineSimilarity(input.vector, trace.vector));
        const context =
          trace.subjectAnchor !== null && (input.contextAnchors ?? []).includes(trace.subjectAnchor) ? 1 : 0;
        const relevance = Math.min(
          1,
          structure * weights.structure +
            association * weights.association +
            semantic * weights.semantic +
            context * weights.context,
        );
        const activation = Math.max(0, relevance + trace.accessibility * weights.accessibility - trace.suppression);
        return { trace, activation };
      })
      .filter((candidate) => candidate.activation >= input.threshold)
      .sort(
        (left, right) => right.activation - left.activation || left.trace.traceId.localeCompare(right.trace.traceId),
      )
      .slice(0, input.candidateLimit)
      .map((candidate) => candidate.trace);
  }

  /** Used memories strengthen only after an accepted cognitive decision. */
  reinforce(
    state: WorkingMemoryState,
    characterId: string,
    traceIds: readonly string[],
    tick: number,
  ): WorkingMemoryState {
    const record = state.records[characterId];
    if (record === undefined) return state;
    const selected = new Set(traceIds);
    const strengthen = (trace: MemoryTrace): MemoryTrace =>
      selected.has(trace.traceId)
        ? Object.freeze({
            ...trace,
            lastUsedTick: tick,
            lastDecayTick: tick,
            accessibility: Math.min(1, trace.accessibility + 0.1),
          })
        : trace;
    return this.updateRecord(state, characterId, {
      ...record,
      recent: Object.freeze(record.recent.map(strengthen)),
      longTerm: Object.freeze(record.longTerm.map(strengthen)),
    });
  }

  /** Consolidation is based on the model's selected text, never world history. */
  consolidate(
    state: WorkingMemoryState,
    characterId: string,
    sourceIds: readonly string[],
    summary: string,
    tick: number,
    vector: readonly number[],
    embeddingVersion: string,
  ): WorkingMemoryState {
    const record = state.records[characterId];
    if (record === undefined) throw new Error("character has no subjective memory");
    const chosen = record.recent.filter((trace) => sourceIds.includes(trace.traceId));
    if (chosen.length === 0 || chosen.length !== new Set(sourceIds).size || summary.trim() === "")
      throw new Error("consolidation must cite current recent memories");
    const longTerm: MemoryTrace = Object.freeze({
      traceId: `${characterId}/memory-${record.traceSequence + 1}`,
      characterId,
      text: summary,
      sourceKind: "reflected",
      sourceIds: Object.freeze(chosen.flatMap((trace) => trace.sourceIds)),
      subjectAnchor: chosen.every((trace) => trace.subjectAnchor === chosen[0]?.subjectAnchor)
        ? (chosen[0]?.subjectAnchor ?? null)
        : null,
      formedTick: tick,
      lastUsedTick: tick,
      lastDecayTick: tick,
      accessibility: Math.max(...chosen.map((trace) => trace.accessibility)),
      suppression: 0,
      vector: Object.freeze([...vector]),
      embeddingVersion,
    });
    const transferred = record.profiles.map((profile) =>
      Object.freeze({
        ...profile,
        assertions: Object.freeze(
          profile.assertions.map((assertion) =>
            Object.freeze({
              ...assertion,
              supportingTraceIds: Object.freeze(
                assertion.supportingTraceIds.some((id) => sourceIds.includes(id))
                  ? [...assertion.supportingTraceIds.filter((id) => !sourceIds.includes(id)), longTerm.traceId]
                  : assertion.supportingTraceIds,
              ),
            }),
          ),
        ),
      }),
    );
    return this.updateRecord(state, characterId, {
      ...record,
      recent: Object.freeze(record.recent.filter((trace) => !sourceIds.includes(trace.traceId))),
      longTerm: Object.freeze([...record.longTerm, longTerm]),
      profiles: Object.freeze(transferred),
      traceSequence: record.traceSequence + 1,
      archived: Object.freeze([
        ...record.archived,
        ...chosen.map((trace) => Object.freeze({ trace, reason: "consolidated" as const, removedTick: tick })),
      ]),
    });
  }

  /** Simulated time alone expires unencoded Working entries and old Recent traces. */
  expire(
    state: WorkingMemoryState,
    tick: number,
    workingLifetime: number,
    recentLifetime: number,
    accessibilityDecayPerTick = 0,
  ): WorkingMemoryState {
    let next = state;
    for (const characterId of Object.keys(state.records).sort()) {
      const record = next.records[characterId]!;
      const entries = record.entries.filter(
        (entry) => entry.kind === "intention" || tick - entry.admittedTick < workingLifetime,
      );
      const decay = (trace: MemoryTrace): MemoryTrace =>
        tick <= trace.lastDecayTick
          ? trace
          : Object.freeze({
              ...trace,
              lastDecayTick: tick,
              accessibility: Math.max(
                0,
                trace.accessibility - (tick - trace.lastDecayTick) * accessibilityDecayPerTick,
              ),
            });
      const recent = record.recent.filter((trace) => tick - trace.formedTick < recentLifetime).map(decay);
      const expired = record.recent.filter((trace) => tick - trace.formedTick >= recentLifetime);
      const longTerm = record.longTerm.map(decay);
      const active = new Set([...recent, ...longTerm].map((trace) => trace.traceId));
      const profiles = record.profiles
        .map((profile) =>
          Object.freeze({
            ...profile,
            assertions: Object.freeze(
              profile.assertions.filter((assertion) => assertion.supportingTraceIds.some((id) => active.has(id))),
            ),
          }),
        )
        .filter((profile) => profile.assertions.length > 0);
      if (
        entries.length !== record.entries.length ||
        recent.length !== record.recent.length ||
        profiles.length !== record.profiles.length ||
        recent.some((trace, index) => trace !== record.recent[index]) ||
        longTerm.some((trace, index) => trace !== record.longTerm[index])
      )
        next = this.updateRecord(next, characterId, {
          ...record,
          entries: Object.freeze(entries),
          recent: Object.freeze(recent),
          longTerm: Object.freeze(longTerm),
          profiles: Object.freeze(profiles),
          archived: Object.freeze([
            ...record.archived,
            ...expired.map((trace) => Object.freeze({ trace, reason: "expired" as const, removedTick: tick })),
          ]),
        });
    }
    return next;
  }

  private updateRecord(
    state: WorkingMemoryState,
    characterId: string,
    record: WorkingMemoryRecord,
  ): WorkingMemoryState {
    return Object.freeze({
      version: bumpVersion(state.version),
      records: Object.freeze({ ...state.records, [characterId]: Object.freeze(record) }),
    });
  }
}
