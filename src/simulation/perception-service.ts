import type { RuntimeConfig } from "../config/config-builder.js";
import type { SimpleValue } from "../config/value-expr.js";
import {
  eventAppearances,
  itemLabel,
  localIdOf,
  perceptionChannels,
  perceptionSettings,
  resolutionLevels,
  type AppearanceSpec,
  type ChannelMaterialKind,
  type PerceptionChannelSpec,
  type PerceptionSettingsSpec,
  type ResolutionLevelSpec,
} from "./config-view.js";
import type {
  Observation,
  ObservationKind,
  ObservationRole,
  ObservationSubject,
  ObservedSubject,
  ObserverPerception,
  PerceptionState,
} from "./types.js";

/**
 * Perception: from purpose-limited material to the observations one character
 * actually holds.
 *
 * The world and the body hand in material, never state: a place and its exits, the
 * objects standing there, the environment values, the events already committed,
 * the availability of a body's own channels and the results of its own actions.
 * Nothing here can dereference an entity, and no observer ever sees an anchor: a
 * subject is addressed by an observer-local reference, and its description comes
 * from the appearance content declares, coarsened by the conditions that hold.
 *
 * Two runs of the same material form the same observations, and a subject that
 * stays unchanged is not reported again: continuity, attention and suppression are
 * all recorded per observer, so a load restores exactly what was already seen.
 */

/** One object the world is willing to describe to one observer. */
export interface SubjectMaterial {
  readonly anchor: string;
  readonly role: ObservationRole;
  /** Whether the observer itself carries this object. */
  readonly held: boolean;
  /** The place the object currently occupies. */
  readonly place: string | null;
  /** Declared outer surface of a character or an item; places declare text instead. */
  readonly appearance: AppearanceSpec | undefined;
  readonly label: string;
  readonly description: string;
}

/** One objective event the world is willing to describe to one observer. */
export interface EventMaterial {
  readonly eventId: string;
  readonly kind: string;
  readonly actor: string | null;
  /** Where it happened, so only a perceiver at that place receives it. */
  readonly place: string | null;
  readonly text: string | null;
}

/** What the world offers one observer for one perception run. */
export interface WorldPerceptionMaterial {
  readonly place: { readonly anchor: string; readonly label: string; readonly description: string } | null;
  readonly exits: readonly SubjectMaterial[];
  readonly subjects: readonly SubjectMaterial[];
  readonly environment: Readonly<Record<string, SimpleValue>>;
  /** Environment members whose value changed since the previous tick. */
  readonly changedFacts: readonly string[];
  readonly events: readonly EventMaterial[];
}

/** One sensory channel of one body, as the body reports it. */
export interface ChannelMaterial {
  readonly channel: string;
  readonly available: boolean;
  readonly efficiency: number;
}

/** One action result the body reports as something its owner can feel. */
export interface OutcomeMaterial {
  readonly actionId: string;
  readonly action: string;
  readonly status: string;
  readonly reason: string;
  /**
   * What the world's rules said this result meant, in the pack's words; `null` when
   * the rules said nothing. The reason is a diagnostic and never a player's text.
   */
  readonly notice: string | null;
}

/** What the body offers its own observer for one perception run. */
export interface BodyPerceptionMaterial {
  readonly channels: readonly ChannelMaterial[];
  readonly outcomes: readonly OutcomeMaterial[];
  readonly participation: string;
}

/** One complete perception frame: the fixed snapshot one run is based on. */
export interface PerceptionFrame {
  readonly observer: string;
  readonly tick: number;
  /** World and body state version this frame was taken from. */
  readonly materialVersion: string;
  /** Observer-local references cognition currently attends to. */
  readonly attention: readonly string[];
  readonly world: WorldPerceptionMaterial;
  readonly body: BodyPerceptionMaterial;
}

export interface PerceptionResult {
  readonly state: PerceptionState;
  readonly observations: readonly Observation[];
  readonly notes: readonly string[];
}

interface ChannelReading {
  readonly spec: PerceptionChannelSpec;
  readonly active: boolean;
  readonly rank: number;
  readonly level: string | null;
  readonly reason: string;
}

const EMPTY_OBSERVER: ObserverPerception = Object.freeze({
  subjects: Object.freeze({}),
  pending: Object.freeze([]),
  references: Object.freeze({}),
  referencesUsed: 0,
  suppressedUntil: Object.freeze({}),
  processedEvents: Object.freeze([]),
  materialVersion: "",
  attentionVersion: "",
});

