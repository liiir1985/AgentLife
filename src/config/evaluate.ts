import { identityOf } from "./canonical.js";
import { evaluateCondition, conditionUsesSimulationTime } from "./conditions.js";
import type { CompiledDerivation, CompiledRule, CompiledRuntimeConfig, CompositionPlan } from "./compile.js";
import { strongestStatus, type ResultStatus } from "./diagnostics.js";
import type { CompositionKind } from "./numeric.js";
import { applyNumericPolicy } from "./numeric.js";
import type { BoundRead } from "./validate.js";
import {
  evaluateValue,
  type Scalar,
  type SimulationTime,
  type ValueFailure,
  type ValueResult,
  type ValueScope,
} from "./values.js";

/**
 * Deterministic evaluation.
 *
 * One evaluation fixes the runtime config, the input snapshot and the explicit
 * simulated time, walks only the rules the trigger index selects, and returns
 * candidates plus a trace. It reads nothing else: no clock, no random source,
 * no I/O and no state that was not handed in.
 */

export interface EvaluationSnapshot {
  /** Domain state version the snapshot was taken at. */
  readonly stateVersion: string;
  readonly simulationTime: SimulationTime;
  /** View identity to the read-only value exposed under that view. */
  readonly views: Readonly<Record<string, unknown>>;
}

export interface EvaluationRequest {
  readonly requestId: string;
  readonly trigger: string;
  /**
   * State version a deferred request was created against. When it no longer
   * matches the snapshot, the request is stale and nothing is evaluated.
   */
  readonly dependsOnStateVersion?: string;
  readonly snapshot: EvaluationSnapshot;
}

export interface ReadTrace {
  readonly alias: string;
  readonly view: string;
  readonly field: string;
  readonly present: boolean;
  readonly value: Scalar | null;
}

export type RuleOutcome = "evaluated" | "condition-false" | "input-missing" | "input-invalid";

export interface RuleTrace {
  readonly rule: string;
  readonly outcome: RuleOutcome;
  readonly reads: readonly ReadTrace[];
  readonly message?: string;
}

export interface ContributionTrace {
  readonly rule: string;
  readonly value: Scalar;
  readonly priority: number | null;
}

export interface CompositionTrace {
  readonly target: string;
  readonly composition: CompositionKind;
  readonly status: "composed" | "conflict" | "rejected";
  readonly contributions: readonly ContributionTrace[];
  readonly result: Scalar | null;
  /** Rules that disagreed at the same highest priority. */
  readonly conflicting: readonly string[];
  readonly message?: string;
}

export interface CandidateEffect {
  /** Stable identity of the candidate, used for consumption and de-duplication. */
  readonly effectId: string;
  readonly target: string;
  readonly owner: string;
  readonly value: Scalar;
  readonly contributors: readonly string[];
  readonly requestId: string;
  readonly dependsOnStateVersion: string;
  readonly simulationTime: SimulationTime;
}

export interface CandidateProcessOperation {
  readonly operationId: string;
  readonly process: string;
  readonly owner: string;
  readonly operation: "establish" | "advance" | "pause" | "end" | "cancel";
  readonly parameters: Readonly<Record<string, Scalar>>;
  readonly rule: string;
}

export interface EvaluationTrace {
  readonly requestId: string;
  readonly trigger: string;
  readonly configIdentity: string;
  readonly stateVersion: string;
  readonly simulationTime: SimulationTime;
  /** Rules the trigger index selected, in stable evaluation order. */
  readonly indexed: readonly string[];
  /** Rules declared by this runtime config that the index did not select. */
  readonly notIndexed: readonly string[];
  readonly rules: readonly RuleTrace[];
  readonly compositions: readonly CompositionTrace[];
  readonly candidates: readonly CandidateEffect[];
  readonly processOperations: readonly CandidateProcessOperation[];
}

export interface EvaluationResult {
  readonly status: ResultStatus;
  readonly configIdentity: string;
  readonly trace: EvaluationTrace;
}

interface RuleEvaluation {
  readonly trace: RuleTrace;
  readonly contributions: readonly { readonly target: string; readonly composition: CompositionKind }[];
  readonly targetValues: readonly {
    readonly target: string;
    readonly composition: CompositionKind;
    readonly priority: number | null;
    readonly value: Scalar;
  }[];
  readonly processOperations: readonly CandidateProcessOperation[];
}

