import { runCondition, conditionUsesSimulationTime } from "./conditions.js";
import type { RuntimeFormula, RuntimeRule, RuntimeConfig, CombinePlan } from "./config-builder.js";
import { strongestStatus, type ResultStatus } from "./diagnostics.js";
import type { CombineMode } from "./numeric.js";
import { applyNumberPolicy } from "./numeric.js";
import type { CheckedInput } from "./config-checker.js";
import type { StateScope } from "./system-spec.js";
import {
  runExpr,
  type SimpleValue,
  type SimTime,
  type ValueFailure,
  type ValueResult,
  type ValueContext,
} from "./value-expr.js";

/** A complete, immutable state projection used by one deterministic run. */
export interface StateInput {
  readonly stateVersion: string;
  readonly simTime: SimTime;
  readonly shared: Readonly<Record<string, unknown>>;
  readonly entities: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
}

export interface RuleRequest {
  readonly runId: string;
  readonly trigger: string;
  /** Explicit evaluation range. The engine de-duplicates and sorts these ids. */
  readonly entityIds: readonly string[];
  readonly baseVersion?: string;
  readonly input: StateInput;
}

export interface InputTrace {
  readonly entityId: string | null;
  readonly name: string;
  readonly stateRef: string;
  readonly field: string;
  readonly present: boolean;
  readonly value: SimpleValue | null;
}

export type RuleStatus = "evaluated" | "condition-false" | "input-missing" | "input-invalid";

export interface RuleTrace {
  readonly entityId: string | null;
  readonly ruleId: string;
  readonly status: RuleStatus;
  readonly inputs: readonly InputTrace[];
  readonly message?: string;
}

export interface ValueTrace {
  readonly entityId: string | null;
  readonly ruleId: string;
  readonly value: SimpleValue;
  readonly priority: number | null;
}

export interface CombineTrace {
  readonly scope: StateScope;
  readonly entityId: string | null;
  readonly stateRef: string;
  readonly combine: CombineMode;
  readonly status: "composed" | "conflict" | "rejected";
  readonly ruleValues: readonly ValueTrace[];
  readonly result: SimpleValue | null;
  readonly conflicting: readonly string[];
  readonly message?: string;
}

export interface StateChangeRequest {
  readonly entityId: string | null;
  readonly stateRef: string;
  readonly system: string;
  readonly newValue: SimpleValue;
  readonly sourceRules: readonly string[];
  readonly runId: string;
  readonly baseVersion: string;
  readonly simTime: SimTime;
}

export interface ProcessChangeRequest {
  readonly entityId: string | null;
  readonly processRef: string;
  readonly system: string;
  readonly action: "establish" | "advance" | "pause" | "end" | "cancel";
  readonly params: Readonly<Record<string, SimpleValue>>;
  readonly sourceRule: string;
}

export interface ScopeTrace {
  readonly entityId: string | null;
  readonly selectedRules: readonly string[];
  readonly skippedRules: readonly string[];
  readonly rules: readonly RuleTrace[];
  readonly combines: readonly CombineTrace[];
  readonly stateChanges: readonly StateChangeRequest[];
  readonly processChanges: readonly ProcessChangeRequest[];
}

export interface RunTrace {
  readonly runId: string;
  readonly trigger: string;
  readonly configId: string;
  readonly stateVersion: string;
  readonly simTime: SimTime;
  readonly shared: ScopeTrace;
  readonly entities: readonly ScopeTrace[];
  readonly stateChanges: readonly StateChangeRequest[];
  readonly processChanges: readonly ProcessChangeRequest[];
}

export interface RuleResult {
  readonly status: ResultStatus;
  readonly configId: string;
  readonly stateChanges: readonly StateChangeRequest[];
  readonly processChanges: readonly ProcessChangeRequest[];
  readonly trace: RunTrace;
}

interface RuleRun {
  readonly trace: RuleTrace;
  readonly stateValues: readonly {
    readonly stateRef: string;
    readonly combine: CombineMode;
    readonly priority: number | null;
    readonly value: SimpleValue;
  }[];
  readonly processChanges: readonly ProcessChangeRequest[];
}

interface ScopeRun {
  readonly trace: ScopeTrace;
  readonly outcomes: readonly RuleStatus[];
}

function failureReason(reason: ValueFailure): RuleStatus {
  return reason === "input-missing" ? "input-missing" : "input-invalid";
}

function entityIdsOf(request: RuleRequest): readonly string[] {
  return [...new Set(request.entityIds)].sort();
}

