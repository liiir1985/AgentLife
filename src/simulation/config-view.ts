import type { RuntimeConfig } from "../config/config-builder.js";
import type { MergedItem } from "../config/config-merge.js";
import { applyNumberPolicy } from "../config/numeric.js";
import type { OutputInfo, ValueMember } from "../config/rule-catalog.js";
import { scalarKind } from "../config/system-spec.js";
import type { SystemIndex } from "../config/system-index.js";
import type { SimpleValue } from "../config/value-expr.js";
import type { TSchema } from "typebox";

/**
 * Read-only access to the compiled runtime config.
 *
 * Services never interpret rule YAML and never read a value by name: everything
 * they need — the declared values of a value set, the actions a body may run, the
 * abilities and modes a body instance owns, the members a local view grants — is
 * addressed through the kernel's own catalog, so adding content still requires no
 * service change.
 */

export const WORLD_FACTS = "agentlife.world/environment";
export const WORLD_ATTRIBUTES = "agentlife.world/attributes";
export const WORLD_INFLUENCE = "agentlife.world/influence";
export const WORLD_PARTICIPATION = "agentlife.world/participation";
export const WORLD_PROCESS = "agentlife.world/process";
export const BODY_VALUES = "agentlife.body/values";
export const BODY_CHANNELS = "agentlife.body/channels";
export const BODY_PARTICIPATION = "agentlife.body/cognitive-participation";
export const BODY_ACTIVITY = "agentlife.body/activity";
export const BODY_MODE = "agentlife.body/current-mode";
export const BODY_PROCESS = "agentlife.body/process";

export const RELATION_STATES: readonly {
  readonly relation: string;
  readonly kind: "location" | "holder" | "support";
}[] = [
  { relation: "agentlife.world/located-at", kind: "location" },
  { relation: "agentlife.world/held-by", kind: "holder" },
  { relation: "agentlife.world/placed-on", kind: "support" },
];

export type ItemTypeRef =
  | "agentlife.world/location"
  | "agentlife.world/item"
  | "agentlife.world/placement"
  | "agentlife.world/fact"
  | "agentlife.world/attribute"
  | "agentlife.world/influence-kind"
  | "agentlife.world/local-view"
  | "agentlife.body/value"
  | "agentlife.body/channel"
  | "agentlife.body/ability"
  | "agentlife.body/resource"
  | "agentlife.body/mode"
  | "agentlife.body/body"
  | "agentlife.body/action"
  | "agentlife.character/character"
  | "agentlife.character/behaviour-tree"
  | "agentlife.interaction/action-command"
  | "agentlife.perception/resolution-level"
  | "agentlife.perception/appearance"
  | "agentlife.perception/event-appearance"
  | "agentlife.perception/channel"
  | "agentlife.perception/settings"
  | "agentlife.cognition/settings"
  | "agentlife.cognition/prompt";

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asStrings(value: unknown): readonly string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** Resolved config items of one declared type, in stable ref order. */
export function itemsOf(config: RuntimeConfig, typeRef: ItemTypeRef): readonly MergedItem[] {
  return config.items.filter((item) => item.typeRef === typeRef);
}

export function itemOf(config: RuntimeConfig, ref: string): MergedItem | undefined {
  return config.items.find((item) => item.ref === ref);
}

/** Value members of one value set, keyed by their member key, in stable order. */
export function membersOf(config: RuntimeConfig, familyRef: string): readonly ValueMember[] {
  const input = config.catalog.input(familyRef);
  if (input === undefined) return [];
  return [...input.fields.values()].sort((left, right) => (left.key < right.key ? -1 : 1));
}

/** Declared starting state of every member of one value set. */
export function initialValues(config: RuntimeConfig, familyRef: string): Readonly<Record<string, SimpleValue>> {
  const values: Record<string, SimpleValue> = {};
  for (const member of membersOf(config, familyRef))
    if (member.initial !== undefined) values[member.key] = member.initial;
  return Object.freeze(values);
}

export function outputInfo(config: RuntimeConfig, stateRef: string): OutputInfo | undefined {
  return config.catalog.output(stateRef);
}

/** Static view fields of one declared input, in stable order. */
export function viewFields(config: RuntimeConfig, viewRef: string): readonly string[] {
  const input = config.catalog.input(viewRef);
  if (input === undefined) return [];
  return [...input.fields.keys()].sort();
}

/**
 * Checks one value against the declared contract of its target: the value type,
 * the closed vocabulary of a string state and the declared numeric policy.
 */
