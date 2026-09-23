import { Type } from "typebox";
import { error } from "../config/diagnostics.js";
import type { SystemCheck, SystemItem, SystemSpec } from "../config/system-spec.js";

/**
 * Perception system system.
 *
 * The perception system owns what an entity can actually see and hear. Its
 * content is deliberately made of projections instead of state: an `appearance`
 * item says how one world entity looks at each declared resolution level, an
 * `event-appearance` item says how one observable event sounds or looks, and a
 * `channel` item says which body channel carries a material and how light, fog
 * and channel efficiency move the resolution of that channel up or down.
 *
 * No item of this system may reference Identity, control routing, cognition,
 * memory or management state. A projection is authored text about an external
 * surface, so a resolver that tried to read a character's identity would be a
 * configuration error rather than a runtime lookup.
 */

/** State a perception projection is never allowed to read or name. */
const FORBIDDEN_REFERENCES: readonly string[] = [
  "agentlife.character/identity",
  "agentlife.character/schedule",
  "agentlife.cognition/",
  "agentlife.memory/",
  "agentlife.body/cognitive-participation",
  "agentlife.interaction/",
];

/** The one observable event kind phase 4 produces and consumes. */
const OBSERVABLE_EVENTS: readonly string[] = ["utterance"];

const LEVEL_SCHEMA = Type.Object(
  {
    name: Type.String(),
    description: Type.String(),
    /** How much detail this level carries; higher is more detailed. */
    rank: Type.Integer({ minimum: 1 }),
    /** Whether a description at this level is clear enough to attempt recognition. */
    recognisable: Type.Boolean(),
  },
  { additionalProperties: false },
);

