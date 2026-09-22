import { applyNumericPolicy, evaluateMapping, RATIO_UNIT, type MappingResult, type NumericMapping } from "./numeric.js";

/** Explicit simulated time; the kernel never reads the machine clock. */
export interface SimulationTime {
  readonly tick: number;
  /** Simulated seconds on the shared clock, supplied by the time system. */
  readonly seconds: number;
}

export type Scalar = number | boolean | string;

/** How one rule combines several operand values into the single value it writes. */
export type CombineMethod = "min" | "max" | "add" | "multiply";

/** Comparison operators available to conditions and to `compare` value sources. */
export type CompareOperator = "eq" | "ne" | "lt" | "lte" | "gt" | "gte";

export const COMPARE_OPERATORS: readonly CompareOperator[] = ["eq", "ne", "lt", "lte", "gt", "gte"];

/** Methods that produce a dimensionless value from dimensionless operands. */
const MULTIPLICATIVE: readonly CombineMethod[] = ["multiply"];

/**
 * Restricted value vocabulary. Every value a rule can compute is either a
 * declared literal, an alias bound to an explicitly declared read, a declared
 * derivation, a declared mapping applied to another value source, a comparison
 * of two declared value sources, or a combination of declared value sources
 * under one declared method. There is no expression language and no way to reach
 * state that was not declared.
 */
export type ValueSource =
  | { readonly kind: "literal"; readonly value: Scalar; readonly unit: string }
  | { readonly kind: "read"; readonly alias: string }
  | { readonly kind: "derived"; readonly ref: string }
  | { readonly kind: "map"; readonly mapping: NumericMapping; readonly input: ValueSource }
  | { readonly kind: "combine"; readonly method: CombineMethod; readonly operands: readonly ValueSource[] }
  | {
      readonly kind: "compare";
      readonly left: ValueSource;
      readonly right: ValueSource;
      readonly operator: CompareOperator;
    }
  | {
      readonly kind: "select";
      readonly left: ValueSource;
      readonly right: ValueSource;
      readonly operator: CompareOperator;
      readonly then: ValueSource;
      readonly otherwise: ValueSource;
    };

/** Reasons a value cannot be produced; they map to distinct result statuses. */
export type ValueFailure = "input-missing" | "input-invalid" | "inexpressible";

export type ValueResult =
  | { readonly ok: true; readonly value: Scalar; readonly unit: string }
  | { readonly ok: false; readonly reason: ValueFailure; readonly message: string };

/**
 * Read-only scope of one evaluation. The kernel only sees values handed in by
 * the caller; there is no back door to a domain object or to the file system.
 */
export interface ValueScope {
  /** `undefined` means the alias is absent from this input snapshot. */
  read(alias: string): { readonly found: boolean; readonly value?: unknown };
  /** Declared unit of an alias, or `null` for non-numeric values. */
  unitOf(alias: string): string | null;
  derive(ref: string): ValueResult;
  readonly simulationTime: SimulationTime;
}

export function valueReads(source: ValueSource): readonly string[] {
  switch (source.kind) {
    case "read":
      return [source.alias];
    case "map":
      return valueReads(source.input);
    case "combine":
      return source.operands.flatMap((operand) => valueReads(operand));
    case "compare":
      return [...valueReads(source.left), ...valueReads(source.right)];
    case "select":
      return [
        ...valueReads(source.left),
        ...valueReads(source.right),
        ...valueReads(source.then),
        ...valueReads(source.otherwise),
      ];
    default:
      return [];
  }
}

export function valueDerivations(source: ValueSource): readonly string[] {
  switch (source.kind) {
    case "derived":
      return [source.ref];
    case "map":
      return valueDerivations(source.input);
    case "combine":
      return source.operands.flatMap((operand) => valueDerivations(operand));
    case "compare":
      return [...valueDerivations(source.left), ...valueDerivations(source.right)];
    case "select":
      return [
        ...valueDerivations(source.left),
        ...valueDerivations(source.right),
        ...valueDerivations(source.then),
        ...valueDerivations(source.otherwise),
      ];
    default:
      return [];
  }
}

export type ComparisonResult =
  | { readonly ok: true; readonly value: boolean }
  | { readonly ok: false; readonly reason: ValueFailure; readonly message: string };

/**
 * Compares two already-produced values. Numbers compare only within one unit,
 * booleans only for equality, strings lexicographically; nothing here coerces.
 */