export function checkValue(
  config: RuntimeConfig,
  stateRef: string,
  value: SimpleValue,
): { readonly ok: true } | { readonly ok: false; readonly reason: string } {
  const target = outputInfo(config, stateRef);
  if (target === undefined) return { ok: false, reason: `unknown state ${stateRef}` };
  if (typeof value !== target.valueType)
    return { ok: false, reason: `${stateRef} holds ${target.valueType}, the change carries ${typeof value}` };
  if (target.allowedValues !== null && typeof value === "string" && !target.allowedValues.includes(value))
    return { ok: false, reason: `${stateRef} does not accept the value ${value}` };
  if (target.policy !== null && typeof value === "number") {
    const normalized = applyNumberPolicy(value, target.policy);
    if (!normalized.ok) return { ok: false, reason: `${stateRef}: ${normalized.message}` };
    if (normalized.value !== value)
      return { ok: false, reason: `${stateRef} would have to normalize ${value} to ${normalized.value}` };
  }
  return { ok: true };
}

export interface ActionSpec {
  readonly ref: string;
  readonly ability: string;
  readonly interruptible: boolean;
  readonly worldInfluence: string | null;
  readonly stages: readonly { readonly name: string; readonly ticks: number; readonly resource: string | null }[];
}

export function actionSpec(config: RuntimeConfig, ref: string): ActionSpec | undefined {
  const item = itemOf(config, ref);
  if (item === undefined || item.typeRef !== "agentlife.body/action") return undefined;
  const ability = asString(item.values.ability);
  if (ability === undefined) return undefined;
  const stages = Array.isArray(item.values.stages) ? item.values.stages : [];
  return {
    ref,
    ability,
    interruptible: asBoolean(item.values.interruptible) ?? false,
    worldInfluence: asString(item.values.worldInfluence) ?? null,
    stages: stages.map((stage) => {
      const record = asRecord(stage);
      return {
        name: asString(record["name"]) ?? "",
        ticks: asNumber(record["ticks"]) ?? 1,
        resource: asString(record["resource"]) ?? null,
      };
    }),
  };
}

/**
 * The world relation one declared influence kind changes, when it changes one.
 * Content declares it, so the world never has to know a content action by name.
 */
export function influenceRelation(config: RuntimeConfig, influenceRef: string | null): string | null {
  if (influenceRef === null) return null;
  const item = itemOf(config, influenceRef);
  if (item === undefined || item.typeRef !== "agentlife.world/influence-kind") return null;
  return asString(item.values["relation"]) ?? null;
}

export interface ResourceSpec {
  readonly ref: string;
  readonly exclusive: boolean;
}

export function resourceSpec(config: RuntimeConfig, ref: string): ResourceSpec | undefined {
  const item = itemOf(config, ref);
  if (item === undefined || item.typeRef !== "agentlife.body/resource") return undefined;
  return { ref, exclusive: asBoolean(item.values.exclusive) ?? false };
}

export interface BodyConfigSpec {
  readonly ref: string;
  readonly abilities: readonly string[];
  readonly resources: readonly string[];
  readonly modes: readonly string[];
  readonly initialMode: string;
}

export function bodyConfigSpec(config: RuntimeConfig, ref: string): BodyConfigSpec | undefined {
  const item = itemOf(config, ref);
  if (item === undefined || item.typeRef !== "agentlife.body/body") return undefined;
  const initialMode = asString(item.values.initialMode);
  if (initialMode === undefined) return undefined;
  return {
    ref,
    abilities: asStrings(item.values.abilities),
    resources: asStrings(item.values.resources),
    modes: asStrings(item.values.modes),
    initialMode,
  };
}

/** Abilities one physical mode allows, or `undefined` when the mode is unknown. */
export function modeAbilities(config: RuntimeConfig, ref: string): readonly string[] | undefined {
  const item = itemOf(config, ref);
  if (item === undefined || item.typeRef !== "agentlife.body/mode") return undefined;
  return asStrings(item.values.abilities);
}

export interface BehaviourTreeSpec {
  readonly ref: string;
  readonly decisionCooldown: number;
  readonly definition: unknown;
  readonly blackboard: Readonly<Record<string, unknown>>;
}

export function behaviourTreeSpec(config: RuntimeConfig, ref: string): BehaviourTreeSpec | undefined {
  const item = itemOf(config, ref);
  if (item === undefined || item.typeRef !== "agentlife.character/behaviour-tree") return undefined;
  return {
    ref,
    decisionCooldown: asNumber(item.values.decisionCooldown) ?? 1,
    definition: item.values.definition,
    blackboard: asRecord(item.values.blackboard),
  };
}