function failureReason(reason: ValueFailure): RuleOutcome {
  return reason === "input-missing" ? "input-missing" : reason === "input-invalid" ? "input-invalid" : "input-invalid";
}

function staleResult(
  config: CompiledRuntimeConfig,
  request: EvaluationRequest,
  index: readonly string[],
): EvaluationResult {
  return {
    status: "state-version-stale",
    configIdentity: config.identity,
    trace: {
      requestId: request.requestId,
      trigger: request.trigger,
      configIdentity: config.identity,
      stateVersion: request.snapshot.stateVersion,
      simulationTime: request.snapshot.simulationTime,
      indexed: index,
      notIndexed: notIndexedRules(config, index),
      rules: [],
      compositions: [],
      candidates: [],
      processOperations: [],
    },
  };
}

function notIndexedRules(config: CompiledRuntimeConfig, indexed: readonly string[]): readonly string[] {
  const selected = new Set(indexed);
  return config.rules.map((rule) => rule.ref).filter((ref) => !selected.has(ref));
}

function viewValue(snapshot: EvaluationSnapshot, view: string, field: string): { present: boolean; value?: unknown } {
  const container = snapshot.views[view];
  if (typeof container !== "object" || container === null) return { present: false };
  const value: unknown = Reflect.get(container, field);
  return value === undefined ? { present: false } : { present: true, value };
}

function readTraces(rule: CompiledRule | CompiledDerivation, snapshot: EvaluationSnapshot): readonly ReadTrace[] {
  return rule.usedReads.map((read) => {
    const found = viewValue(snapshot, read.view, read.field);
    const value = found.value;
    const scalar = typeof value === "number" || typeof value === "boolean" || typeof value === "string" ? value : null;
    return {
      alias: read.alias,
      view: read.view,
      field: read.field,
      present: found.present && scalar !== null,
      value: scalar,
    };
  });
}

function buildScope(
  config: CompiledRuntimeConfig,
  snapshot: EvaluationSnapshot,
  reads: readonly BoundRead[],
): { scope: ValueScope; derivations: Map<string, ValueResult> } {
  const units = new Map(reads.map((read) => [read.alias, read.unit]));
  const memo = new Map<string, ValueResult>();
  const visiting = new Set<string>();
  const derivationsByRef = new Map(config.derivations.map((derivation) => [derivation.ref, derivation]));

  const derive = (ref: string): ValueResult => {
    const cached = memo.get(ref);
    if (cached !== undefined) return cached;
    const derivation = derivationsByRef.get(ref);
    if (derivation === undefined) return { ok: false, reason: "inexpressible", message: `Unknown derivation ${ref}` };
    if (visiting.has(ref)) return { ok: false, reason: "inexpressible", message: `Derivation cycle at ${ref}` };
    visiting.add(ref);
    const result = evaluateValue(derivation.value, innerScope);
    visiting.delete(ref);
    memo.set(ref, result);
    return result;
  };

  const innerScope: ValueScope = {
    read: (alias) => {
      const read = reads.find((candidate) => candidate.alias === alias);
      if (read === undefined) return { found: false };
      const found = viewValue(snapshot, read.view, read.field);
      return found.present ? { found: true, value: found.value } : { found: false };
    },
    unitOf: (alias) => units.get(alias) ?? null,
    derive,
    simulationTime: snapshot.simulationTime,
  };
  return { scope: innerScope, derivations: memo };
}