/** What one channel delivers this run, after availability and conditions. */
function readChannel(
  spec: PerceptionChannelSpec,
  frame: PerceptionFrame,
  ranks: ReadonlyMap<string, ResolutionLevelSpec>,
): ChannelReading {
  const silent = (reason: string): ChannelReading => ({ spec, active: false, rank: 0, level: null, reason });
  const material = frame.body.channels.find((candidate) => candidate.channel === spec.channel);
  if (material === undefined) return silent(`${spec.ref} reads an undeclared body channel`);
  if (!material.available) return silent(`${spec.channel} is unavailable`);
  if (spec.faintBelow !== null && material.efficiency < spec.faintBelow)
    return silent(`${spec.channel} is too faint to carry anything`);
  const finest = ranks.get(spec.finestLevel);
  if (finest === undefined) return silent(`${spec.ref} names an unknown finest level`);
  let drops = 0;
  if (spec.lightFact !== null && spec.darkBelow !== null) {
    const light = frame.world.environment[localIdOf(spec.lightFact)];
    if (typeof light === "number" && light < spec.darkBelow) drops += 1;
  }
  if (spec.fogFact !== null && spec.fogDenseAbove !== null) {
    const fog = frame.world.environment[localIdOf(spec.fogFact)];
    if (typeof fog === "number" && fog > spec.fogDenseAbove) drops += 1;
  }
  if (spec.dimBelow !== null && material.efficiency < spec.dimBelow) drops += 1;
  const usable = [...ranks.values()]
    .filter((level) => level.rank <= finest.rank - drops)
    .sort((left, right) => right.rank - left.rank || left.ref.localeCompare(right.ref))[0];
  if (usable === undefined) return silent(`${spec.ref} reaches no declared level under these conditions`);
  return {
    spec,
    active: true,
    rank: usable.rank,
    level: usable.ref,
    reason:
      drops === 0 ? `${spec.ref} at ${usable.ref}` : `${spec.ref} at ${usable.ref} (${drops} condition(s) cost detail)`,
  };
}

function bumpVersion(version: string): string {
  const separator = version.lastIndexOf("-");
  const count = separator < 0 ? Number.NaN : Number(version.slice(separator + 1));
  return Number.isFinite(count) ? `${version.slice(0, separator)}-${count + 1}` : `${version}-1`;
}

/**
 * One observer's perception run.
 *
 * The run owns the mutable bookkeeping of a single frame - local references,
 * continuity, suppression and the submitted observations - so the service itself
 * stays a stateless owner of the perception state.
 */
class ObserverRun {
  private readonly subjects: Record<string, ObservedSubject>;
  private readonly references: Record<string, string>;
  private readonly suppressed: Record<string, number>;
  private readonly processed: Set<string>;
  private readonly attentionAnchors = new Set<string>();
  private readonly attentionChanged: boolean;
  private readonly readings: readonly ChannelReading[];
  private readonly observations: Observation[] = [];
  private readonly notes: string[] = [];
  private referencesUsed: number;
  private sequence: number;
  private pending: readonly Observation[] = Object.freeze([]);
  private readonly attentionVersion: string;

  constructor(
    private readonly config: RuntimeConfig,
    private readonly settings: PerceptionSettingsSpec,
    private readonly ranks: ReadonlyMap<string, ResolutionLevelSpec>,
    private readonly frame: PerceptionFrame,
    private readonly previous: ObserverPerception,
  ) {
    this.subjects = { ...previous.subjects };
    this.references = { ...previous.references };
    this.suppressed = { ...previous.suppressedUntil };
    this.processed = new Set(previous.processedEvents);
    this.referencesUsed = previous.referencesUsed;
    this.sequence = previous.pending.length;
    this.readings = perceptionChannels(config).map((spec) => readChannel(spec, frame, ranks));
    const attentionVersion = [...frame.attention].sort().join(",");
    this.attentionChanged = attentionVersion !== previous.attentionVersion;
    this.attentionVersion = attentionVersion;
    for (const reference of frame.attention) {
      const anchor = Object.entries(this.references).find(([, value]) => value === reference)?.[0];
      if (anchor !== undefined) this.attentionAnchors.add(anchor);
    }
    for (const entry of this.readings) this.notes.push(`${entry.active ? "on" : "off"} ${entry.reason}`);
  }