/** Whitelisted local view members of one local view item. */
export function localViewMembers(config: RuntimeConfig, ref: string): readonly string[] {
  const item = itemOf(config, ref);
  if (item === undefined || item.typeRef !== "agentlife.world/local-view") return [];
  return asStrings(item.values.members);
}

/** The attribute values an entity declares for itself; anything else keeps the declared default. */
export function declaredAttributes(
  config: RuntimeConfig,
): Readonly<Record<string, Readonly<Record<string, SimpleValue>>>> {
  const keyOf = new Map(itemsOf(config, "agentlife.world/attribute").map((item) => [item.ref, item.name]));
  const declared: Record<string, Record<string, SimpleValue>> = {};
  for (const item of config.items) {
    const values = item.values["attributes"];
    if (typeof values !== "object" || values === null || Array.isArray(values)) continue;
    const entity: Record<string, SimpleValue> = {};
    for (const [ref, value] of Object.entries(values)) {
      const key = keyOf.get(ref);
      if (key === undefined) continue;
      if (typeof value === "number" || typeof value === "boolean" || typeof value === "string") entity[key] = value;
    }
    if (Object.keys(entity).length > 0) declared[item.ref] = entity;
  }
  return declared;
}

/** Declared initial positions of items and characters, keyed by entity. */
export function placements(config: RuntimeConfig): Readonly<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const item of itemsOf(config, "agentlife.world/placement")) {
    const entity = asString(item.values.entity);
    const location = asString(item.values.location);
    if (entity !== undefined && location !== undefined) result[entity] = location;
  }
  return result;
}

/** Declared initial positions of items only; characters start at their home location. */
export function itemPlacements(config: RuntimeConfig): Readonly<Record<string, string>> {
  const declared = placements(config);
  const result: Record<string, string> = {};
  for (const item of itemsOf(config, "agentlife.world/item")) {
    const location = declared[item.ref];
    if (location !== undefined) result[item.ref] = location;
  }
  return result;
}

export interface ProcessSpecView {
  readonly ref: string;
  readonly scope: "shared" | "entity";
  readonly operations: readonly string[];
  readonly parameters: readonly { readonly name: string; readonly valueType: "number" | "boolean" | "string" }[];
}

/** Declared process: its scope, allowed operations and parameter types. */
export function processSpec(systemIndex: SystemIndex, ref: string): ProcessSpecView | undefined {
  const entry = systemIndex.process(ref);
  if (entry === undefined) return undefined;
  const declaration = entry.declaration;
  const parameters = Object.entries(propertiesOf(declaration.parameters))
    .map(([name, schema]) => {
      const valueType = scalarKind(schema);
      return valueType === null ? undefined : { name, valueType };
    })
    .filter(
      (parameter): parameter is { name: string; valueType: "number" | "boolean" | "string" } => parameter !== undefined,
    )
    .sort((left, right) => (left.name < right.name ? -1 : 1));
  return { ref, scope: declaration.scope, operations: declaration.operations, parameters };
}

function propertiesOf(schema: unknown): Record<string, TSchema> {
  if (typeof schema !== "object" || schema === null) return {};
  const properties: unknown = Reflect.get(schema as object, "properties");
  return typeof properties === "object" && properties !== null ? (properties as Record<string, TSchema>) : {};
}

/** The local id of a content ref, i.e. what follows the namespace. */
export function localIdOf(ref: string): string {
  const separator = ref.indexOf("/");
  return separator < 0 ? ref : ref.slice(separator + 1);
}

/** The display name one content item declares, falling back to its ref. */
export function itemLabel(config: RuntimeConfig, ref: string): string {
  const value = itemOf(config, ref)?.values.name;
  return typeof value === "string" ? value : ref;
}

/** The display description one content item declares. */
export function itemDescription(config: RuntimeConfig, ref: string): string {
  const value = itemOf(config, ref)?.values.description;
  return typeof value === "string" ? value : "";
}

/** The subsystem modules one character declares; empty when content declares none. */
export function characterModules(config: RuntimeConfig, ref: string): readonly string[] {
  return asStrings(itemOf(config, ref)?.values["modules"]);
}

export interface ResolutionLevelSpec {
  readonly ref: string;
  readonly rank: number;
  /** Whether this level is clear enough to attempt recognising the subject. */
  readonly recognisable: boolean;
}

/** Resolution levels by ref, so a coarser level can never express a finer one's detail. */
export function resolutionLevels(config: RuntimeConfig): ReadonlyMap<string, ResolutionLevelSpec> {
  const levels = new Map<string, ResolutionLevelSpec>();
  for (const item of itemsOf(config, "agentlife.perception/resolution-level")) {
    const rank = asNumber(item.values.rank);
    if (rank === undefined) continue;
    levels.set(item.ref, { ref: item.ref, rank, recognisable: asBoolean(item.values.recognisable) ?? false });
  }
  return levels;
}