function evaluateEffects(
  config: CompiledRuntimeConfig,
  rule: CompiledRule,
  scope: ValueScope,
): {
  effects: RuleEvaluation["targetValues"];
  processOperations: CandidateProcessOperation[];
  failure?: Extract<ValueResult, { readonly ok: false }>;
} {
  const targetValues: RuleEvaluation["targetValues"][number][] = [];
  const processOperations: CandidateProcessOperation[] = [];
  for (const effect of rule.effects) {
    if (effect.kind === "target") {
      const value = evaluateValue(effect.value, scope);
      if (!value.ok) return { effects: targetValues, processOperations, failure: value };
      targetValues.push({
        target: effect.target,
        composition: effect.composition,
        priority: effect.priority,
        value: value.value,
      });
      continue;
    }
    const parameters: Record<string, Scalar> = {};
    for (const parameter of effect.parameters) {
      const value = evaluateValue(parameter.value, scope);
      if (!value.ok) return { effects: targetValues, processOperations, failure: value };
      parameters[parameter.name] = value.value;
    }
    processOperations.push({
      operationId: identityOf({
        configIdentity: config.identity,
        rule: rule.ref,
        process: effect.process,
        operation: effect.operation,
        parameters,
      }),
      process: effect.process,
      owner: effect.owner,
      operation: effect.operation,
      parameters,
      rule: rule.ref,
    });
  }
  return { effects: targetValues, processOperations };
}

function evaluateRule(config: CompiledRuntimeConfig, rule: CompiledRule, snapshot: EvaluationSnapshot): RuleEvaluation {
  const reads = readTraces(rule, snapshot);
  const missing = reads.filter((read) => !read.present);
  if (missing.length > 0)
    return {
      trace: {
        rule: rule.ref,
        outcome: "input-missing",
        reads,
        message: `Missing declared reads: ${missing.map((read) => read.alias).join(", ")}`,
      },
      contributions: [],
      targetValues: [],
      processOperations: [],
    };

  const { scope } = buildScope(config, snapshot, rule.usedReads);
  const condition = evaluateCondition(rule.condition, scope);
  if (!condition.ok)
    return {
      trace: { rule: rule.ref, outcome: failureReason(condition.reason), reads, message: condition.message },
      contributions: [],
      targetValues: [],
      processOperations: [],
    };
  if (!condition.value)
    return {
      trace: { rule: rule.ref, outcome: "condition-false", reads },
      contributions: [],
      targetValues: [],
      processOperations: [],
    };

  const evaluated = evaluateEffects(config, rule, scope);
  const failed = evaluated.failure;
  if (failed !== undefined)
    return {
      trace: {
        rule: rule.ref,
        outcome: failureReason(failed.reason),
        reads,
        message: failed.message,
      },
      contributions: [],
      targetValues: [],
      processOperations: [],
    };
  return {
    trace: { rule: rule.ref, outcome: "evaluated", reads },
    contributions: [],
    targetValues: evaluated.effects,
    processOperations: evaluated.processOperations,
  };
}

