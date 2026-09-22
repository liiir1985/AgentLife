import { isWithinRange } from "./numeric.js";
import {
  COMPARE_OPERATORS,
  compareValues,
  runExpr,
  formulaRefs,
  inputNames,
  type CompareOperator,
  type SimTime,
  type ValueFailure,
  type ValueContext,
  type ValueExpr,
} from "./value-expr.js";

export type { CompareOperator } from "./value-expr.js";

/**
 * Restricted condition vocabulary. Conditions compare declared values, check a
 * declared interval, or read the explicit simulated time. A missing read is
 * never treated as false: it produces an input failure so that a missing input
 * cannot silently disable a rule.
 */
export type Condition =
  | { readonly op: "always" }
  | { readonly op: "all"; readonly operands: readonly Condition[] }
  | { readonly op: "any"; readonly operands: readonly Condition[] }
  | { readonly op: "not"; readonly operand: Condition }
  | {
      readonly op: "compare";
      readonly left: ValueExpr;
      readonly right: ValueExpr;
      readonly operator: CompareOperator;
    }
  | {
      readonly op: "within";
      readonly value: ValueExpr;
      readonly min: number | null;
      readonly max: number | null;
      readonly boundary: "inclusive" | "exclusive";
    }
  | { readonly op: "simulation-time"; readonly operator: "before" | "at-or-after"; readonly tick: number };

export type ConditionResult =
  | { readonly ok: true; readonly value: boolean }
  | { readonly ok: false; readonly reason: ValueFailure; readonly message: string };

export function conditionInputs(condition: Condition): readonly string[] {
  switch (condition.op) {
    case "always":
      return [];
    case "all":
    case "any":
      return condition.operands.flatMap(conditionInputs);
    case "not":
      return conditionInputs(condition.operand);
    case "compare":
      return [...inputNames(condition.left), ...inputNames(condition.right)];
    case "within":
      return inputNames(condition.value);
    default:
      return [];
  }
}

export function conditionFormulas(condition: Condition): readonly string[] {
  switch (condition.op) {
    case "always":
      return [];
    case "all":
    case "any":
      return condition.operands.flatMap(conditionFormulas);
    case "not":
      return conditionFormulas(condition.operand);
    case "compare":
      return [...formulaRefs(condition.left), ...formulaRefs(condition.right)];
    case "within":
      return formulaRefs(condition.value);
    default:
      return [];
  }
}

export function conditionUsesSimulationTime(condition: Condition): boolean {
  switch (condition.op) {
    case "simulation-time":
      return true;
    case "all":
    case "any":
      return condition.operands.some(conditionUsesSimulationTime);
    case "not":
      return conditionUsesSimulationTime(condition.operand);
    default:
      return false;
  }
}

function failure(reason: ValueFailure, message: string): ConditionResult {
  return { ok: false, reason, message };
}

export function runCondition(condition: Condition, scope: ValueContext): ConditionResult {
  switch (condition.op) {
    case "always":
      return { ok: true, value: true };
    case "all": {
      for (const operand of condition.operands) {
        const result = runCondition(operand, scope);
        if (!result.ok) return result;
        if (!result.value) return { ok: true, value: false };
      }
      return { ok: true, value: true };
    }
    case "any": {
      let failure_: ConditionResult | undefined;
      for (const operand of condition.operands) {
        const result = runCondition(operand, scope);
        if (!result.ok) {
          failure_ = result;
          continue;
        }
        if (result.value) return { ok: true, value: true };
      }
      return failure_ ?? { ok: true, value: false };
    }
    case "not": {
      const result = runCondition(condition.operand, scope);
      if (!result.ok) return result;
      return { ok: true, value: !result.value };
    }
    case "compare": {
      const left = runExpr(condition.left, scope);
      if (!left.ok) return failure(left.reason, left.message);
      const right = runExpr(condition.right, scope);
      if (!right.ok) return failure(right.reason, right.message);
      if (!COMPARE_OPERATORS.includes(condition.operator))
        return failure("inexpressible", `Unsupported comparison operator ${String(condition.operator)}`);
      return compareValues(left, right, condition.operator);
    }
    case "within": {
      const value = runExpr(condition.value, scope);
      if (!value.ok) return failure(value.reason, value.message);
      if (typeof value.value !== "number")
        return failure("input-invalid", "Interval conditions require a numeric value");
      if (condition.boundary !== "inclusive" && condition.boundary !== "exclusive")
        return failure("inexpressible", "Interval conditions require a declared boundary");
      return {
        ok: true,
        value: isWithinRange(value.value, {
          min: condition.min,
          max: condition.max,
          boundary: condition.boundary,
        }),
      };
    }
    case "simulation-time":
      return { ok: true, value: appliesToSimTime(condition, scope.simTime) };
    default:
      return failure("inexpressible", "Unsupported condition");
  }
}

/** The only time predicate the kernel understands; it never advances the clock. */
function appliesToSimTime(condition: Extract<Condition, { op: "simulation-time" }>, simTime: SimTime): boolean {
  return condition.operator === "before" ? simTime.tick < condition.tick : simTime.tick >= condition.tick;
}
