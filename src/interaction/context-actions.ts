import type { RuntimeConfig } from "../config/config-builder.js";
import type { MergedItem } from "../config/config-merge.js";
import type { SimpleValue } from "../config/value-expr.js";
import { actionSpec, bodyConfigSpec, itemOf, itemsOf, modeAbilities } from "../simulation/config-view.js";
import type {
  ActionPlan,
  ActionPolicy,
  ActionStep,
  SimulationState,
  WorldEntity,
  WorldEvent,
} from "../simulation/types.js";

export type EntityCandidateSource = "current-exits" | "visible-items" | "held-items" | "visible-entities";

export interface EntityCandidateFilter {
  readonly attribute: string;
  readonly equals: SimpleValue;
}

export type ActionCommandArgument =
  | {
      readonly name: string;
      readonly kind: "entity";
      readonly binding: "target" | "destination";
      readonly candidates: EntityCandidateSource;
      readonly filters: readonly EntityCandidateFilter[];
      readonly prompt: string;
    }
  | {
      readonly name: string;
      readonly kind: "text";
      readonly field: string;
      readonly prompt: string;
      readonly minLength: number;
      readonly maxLength: number;
    };

export interface ActionCommandDefinition {
  readonly ref: string;
  readonly name: string;
  readonly description: string;
  readonly order: number;
  readonly aliases: readonly string[];
  readonly action: string;
  readonly conflict: ActionPolicy;
  readonly arguments: readonly ActionCommandArgument[];
}

export interface EntityChoice {
  readonly entityId: string;
  readonly name: string;
  readonly detail: string;
}

export interface AvailableAction {
  readonly command: ActionCommandDefinition;
  readonly firstChoices: readonly EntityChoice[];
}

export interface PlayerViewEntity extends EntityChoice {
  readonly kind: "item" | "character";
  readonly relation: "nearby" | "held" | "placed";
}

export interface PlayerView {
  readonly playerId: string;
  readonly tick: number;
  readonly simSeconds: number;
  readonly runMode: string;
  readonly configId: string;
  readonly locationId: string | null;
  readonly locationName: string;
  readonly locationDescription: string;
  readonly exits: readonly EntityChoice[];
  readonly entities: readonly PlayerViewEntity[];
  readonly heldItems: readonly PlayerViewEntity[];
  readonly playerActions: readonly {
    readonly action: string;
    readonly status: string;
    readonly outcome: string | null;
  }[];
  readonly barrier: string | null;
}

export interface ObservedEvent {
  readonly eventId: string;
  readonly text: string;
}

export interface ActionParameterValues {
  readonly target?: string;
  readonly destination?: string;
  readonly inputs?: Readonly<Record<string, string>>;
}

const recordOf = (value: unknown): Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : {};

const stringsOf = (value: unknown): readonly string[] =>
  Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];

function commandOf(item: MergedItem): ActionCommandDefinition {
  const argumentsValue = Array.isArray(item.values.arguments) ? item.values.arguments : [];
  const args: ActionCommandArgument[] = [];
  for (const value of argumentsValue) {
    const argument = recordOf(value);
    if (argument.kind === "entity") {
      const filters = Array.isArray(argument.filters) ? argument.filters : [];
      args.push({
        name: String(argument.name),
        kind: "entity",
        binding: argument.binding as "target" | "destination",
        candidates: argument.candidates as EntityCandidateSource,
        filters: filters.map((filter) => {
          const entry = recordOf(filter);
          return { attribute: String(entry.attribute), equals: entry.equals as SimpleValue };
        }),
        prompt: String(argument.prompt),
      });
    } else {
      args.push({
        name: String(argument.name),
        kind: "text",
        field: String(argument.field),
        prompt: String(argument.prompt),
        minLength: typeof argument.minLength === "number" ? argument.minLength : 0,
        maxLength: Number(argument.maxLength),
      });
    }
  }
  return Object.freeze({
    ref: item.ref,
    name: String(item.values.name),
    description: String(item.values.description),
    order: Number(item.values.order),
    aliases: Object.freeze([...stringsOf(item.values.aliases)]),
    action: String(item.values.action),
    conflict: item.values.conflict as ActionPolicy,
    arguments: Object.freeze(args),
  });
}

export function actionCommands(config: RuntimeConfig): readonly ActionCommandDefinition[] {
  return itemsOf(config, "agentlife.interaction/action-command")
    .map(commandOf)
    .sort((left, right) => left.order - right.order || left.ref.localeCompare(right.ref));
}