  private referenceOf(anchor: string): string {
    const existing = this.references[anchor];
    if (existing !== undefined) return existing;
    this.referencesUsed += 1;
    const reference = `o${this.referencesUsed}`;
    this.references[anchor] = reference;
    return reference;
  }

  /** How an observer names a subject it holds in view. */
  private display(subject: ObservationSubject): string {
    return `${subject.reference}（${subject.identity ?? subject.description}）`;
  }

  private submit(
    channel: string,
    kind: ObservationKind,
    subject: ObservationSubject | null,
    text: string,
    salience: number,
    eventId: string | null,
    anchor: string,
  ): void {
    this.sequence += 1;
    this.observations.push(
      Object.freeze({
        observationId: `${this.frame.observer}/tick-${this.frame.tick}/obs-${this.sequence}`,
        tick: this.frame.tick,
        channel,
        kind,
        subject,
        eventId,
        text,
        salience,
      }),
    );
    this.suppressed[anchor] = this.frame.tick + this.settings.repeatSuppressionTicks;
  }

  /** The structured description of one material at the resolution a channel reached. */
  private describe(material: SubjectMaterial, rank: number, level: string): ObservationSubject | null {
    const reference = this.referenceOf(material.anchor);
    if (material.role === "place" || material.role === "exit")
      return Object.freeze({
        anchor: material.anchor,
        reference,
        role: material.role,
        held: material.held,
        level,
        recognisable: true,
        description: material.description,
        identity: material.label === "" ? null : material.label,
      });
    const appearance = material.appearance;
    if (appearance === undefined) return null;
    const usable = appearance.projections
      .filter((projection) => (this.ranks.get(projection.level)?.rank ?? 0) <= rank)
      .sort((left, right) => (this.ranks.get(right.level)?.rank ?? 0) - (this.ranks.get(left.level)?.rank ?? 0))[0];
    if (usable === undefined) return null;
    const recognisable = appearance.recognisable === null ? undefined : this.ranks.get(appearance.recognisable);
    const recognised = recognisable !== undefined && rank >= recognisable.rank;
    return Object.freeze({
      anchor: material.anchor,
      reference,
      role: material.role,
      held: material.held,
      level: usable.level,
      recognisable: recognised,
      description: usable.detail,
      identity: recognised
        ? (appearance.projections.find((projection) => projection.level === appearance.recognisable)?.identity ?? null)
        : null,
    });
  }

  private salienceOf(anchor: string, band: number): number {
    return this.attentionAnchors.has(anchor) ? Math.max(band, this.settings.attentionSalience) : band;
  }

  /** Reports one material as a subject, or keeps it silently tracked as unchanged. */
  private reportSubject(material: SubjectMaterial, entry: ChannelReading, band: number): void {
    if (entry.level === null) return;
    const subject = this.describe(material, entry.rank, entry.level);
    if (subject === null) return;
    const previous = this.subjects[material.anchor];
    // Only what the observer could have read counts as a change. The level decides
    // which projection describes the subject, so a level change matters when it
    // brings another description or an identity with it; on its own it says nothing
    // a change observation could put on either side of the arrow.
    const described =
      previous === undefined || previous.description !== subject.description || previous.identity !== subject.identity;
    // An object that comes into or leaves the observer's hands changed, even though
    // its appearance is the same one it had a moment ago.
    const carried = previous !== undefined && previous.held !== subject.held;
    const changed = described || carried;
    const attended = this.attentionAnchors.has(material.anchor) && this.attentionChanged;
    const silent =
      previous !== undefined && !changed && !attended && (this.suppressed[material.anchor] ?? 0) > this.frame.tick;
    const salience = this.salienceOf(
      material.anchor,
      previous !== undefined && !changed ? band : this.settings.changeSalience,
    );
    if (!silent && salience >= this.settings.salienceThreshold) {
      const kind: ObservationKind =
        previous === undefined
          ? "appearance"
          : changed
            ? "change"
            : previous.lastTick >= this.frame.tick - 1
              ? "continuing"
              : "reappearance";
      // A change is only legible against what it changed from. Naming the new
      // appearance on both sides of the arrow would report that nothing changed.
      const before =
        previous === undefined
          ? null
          : this.display({ ...subject, description: previous.description, identity: previous.identity });
      const text =
        kind === "appearance"
          ? `${this.display(subject)}${material.held ? "现在在你手上" : "出现在这里"}`
          : kind === "change"
            ? described && before !== null
              ? `${before}变了：${subject.description}`
              : `${this.display(subject)}${subject.held ? "现在在你手上" : "不在你手上了"}`
            : kind === "continuing"
              ? `${this.display(subject)}还在那里`
              : `${this.display(subject)}又出现了：${subject.description}`;
      this.submit(entry.spec.ref, kind, subject, text, salience, null, material.anchor);
      this.subjects[material.anchor] = Object.freeze({
        ...subject,
        lastTick: this.frame.tick,
        lastEmittedTick: this.frame.tick,
      });
      return;
    }
    this.subjects[material.anchor] = Object.freeze({
      ...subject,
      lastTick: this.frame.tick,
      lastEmittedTick: previous?.lastEmittedTick ?? 0,
    });
  }