const PROJECTION_SCHEMA = Type.Object(
  {
    level: Type.String(),
    /** What the observer gets at this level; never the subject's own identity text. */
    detail: Type.String(),
    /** How the subject is called once the observer recognises it. */
    identity: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

const APPEARANCE_SCHEMA = Type.Object(
  {
    name: Type.String(),
    description: Type.String(),
    subject: Type.String(),
    /** The level from which the projections of this appearance may express identity. */
    recognisable: Type.Optional(Type.String()),
    projections: Type.Array(PROJECTION_SCHEMA),
  },
  { additionalProperties: false },
);

const EVENT_APPEARANCE_SCHEMA = Type.Object(
  {
    name: Type.String(),
    description: Type.String(),
    event: Type.Union(OBSERVABLE_EVENTS.map((kind) => Type.Literal(kind))),
    channel: Type.String(),
    /** `{speaker}`, `{utterance}` and `{place}` are the only placeholders. */
    template: Type.String(),
  },
  { additionalProperties: false },
);

const CHANNEL_MATERIALS: readonly string[] = ["place", "exits", "subjects", "environment", "events"];

const CHANNEL_SCHEMA = Type.Object(
  {
    name: Type.String(),
    description: Type.String(),
    channel: Type.String(),
    finestLevel: Type.String(),
    /** Which materials of a perception frame this channel delivers. */
    carries: Type.Array(Type.Union(CHANNEL_MATERIALS.map((material) => Type.Literal(material)))),
    lightFact: Type.Optional(Type.String()),
    darkBelow: Type.Optional(Type.Number()),
    fogFact: Type.Optional(Type.String()),
    fogDenseAbove: Type.Optional(Type.Number()),
    /** Channel efficiency below which this channel carries nothing at all. */
    faintBelow: Type.Optional(Type.Number()),
    /** Channel efficiency below which this channel loses one level of detail. */
    dimBelow: Type.Optional(Type.Number()),
    events: Type.Array(Type.String()),
  },
  { additionalProperties: false },
);

const SETTINGS_SCHEMA = Type.Object(
  {
    name: Type.String(),
    description: Type.String(),
    maxObservationsPerTick: Type.Integer({ minimum: 1 }),
    /** Ticks a stable subject stays silent after its last observation. */
    repeatSuppressionTicks: Type.Integer({ minimum: 1 }),
    ordinarySalience: Type.Number(),
    changeSalience: Type.Number(),
    attentionSalience: Type.Number(),
    eventSalience: Type.Number(),
    /** Salience of an entity's own action result. */
    outcomeSalience: Type.Number(),
    /** Materials below this salience never become an observation. */
    salienceThreshold: Type.Number(),
  },
  { additionalProperties: false },
);

const TEMPLATE_PLACEHOLDERS: readonly string[] = ["speaker", "utterance", "place"];

function stringsIn(value: unknown, found: string[] = []): readonly string[] {
  if (typeof value === "string") found.push(value);
  else if (Array.isArray(value)) for (const entry of value) stringsIn(entry, found);
  else if (typeof value === "object" && value !== null)
    for (const entry of Object.values(value)) stringsIn(entry, found);
  return found;
}

function levelRank(lookup: (ref: string) => { readonly type: string; readonly values?: unknown } | undefined) {
  return (ref: string): number | undefined => {
    const item = lookup(ref);
    if (item === undefined || item.type !== "agentlife.perception/resolution-level") return undefined;
    const values = item.values;
    const rank = typeof values === "object" && values !== null ? Reflect.get(values, "rank") : undefined;
    return typeof rank === "number" ? rank : undefined;
  };
}

function appearanceProblems(
  item: SystemItem,
  rankOf: (ref: string) => number | undefined,
  report: (message: string) => void,
): void {
  const projections = Array.isArray(item.values.projections) ? item.values.projections : [];
  if (projections.length === 0) report(`${item.ref} declares no projection`);
  const levels = new Set<string>();
  const recognisable = typeof item.values.recognisable === "string" ? item.values.recognisable : undefined;
  const recognisableRank = recognisable === undefined ? undefined : rankOf(recognisable);
  if (recognisable !== undefined && recognisableRank === undefined)
    report(`${item.ref} names an unknown recognisable level ${recognisable}`);
  for (const projection of projections) {
    if (typeof projection !== "object" || projection === null) continue;
    const level = Reflect.get(projection, "level");
    if (typeof level !== "string") continue;
    if (levels.has(level)) report(`${item.ref} declares level ${level} twice`);
    levels.add(level);
    const rank = rankOf(level);
    if (rank === undefined) {
      report(`${item.ref} names an unknown resolution level ${level}`);
      continue;
    }
    if (Reflect.get(projection, "identity") === undefined) continue;
    if (recognisableRank === undefined) {
      report(`${item.ref} expresses identity at ${level} without declaring a recognisable level`);
      continue;
    }
    // A coarse projection must never carry information only a finer level may express.
    if (rank < recognisableRank)
      report(`${item.ref} exposes identity at level ${level}, which is below its recognisable level`);
  }
}

function eventProblems(item: SystemItem, report: (message: string) => void): void {
  const template = typeof item.values.template === "string" ? item.values.template : "";
  for (const slot of template.matchAll(/\{([^}]*)\}/g)) {
    const name = slot[1] ?? "";
    if (!TEMPLATE_PLACEHOLDERS.includes(name)) report(`${item.ref} uses unknown template placeholder {${name}}`);
  }
  if (template.trim() === "") report(`${item.ref} declares an empty template`);
}

function channelProblems(
  item: SystemItem,
  eventOf: (ref: string) => { readonly event?: unknown; readonly channel?: unknown } | undefined,
  report: (message: string) => void,
): void {
  const events = Array.isArray(item.values.events) ? item.values.events : [];
  for (const event of events) {
    if (typeof event !== "string") continue;
    const appearance = eventOf(event);
    if (appearance === undefined) continue;
    if (appearance.channel !== item.values.channel)
      report(`${item.ref} lists ${event}, which is carried by ${String(appearance.channel)}`);
  }
  const faint = item.values.faintBelow;
  const dim = item.values.dimBelow;
  // A channel that stops carrying below a bound must lose detail before that bound,
  // otherwise the dimmer level of detail could never be observed.
  if (typeof faint === "number" && typeof dim === "number" && dim <= faint)
    report(`${item.ref} loses detail at or below the efficiency where it stops carrying anything`);
  const carries = Array.isArray(item.values.carries) ? item.values.carries : [];
  if (carries.length === 0) report(`${item.ref} carries no material, so it could never deliver an observation`);
  if (carries.includes("events") !== events.length > 0)
    report(
      `${item.ref} declares ${events.length} event appearance(s) but ${carries.includes("events") ? "carries" : "does not carry"} events`,
    );
}

function settingsProblems(item: SystemItem, report: (message: string) => void): void {
  const threshold = item.values.salienceThreshold;
  const ordinary = item.values.ordinarySalience;
  // An ordinary subject of the current location must still be observable.
  if (typeof threshold === "number" && typeof ordinary === "number" && threshold > ordinary)
    report(`${item.ref} sets a salience threshold above the salience of an ordinary subject`);
  for (const band of ["changeSalience", "attentionSalience", "eventSalience", "outcomeSalience"] as const) {
    const value = item.values[band];
    if (typeof threshold === "number" && typeof value === "number" && value < threshold)
      report(`${item.ref} declares ${band} below its own salience threshold, so it could never be observed`);
  }
}

/** Every item of this system must stay clear of Identity, cognition and memory. */
function referenceProblems(item: SystemItem, report: (message: string) => void): void {
  for (const value of stringsIn(item.values)) {
    if (value.startsWith("agentlife.character/") && !value.startsWith("agentlife.character/character"))
      report(`${item.ref} references ${value}, which perception may not read`);
    for (const forbidden of FORBIDDEN_REFERENCES)
      if (value.startsWith(forbidden)) report(`${item.ref} references ${value}, which perception may not read`);
  }
}

export function createPerceptionSpec(): SystemSpec {
  return {
    name: "perception",
    namespace: "agentlife.perception",
    version: "1.0.0",
    kernel: ">=1.0.0 <2.0.0",
    requires: ["agentlife.world", "agentlife.body"],
    items: [
      {
        kind: "resolution-level",
        fields: LEVEL_SCHEMA,
        overridable: ["name", "description", "rank", "recognisable"],
        merge: { name: "replace", description: "replace", rank: "replace", recognisable: "replace" },
      },
      {
        kind: "appearance",
        fields: APPEARANCE_SCHEMA,
        references: {
          subject: ["agentlife.world/item", "agentlife.character/character"],
          recognisable: ["agentlife.perception/resolution-level"],
        },
        memberReferences: {},
        overridable: ["name", "description", "subject", "recognisable", "projections"],
        merge: {
          name: "replace",
          description: "replace",
          subject: "replace",
          recognisable: "replace",
          projections: "replace",
        },
      },
      {
        kind: "event-appearance",
        fields: EVENT_APPEARANCE_SCHEMA,
        references: { channel: ["agentlife.body/channel"] },
        overridable: ["name", "description", "event", "channel", "template"],
        merge: { name: "replace", description: "replace", event: "replace", channel: "replace", template: "replace" },
      },
      {
        kind: "channel",
        fields: CHANNEL_SCHEMA,
        references: {
          channel: ["agentlife.body/channel"],
          finestLevel: ["agentlife.perception/resolution-level"],
          lightFact: ["agentlife.world/fact"],
          fogFact: ["agentlife.world/fact"],
          events: ["agentlife.perception/event-appearance"],
        },
        overridable: [
          "name",
          "description",
          "channel",
          "finestLevel",
          "carries",
          "lightFact",
          "darkBelow",
          "fogFact",
          "fogDenseAbove",
          "faintBelow",
          "dimBelow",
          "events",
        ],
        merge: {
          name: "replace",
          description: "replace",
          channel: "replace",
          finestLevel: "replace",
          carries: "replace",
          lightFact: "replace",
          darkBelow: "replace",
          fogFact: "replace",
          fogDenseAbove: "replace",
          faintBelow: "replace",
          dimBelow: "replace",
          events: "replace",
        },
      },
      {
        kind: "settings",
        fields: SETTINGS_SCHEMA,
        overridable: [
          "name",
          "description",
          "maxObservationsPerTick",
          "repeatSuppressionTicks",
          "ordinarySalience",
          "changeSalience",
          "attentionSalience",
          "eventSalience",
          "outcomeSalience",
          "salienceThreshold",
        ],
        merge: {
          name: "replace",
          description: "replace",
          maxObservationsPerTick: "replace",
          repeatSuppressionTicks: "replace",
          ordinarySalience: "replace",
          changeSalience: "replace",
          attentionSalience: "replace",
          eventSalience: "replace",
          outcomeSalience: "replace",
          salienceThreshold: "replace",
        },
      },
    ],
    inputs: [],
    triggers: ["observation-formed"],
    outputs: [],
    propagation: [],
    validate: ({ packNamespace, items, report }: SystemCheck) => {
      const levels = items.filter((item) => item.type === "agentlife.perception/resolution-level");
      for (const level of levels)
        for (const other of levels)
          if (other !== level && other.values.rank === level.values.rank)
            report(
              error(
                "system",
                "system-rejected",
                `${level.ref} and ${other.ref} share resolution rank ${String(level.values.rank)}`,
                {
                  subject: level.ref,
                },
              ),
            );
      const rankOf = levelRank((ref) => {
        const found = items.find((candidate) => candidate.ref === ref);
        return found === undefined ? undefined : { type: found.type, values: found.values };
      });
      const eventOf = (ref: string): { readonly event?: unknown; readonly channel?: unknown } | undefined =>
        items.find((candidate) => candidate.ref === ref)?.values;
      const settings = items.filter((item) => item.type === "agentlife.perception/settings");
      const rootSettings = settings.filter((item) => item.namespace === packNamespace);
      // A pack may leave out perception entirely; a service built on content that
      // declares settings twice could not choose one, so that stays refused.
      if (rootSettings.length > 1)
        report(
          error(
            "system",
            "system-rejected",
            `The root pack must declare at most one perception settings item, found ${rootSettings.length}`,
            { subject: "agentlife.perception" },
          ),
        );
      const subjects = new Set<string>();
      for (const item of items) {
        referenceProblems(item, (message) =>
          report(error("system", "system-rejected", message, { subject: item.ref })),
        );
        if (item.type === "agentlife.perception/appearance") {
          const subject = String(item.values.subject);
          if (subjects.has(subject))
            report(
              error(
                "system",
                "system-rejected",
                `${item.ref} describes ${subject}, which another appearance already describes`,
                {
                  subject: item.ref,
                },
              ),
            );
          subjects.add(subject);
          appearanceProblems(item, rankOf, (message) =>
            report(error("system", "system-rejected", message, { subject: item.ref })),
          );
        } else if (item.type === "agentlife.perception/event-appearance") {
          eventProblems(item, (message) => report(error("system", "system-rejected", message, { subject: item.ref })));
        } else if (item.type === "agentlife.perception/channel") {
          channelProblems(item, eventOf, (message) =>
            report(error("system", "system-rejected", message, { subject: item.ref })),
          );
        } else if (item.type === "agentlife.perception/settings") {
          settingsProblems(item, (message) =>
            report(error("system", "system-rejected", message, { subject: item.ref })),
          );
        }
      }
      const carried = new Set(
        items
          .filter((item) => item.type === "agentlife.perception/channel")
          .flatMap((item) => (Array.isArray(item.values.events) ? item.values.events : []))
          .filter((entry): entry is string => typeof entry === "string"),
      );
      for (const item of items.filter((candidate) => candidate.type === "agentlife.perception/event-appearance"))
        if (!carried.has(item.ref))
          report(
            error("system", "system-rejected", `${item.ref} is carried by no perception channel`, {
              subject: item.ref,
            }),
          );
    },
  };
}