export interface AppearanceProjection {
  readonly level: string;
  readonly detail: string;
  /** How the subject is called once the observer recognises it, if ever. */
  readonly identity: string | null;
}

/** What one entity looks like at each declared resolution level. */
export interface AppearanceSpec {
  readonly ref: string;
  readonly subject: string;
  /** The level from which the projections of this appearance may express identity. */
  readonly recognisable: string | null;
  readonly projections: readonly AppearanceProjection[];
}

function appearanceOf(item: MergedItem): AppearanceSpec | undefined {
  const subject = asString(item.values.subject);
  if (subject === undefined) return undefined;
  const projections = Array.isArray(item.values.projections) ? item.values.projections : [];
  return {
    ref: item.ref,
    subject,
    recognisable: asString(item.values.recognisable) ?? null,
    projections: projections.map((entry) => {
      const record = asRecord(entry);
      return {
        level: asString(record["level"]) ?? "",
        detail: asString(record["detail"]) ?? "",
        identity: asString(record["identity"]) ?? null,
      };
    }),
  };
}

/** Appearances keyed by the entity they describe. */
export function appearances(config: RuntimeConfig): ReadonlyMap<string, AppearanceSpec> {
  const appearances = new Map<string, AppearanceSpec>();
  for (const item of itemsOf(config, "agentlife.perception/appearance")) {
    const appearance = appearanceOf(item);
    if (appearance !== undefined) appearances.set(appearance.subject, appearance);
  }
  return appearances;
}

/** The appearance of one entity, or `undefined` when content describes none. */
export function appearanceFor(config: RuntimeConfig, subject: string): AppearanceSpec | undefined {
  const item = itemsOf(config, "agentlife.perception/appearance").find(
    (candidate) => candidate.values.subject === subject,
  );
  return item === undefined ? undefined : appearanceOf(item);
}

/** The materials one perception channel can deliver. */
export type ChannelMaterialKind = "place" | "exits" | "subjects" | "environment" | "events";

/** One declared perception channel: how a material reaches an observer and what coarsens it. */
export interface PerceptionChannelSpec {
  readonly ref: string;
  /** Body channel this perception channel reads its availability and efficiency from. */
  readonly channel: string;
  readonly channelKey: string;
  readonly finestLevel: string;
  /** Which materials of a frame this channel delivers. */
  readonly carries: readonly ChannelMaterialKind[];
  /** Environment fact holding the light level, and the value below which details drop. */
  readonly lightFact: string | null;
  readonly darkBelow: number | null;
  readonly fogFact: string | null;
  readonly fogDenseAbove: number | null;
  /** Channel efficiency below which the channel carries nothing at all. */
  readonly faintBelow: number | null;
  /** Channel efficiency below which the channel loses one level of detail. */
  readonly dimBelow: number | null;
  readonly events: readonly string[];
}

export function perceptionChannels(config: RuntimeConfig): readonly PerceptionChannelSpec[] {
  const channels: PerceptionChannelSpec[] = [];
  for (const item of itemsOf(config, "agentlife.perception/channel")) {
    const channel = asString(item.values.channel);
    const finestLevel = asString(item.values.finestLevel);
    if (channel === undefined || finestLevel === undefined) continue;
    channels.push({
      ref: item.ref,
      channel,
      channelKey: localIdOf(channel),
      finestLevel,
      carries: asStrings(item.values.carries) as readonly ChannelMaterialKind[],
      lightFact: asString(item.values.lightFact) ?? null,
      darkBelow: asNumber(item.values.darkBelow) ?? null,
      fogFact: asString(item.values.fogFact) ?? null,
      fogDenseAbove: asNumber(item.values.fogDenseAbove) ?? null,
      faintBelow: asNumber(item.values.faintBelow) ?? null,
      dimBelow: asNumber(item.values.dimBelow) ?? null,
      events: asStrings(item.values.events),
    });
  }
  return channels;
}

/** How one observable event is rendered for an observer that can perceive it. */
export interface EventAppearanceSpec {
  readonly ref: string;
  readonly event: string;
  readonly channel: string;
  readonly template: string;
}

export function eventAppearances(config: RuntimeConfig): readonly EventAppearanceSpec[] {
  const appearances: EventAppearanceSpec[] = [];
  for (const item of itemsOf(config, "agentlife.perception/event-appearance")) {
    const event = asString(item.values.event);
    const channel = asString(item.values.channel);
    const template = asString(item.values.template);
    if (event === undefined || channel === undefined || template === undefined) continue;
    appearances.push({ ref: item.ref, event, channel, template });
  }
  return appearances;
}

