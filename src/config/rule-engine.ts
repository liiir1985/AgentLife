import { hashId } from "./canonical.js";
import { runCondition, conditionUsesSimulationTime } from "./conditions.js";
import type { RuntimeFormula, RuntimeRule, RuntimeConfig, CombinePlan } from "./config-builder.js";
import { strongestStatus, type ResultStatus } from "./diagnostics.js";
import type { CombineMode } from "./numeric.js";
import { applyNumberPolicy } from "./numeric.js";
import type { CheckedInput } from "./config-checker.js";
import {
  runExpr,
  type SimpleValue,
  type SimTime,
  type ValueFailure,
  type ValueResult,
  type ValueContext,
} from "./value-expr.js";

/**
 * Deterministic evaluation.
 *
 * One run fixes the runtime config, the state input and the explicit
 * simulated time, walks only the rules the trigger index selects, and returns
 * state changes plus a trace. It reads nothing else: no clock, no random source,
 * no I/O and no state that was not handed in.
 */

export interface StateInput {
  /** State version this input was taken from. */
  readonly stateVersion: string;
  readonly simTime: SimTime;
  /** View identity to the read-only value exposed under that input. */
  readonly inputs: Readonly<Record<string, unknown>>;
}

export interface RuleRequest {
  readonly runId: string;
  readonly trigger: string;
  /**
   * State version a deferred request was created against. When it no longer
   * matches the input, the request is stale and nothing is evaluated.
   */
  readonly baseVersion?: string;
  readonly input: StateInput;
}

export interface InputTrace {
  readonly name: string;
  readonly stateRef: string;
  readonly field: string;
  readonly present: boolean;
  readonly value: SimpleValue | null;
}

export type RuleStatus = "evaluated" | "condition-false" | "input-missing" | "input-invalid";

export interface RuleTrace {
  readonly ruleId: string;
  readonly status: RuleStatus;
  readonly inputs: readonly InputTrace[];
  readonly message?: string;
}

export interface ValueTrace {
  readonly ruleId: string;
  readonly value: SimpleValue;
  readonly priority: number | null;
}

export interface CombineTrace {
  readonly stateRef: string;
  readonly combine: CombineMode;
  readonly status: "composed" | "conflict" | "rejected";
  readonly ruleValues: readonly ValueTrace[];
  readonly result: SimpleValue | null;
  /** Rules that disagreed at the same highest priority. */
  readonly conflicting: readonly string[];
  readonly message?: string;
}

export interface StateChangeRequest {
  /** Stable request identity, used for consumption and de-duplication. */
  readonly changeId: string;
  readonly stateRef: string;
  readonly system: string;
  readonly newValue: SimpleValue;
  readonly sourceRules: readonly string[];
  readonly runId: string;
  readonly baseVersion: string;
  readonly simTime: SimTime;
}

export interface ProcessChangeRequest {
  readonly changeId: string;
  readonly processRef: string;
  readonly system: string;
  readonly action: "establish" | "advance" | "pause" | "end" | "cancel";
  readonly params: Readonly<Record<string, SimpleValue>>;
  readonly sourceRule: string;
}

export interface RunTrace {
  readonly runId: string;
  readonly trigger: string;
  readonly configId: string;
  readonly stateVersion: string;
  readonly simTime: SimTime;
  /** Rules the trigger index selected, in stable evaluation order. */
  readonly selectedRules: readonly string[];
  /** Rules declared by this runtime config that the index did not select. */
  readonly skippedRules: readonly string[];
  readonly rules: readonly RuleTrace[];
  readonly combines: readonly CombineTrace[];
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
  readonly ruleValues: readonly { readonly stateRef: string; readonly combine: CombineMode }[];
  readonly stateValues: readonly {
    readonly stateRef: string;
    readonly combine: CombineMode;
    readonly priority: number | null;
    readonly value: SimpleValue;
  }[];
  readonly processChanges: readonly ProcessChangeRequest[];
}

function failureReason(reason: ValueFailure): RuleStatus {
  return reason === "input-missing" ? "input-missing" : reason === "input-invalid" ? "input-invalid" : "input-invalid";
}

function staleResult(config: RuntimeConfig, request: RuleRequest, index: readonly string[]): RuleResult {
  return {
    status: "state-version-stale",
    configId: config.configId,
    stateChanges: [],
    processChanges: [],
    trace: {
      runId: request.runId,
      trigger: request.trigger,
      configId: config.configId,
      stateVersion: request.input.stateVersion,
      simTime: request.input.simTime,
      selectedRules: index,
      skippedRules: skippedRules(config, index),
      rules: [],
      combines: [],
      stateChanges: [],
      processChanges: [],
    },
  };
}

