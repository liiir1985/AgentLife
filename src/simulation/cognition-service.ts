import type { RuntimeConfig } from "../config/config-builder.js";
import { cognitionSettings, perceptionSettings } from "./config-view.js";
import type {
  CharacterRecord,
  CognitionDemand,
  CognitionDemandReason,
  CognitionRecord,
  CognitionState,
  CognitiveDecision,
  IdleCommitment,
  IntentionChange,
  IntentionRecord,
  Observation,
  WorkingMemoryEntry,
} from "./types.js";

/**
 * Cognition: what an entity carries between decisions, and when the tick has to
 * stop for it to think.
 *
 * The service owns the prospective state of one entity - what it attends to, what
 * it currently understands, the intentions it is pursuing and the commitment it
 * made to wait - and it decides which entities owe a decision at this tick. It
 * never calls a model: it produces demands, applies the decisions the coordinator
 * already validated, and maintains the bounded wait of an idle entity.
 */

/** Why one entity owes a decision right now; every reason is a bounded cause. */
export interface DemandInput {
  readonly tick: number;
  readonly cognition: CognitionState;
  readonly characters: Readonly<Record<string, CharacterRecord>>;
  /** Body participation per entity: `forbidden` keeps cognition out entirely. */
  readonly participation: Readonly<Record<string, string>>;
  /** Observations admitted into Working Memory in this tick, per entity. */
  readonly admitted: Readonly<Record<string, readonly Observation[]>>;
}

/** Demand reasons a body that only allows restricted cognition still receives. */
const RESTRICTED_REASONS: readonly CognitionDemandReason[] = ["observation", "outcome"];

const REASON_ORDER: readonly CognitionDemandReason[] = [
  "initial",
  "idle-expiry",
  "idle-review",
  "outcome",
  "observation",
];

export interface DecisionApplication {
  readonly state: CognitionState;
  readonly notes: readonly string[];
}

function bumpVersion(version: string): string {
  const separator = version.lastIndexOf("-");
  const count = separator < 0 ? Number.NaN : Number(version.slice(separator + 1));
  return Number.isFinite(count) ? `${version.slice(0, separator)}-${count + 1}` : `${version}-1`;
}

function emptyRecord(characterId: string): CognitionRecord {
  return Object.freeze({
    characterId,
    attention: Object.freeze([]),
    understanding: "",
    questions: Object.freeze([]),
    persistence: "",
    intentions: Object.freeze([]),
    intentionSequence: 0,
    idle: null,
    lastDecisionTick: 0,
    decisions: 0,
    pendingRequestId: null,
    attempts: 0,
  });
}

export class CognitionService {
  constructor(private readonly config: RuntimeConfig) {}

  /** One record per entity that keeps cognition state, AI or user controlled. */
  create(characterIds: readonly string[]): CognitionState {
    const records: Record<string, CognitionRecord> = {};
    for (const characterId of [...characterIds].sort()) records[characterId] = emptyRecord(characterId);
    return Object.freeze({ version: "cognition-1", records: Object.freeze(records) });
  }

  record(state: CognitionState, characterId: string): CognitionRecord | undefined {
    return state.records[characterId];
  }

  private write(state: CognitionState, record: CognitionRecord): CognitionState {
    return Object.freeze({
      ...state,
      version: bumpVersion(state.version),
      records: Object.freeze({ ...state.records, [record.characterId]: Object.freeze(record) }),
    });
  }

  /**
   * Which entities owe a decision before this tick may go on.
   *
   * An entity is asked to think when it has never decided, when something worth
   * responding to arrived (an utterance it could hear, its own action result, or a
   * change at or above the configured change salience), when the re-review moment
   * of its idle commitment arrived, or when the bounded wait ran out. A body that
   * forbids cognition is never asked, and a stable scene is never re-evaluated.
   */
  demands(input: DemandInput): readonly CognitionDemand[] {
    const settings = cognitionSettings(this.config);
    if (settings === undefined) return [];
    const demands: CognitionDemand[] = [];
    for (const characterId of Object.keys(input.characters).sort()) {
      const character = input.characters[characterId];
      const record = input.cognition.records[characterId];
      if (character === undefined || record === undefined) continue;
      if (character.control !== "cognition" || character.lifecycle !== "running") continue;
      const participation = input.participation[characterId] ?? "allowed";
      if (participation === "forbidden") continue;
      const admitted = input.admitted[characterId] ?? [];
      const events = admitted.filter((observation) => observation.kind === "event");
      const outcomes = admitted.filter((observation) => observation.kind === "outcome");
      const notable = admitted.filter(
        (observation) =>
          observation.kind !== "event" &&
          observation.kind !== "outcome" &&
          observation.salience >= (perceptionSettings(this.config)?.changeSalience ?? 0),
      );
      const reasons: CognitionDemandReason[] = [];
      const details: string[] = [];
      if (record.decisions === 0 && record.idle === null) {
        reasons.push("initial");
        details.push("has not decided yet");
      }
      if (record.idle !== null && input.tick >= record.idle.untilTick) {
        reasons.push("idle-expiry");
        details.push(`waited until ${record.idle.untilTick}`);
      } else if (record.idle !== null && input.tick >= record.idle.reviewTick) {
        reasons.push("idle-review");
        details.push(`re-reviews at ${record.idle.reviewTick}`);
      }
      if (outcomes.length > 0) {
        reasons.push("outcome");
        details.push(`${outcomes.length} own action result(s)`);
      }
      if (events.length > 0) {
        reasons.push("observation");
        details.push(`${events.length} event(s) to respond to`);
      }
      if (notable.length > 0) {
        reasons.push("observation");
        details.push(`${notable.length} notable change(s)`);
      }
      const usable =
        participation === "restricted" ? reasons.filter((reason) => RESTRICTED_REASONS.includes(reason)) : reasons;
      if (usable.length === 0) continue;
      const reason = REASON_ORDER.find((candidate) => usable.includes(candidate)) ?? usable[0];
      demands.push(
        Object.freeze({
          demandId: `${characterId}/tick-${input.tick}/demand`,
          characterId,
          reason: reason as CognitionDemandReason,
          detail: [...new Set(details)].join("; "),
          observations: Object.freeze(admitted.map((observation) => observation.observationId)),
        }),
      );
    }
    return Object.freeze(demands);
  }