  /** Reports the environment members that changed since the previous tick. */
  private reportEnvironment(entry: ChannelReading): void {
    const place = this.frame.world.place;
    if (place === null || !entry.spec.carries.includes("environment") || this.frame.world.changedFacts.length === 0)
      return;
    const facts = this.config.items
      .filter((item) => item.typeRef === "agentlife.world/fact")
      .filter((item) => this.frame.world.changedFacts.includes(localIdOf(item.ref)))
      .map((item) => `${String(item.values.name)}：${String(this.frame.world.environment[localIdOf(item.ref)])}`);
    if (facts.length === 0) return;
    const subject = this.describe(
      {
        anchor: place.anchor,
        role: "place",
        held: false,
        place: place.anchor,
        appearance: undefined,
        label: place.label,
        description: place.description,
      },
      entry.rank,
      entry.level ?? "",
    );
    if (subject === null) return;
    this.submit(
      entry.spec.ref,
      "change",
      subject,
      `${this.display(subject)}的环境变了：${facts.join("，")}`,
      this.settings.changeSalience,
      null,
      place.anchor,
    );
    this.subjects[place.anchor] = Object.freeze({
      ...subject,
      lastTick: this.frame.tick,
      lastEmittedTick: this.frame.tick,
    });
  }

  /** Reports the events this observer can receive at this place. */
  private reportEvents(): void {
    const place = this.frame.world.place;
    if (place === null) return;
    for (const event of this.frame.world.events) {
      if (this.processed.has(event.eventId)) continue;
      const appearance = eventAppearances(this.config).find((candidate) => candidate.event === event.kind);
      const entry = this.readings.find(
        (candidate) =>
          candidate.active &&
          appearance !== undefined &&
          candidate.spec.carries.includes("events") &&
          candidate.spec.channel === appearance.channel &&
          candidate.spec.events.includes(appearance.ref),
      );
      // An event this observer cannot receive is still marked as processed: it was
      // delivered to the frame, and a later run must not reconsider it.
      this.processed.add(event.eventId);
      if (appearance === undefined || entry === undefined || entry.level === null) continue;
      if (event.place !== place.anchor) continue;
      const anchor = event.actor ?? place.anchor;
      // Hearing oneself is not the same as hearing a person: the observer is never
      // its own observed subject, and it is never given a reference for itself.
      if (event.actor === this.frame.observer) {
        if (this.settings.eventSalience < this.settings.salienceThreshold) continue;
        this.submit(
          entry.spec.ref,
          "event",
          null,
          appearance.template
            .replace("{speaker}", "你")
            .replace("{utterance}", event.text ?? "")
            .replace("{place}", place.label),
          this.settings.eventSalience,
          event.eventId,
          anchor,
        );
        continue;
      }
      const material = this.frame.world.subjects.find((subject) => subject.anchor === anchor);
      const subject =
        material === undefined
          ? Object.freeze({
              anchor,
              reference: this.referenceOf(anchor),
              role: "character" as ObservationRole,
              held: false,
              level: entry.level,
              recognisable: false,
              description: "有人",
              identity: null,
            })
          : this.describe(material, entry.rank, entry.level);
      if (subject === null) continue;
      if (this.settings.eventSalience < this.settings.salienceThreshold) continue;
      const text = appearance.template
        .replace("{speaker}", this.display(subject))
        .replace("{utterance}", event.text ?? "")
        .replace("{place}", place.label);
      this.submit(entry.spec.ref, "event", subject, text, this.settings.eventSalience, event.eventId, anchor);
    }
  }

