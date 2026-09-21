import { BehaviourTree, State, type NodeDetails } from "mistreevous";
import type { Agent } from "mistreevous/dist/Agent.js";

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

/**
 * The only surface a tree function can reach: a bounded JSON blackboard plus a plan
 * recorder. No world, no private state, no I/O, no LLM and no clock are in scope.
 */
export interface BehaviorFunctionContext {
  read(key: string): JsonValue | undefined;
  write(key: string, value: JsonValue): void;
  emit(step: string): void;
}

export type BehaviorState = "succeeded" | "failed";
/** Action nodes and `entry`/`step`/`exit` callbacks. */
export type BehaviorFunction = (context: BehaviorFunctionContext, ...args: JsonValue[]) => BehaviorState;
/** `condition` nodes and `while`/`until` guards, which must return a real boolean. */
export type BehaviorPredicate = (context: BehaviorFunctionContext, ...args: JsonValue[]) => boolean;

export interface BehaviorFunctionRegistry {
  readonly functions: Readonly<Record<string, BehaviorFunction>>;
  readonly predicates: Readonly<Record<string, BehaviorPredicate>>;
}

export interface BehaviorTraceEntry {
  /** Canonical structural path; Mistreevous node ids are random per instance. */
  readonly path: string;
  readonly type: string;
  readonly previousState: string;
  readonly state: string;
}

export interface BehaviorRuntimeState {
  readonly tick: number;
  readonly blackboard: Readonly<Record<string, JsonValue>>;
  readonly plan: readonly string[];
  readonly trace: readonly BehaviorTraceEntry[];
  readonly appliedKeys: readonly string[];
}

export interface BehaviorDecision {
  readonly tick: number;
  readonly key: string;
  readonly status: "resolved" | "already-applied";
  readonly blackboard: Readonly<Record<string, JsonValue>>;
  readonly plan: readonly string[];
  readonly trace: readonly BehaviorTraceEntry[];
}

export interface BehaviorTreeAdapterOptions {
  readonly definition: unknown;
  readonly registry: BehaviorFunctionRegistry;
  /** Explicit simulated duration of one tick; Mistreevous never sees a machine clock. */
  readonly tickSeconds: number;
  readonly maxBlackboardKeys?: number;
  readonly maxStepsPerDecision?: number;
}

export class BehaviorTreeAdapterError extends Error {}

/**
 * Node kinds accepted in phase 0. Each resolves inside a single `step()` once its leaf
 * functions return only SUCCEEDED or FAILED, so no node state has to survive a decision.
 */
const ALLOWED_NODES: Record<string, "composite" | "decorator" | "leaf"> = {
  root: "decorator",
  sequence: "composite",
  selector: "composite",
  parallel: "composite",
  race: "composite",
  all: "composite",
  repeat: "decorator",
  retry: "decorator",
  flip: "decorator",
  succeed: "decorator",
  fail: "decorator",
  action: "leaf",
  condition: "leaf",
};

/** Excluded kinds carry state or entropy that the public API cannot export. */
const EXCLUDED_NODES: Record<string, string> = {
  wait: "wait nodes accumulate duration internally across steps",
  lotto: "lotto nodes consume randomness",
  branch: "branch nodes resolve subtrees from a global registry at run time",
};

const GUARD_ATTRIBUTES = ["while", "until"] as const;
const CALLBACK_ATTRIBUTES = ["entry", "step", "exit"] as const;

/**
 * Restricted Mistreevous adapter: JSON definitions only, a fixed function registry,
 * blackboard and idempotency identity persisted by the adapter, and one decision per
 * `step()`. Internal `RUNNING` state is never relied upon or reachable.
 */
export class BehaviorTreeAdapterProbe {
  private readonly tree: BehaviourTree;
  private readonly paths: ReadonlyMap<string, string>;
  private readonly maxBlackboardKeys: number;
  private readonly maxStepsPerDecision: number;
  private readonly applied: Set<string>;
  private readonly context: BehaviorFunctionContext;
  private blackboard: Map<string, JsonValue>;
  private pending: Map<string, JsonValue>;
  private trace: BehaviorTraceEntry[] = [];
  private plan: string[] = [];
  private tick: number;
  private failure: string | undefined;