function skippedRules(config: RuntimeConfig, selectedRules: readonly string[]): readonly string[] {
  const selected = new Set(selectedRules);
  return config.rules.map((rule) => rule.ref).filter((ref) => !selected.has(ref));
}

function inputValue(state: StateInput, stateRef: string, field: string): { present: boolean; value?: unknown } {
  const container = state.inputs[stateRef];
  if (typeof container !== "object" || container === null) return { present: false };
  const value: unknown = Reflect.get(container, field);
  return value === undefined ? { present: false } : { present: true, value };
}

function inputTraces(rule: RuntimeRule | RuntimeFormula, input: StateInput): readonly InputTrace[] {
  return rule.usedInputs.map((read) => {
    const found = inputValue(input, read.stateRef, read.field);
    const value = found.value;
    const scalar = typeof value === "number" || typeof value === "boolean" || typeof value === "string" ? value : null;
    return {
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
): { scope: ValueContext; formulas: Map<string, ValueResult> } {
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
    const result = runExpr(formula.value, innerScope);
    visiting.delete(ref);
    memo.set(ref, result);
    return result;
  };

  const innerScope: ValueContext = {
    read: (name) => {
      const read = inputs.find((candidate) => candidate.name === name);
      if (read === undefined) return { found: false };
      const found = inputValue(input, read.stateRef, read.field);
      return found.present ? { found: true, value: found.value } : { found: false };
    },
    unitOf: (name) => units.get(name) ?? null,
    formula: runFormula,
    simTime: input.simTime,
  };
  return { scope: innerScope, formulas: memo };
}

function runChanges(
  config: RuntimeConfig,
  rule: RuntimeRule,
  scope: ValueContext,
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
      changeId: hashId({
        configId: config.configId,
        rule: rule.ref,
        processRef: change.processRef,
        action: change.action,
        params,
      }),
      processRef: change.processRef,
      system: change.system,
      action: change.action,
      params,
      sourceRule: rule.ref,
    });
  }
  return { changes: stateValues, processChanges };
}

function runRule(config: RuntimeConfig, rule: RuntimeRule, input: StateInput): RuleRun {
  const inputs = inputTraces(rule, input);
  const missing = inputs.filter((read) => !read.present);
  if (missing.length > 0)
    return {
      trace: {
        ruleId: rule.ref,
        status: "input-missing",
        inputs,
        message: `Missing declared inputs: ${missing.map((read) => read.name).join(", ")}`,
      },
      ruleValues: [],
      stateValues: [],
      processChanges: [],
    };

  const { scope } = buildScope(config, input, rule.usedInputs);
  const condition = runCondition(rule.condition, scope);
  if (!condition.ok)
    return {
      trace: { ruleId: rule.ref, status: failureReason(condition.reason), inputs, message: condition.message },
      ruleValues: [],
      stateValues: [],
      processChanges: [],
    };
  if (!condition.value)
    return {
      trace: { ruleId: rule.ref, status: "condition-false", inputs },
      ruleValues: [],
      stateValues: [],
      processChanges: [],
    };

  const evaluated = runChanges(config, rule, scope);
  const failed = evaluated.failure;
  if (failed !== undefined)
    return {
      trace: {
        ruleId: rule.ref,
        status: failureReason(failed.reason),
        inputs,
        message: failed.message,
      },
      ruleValues: [],
      stateValues: [],
      processChanges: [],
    };
  return {
    trace: { ruleId: rule.ref, status: "evaluated", inputs },
    ruleValues: [],
    stateValues: evaluated.changes,
    processChanges: evaluated.processChanges,
  };
}

function combineValues(
  plan: CombinePlan,
  ruleValues: readonly { readonly ruleId: string; readonly value: SimpleValue; readonly priority: number | null }[],
): CombineTrace {
  const base: Omit<CombineTrace, "status"> = {
    stateRef: plan.stateRef,
    combine: plan.combine,
    ruleValues,
    result: null,
    conflicting: [],
  };
  if (ruleValues.length === 0) return { ...base, status: "composed" };

  if (plan.combine === "priority") {
    const highest = Math.max(...ruleValues.map((ruleValue) => ruleValue.priority ?? 0));
    const winners = ruleValues.filter((ruleValue) => (ruleValue.priority ?? 0) === highest);
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
      return {
        ...base,
        status: "rejected",
        message: `${plan.stateRef} does not accept the value ${String(winner)}`,
      };
    return { ...base, status: "composed", result: winner };
  }

  const numbers = ruleValues.map((ruleValue) => ruleValue.value);
  if (numbers.some((value) => typeof value !== "number"))
    return {
      ...base,
      status: "rejected",
      message: `${plan.combine} requires numeric ruleValues`,
    };
  const numeric = numbers as readonly number[];
  let combined: number;
  switch (plan.combine) {
    case "min":
      combined = Math.min(...numeric);
      break;
    case "max":
      combined = Math.max(...numeric);
      break;
    case "add":
      combined = numeric.reduce((total, value) => total + value, 0);
      break;
    default:
      combined = numeric.reduce((total, value) => total * value, 1);
      break;
  }
  if (plan.policy === null) return { ...base, status: "composed", result: combined };
  const normalized = applyNumberPolicy(combined, plan.policy);
  if (!normalized.ok) return { ...base, status: "rejected", message: normalized.message };
  return { ...base, status: "composed", result: normalized.value };
}