function selectedRules(config: RuntimeConfig, trigger: string, scope: StateScope): readonly RuntimeRule[] {
  const byRef = new Map(config.rules.map((rule) => [rule.ref, rule]));
  return (config.triggerIndex[trigger] ?? [])
    .map((ref) => byRef.get(ref))
    .filter((rule): rule is RuntimeRule => rule !== undefined && rule.evaluationScope === scope);
}

function skippedRules(config: RuntimeConfig, selected: readonly RuntimeRule[], scope: StateScope): readonly string[] {
  const selectedIds = new Set(selected.map((rule) => rule.ref));
  return config.rules
    .filter((rule) => rule.evaluationScope === scope && !selectedIds.has(rule.ref))
    .map((rule) => rule.ref);
}

function inputValue(
  state: StateInput,
  scope: StateScope,
  entityId: string | null,
  stateRef: string,
  field: string,
): { present: boolean; value?: unknown } {
  const source = scope === "shared" ? state.shared : entityId === null ? undefined : state.entities[entityId];
  const container = source?.[stateRef];
  if (typeof container !== "object" || container === null) return { present: false };
  const value: unknown = Reflect.get(container, field);
  return value === undefined ? { present: false } : { present: true, value };
}

function inputTraces(
  rule: RuntimeRule | RuntimeFormula,
  input: StateInput,
  entityId: string | null,
): readonly InputTrace[] {
  return rule.usedInputs.map((read) => {
    const found = inputValue(input, read.scope, entityId, read.stateRef, read.field);
    const value = found.value;
    const scalar = typeof value === "number" || typeof value === "boolean" || typeof value === "string" ? value : null;
    return {
      entityId,
      name: read.name,
      stateRef: read.stateRef,
      field: read.field,
      present: found.present && scalar !== null,
      value: scalar,
    };
  });
}

function buildScope(
  config: RuntimeConfig,
  input: StateInput,
  inputs: readonly CheckedInput[],
  entityId: string | null,
): ValueContext {
  const units = new Map(inputs.map((read) => [read.name, read.unit]));
  const memo = new Map<string, ValueResult>();
  const visiting = new Set<string>();
  const formulasById = new Map(config.formulas.map((formula) => [formula.ref, formula]));
  const runFormula = (ref: string): ValueResult => {
    const cached = memo.get(ref);
    if (cached !== undefined) return cached;
    const formula = formulasById.get(ref);
    if (formula === undefined) return { ok: false, reason: "inexpressible", message: `Unknown formula ${ref}` };
    if (visiting.has(ref)) return { ok: false, reason: "inexpressible", message: `Formula cycle at ${ref}` };
    visiting.add(ref);
    const result = runExpr(formula.value, context);
    visiting.delete(ref);
    memo.set(ref, result);
    return result;
  };
  const context: ValueContext = {
    read: (name) => {
      const read = inputs.find((candidate) => candidate.name === name);
      if (read === undefined) return { found: false };
      const found = inputValue(input, read.scope, entityId, read.stateRef, read.field);
      return found.present ? { found: true, value: found.value } : { found: false };
    },
    unitOf: (name) => units.get(name) ?? null,
    formula: runFormula,
    simTime: input.simTime,
  };
  return context;
}

function runChanges(
  rule: RuntimeRule,
  scope: ValueContext,
  entityId: string | null,
): {
  changes: RuleRun["stateValues"];
  processChanges: ProcessChangeRequest[];
  failure?: Extract<ValueResult, { readonly ok: false }>;
} {
  const stateValues: RuleRun["stateValues"][number][] = [];
  const processChanges: ProcessChangeRequest[] = [];
  for (const change of rule.changes) {
    if (change.kind === "state") {
      const value = runExpr(change.value, scope);
      if (!value.ok) return { changes: stateValues, processChanges, failure: value };
      stateValues.push({
        stateRef: change.stateRef,
        combine: change.combine,
        priority: change.priority,
        value: value.value,
      });
      continue;
    }
    const params: Record<string, SimpleValue> = {};
    for (const parameter of change.params) {
      const value = runExpr(parameter.value, scope);
      if (!value.ok) return { changes: stateValues, processChanges, failure: value };
      params[parameter.name] = value.value;
    }
    processChanges.push({
      entityId,
      processRef: change.processRef,
      system: change.system,
      action: change.action,
      params,
      sourceRule: rule.ref,
    });
  }
  return { changes: stateValues, processChanges };
}