function label(config: RuntimeConfig, ref: string): string {
  const value = itemOf(config, ref)?.values.name;
  return typeof value === "string" ? value : ref;
}

function description(config: RuntimeConfig, ref: string): string {
  const value = itemOf(config, ref)?.values.description;
  return typeof value === "string" ? value : "";
}

/** Resolves the location carrying an entity without mutating or interpreting world rules. */
export function physicalLocation(state: SimulationState, entityId: string): string | null {
  const seen = new Set<string>();
  let current: string | null = entityId;
  while (current !== null && !seen.has(current)) {
    seen.add(current);
    const entity: WorldEntity | undefined = state.world.entities[current];
    if (entity === undefined) return null;
    if (entity.kind === "location") return entity.entityId;
    current = entity.locatedAt ?? entity.heldBy ?? entity.placedOn;
  }
  return null;
}

export function playerView(config: RuntimeConfig, state: SimulationState, playerId: string): PlayerView {
  const locationId = physicalLocation(state, playerId);
  const location = locationId === null ? undefined : itemOf(config, locationId);
  const exits = stringsOf(location?.values.exits).map((ref) => ({
    entityId: ref,
    name: label(config, ref),
    detail: description(config, ref),
  }));
  const entities: PlayerViewEntity[] = [];
  const heldItems: PlayerViewEntity[] = [];
  for (const entity of Object.values(state.world.entities).sort((left, right) =>
    left.entityId.localeCompare(right.entityId),
  )) {
    if (entity.entityId === playerId || entity.kind === "location") continue;
    const common = {
      entityId: entity.entityId,
      name: label(config, entity.entityId),
      detail: description(config, entity.entityId),
      kind: entity.kind as "item" | "character",
    };
    if (entity.heldBy === playerId) heldItems.push({ ...common, relation: "held" });
    else if (locationId !== null && physicalLocation(state, entity.entityId) === locationId)
      entities.push({ ...common, relation: entity.placedOn === null ? "nearby" : "placed" });
  }
  return Object.freeze({
    playerId,
    tick: state.tick,
    simSeconds: state.simTime.seconds,
    runMode: state.runMode,
    configId: state.configId,
    locationId,
    locationName: locationId === null ? "未知地点" : label(config, locationId),
    locationDescription: locationId === null ? "" : description(config, locationId),
    exits: Object.freeze(exits),
    entities: Object.freeze(entities),
    heldItems: Object.freeze(heldItems),
    playerActions: Object.freeze(
      state.actions
        .filter((action) => action.entityId === playerId)
        .map((action) => ({
          action: label(config, action.action),
          status: action.status,
          outcome: action.outcome?.reason ?? null,
        })),
    ),
    barrier: state.barrier?.detail ?? state.failure?.detail ?? null,
  });
}

function eventIsVisible(state: SimulationState, playerId: string, event: WorldEvent): boolean {
  const locationId = physicalLocation(state, playerId);
  const visible = new Set(
    Object.values(state.world.entities)
      .filter((entity) => locationId !== null && physicalLocation(state, entity.entityId) === locationId)
      .map((entity) => entity.entityId),
  );
  visible.add(playerId);
  return (event.actor !== null && visible.has(event.actor)) || (event.subject !== null && visible.has(event.subject));
}

function eventText(config: RuntimeConfig, playerId: string, event: WorldEvent): string {
  const actor = event.actor === null ? "环境" : label(config, event.actor);
  const subject = event.subject === null ? "环境" : label(config, event.subject);
  const from = typeof event.from === "string" ? label(config, event.from) : String(event.from ?? "无");
  const to = typeof event.to === "string" ? label(config, event.to) : String(event.to ?? "无");
  if (event.kind === "relation-changed") {
    if (event.stateRef === "agentlife.world/located-at") return `${subject}从${from}移动到了${to}`;
    if (event.stateRef === "agentlife.world/held-by") {
      if (event.to === playerId) return `你拿起了${subject}`;
      if (event.from === playerId) return `你放下了${subject}`;
      return `${actor}拿起了${subject}`;
    }
    if (event.stateRef === "agentlife.world/placed-on") return `${actor}把${subject}放在了${to}上`;
    return `${subject}的状态从${from}变为${to}`;
  }
  if (event.kind === "environment-changed") return `${subject}发生了变化：${from} → ${to}`;
  if (event.kind === "influence-rejected") return `${actor}对${subject}的尝试没有生效`;
  if (event.kind === "process-established") return `${subject}开始发生变化`;
  if (event.kind === "process-ended") return `${subject}的变化结束了`;
  return `${subject}的变化仍在继续`;
}