  private constructor(options: BehaviorTreeAdapterOptions, state: BehaviorRuntimeState | undefined) {
    validateDefinition(options.definition, options.registry);
    this.maxBlackboardKeys = options.maxBlackboardKeys ?? 32;
    this.maxStepsPerDecision = options.maxStepsPerDecision ?? 256;
    this.blackboard = new Map(Object.entries(state?.blackboard ?? {}));
    this.pending = new Map(this.blackboard);
    this.applied = new Set(state?.appliedKeys ?? []);
    this.tick = state?.tick ?? 0;
    this.plan = [...(state?.plan ?? [])];
    this.trace = [...(state?.trace ?? [])];
    this.context = {
      read: (key) => this.pending.get(key),
      write: (key, value) => this.write(key, value),
      emit: (step) => this.plan.push(step),
    };

    const agent: Agent = {};
    for (const [name, behavior] of Object.entries(options.registry.functions)) {
      agent[name] = (...args: unknown[]) =>
        behavior(this.context, ...(args as JsonValue[])) === "succeeded" ? State.SUCCEEDED : State.FAILED;
    }
    for (const [name, predicate] of Object.entries(options.registry.predicates)) {
      agent[name] = (...args: unknown[]) => predicate(this.context, ...(args as JsonValue[]));
    }

    this.tree = new BehaviourTree(options.definition as never, agent, {
      getDeltaTime: () => options.tickSeconds,
      // Randomness reaches the tree through excluded nodes only; this hook keeps a
      // definition that slipped past validation from silently drawing on Math.random.
      random: () => {
        throw new BehaviorTreeAdapterError("Random sources are not permitted in phase 0");
      },
      onNodeStateChange: (change) => {
        this.trace.push(
          Object.freeze({
            path: this.paths.get(change.id) ?? change.id,
            type: change.type,
            previousState: change.previousState.replace("mistreevous.", ""),
            state: change.state.replace("mistreevous.", ""),
          }),
        );
      },
    });
    this.paths = indexNodePaths(this.tree.getTreeNodeDetails());
  }

  static create(options: BehaviorTreeAdapterOptions): BehaviorTreeAdapterProbe {
    return new BehaviorTreeAdapterProbe(options, undefined);
  }

  static restore(options: BehaviorTreeAdapterOptions, state: BehaviorRuntimeState): BehaviorTreeAdapterProbe {
    return new BehaviorTreeAdapterProbe(options, state);
  }

  /**
   * Run one decision. A repeated key is reported as already applied, ticks must
   * strictly advance, and a decision that throws leaves the blackboard untouched and
   * latches the adapter as unusable.
   */
  decide(input: { tick: number; key: string }): BehaviorDecision {
    if (this.failure !== undefined) throw new BehaviorTreeAdapterError(`Adapter is unusable after: ${this.failure}`);
    if (this.applied.has(input.key)) return this.snapshot(this.tick, input.key, "already-applied");
    if (input.tick <= this.tick) {
      throw new BehaviorTreeAdapterError(`Tick ${input.tick} does not advance past ${this.tick}`);
    }

    this.pending = new Map(this.blackboard);
    this.plan = [];
    // Mistreevous resets resolved nodes lazily inside `step()`; doing it explicitly
    // first keeps a decision's trace independent of which instance produced the
    // previous decision, so a restored adapter traces exactly like a fresh one.
    this.tree.reset();
    this.trace = [];
    let steps = 0;
    try {
      for (;;) {
        this.tree.step();
        steps += 1;
        if (!this.tree.isRunning()) break;
        if (steps >= this.maxStepsPerDecision) {
          throw new BehaviorTreeAdapterError(
            `Definition did not resolve within ${this.maxStepsPerDecision} steps at tick ${input.tick}`,
          );
        }
      }
    } catch (error) {
      this.failure = error instanceof Error ? error.message : String(error);
      this.pending = this.blackboard;
      throw error;
    }

    this.blackboard = this.pending;
    this.pending = this.blackboard;
    this.tick = input.tick;
    this.applied.add(input.key);
    return this.snapshot(input.tick, input.key, "resolved");
  }

  exportState(): BehaviorRuntimeState {
    return Object.freeze({
      tick: this.tick,
      blackboard: freezeBlackboard(this.blackboard),
      plan: Object.freeze([...this.plan]),
      trace: Object.freeze(this.trace.map((entry) => Object.freeze({ ...entry }))),
      appliedKeys: Object.freeze([...this.applied].sort()),
    });
  }

  private write(key: string, value: JsonValue): void {
    if (!isJsonValue(value)) throw new BehaviorTreeAdapterError(`Blackboard value for ${key} is not JSON`);
    if (!this.pending.has(key) && this.pending.size >= this.maxBlackboardKeys) {
      throw new BehaviorTreeAdapterError(`Blackboard is limited to ${this.maxBlackboardKeys} keys`);
    }
    this.pending.set(key, value);
  }

  private snapshot(tick: number, key: string, status: BehaviorDecision["status"]): BehaviorDecision {
    return Object.freeze({
      tick,
      key,
      status,
      blackboard: freezeBlackboard(this.blackboard),
      plan: Object.freeze([...this.plan]),
      trace: Object.freeze(this.trace.map((entry) => Object.freeze({ ...entry }))),
    });
  }
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (typeof value !== "object") return false;
  return Object.values(value as Record<string, unknown>).every(isJsonValue);
}

function freezeBlackboard(blackboard: ReadonlyMap<string, JsonValue>): Readonly<Record<string, JsonValue>> {
  const sorted: Record<string, JsonValue> = {};
  for (const key of [...blackboard.keys()].sort()) sorted[key] = blackboard.get(key) as JsonValue;
  return Object.freeze(sorted);
}

function nodeLabel(type: string, name: string): string {
  return type === "action" || type === "condition" ? `${type}:${name}` : type;
}

