import type {
  BehaviorFunction,
  BehaviorFunctionRegistry,
  BehaviorPredicate,
  JsonValue,
} from "./behavior-tree-adapter.js";

/**
 * The fixed function and predicate vocabulary a behaviour tree may call.
 *
 * A tree is content, so it can only reach what this registry exposes: its own
 * bounded blackboard, the whitelisted local execution view and the plan recorder.
 * There is no binding for reading the whole world, another character's private
 * state, protected classification, files, the network, the database, the machine
 * clock or a model.
 */

export interface PlannedStep {
  readonly action: string;
  readonly target?: string;
  readonly destination?: string;
}

function asString(value: JsonValue | undefined): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function asNumber(value: JsonValue | undefined): number | undefined {
  return typeof value === "number" ? value : undefined;
}

/** One planned step, encoded for the adapter's string-only plan recorder. */
export function encodedStep(step: PlannedStep): string {
  return JSON.stringify(step);
}

export function plannedStep(text: string): PlannedStep | undefined {
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const action: unknown = Reflect.get(parsed, "action");
    if (typeof action !== "string") return undefined;
    const target: unknown = Reflect.get(parsed, "target");
    const destination: unknown = Reflect.get(parsed, "destination");
    return {
      action,
      ...(typeof target === "string" ? { target } : {}),
      ...(typeof destination === "string" ? { destination } : {}),
    };
  } catch {
    return undefined;
  }
}

const predicates: Readonly<Record<string, BehaviorPredicate>> = {
  /** True when a whitelisted local view member carries exactly this value. */
  "view-equals": (context, member, expected) => context.view(String(member)) === expected,
  /** True when a whitelisted numeric local view member reaches this bound. */
  "view-at-least": (context, member, bound) => {
    const value = asNumber(context.view(String(member)));
    const limit = asNumber(bound);
    return value !== undefined && limit !== undefined && value >= limit;
  },
  /** True when a whitelisted numeric local view member stays below this bound. */
  "view-below": (context, member, bound) => {
    const value = asNumber(context.view(String(member)));
    const limit = asNumber(bound);
    return value !== undefined && limit !== undefined && value < limit;
  },
  /** True when the blackboard flag is set. */
  flag: (context, key) => context.read(String(key)) === true,
  /** True when the simulated tick has reached the tick remembered under this key. */
  "tick-at-least": (context, key) => {
    const remembered = asNumber(context.read(String(key)));
    return remembered !== undefined && context.tick >= remembered;
  },
};

const functions: Readonly<Record<string, BehaviorFunction>> = {
  /** Sets one blackboard flag; the blackboard stays bounded by the adapter. */
  "set-flag": (context, key, value) => {
    context.write(String(key), value === undefined ? true : value);
    return "succeeded";
  },
  "clear-flag": (context, key) => {
    context.write(String(key), false);
    return "succeeded";
  },
  /** Remembers the current simulated tick, used for waiting and cooldowns. */
  "record-tick": (context, key) => {
    context.write(String(key), context.tick);
    return "succeeded";
  },
  /** Adds one step to the body plan this decision hands over. */
  plan: (context, action, target, destination) => {
    const named = asString(action);
    if (named === undefined) return "failed";
    const entity = asString(target);
    const place = asString(destination);
    context.emit(
      encodedStep({
        action: named,
        ...(entity === undefined ? {} : { target: entity }),
        ...(place === undefined ? {} : { destination: place }),
      }),
    );
    return "succeeded";
  },
  /** A decision that changes nothing; still recorded, so identity stays stable. */
  idle: () => "succeeded",
};

export function behaviorFunctionRegistry(): BehaviorFunctionRegistry {
  return { functions, predicates };
}

/** Names a behaviour tree definition may call, in stable order. */
export function behaviorFunctionNames(): readonly string[] {
  return [...Object.keys(functions), ...Object.keys(predicates)].sort();
}