/** Every event kind content declares as observable at all. */
export function observableEvents(config: RuntimeConfig): readonly string[] {
  return [...new Set(eventAppearances(config).map((appearance) => appearance.event))].sort();
}

/** Salience bands and bounds one perception settings item declares. */
export interface PerceptionSettingsSpec {
  readonly ref: string;
  readonly maxObservationsPerTick: number;
  readonly repeatSuppressionTicks: number;
  readonly ordinarySalience: number;
  readonly changeSalience: number;
  readonly attentionSalience: number;
  readonly eventSalience: number;
  readonly outcomeSalience: number;
  readonly salienceThreshold: number;
}

export function perceptionSettings(config: RuntimeConfig): PerceptionSettingsSpec | undefined {
  const item = itemsOf(config, "agentlife.perception/settings")[0];
  if (item === undefined) return undefined;
  return {
    ref: item.ref,
    maxObservationsPerTick: asNumber(item.values["maxObservationsPerTick"]) ?? 0,
    repeatSuppressionTicks: asNumber(item.values["repeatSuppressionTicks"]) ?? 0,
    ordinarySalience: asNumber(item.values["ordinarySalience"]) ?? 0,
    changeSalience: asNumber(item.values["changeSalience"]) ?? 0,
    attentionSalience: asNumber(item.values["attentionSalience"]) ?? 0,
    eventSalience: asNumber(item.values["eventSalience"]) ?? 0,
    outcomeSalience: asNumber(item.values["outcomeSalience"]) ?? 0,
    salienceThreshold: asNumber(item.values["salienceThreshold"]) ?? 0,
  };
}

/** Bounds and model choice one cognition settings item declares. */
export interface CognitionSettingsSpec {
  readonly ref: string;
  readonly observationCapacity: number;
  readonly intentionReservation: number;
  readonly attentionCapacity: number;
  readonly maxPlanSteps: number;
  readonly maxAttempts: number;
  readonly requestTimeoutSeconds: number;
  readonly idleReviewTicks: number;
  readonly idleWaitLimitTicks: number;
  readonly provider: string;
  readonly model: string;
  readonly allowedActions: readonly string[];
}

export function cognitionSettings(config: RuntimeConfig): CognitionSettingsSpec | undefined {
  const item = itemsOf(config, "agentlife.cognition/settings")[0];
  if (item === undefined) return undefined;
  return {
    ref: item.ref,
    observationCapacity: asNumber(item.values["observationCapacity"]) ?? 0,
    intentionReservation: asNumber(item.values["intentionReservation"]) ?? 0,
    attentionCapacity: asNumber(item.values["attentionCapacity"]) ?? 0,
    maxPlanSteps: asNumber(item.values["maxPlanSteps"]) ?? 0,
    maxAttempts: asNumber(item.values["maxAttempts"]) ?? 0,
    requestTimeoutSeconds: asNumber(item.values["requestTimeoutSeconds"]) ?? 0,
    idleReviewTicks: asNumber(item.values["idleReviewTicks"]) ?? 0,
    idleWaitLimitTicks: asNumber(item.values["idleWaitLimitTicks"]) ?? 0,
    provider: asString(item.values.provider) ?? "",
    model: asString(item.values.model) ?? "",
    allowedActions: asStrings(item.values.allowedActions),
  };
}

/** The authored prompt a cognition request is started with. */
export function cognitionPrompt(config: RuntimeConfig): string | undefined {
  const item = itemsOf(config, "agentlife.cognition/prompt")[0];
  const text = item === undefined ? undefined : asString(item.values.text);
  return text === undefined || text.trim() === "" ? undefined : text;
}

/**
 * The input field one action turns into an utterance when it completes.
 *
 * Content declares it, so the runtime never has to know which action is "say":
 * the action that carries an utterance is the action whose text becomes audible.
 */
export function actionUtteranceField(config: RuntimeConfig, actionRef: string): string | null {
  const utterance = itemOf(config, actionRef)?.values["utterance"];
  const field =
    typeof utterance === "object" && utterance !== null ? asString(Reflect.get(utterance, "field")) : undefined;
  return field === undefined || field.trim() === "" ? null : field;
}

/** Environment facts by their member key, so materials can name what changed. */
export function environmentFacts(config: RuntimeConfig): ReadonlyMap<string, string> {
  const facts = new Map<string, string>();
  for (const item of itemsOf(config, "agentlife.world/fact"))
    facts.set(localIdOf(item.ref), item.values.name as string);
  return facts;
}
