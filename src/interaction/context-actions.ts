import type { RuntimeConfig } from "../config/config-builder.js";
import type { MergedItem } from "../config/config-merge.js";
import type { SimpleValue } from "../config/value-expr.js";
import { actionSpec, bodyConfigSpec, itemLabel, itemOf, modeAbilities } from "../simulation/config-view.js";
import type {
  ActionPlan,
  ActionPolicy,
  ActionStep,
  ObservationRole,
  ObservedSubject,
  SimulationState,
} from "../simulation/types.js";

/**
 * The authorized player view and the commands built from it.
 *
 * Everything here reads what the player's own perception holds: the place, the
 * objects in view by their observer-local reference, and the player's own action
 * state. A reference is handed back when the player chooses, and the session maps
 * it back onto the protected anchor the services work with, so the interface never
 * addresses the world directly and never learns a name content did not project.
 */

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

/** One object the player may choose: a reference to hand back, an anchor to act on. */
export interface EntityChoice {
  readonly reference: string;
  readonly anchor: string;
  readonly name: string;
  readonly detail: string;
}

export interface AvailableAction {
  readonly command: ActionCommandDefinition;
  readonly firstChoices: readonly EntityChoice[];
}

export interface PerceivedSubject extends EntityChoice {
  readonly kind: ObservationRole;
  readonly held: boolean;
  readonly recognisable: boolean;
}

/** One observation the player actually holds, for the ordinary log. */
export interface PerceivedObservation {
  readonly observationId: string;
  readonly text: string;
}

export interface PerceivedPlayerView {
  readonly playerId: string;
  readonly tick: number;
  readonly simSeconds: number;
  readonly runMode: string;
  readonly configId: string;
  /** The place the player perceives, as its own observation describes it. */
  readonly place: PerceivedSubject | null;
  readonly exits: readonly PerceivedSubject[];
  readonly entities: readonly PerceivedSubject[];
  readonly heldItems: readonly PerceivedSubject[];
  readonly playerActions: readonly {
    readonly action: string;
    readonly status: string;
    readonly outcome: string | null;
  }[];
  readonly observations: readonly PerceivedObservation[];
  readonly barrier: string | null;
  readonly cognition: string | null;
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
  return config.items
    .filter((item) => item.typeRef === "agentlife.interaction/action-command")
    .map(commandOf)
    .sort((left, right) => left.order - right.order || left.ref.localeCompare(right.ref));
}

/** Everything the player's own perception currently holds, in reference order. */
function subjectsOf(state: SimulationState, playerId: string): readonly ObservedSubject[] {
  const observer = state.perception.observers[playerId];
  if (observer === undefined) return [];
  return Object.values(observer.subjects).sort((left, right) => left.reference.localeCompare(right.reference));
}

function perceivedOf(subject: ObservedSubject): PerceivedSubject {
  return Object.freeze({
    reference: subject.reference,
    anchor: subject.anchor,
    // Only what the observer recognised or was shown: a subject without a projected
    // identity is described, never named.
    name: subject.identity ?? subject.description,
    detail: subject.description,
    kind: subject.role,
    held: subject.held,
    recognisable: subject.recognisable,
  });
}

export function perceivedView(config: RuntimeConfig, state: SimulationState, playerId: string): PerceivedPlayerView {
  const subjects = subjectsOf(state, playerId).map(perceivedOf);
  const place = subjects.find((subject) => subject.kind === "place") ?? null;
  const exits = subjects.filter((subject) => subject.kind === "exit");
  const visible = subjects.filter((subject) => subject.kind === "character" || subject.kind === "item");
  const pending = state.perception.observers[playerId]?.pending ?? [];
  return Object.freeze({
    playerId,
    tick: state.tick,
    simSeconds: state.simTime.seconds,
    runMode: state.runMode,
    configId: state.configId,
    place,
    exits: Object.freeze(exits),
    entities: Object.freeze(visible),
    heldItems: Object.freeze(visible.filter((subject) => subject.held)),
    playerActions: Object.freeze(
      state.actions
        .filter((action) => action.entityId === playerId)
        .map((action) => ({
          action: itemLabel(config, action.action),
          status: action.status,
          outcome: action.outcome?.reason ?? null,
        })),
    ),
    observations: Object.freeze(
      pending.map((observation) => ({ observationId: observation.observationId, text: observation.text })),
    ),
    barrier: state.barrier?.detail ?? state.failure?.detail ?? null,
    cognition:
      state.round === null
        ? null
        : `${state.round.status}: ${state.round.participants
            .map((participant) => `${participant.characterId}=${participant.state}`)
            .join(", ")}`,
  });
}

/** What the player perceived, in formation order; the ordinary log renders this. */
export function perceivedObservations(state: SimulationState, playerId: string): readonly PerceivedObservation[] {
  return Object.freeze(
    (state.perception.observers[playerId]?.pending ?? []).map((observation) => ({
      observationId: observation.observationId,
      text: observation.text,
    })),
  );
}

function attributeKey(config: RuntimeConfig, ref: string): string | undefined {
  const item = itemOf(config, ref);
  return item?.typeRef === "agentlife.world/attribute" ? item.name : undefined;
}

function passesFilters(
  config: RuntimeConfig,
  state: SimulationState,
  anchor: string,
  filters: readonly EntityCandidateFilter[],
): boolean {
  const attributes = state.world.entities[anchor]?.attributes;
  if (attributes === undefined) return false;
  return filters.every((filter) => {
    const key = attributeKey(config, filter.attribute);
    return key !== undefined && attributes[key] === filter.equals;
  });
}

/** The objects of one observer-local view that fit a declared candidate source. */
function sourceOf(view: PerceivedPlayerView, source: EntityCandidateSource): readonly PerceivedSubject[] {
  if (source === "current-exits") return view.exits;
  if (source === "held-items") return view.heldItems;
  if (source === "visible-items") return view.entities.filter((subject) => subject.kind === "item");
  return view.entities;
}

export function entityChoices(
  config: RuntimeConfig,
  state: SimulationState,
  playerId: string,
  argument: Extract<ActionCommandArgument, { readonly kind: "entity" }>,
): readonly EntityChoice[] {
  const view = perceivedView(config, state, playerId);
  return Object.freeze(
    sourceOf(view, argument.candidates)
      .filter((subject) => passesFilters(config, state, subject.anchor, argument.filters))
      .map((subject) => ({
        reference: subject.reference,
        anchor: subject.anchor,
        name: subject.name,
        detail: subject.detail,
      })),
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

/** The plan one fulfilled command becomes; the session already mapped references. */
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
    source: "player-command",
    formedVersion,
    conflict: command.conflict,
    steps: Object.freeze([step]),
  });
}