export function runRules(config: RuntimeConfig, request: RuleRequest): RuleResult {
  const selectedRules = config.triggerIndex[request.trigger] ?? [];
  const byRef = new Map(config.rules.map((rule) => [rule.ref, rule]));
  const selected = selectedRules.map((ref) => byRef.get(ref)).filter((rule): rule is RuntimeRule => rule !== undefined);

  if (request.baseVersion !== undefined && request.baseVersion !== request.input.stateVersion)
    return staleResult(config, request, selectedRules);

  if (selected.length === 0) {
    return {
      status: "no-match",
      configId: config.configId,
      stateChanges: [],
      processChanges: [],
      trace: {
        runId: request.runId,
        trigger: request.trigger,
        configId: config.configId,
        stateVersion: request.input.stateVersion,
        simTime: request.input.simTime,
        selectedRules: [],
        skippedRules: skippedRules(config, []),
        rules: [],
        combines: [],
        stateChanges: [],
        processChanges: [],
      },
    };
  }

  const ruleTraces: RuleTrace[] = [];
  const pending = new Map<string, { ruleId: string; value: SimpleValue; priority: number | null }[]>();
  const processChanges: ProcessChangeRequest[] = [];
  for (const rule of selected) {
    const evaluation = runRule(config, rule, request.input);
    ruleTraces.push(evaluation.trace);
    for (const stateRef of evaluation.stateValues) {
      const bucket = pending.get(stateRef.stateRef);
      const ruleValue = { ruleId: rule.ref, value: stateRef.value, priority: stateRef.priority };
      if (bucket === undefined) pending.set(stateRef.stateRef, [ruleValue]);
      else bucket.push(ruleValue);
    }
    processChanges.push(...evaluation.processChanges);
  }

  const combines: CombineTrace[] = [];
  const stateChanges: StateChangeRequest[] = [];
  for (const stateRef of [...pending.keys()].sort()) {
    const plan = config.combinePlans[stateRef];
    if (plan === undefined) continue;
    const ruleValues = pending.get(stateRef) ?? [];
    const combine = combineValues(plan, ruleValues);
    combines.push(combine);
    if (combine.status !== "composed" || combine.result === null) continue;
    stateChanges.push({
      changeId: hashId({
        configId: config.configId,
        runId: request.runId,
        stateRef,
        value: combine.result,
      }),
      stateRef,
      system: plan.system,
      newValue: combine.result,
      sourceRules: ruleValues.map((ruleValue) => ruleValue.ruleId).sort(),
      runId: request.runId,
      baseVersion: request.input.stateVersion,
      simTime: request.input.simTime,
    });
  }

  const outcomes = ruleTraces.map((trace) => trace.status);
  const statuses: ResultStatus[] = [];
  for (const combine of combines) {
    if (combine.status === "conflict") statuses.push("conflict");
    if (combine.status === "rejected") statuses.push("inexpressible");
  }
  if (stateChanges.length > 0 || processChanges.length > 0) statuses.push("changes");
  if (outcomes.includes("input-missing") || outcomes.includes("input-invalid")) statuses.push("input-invalid");
  const evaluatedOutcomes = outcomes.filter(
    (outcome) => outcome === "evaluated" || outcome === "input-missing" || outcome === "input-invalid",
  );
  if (evaluatedOutcomes.length === 0) statuses.push("condition-false");
  if (statuses.length === 0) statuses.push("condition-false");

  return {
    status: strongestStatus(statuses),
    configId: config.configId,
    stateChanges,
    processChanges,
    trace: {
      runId: request.runId,
      trigger: request.trigger,
      configId: config.configId,
      stateVersion: request.input.stateVersion,
      simTime: request.input.simTime,
      selectedRules,
      skippedRules: skippedRules(config, selectedRules),
      rules: ruleTraces,
      combines,
      stateChanges,
      processChanges,
    },
  };
}

/** Rules that need the explicit simulated time; used by callers to prove inputs. */
export function timedRules(config: RuntimeConfig): readonly string[] {
  return config.rules.filter((rule) => conditionUsesSimulationTime(rule.condition)).map((rule) => rule.ref);
}