/** Temporary phase-3 observation projection; formal perception replaces it in phase 4. */
export function observedEvents(
  config: RuntimeConfig,
  state: SimulationState,
  playerId: string,
): readonly ObservedEvent[] {
  return Object.freeze(
    state.world.events
      .filter((event) => eventIsVisible(state, playerId, event))
      .map((event) => Object.freeze({ eventId: event.eventId, text: eventText(config, playerId, event) })),
  );
}

function attributeKey(config: RuntimeConfig, ref: string): string | undefined {
  const item = itemOf(config, ref);
  return item?.typeRef === "agentlife.world/attribute" ? item.name : undefined;
}

function passesFilters(
  config: RuntimeConfig,
  state: SimulationState,
  entityId: string,
  filters: readonly EntityCandidateFilter[],
): boolean {
  const attributes = state.world.entities[entityId]?.attributes;
  if (attributes === undefined) return false;
  return filters.every((filter) => {
    const key = attributeKey(config, filter.attribute);
    return key !== undefined && attributes[key] === filter.equals;
  });
}

export function entityChoices(
  config: RuntimeConfig,
  state: SimulationState,
  playerId: string,
  argument: Extract<ActionCommandArgument, { readonly kind: "entity" }>,
): readonly EntityChoice[] {
  const view = playerView(config, state, playerId);
  let ids: readonly string[];
  if (argument.candidates === "current-exits") ids = view.exits.map((entry) => entry.entityId);
  else if (argument.candidates === "held-items") ids = view.heldItems.map((entry) => entry.entityId);
  else if (argument.candidates === "visible-items")
    ids = view.entities.filter((entry) => entry.kind === "item").map((entry) => entry.entityId);
  else ids = view.entities.map((entry) => entry.entityId);
  return Object.freeze(
    ids
      .filter((entityId) => passesFilters(config, state, entityId, argument.filters))
      .map((entityId) => ({ entityId, name: label(config, entityId), detail: description(config, entityId) })),
  );
}

function bodyAllows(config: RuntimeConfig, state: SimulationState, playerId: string, actionRef: string): boolean {
  if (state.characters.characters[playerId]?.lifecycle !== "running") return false;
  const body = state.body.bodies[playerId];
  const action = actionSpec(config, actionRef);
  if (body === undefined || action === undefined) return false;
  const bodyConfig = bodyConfigSpec(config, body.configRef);
  const mode = modeAbilities(config, body.mode);
  return (
    bodyConfig !== undefined && bodyConfig.abilities.includes(action.ability) && mode?.includes(action.ability) === true
  );
}

export function availableActions(
  config: RuntimeConfig,
  state: SimulationState,
  playerId: string,
): readonly AvailableAction[] {
  const available: AvailableAction[] = [];
  for (const command of actionCommands(config)) {
    if (!bodyAllows(config, state, playerId, command.action)) continue;
    const firstEntity = command.arguments.find((argument) => argument.kind === "entity");
    const firstChoices = firstEntity === undefined ? [] : entityChoices(config, state, playerId, firstEntity);
    if (firstEntity !== undefined && firstChoices.length === 0) continue;
    // Every required entity slot must have at least one current candidate. This is
    // discovery only; the authoritative services still decide the submitted plan.
    if (
      command.arguments.some(
        (argument) => argument.kind === "entity" && entityChoices(config, state, playerId, argument).length === 0,
      )
    )
      continue;
    available.push(Object.freeze({ command, firstChoices }));
  }
  return Object.freeze(available);
}

export function planFromCommand(
  command: ActionCommandDefinition,
  values: ActionParameterValues,
  playerId: string,
  planId: string,
  formedVersion: string,
): ActionPlan {
  const step: ActionStep = {
    action: command.action,
    ...(values.target === undefined ? {} : { target: values.target }),
    ...(values.destination === undefined ? {} : { destination: values.destination }),
    ...(values.inputs === undefined ? {} : { inputs: Object.freeze({ ...values.inputs }) }),
  };
  return Object.freeze({
    planId,
    entityId: playerId,
    source: "diagnostic",
    formedVersion,
    conflict: command.conflict,
    steps: Object.freeze([step]),
  });
}