function runRule(
  config: RuntimeConfig,
  request: RuleRequest,
  rule: RuntimeRule,
  entityId: string | null,
  missingEntity: boolean,
): RuleRun {
  const inputs = inputTraces(rule, request.input, entityId);
  if (missingEntity)
    return {
      trace: { entityId, ruleId: rule.ref, status: "input-missing", inputs, message: `Missing entity ${entityId}` },
      stateValues: [],
      processChanges: [],
    };
  const missing = inputs.filter((read) => !read.present);
  if (missing.length > 0)
    return {
      trace: {
        entityId,
        ruleId: rule.ref,
        status: "input-missing",
        inputs,
        message: `Missing declared inputs: ${missing.map((read) => read.name).join(", ")}`,
      },
      stateValues: [],
      processChanges: [],
    };

  const scope = buildScope(config, request.input, rule.usedInputs, entityId);
  const condition = runCondition(rule.condition, scope);
  if (!condition.ok)
    return {
      trace: {
        entityId,
        ruleId: rule.ref,
        status: failureReason(condition.reason),
        inputs,
        message: condition.message,
      },
      stateValues: [],
      processChanges: [],
    };
  if (!condition.value)
    return {
      trace: { entityId, ruleId: rule.ref, status: "condition-false", inputs },
      stateValues: [],
      processChanges: [],
    };

  const evaluated = runChanges(rule, scope, entityId);
  if (evaluated.failure !== undefined)
    return {
      trace: {
        entityId,
        ruleId: rule.ref,
        status: failureReason(evaluated.failure.reason),
        inputs,
        message: evaluated.failure.message,
      },
      stateValues: [],
      processChanges: [],
    };
  return {
    trace: { entityId, ruleId: rule.ref, status: "evaluated", inputs },
    stateValues: evaluated.changes,
    processChanges: evaluated.processChanges,
  };
}

function combineValues(plan: CombinePlan, entityId: string | null, ruleValues: readonly ValueTrace[]): CombineTrace {
  const base: Omit<CombineTrace, "status"> = {
    scope: plan.scope,
    entityId,
    stateRef: plan.stateRef,
    combine: plan.combine,
    ruleValues,
    result: null,
    conflicting: [],
  };
  if (ruleValues.length === 0) return { ...base, status: "composed" };
  if (plan.combine === "priority") {
    const highest = Math.max(...ruleValues.map((value) => value.priority ?? 0));
    const winners = ruleValues.filter((value) => (value.priority ?? 0) === highest);
    const distinct = [...new Set(winners.map((winner) => winner.value))];
    if (distinct.length > 1)
      return {
        ...base,
        status: "conflict",
        conflicting: winners.map((winner) => winner.ruleId),
        message: `Priority ${highest} is claimed by ${winners
          .map((winner) => `${winner.ruleId}=${String(winner.value)}`)
          .join(", ")}`,
      };
    const winner = winners[0]?.value ?? null;
    if (winner !== null && plan.allowedValues !== null && !plan.allowedValues.includes(String(winner)))
      return { ...base, status: "rejected", message: `${plan.stateRef} does not accept the value ${String(winner)}` };
    return { ...base, status: "composed", result: winner };
  }

  const values = ruleValues.map((ruleValue) => ruleValue.value);
  if (values.some((value) => typeof value !== "number"))
    return { ...base, status: "rejected", message: `${plan.combine} requires numeric ruleValues` };
  const numbers = values as readonly number[];
  const combined =
    plan.combine === "min"
      ? Math.min(...numbers)
      : plan.combine === "max"
        ? Math.max(...numbers)
        : plan.combine === "add"
          ? numbers.reduce((total, value) => total + value, 0)
          : numbers.reduce((total, value) => total * value, 1);
  if (plan.policy === null) return { ...base, status: "composed", result: combined };
  const normalized = applyNumberPolicy(combined, plan.policy);
  return normalized.ok
    ? { ...base, status: "composed", result: normalized.value }
    : { ...base, status: "rejected", message: normalized.message };
}