export function compareValues(
  left: ValueResult & { readonly ok: true },
  right: ValueResult & { readonly ok: true },
  operator: CompareOperator,
): ComparisonResult {
  const leftValue = left.value;
  const rightValue = right.value;
  if (typeof leftValue !== typeof rightValue)
    return {
      ok: false,
      reason: "input-invalid",
      message: `Cannot compare ${typeof leftValue} with ${typeof rightValue}`,
    };
  if (typeof leftValue === "number" && typeof rightValue === "number") {
    if (left.unit !== right.unit)
      return { ok: false, reason: "input-invalid", message: `Cannot compare ${left.unit} with ${right.unit}` };
    if (operator === "eq") return { ok: true, value: leftValue === rightValue };
    if (operator === "ne") return { ok: true, value: leftValue !== rightValue };
    if (operator === "lt") return { ok: true, value: leftValue < rightValue };
    if (operator === "lte") return { ok: true, value: leftValue <= rightValue };
    if (operator === "gt") return { ok: true, value: leftValue > rightValue };
    return { ok: true, value: leftValue >= rightValue };
  }
  if (typeof leftValue === "boolean" && typeof rightValue === "boolean") {
    if (operator === "eq") return { ok: true, value: leftValue === rightValue };
    if (operator === "ne") return { ok: true, value: leftValue !== rightValue };
    return { ok: false, reason: "input-invalid", message: `Operator ${operator} does not apply to booleans` };
  }
  if (typeof leftValue === "string" && typeof rightValue === "string") {
    const order = leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0;
    switch (operator) {
      case "eq":
        return { ok: true, value: order === 0 };
      case "ne":
        return { ok: true, value: order !== 0 };
      case "lt":
        return { ok: true, value: order < 0 };
      case "lte":
        return { ok: true, value: order <= 0 };
      case "gt":
        return { ok: true, value: order > 0 };
      default:
        return { ok: true, value: order >= 0 };
    }
  }
  return { ok: false, reason: "input-invalid", message: "Unsupported comparison operands" };
}

function mappingFailure(result: Extract<MappingResult, { readonly ok: false }>): ValueResult {
  return { ok: false, reason: "input-invalid", message: result.message };
}

export function evaluateValue(source: ValueSource, scope: ValueScope): ValueResult {
  switch (source.kind) {
    case "literal":
      return { ok: true, value: source.value, unit: source.unit };
    case "read": {
      const read = scope.read(source.alias);
      if (!read.found)
        return {
          ok: false,
          reason: "input-missing",
          message: `Declared read ${source.alias} is absent from the input`,
        };
      const value = read.value;
      if (typeof value !== "number" && typeof value !== "boolean" && typeof value !== "string")
        return {
          ok: false,
          reason: "input-invalid",
          message: `Read ${source.alias} is not a scalar value`,
        };
      return { ok: true, value, unit: scope.unitOf(source.alias) ?? "" };
    }
    case "derived":
      return scope.derive(source.ref);
    case "map": {
      const input = evaluateValue(source.input, scope);
      if (!input.ok) return input;
      if (typeof input.value !== "number")
        return {
          ok: false,
          reason: "input-invalid",
          message: `Mapping input for ${source.mapping.kind} must be a number`,
        };
      if (input.unit !== source.mapping.inputUnit)
        return {
          ok: false,
          reason: "input-invalid",
          message: `Mapping expects unit ${source.mapping.inputUnit} but received ${input.unit}`,
        };
      const mapped = evaluateMapping(source.mapping, input.value);
      if (!mapped.ok) return mappingFailure(mapped);
      const normalized = applyNumericPolicy(mapped.value, source.mapping.policy);
      if (!normalized.ok) return { ok: false, reason: "input-invalid", message: normalized.message };
      return { ok: true, value: normalized.value, unit: source.mapping.policy.unit };
    }
    case "combine": {
      const operands: { readonly value: number; readonly unit: string }[] = [];
      for (const operand of source.operands) {
        const evaluated = evaluateValue(operand, scope);
        if (!evaluated.ok) return evaluated;
        if (typeof evaluated.value !== "number")
          return {
            ok: false,
            reason: "input-invalid",
            message: `Combination ${source.method} requires numbers but received ${typeof evaluated.value}`,
          };
        operands.push({ value: evaluated.value, unit: evaluated.unit });
      }
      const multiplicative = MULTIPLICATIVE.includes(source.method);
      const first = operands[0];
      const unit = multiplicative || first === undefined ? "" : first.unit;
      for (const operand of operands) {
        if (multiplicative) {
          if (operand.unit !== "" && operand.unit !== RATIO_UNIT)
            return {
              ok: false,
              reason: "input-invalid",
              message: `Combination multiply requires dimensionless operands but received ${operand.unit}`,
            };
        } else if (operand.unit !== unit)
          return {
            ok: false,
            reason: "input-invalid",
            message: `Combination ${source.method} requires one unit but received ${unit} and ${operand.unit}`,
          };
      }
      const combined = multiplicative
        ? operands.reduce((total, operand) => total * operand.value, 1)
        : source.method === "add"
          ? operands.reduce((total, operand) => total + operand.value, 0)
          : source.method === "min"
            ? Math.min(...operands.map((operand) => operand.value))
            : Math.max(...operands.map((operand) => operand.value));
      if (!Number.isFinite(combined))
        return {
          ok: false,
          reason: "input-invalid",
          message: `Combination ${source.method} produced a non-finite value`,
        };
      return { ok: true, value: combined, unit };
    }
    case "compare": {
      const left = evaluateValue(source.left, scope);
      if (!left.ok) return left;
      const right = evaluateValue(source.right, scope);
      if (!right.ok) return right;
      const compared = compareValues(left, right, source.operator);
      if (!compared.ok) return { ok: false, reason: compared.reason, message: compared.message };
      return { ok: true, value: compared.value, unit: "" };
    }
    case "select": {
      const left = evaluateValue(source.left, scope);
      if (!left.ok) return left;
      const right = evaluateValue(source.right, scope);
      if (!right.ok) return right;
      const compared = compareValues(left, right, source.operator);
      if (!compared.ok) return { ok: false, reason: compared.reason, message: compared.message };
      return evaluateValue(compared.value ? source.then : source.otherwise, scope);
    }
    default:
      return { ok: false, reason: "inexpressible", message: "Unsupported value source" };
  }
}