function composeTarget(
  plan: CompositionPlan,
  contributions: readonly { readonly rule: string; readonly value: Scalar; readonly priority: number | null }[],
): CompositionTrace {
  const base: Omit<CompositionTrace, "status"> = {
    target: plan.target,
    composition: plan.composition,
    contributions,
    result: null,
    conflicting: [],
  };
  if (contributions.length === 0) return { ...base, status: "composed" };

  if (plan.composition === "priority") {
    const highest = Math.max(...contributions.map((contribution) => contribution.priority ?? 0));
    const winners = contributions.filter((contribution) => (contribution.priority ?? 0) === highest);
    const distinct = [...new Set(winners.map((winner) => winner.value))];
    if (distinct.length > 1)
      return {
        ...base,
        status: "conflict",
        conflicting: winners.map((winner) => winner.rule),
        message: `Priority ${highest} is claimed by ${winners
          .map((winner) => `${winner.rule}=${String(winner.value)}`)
          .join(", ")}`,
      };
    const winner = winners[0]?.value ?? null;
    if (winner !== null && plan.allowedValues !== null && !plan.allowedValues.includes(String(winner)))
      return {
        ...base,
        status: "rejected",
        message: `${plan.target} does not accept the value ${String(winner)}`,
      };
    return { ...base, status: "composed", result: winner };
  }

  const numbers = contributions.map((contribution) => contribution.value);
  if (numbers.some((value) => typeof value !== "number"))
    return {
      ...base,
      status: "rejected",
      message: `${plan.composition} requires numeric contributions`,
    };
  const numeric = numbers as readonly number[];
  let combined: number;
  switch (plan.composition) {
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
  const normalized = applyNumericPolicy(combined, plan.policy);
  if (!normalized.ok) return { ...base, status: "rejected", message: normalized.message };
  return { ...base, status: "composed", result: normalized.value };
}

export function evaluate(config: CompiledRuntimeConfig, request: EvaluationRequest): EvaluationResult {
  const indexed = config.triggerIndex[request.trigger] ?? [];
  const byRef = new Map(config.rules.map((rule) => [rule.ref, rule]));
  const indexedRules = indexed.map((ref) => byRef.get(ref)).filter((rule): rule is CompiledRule => rule !== undefined);

  if (request.dependsOnStateVersion !== undefined && request.dependsOnStateVersion !== request.snapshot.stateVersion)
    return staleResult(config, request, indexed);

  if (indexedRules.length === 0) {
    return {
      status: "no-match",
      configIdentity: config.identity,
      trace: {
        requestId: request.requestId,
        trigger: request.trigger,
        configIdentity: config.identity,
        stateVersion: request.snapshot.stateVersion,
        simulationTime: request.snapshot.simulationTime,
        indexed: [],
        notIndexed: notIndexedRules(config, []),
        rules: [],
        compositions: [],
        candidates: [],
        processOperations: [],
      },
    };
  }

  const ruleTraces: RuleTrace[] = [];
  const pending = new Map<string, { rule: string; value: Scalar; priority: number | null }[]>();
  const processOperations: CandidateProcessOperation[] = [];
  for (const rule of indexedRules) {
    const evaluation = evaluateRule(config, rule, request.snapshot);
    ruleTraces.push(evaluation.trace);
    for (const target of evaluation.targetValues) {
      const bucket = pending.get(target.target);
      const contribution = { rule: rule.ref, value: target.value, priority: target.priority };
      if (bucket === undefined) pending.set(target.target, [contribution]);
      else bucket.push(contribution);
    }
    processOperations.push(...evaluation.processOperations);
  }

  const compositions: CompositionTrace[] = [];
  const candidates: CandidateEffect[] = [];
  for (const target of [...pending.keys()].sort()) {
    const plan = config.compositionPlans[target];
    if (plan === undefined) continue;
    const contributions = pending.get(target) ?? [];
    const composition = composeTarget(plan, contributions);
    compositions.push(composition);
    if (composition.status !== "composed" || composition.result === null) continue;
    candidates.push({
      effectId: identityOf({
        configIdentity: config.identity,
        requestId: request.requestId,
        target,
        value: composition.result,
      }),
      target,
      owner: plan.owner,
      value: composition.result,
      contributors: contributions.map((contribution) => contribution.rule).sort(),
      requestId: request.requestId,
      dependsOnStateVersion: request.snapshot.stateVersion,
      simulationTime: request.snapshot.simulationTime,
    });
  }

  const outcomes = ruleTraces.map((trace) => trace.outcome);
  const statuses: ResultStatus[] = [];
  for (const composition of compositions) {
    if (composition.status === "conflict") statuses.push("conflict");
    if (composition.status === "rejected") statuses.push("inexpressible");
  }
  if (candidates.length > 0 || processOperations.length > 0) statuses.push("candidates");
  if (outcomes.includes("input-missing") || outcomes.includes("input-invalid")) statuses.push("input-invalid");
  const evaluatedOutcomes = outcomes.filter(
    (outcome) => outcome === "evaluated" || outcome === "input-missing" || outcome === "input-invalid",
  );
  if (evaluatedOutcomes.length === 0) statuses.push("condition-false");
  if (statuses.length === 0) statuses.push("condition-false");

  return {
    status: strongestStatus(statuses),
    configIdentity: config.identity,
    trace: {
      requestId: request.requestId,
      trigger: request.trigger,
      configIdentity: config.identity,
      stateVersion: request.snapshot.stateVersion,
      simulationTime: request.snapshot.simulationTime,
      indexed,
      notIndexed: notIndexedRules(config, indexed),
      rules: ruleTraces,
      compositions,
      candidates,
      processOperations,
    },
  };
}

/** Rules that need the explicit simulated time; used by callers to prove inputs. */
export function rulesUsingSimulationTime(config: CompiledRuntimeConfig): readonly string[] {
  return config.rules.filter((rule) => conditionUsesSimulationTime(rule.condition)).map((rule) => rule.ref);
}