  /** Reports what the observer's own body just finished, failed or lost. */
  private reportOutcomes(): void {
    if (this.settings.outcomeSalience < this.settings.salienceThreshold) return;
    for (const outcome of this.frame.body.outcomes) {
      const label = itemLabel(this.config, outcome.action);
      // A completed action needs no explanation, but the pack may still have one: an
      // operation the world answered with nothing changed says so here rather than
      // leaving the player to guess why nothing moved.
      const text =
        outcome.status === "completed"
          ? outcome.notice === null
            ? `你完成了「${label}」`
            : `你完成了「${label}」：${outcome.notice}`
          : `你的「${label}」${outcome.status === "failed" ? "失败了" : "中断了"}：${outcome.reason}`;
      this.sequence += 1;
      this.observations.push(
        Object.freeze({
          observationId: `${this.frame.observer}/tick-${this.frame.tick}/obs-${this.sequence}`,
          tick: this.frame.tick,
          channel: outcome.action,
          kind: "outcome" as ObservationKind,
          subject: null,
          eventId: outcome.actionId,
          text,
          salience: this.settings.outcomeSalience,
        }),
      );
    }
  }

  /** Reports every tracked subject that is no longer part of the material. */
  private reportDisappearances(channel: string): void {
    const place = this.frame.world.place;
    // Continuity is decided by the material, not by what this tick could report: a
    // subject that stays in it keeps its tracking even when it is unreadable now,
    // while a place left behind and an exit that is no longer adjacent lose theirs.
    const present = new Set<string>([
      ...(place === null ? [] : [place.anchor]),
      ...this.frame.world.exits.map((material) => material.anchor),
      ...this.frame.world.subjects.map((material) => material.anchor),
    ]);
    for (const [anchor, tracked] of Object.entries({ ...this.subjects })) {
      if (tracked.lastTick === this.frame.tick || present.has(anchor)) continue;
      delete this.subjects[anchor];
      this.sequence += 1;
      const subject: ObservationSubject = Object.freeze({
        anchor,
        reference: tracked.reference,
        role: tracked.role,
        held: tracked.held,
        level: tracked.level,
        recognisable: tracked.recognisable,
        description: tracked.description,
        identity: tracked.identity,
      });
      this.observations.push(
        Object.freeze({
          observationId: `${this.frame.observer}/tick-${this.frame.tick}/obs-${this.sequence}`,
          tick: this.frame.tick,
          channel,
          kind: "disappearance" as ObservationKind,
          subject,
          eventId: null,
          text: `${this.display(subject)}不见了`,
          salience: this.settings.changeSalience,
        }),
      );
    }
  }

  private stateFrom(state: PerceptionState): PerceptionState {
    return Object.freeze({
      ...state,
      version: bumpVersion(state.version),
      observers: Object.freeze({
        ...state.observers,
        [this.frame.observer]: Object.freeze({
          subjects: Object.freeze(this.subjects),
          pending: Object.freeze(this.pending),
          references: Object.freeze(this.references),
          referencesUsed: this.referencesUsed,
          suppressedUntil: Object.freeze(this.suppressed),
          processedEvents: Object.freeze([...this.processed].sort()),
          materialVersion: this.frame.materialVersion,
          attentionVersion: this.attentionVersion,
        }),
      }),
    });
  }

