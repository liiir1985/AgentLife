import { isWithinRange } from "./numeric.js";
import {
  COMPARE_OPERATORS,
  compareValues,
  evaluateValue,
  valueDerivations,
  valueReads,
  type CompareOperator,
  type SimulationTime,
  type ValueFailure,
  type ValueScope,
  type ValueSource,
} from "./values.js";

export type { CompareOperator } from "./values.js";

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
      readonly left: ValueSource;
      readonly right: ValueSource;
      readonly operator: CompareOperator;
    }
  | {
      readonly op: "within";
      readonly value: ValueSource;
      readonly min: number | null;
      readonly max: number | null;
      readonly boundary: "inclusive" | "exclusive";
    }
  | { readonly op: "simulation-time"; readonly operator: "before" | "at-or-after"; readonly tick: number };

export type ConditionResult =
  | { readonly ok: true; readonly value: boolean }
  | { readonly ok: false; readonly reason: ValueFailure; readonly message: string };

export function conditionReads(condition: Condition): readonly string[] {
  switch (condition.op) {
    case "always":
      return [];
    case "all":
    case "any":
      return condition.operands.flatMap(conditionReads);
    case "not":
      return conditionReads(condition.operand);
    case "compare":
      return [...valueReads(condition.left), ...valueReads(condition.right)];
    case "within":
      return valueReads(condition.value);
    default:
      return [];
  }
}

export function conditionDerivations(condition: Condition): readonly string[] {
  switch (condition.op) {
    case "always":
      return [];
    case "all":
    case "any":
      return condition.operands.flatMap(conditionDerivations);
    case "not":
      return conditionDerivations(condition.operand);
    case "compare":
      return [...valueDerivations(condition.left), ...valueDerivations(condition.right)];
    case "within":
      return valueDerivations(condition.value);
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

export function evaluateCondition(condition: Condition, scope: ValueScope): ConditionResult {
  switch (condition.op) {
    case "always":
      return { ok: true, value: true };
    case "all": {
      for (const operand of condition.operands) {
        const result = evaluateCondition(operand, scope);
        if (!result.ok) return result;
        if (!result.value) return { ok: true, value: false };
      }
      return { ok: true, value: true };
    }
    case "any": {
      let failure_: ConditionResult | undefined;
      for (const operand of condition.operands) {
        const result = evaluateCondition(operand, scope);
        if (!result.ok) {
          failure_ = result;
          continue;
        }
        if (result.value) return { ok: true, value: true };
      }
      return failure_ ?? { ok: true, value: false };
    }
    case "not": {
      const result = evaluateCondition(condition.operand, scope);
      if (!result.ok) return result;
      return { ok: true, value: !result.value };
    }
    case "compare": {
      const left = evaluateValue(condition.left, scope);
      if (!left.ok) return failure(left.reason, left.message);
      const right = evaluateValue(condition.right, scope);
      if (!right.ok) return failure(right.reason, right.message);
      if (!COMPARE_OPERATORS.includes(condition.operator))
        return failure("inexpressible", `Unsupported comparison operator ${String(condition.operator)}`);
      return compareValues(left, right, condition.operator);
    }
    case "within": {
      const value = evaluateValue(condition.value, scope);
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
      return { ok: true, value: appliesToSimulationTime(condition, scope.simulationTime) };
    default:
      return failure("inexpressible", "Unsupported condition");
  }
}

/** The only time predicate the kernel understands; it never advances the clock. */
function appliesToSimulationTime(
  condition: Extract<Condition, { op: "simulation-time" }>,
  simulationTime: SimulationTime,
): boolean {
  return condition.operator === "before" ? simulationTime.tick < condition.tick : simulationTime.tick >= condition.tick;
}