  /** Records the request that is currently allowed to commit for one entity. */
  beginRequest(state: CognitionState, characterId: string, requestId: string, attempt: number): CognitionState {
    const record = state.records[characterId];
    if (record === undefined) return state;
    return this.write(state, { ...record, pendingRequestId: requestId, attempts: attempt });
  }

  /** Applies one validated decision: attention, understanding, intentions and idle. */
  applyDecision(
    state: CognitionState,
    input: { readonly characterId: string; readonly tick: number; readonly decision: CognitiveDecision },
  ): DecisionApplication {
    const record = state.records[input.characterId];
    if (record === undefined) return { state, notes: Object.freeze([]) };
    const notes: string[] = [];
    let sequence = record.intentionSequence;
    let intentions: IntentionRecord[] = [...record.intentions];
    for (const change of [...input.decision.intentionChanges].sort((left, right) =>
      (left.intentionId ?? "").localeCompare(right.intentionId ?? ""),
    )) {
      const applied = this.applyIntentionChange(intentions, change, input.characterId, sequence, input.tick);
      sequence = applied.sequence;
      intentions = [...applied.intentions];
      notes.push(applied.note);
    }
    const used = new Set(input.decision.consideredIntentions);
    intentions = intentions.map((intention) =>
      used.has(intention.intentionId)
        ? Object.freeze({ ...intention, useCount: intention.useCount + 1, reviewedTick: input.tick })
        : intention,
    );
    return {
      state: this.write(state, {
        ...record,
        attention: Object.freeze([...input.decision.attention]),
        understanding: input.decision.understanding,
        questions: Object.freeze([...input.decision.questions]),
        persistence: input.decision.persistence,
        intentions: Object.freeze(intentions),
        intentionSequence: sequence,
        idle: input.decision.idle,
        lastDecisionTick: input.tick,
        decisions: record.decisions + 1,
        pendingRequestId: null,
        attempts: 0,
      }),
      notes: Object.freeze(notes),
    };
  }

  private applyIntentionChange(
    intentions: readonly IntentionRecord[],
    change: IntentionChange,
    characterId: string,
    sequence: number,
    tick: number,
  ): { readonly intentions: readonly IntentionRecord[]; readonly sequence: number; readonly note: string } {
    if (change.intentionId === null) {
      const next = sequence + 1;
      const created: IntentionRecord = Object.freeze({
        intentionId: `${characterId}/int-${next}`,
        content: change.content,
        source: "cognition" as const,
        status: change.status,
        createdTick: tick,
        reviewedTick: tick,
        useCount: 0,
      });
      return {
        intentions: [...intentions, created],
        sequence: next,
        note: `intention ${created.intentionId} ${change.status}`,
      };
    }
    const existing = intentions.find((intention) => intention.intentionId === change.intentionId);
    if (existing === undefined) return { intentions, sequence, note: `${change.intentionId} is not held` };
    return {
      intentions: intentions.map((intention) =>
        intention.intentionId === change.intentionId
          ? Object.freeze({
              ...intention,
              content: change.content,
              status: change.status,
              reviewedTick: tick,
            })
          : intention,
      ),
      sequence,
      note: `intention ${change.intentionId} ${change.status}`,
    };
  }

  /** The entity confirmed the entries it actually used; its request identity is released. */
  confirmUsage(
    state: CognitionState,
    input: { readonly characterId: string; readonly requestId: string },
  ): CognitionState {
    const record = state.records[input.characterId];
    if (record === undefined || record.pendingRequestId !== input.requestId) return state;
    return this.write(state, { ...record, pendingRequestId: null, attempts: 0 });
  }

  /** The entity owes an initial decision: it never decided and never committed to idle. */
  owesInitialDecision(state: CognitionState, characterId: string): boolean {
    const record = state.records[characterId];
    return record === undefined ? false : record.decisions === 0 && record.idle === null;
  }

  /** Clears an idle commitment whose bounded wait ran out before the new decision. */
  expireIdle(state: CognitionState, characterId: string, tick: number): CognitionState {
    const record = state.records[characterId];
    if (record === undefined || record.idle === null || tick < record.idle.untilTick) return state;
    return this.write(state, { ...record, idle: null });
  }

  /** The wait one idle commitment still has, as a readable diagnostic. */
  idleSummary(state: CognitionState, characterId: string): string | null {
    const idle: IdleCommitment | null = state.records[characterId]?.idle ?? null;
    if (idle === null) return null;
    return `${idle.kind} until ${idle.untilTick}: ${idle.detail}`;
  }

  /** The entries one entity confirmed it used, as Working Memory entry identities. */
  usedEntries(entries: readonly WorkingMemoryEntry[], references: readonly string[]): readonly string[] {
    const named = new Set(references);
    return entries
      .filter((entry) => entry.reference !== null && named.has(entry.reference))
      .map((entry) => entry.entryId);
  }
}