/** Canonical, instance-independent path for every node, keyed by the library's id. */
function indexNodePaths(details: NodeDetails): ReadonlyMap<string, string> {
  const paths = new Map<string, string>();
  const visit = (node: NodeDetails, parent: string): void => {
    const path = parent === "" ? nodeLabel(node.type, node.name) : `${parent}/${nodeLabel(node.type, node.name)}`;
    paths.set(node.id, path);
    (node.children ?? []).forEach((child, index) => visit(child, `${path}#${index}`));
  };
  visit(details, "");
  return paths;
}

function validateDefinition(definition: unknown, registry: BehaviorFunctionRegistry): void {
  if (typeof definition !== "object" || definition === null || Array.isArray(definition)) {
    throw new BehaviorTreeAdapterError("Behaviour trees must be supplied as a JSON object, not MDSL text");
  }
  const root = definition as Record<string, unknown>;
  if (root["type"] !== "root") throw new BehaviorTreeAdapterError("A tree definition must have a single root node");
  validateNode(root, registry, "");
}

function validateNode(node: unknown, registry: BehaviorFunctionRegistry, parentPath: string): void {
  if (typeof node !== "object" || node === null || Array.isArray(node)) {
    throw new BehaviorTreeAdapterError(`Node at ${parentPath} must be a JSON object`);
  }
  const candidate = node as Record<string, unknown>;
  const type = candidate["type"];
  if (typeof type !== "string") throw new BehaviorTreeAdapterError(`Node at ${parentPath} has no type`);
  const call = candidate["call"];
  const path = `${parentPath === "" ? "" : `${parentPath}/`}${nodeLabel(type, typeof call === "string" ? call : "")}`;

  const excluded = EXCLUDED_NODES[type];
  if (excluded !== undefined)
    throw new BehaviorTreeAdapterError(`Unsupported node type ${type} at ${path}: ${excluded}`);
  const kind = ALLOWED_NODES[type];
  if (kind === undefined) throw new BehaviorTreeAdapterError(`Unknown node type ${type} at ${path}`);

  if (type === "action") {
    requireRegistered(registry.functions, call, path, "Function");
    validateArgs(candidate["args"], path);
  }
  if (type === "condition") {
    requireRegistered(registry.predicates, call, path, "Predicate");
    validateArgs(candidate["args"], path);
  }
  if (kind === "composite") {
    const children = candidate["children"];
    if (!Array.isArray(children) || children.length === 0) {
      throw new BehaviorTreeAdapterError(`Composite node ${type} at ${path} needs children`);
    }
    children.forEach((child, index) => validateNode(child, registry, `${path}#${index}`));
  }
  if (kind === "decorator") {
    if (candidate["child"] === undefined) {
      throw new BehaviorTreeAdapterError(`Decorator node ${type} at ${path} needs a child`);
    }
    validateNode(candidate["child"], registry, `${path}#0`);
  }
  if (type === "repeat" || type === "retry") {
    const bound = type === "repeat" ? candidate["iterations"] : candidate["attempts"];
    if (!Number.isInteger(bound) || (bound as number) < 1) {
      const name = type === "repeat" ? "iterations" : "attempts";
      throw new BehaviorTreeAdapterError(
        `${type} at ${path} needs a positive integer ${name} (random ranges are disabled)`,
      );
    }
  }
  for (const attribute of GUARD_ATTRIBUTES) {
    const call = attributeCall(candidate, attribute, path);
    if (call !== undefined) requireRegistered(registry.predicates, call, `${path}/${attribute}`, "Predicate");
  }
  for (const attribute of CALLBACK_ATTRIBUTES) {
    const call = attributeCall(candidate, attribute, path);
    if (call !== undefined) requireRegistered(registry.functions, call, `${path}/${attribute}`, "Function");
  }
}

function attributeCall(candidate: Record<string, unknown>, attribute: string, path: string): unknown {
  const value = candidate[attribute];
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new BehaviorTreeAdapterError(`Attribute ${attribute} at ${path} must be an object`);
  }
  const record = value as Record<string, unknown>;
  validateArgs(record["args"], `${path}/${attribute}`);
  return record["call"];
}

function requireRegistered(table: Readonly<Record<string, unknown>>, call: unknown, path: string, kind: string): void {
  if (typeof call !== "string" || call.length === 0)
    throw new BehaviorTreeAdapterError(`Node at ${path} needs a call name`);
  if (table[call] === undefined) throw new BehaviorTreeAdapterError(`${kind} ${call} at ${path} is not registered`);
}

function validateArgs(args: unknown, path: string): void {
  if (args === undefined) return;
  if (!Array.isArray(args)) throw new BehaviorTreeAdapterError(`Arguments at ${path} must be an array`);
  for (const argument of args) {
    if (typeof argument === "object" && argument !== null && "$" in argument) {
      throw new BehaviorTreeAdapterError(`Argument references are not permitted at ${path}`);
    }
    if (!isJsonValue(argument)) throw new BehaviorTreeAdapterError(`Argument at ${path} is not JSON`);
  }
}