function evaluateScope(
  config: RuntimeConfig,
  request: RuleRequest,
  scope: StateScope,
  entityId: string | null,
  selected: readonly RuntimeRule[],
): ScopeRun {
  const ruleTraces: RuleTrace[] = [];
  const pending = new Map<string, ValueTrace[]>();
  const processChanges: ProcessChangeRequest[] = [];
  const missingEntity = scope === "entity" && entityId !== null && request.input.entities[entityId] === undefined;
  for (const rule of selected) {
    const evaluation = runRule(config, request, rule, entityId, missingEntity);
    ruleTraces.push(evaluation.trace);
    for (const change of evaluation.stateValues) {
      const value: ValueTrace = { entityId, ruleId: rule.ref, value: change.value, priority: change.priority };
      const bucket = pending.get(change.stateRef);
      if (bucket === undefined) pending.set(change.stateRef, [value]);
      else bucket.push(value);
    }
    processChanges.push(...evaluation.processChanges);
  }

  const combines: CombineTrace[] = [];
  const stateChanges: StateChangeRequest[] = [];
  for (const stateRef of [...pending.keys()].sort()) {
    const plan = config.combinePlans[stateRef];
    if (plan === undefined || plan.scope !== scope) continue;
    const ruleValues = pending.get(stateRef) ?? [];
    const combine = combineValues(plan, entityId, ruleValues);
    combines.push(combine);
    if (combine.status !== "composed" || combine.result === null) continue;
    stateChanges.push({
      entityId,
      stateRef,
      system: plan.system,
      newValue: combine.result,
      sourceRules: ruleValues.map((value) => value.ruleId).sort(),
      runId: request.runId,
      baseVersion: request.input.stateVersion,
      simTime: request.input.simTime,
    });
  }

  return {
    outcomes: ruleTraces.map((trace) => trace.status),
    trace: {
      entityId,
      selectedRules: selected.map((rule) => rule.ref),
      skippedRules: skippedRules(config, selected, scope),
      rules: ruleTraces,
      combines,
      stateChanges,
      processChanges,
    },
  };
}

function emptyScopeTrace(
  config: RuntimeConfig,
  selected: readonly RuntimeRule[],
  scope: StateScope,
  entityId: string | null,
): ScopeTrace {
  return {
    entityId,
    selectedRules: selected.map((rule) => rule.ref),
    skippedRules: skippedRules(config, selected, scope),
    rules: [],
    combines: [],
    stateChanges: [],
    processChanges: [],
  };
}

function traceOf(
  config: RuntimeConfig,
  request: RuleRequest,
  shared: ScopeTrace,
  entities: readonly ScopeTrace[],
): RunTrace {
  const stateChanges = [shared, ...entities].flatMap((trace) => trace.stateChanges);
  const processChanges = [shared, ...entities].flatMap((trace) => trace.processChanges);
  return {
    runId: request.runId,
    trigger: request.trigger,
    configId: config.configId,
    stateVersion: request.input.stateVersion,
    simTime: request.input.simTime,
    shared,
    entities,
    stateChanges,
    processChanges,
  };
}

export function runRules(config: RuntimeConfig, request: RuleRequest): RuleResult {
  const ids = entityIdsOf(request);
  const sharedRules = selectedRules(config, request.trigger, "shared");
  const entityRules = selectedRules(config, request.trigger, "entity");

  if (request.baseVersion !== undefined && request.baseVersion !== request.input.stateVersion) {
    const trace = traceOf(
      config,
      request,
      emptyScopeTrace(config, sharedRules, "shared", null),
      ids.map((entityId) => emptyScopeTrace(config, entityRules, "entity", entityId)),
    );
    return { status: "state-version-stale", configId: config.configId, stateChanges: [], processChanges: [], trace };
  }

  if (sharedRules.length === 0 && entityRules.length === 0) {
    const trace = traceOf(
      config,
      request,
      emptyScopeTrace(config, [], "shared", null),
      ids.map((entityId) => emptyScopeTrace(config, [], "entity", entityId)),
    );
    return { status: "no-match", configId: config.configId, stateChanges: [], processChanges: [], trace };
  }

  const shared = evaluateScope(config, request, "shared", null, sharedRules);
  const entities = ids.map((entityId) => evaluateScope(config, request, "entity", entityId, entityRules));
  const trace = traceOf(
    config,
    request,
    shared.trace,
    entities.map((run) => run.trace),
  );
  const statuses: ResultStatus[] = [];
  const scopeRuns = [shared, ...entities];
  const outcomes = scopeRuns.flatMap((run) => run.outcomes);
  for (const combine of scopeRuns.flatMap((run) => run.trace.combines)) {
    if (combine.status === "conflict") statuses.push("conflict");
    if (combine.status === "rejected") statuses.push("inexpressible");
  }
  if (trace.stateChanges.length > 0 || trace.processChanges.length > 0) statuses.push("changes");
  if (outcomes.includes("input-missing") || outcomes.includes("input-invalid")) statuses.push("input-invalid");
  if (
    !outcomes.some((outcome) => outcome === "evaluated" || outcome === "input-missing" || outcome === "input-invalid")
  )
    statuses.push("condition-false");
  if (statuses.length === 0) statuses.push("condition-false");
  return {
    status: strongestStatus(statuses),
    configId: config.configId,
    stateChanges: trace.stateChanges,
    processChanges: trace.processChanges,
    trace,
  };
}

/** Rules that need the explicit simulated time; used by callers to prove inputs. */
export function timedRules(config: RuntimeConfig): readonly string[] {
  return config.rules.filter((rule) => conditionUsesSimulationTime(rule.condition)).map((rule) => rule.ref);
}