  run(state: PerceptionState): PerceptionResult {
    const sight = this.readings.filter(
      (entry) => entry.active && entry.spec.carries.some((carried: ChannelMaterialKind) => carried !== "events"),
    );
    const best = sight
      .filter((entry) => entry.spec.carries.includes("subjects"))
      .sort((left, right) => right.rank - left.rank)[0];
    if (best !== undefined) {
      const place = this.frame.world.place;
      if (place !== null)
        this.reportSubject(
          {
            anchor: place.anchor,
            role: "place",
            held: false,
            place: place.anchor,
            appearance: undefined,
            label: place.label,
            description: place.description,
          },
          best,
          this.settings.ordinarySalience,
        );
      for (const exit of this.frame.world.exits) this.reportSubject(exit, best, this.settings.ordinarySalience);
      for (const material of this.frame.world.subjects)
        this.reportSubject(material, best, this.settings.ordinarySalience);
      const environment = sight.find((entry) => entry.spec.carries.includes("environment"));
      if (environment !== undefined) this.reportEnvironment(environment);
    }
    this.reportEvents();
    this.reportOutcomes();
    this.reportDisappearances(best?.spec.ref ?? "");

    const ordered = this.observations
      .sort(
        (left, right) =>
          right.salience - left.salience ||
          (left.subject?.reference ?? "").localeCompare(right.subject?.reference ?? "") ||
          left.observationId.localeCompare(right.observationId),
      )
      .slice(0, this.settings.maxObservationsPerTick)
      .sort((left, right) => left.observationId.localeCompare(right.observationId));
    const limit = this.settings.maxObservationsPerTick * this.settings.repeatSuppressionTicks;
    this.pending = [...this.previous.pending, ...ordered]
      .sort((left, right) => right.salience - left.salience || left.observationId.localeCompare(right.observationId))
      .slice(0, limit)
      .sort((left, right) => left.observationId.localeCompare(right.observationId));
    this.notes.push(`${ordered.length} observation(s) submitted, ${this.pending.length} pending`);
    return {
      state: this.stateFrom(state),
      observations: Object.freeze(ordered),
      notes: Object.freeze(this.notes),
    };
  }
}

export class PerceptionService {
  constructor(private readonly config: RuntimeConfig) {}

  /** One perception instance per observer; an observer that never looks holds nothing. */
  create(observerIds: readonly string[]): PerceptionState {
    const observers: Record<string, ObserverPerception> = {};
    for (const observer of [...observerIds].sort()) observers[observer] = EMPTY_OBSERVER;
    return Object.freeze({ version: "perception-1", observers: Object.freeze(observers) });
  }

  observer(state: PerceptionState, characterId: string): ObserverPerception | undefined {
    return state.observers[characterId];
  }

  /** Observations formed and not yet consumed, in formation order. */
  pendingObservations(state: PerceptionState, characterId: string): readonly Observation[] {
    return state.observers[characterId]?.pending ?? [];
  }

  /** The protected anchor one observer-local reference stands for. */
  anchorFor(state: PerceptionState, characterId: string, reference: string): string | undefined {
    const references = state.observers[characterId]?.references;
    if (references === undefined) return undefined;
    for (const [anchor, value] of Object.entries(references)) if (value === reference) return anchor;
    return undefined;
  }

  /** The observer-local reference under which one anchor is currently known. */
  referenceFor(state: PerceptionState, characterId: string, anchor: string): string | undefined {
    return state.observers[characterId]?.references[anchor];
  }

  /** Object anchors the observer currently holds in view, by role. */
  visibleAnchors(state: PerceptionState, characterId: string, role: ObservationRole): readonly string[] {
    const observer = state.observers[characterId];
    if (observer === undefined) return [];
    return Object.values(observer.subjects)
      .filter((subject) => subject.role === role)
      .map((subject) => subject.anchor)
      .sort();
  }

  /** Whether the observer currently holds one object in view at all. */
  holds(state: PerceptionState, characterId: string, anchor: string): boolean {
    return state.observers[characterId]?.subjects[anchor] !== undefined;
  }

  /** Removes consumed observations from the pending stream. */
  confirmConsumed(state: PerceptionState, characterId: string, observationIds: readonly string[]): PerceptionState {
    const observer = state.observers[characterId];
    if (observer === undefined || observationIds.length === 0) return state;
    const consumed = new Set(observationIds);
    const pending = observer.pending.filter((observation) => !consumed.has(observation.observationId));
    if (pending.length === observer.pending.length) return state;
    return Object.freeze({
      ...state,
      version: bumpVersion(state.version),
      observers: Object.freeze({
        ...state.observers,
        [characterId]: Object.freeze({ ...observer, pending: Object.freeze(pending) }),
      }),
    });
  }

  /** Runs one perception snapshot for one observer and commits the observations. */
  observe(state: PerceptionState, frame: PerceptionFrame): PerceptionResult {
    const settings = perceptionSettings(this.config);
    const previous = state.observers[frame.observer];
    if (settings === undefined || previous === undefined)
      return { state, observations: Object.freeze([]), notes: Object.freeze(["perception is not configured"]) };
    return new ObserverRun(this.config, settings, resolutionLevels(this.config), frame, previous).run(state);
  }
}
