/**
 * Numeric semantics of the shared kernel.
 *
 * Every numeric value in the kernel passes through a declared `NumberPolicy`
 * (unit, rounding, range boundary, overflow) and every mapped value comes from a
 * declared mapping form (hard threshold, piecewise constant, piecewise linear).
 * Nothing here inputs the platform's implicit behaviour: rounding mode, boundary
 * inclusion and out-of-range behaviour are all explicit, and a declaration that
 * omits one of them is invalid rather than silently defaulted.
 */

export type RoundingMode = "none" | "half-away-from-zero" | "floor" | "ceil" | "truncate";

export interface RoundingRule {
  readonly mode: RoundingMode;
  /** Decimal places kept by the rounding mode; must be 0 when mode is `none`. */
  readonly precision: number;
}

export interface NumberRange {
  /** `null` means unbounded; the null must be written out to count as declared. */
  readonly min: number | null;
  readonly max: number | null;
  readonly boundary: "inclusive" | "exclusive";
}

export interface NumberPolicy {
  readonly unit: string;
  readonly rounding: RoundingRule;
  readonly range: NumberRange;
  readonly overflow: "saturate" | "reject";
}

/**
 * A policy block whose every part is optional, used by values, channels and
 * mappings. Absent parts carry no constraint: a value that declares nothing is
 * unit-less, unrounded, unbounded and saturating.
 */
export interface PartialNumberPolicy {
  readonly unit?: string;
  readonly rounding?: { readonly mode?: RoundingMode; readonly precision?: number };
  readonly range?: {
    readonly min?: number | null;
    readonly max?: number | null;
    readonly boundary?: "inclusive" | "exclusive";
  };
  readonly overflow?: "saturate" | "reject";
}

/** Merges a declared policy block with the constraints-free defaults. */
export function resolveNumberPolicy(partial: PartialNumberPolicy | undefined): NumberPolicy | null {
  if (partial === undefined) return null;
  return {
    unit: partial.unit ?? "",
    rounding: { mode: partial.rounding?.mode ?? "none", precision: partial.rounding?.precision ?? 0 },
    range: {
      min: partial.range?.min ?? null,
      max: partial.range?.max ?? null,
      boundary: partial.range?.boundary ?? "inclusive",
    },
    overflow: partial.overflow ?? "saturate",
  };
}

/** Dimensionless factors, the only unit accepted for `multiply` ruleValues. */
export const RATIO_UNIT = "ratio";

/** Ways rule values may be combined. */
export type CombineMode = "priority" | "min" | "max" | "add" | "multiply";

const ROUNDING_MODES: readonly RoundingMode[] = ["none", "half-away-from-zero", "floor", "ceil", "truncate"];

export function isCombineMode(value: string): value is CombineMode {
  return value === "priority" || value === "min" || value === "max" || value === "add" || value === "multiply";
}

export function checkNumberPolicy(policy: NumberPolicy, path: string): string[] {
  const problems: string[] = [];
  if (typeof policy.unit !== "string" || policy.unit !== policy.unit.trim())
    problems.push(`${path}.unit must be a unit name or "" for a dimensionless value`);
  if (policy.unit !== "" && !/^[A-Za-z][A-Za-z0-9-]*$/.test(policy.unit))
    problems.push(`${path}.unit is not a unit name`);
  if (!ROUNDING_MODES.includes(policy.rounding.mode)) problems.push(`${path}.rounding.mode is not supported`);
  if (!Number.isInteger(policy.rounding.precision) || policy.rounding.precision < 0 || policy.rounding.precision > 9)
    problems.push(`${path}.rounding.precision must be an integer between 0 and 9`);
  if (policy.rounding.mode === "none" && policy.rounding.precision !== 0)
    problems.push(`${path}.rounding.precision must be 0 when the rounding mode is "none"`);
  const { min, max, boundary } = policy.range;
  for (const [label, bound] of [
    ["min", min],
    ["max", max],
  ] as const) {
    if (bound !== null && !Number.isFinite(bound)) problems.push(`${path}.range.${label} must be finite or null`);
  }
  if (min !== null && max !== null && min > max) problems.push(`${path}.range.min must not exceed range.max`);
  if (min !== null && max !== null && min === max && boundary === "exclusive")
    problems.push(`${path}.range has an empty interval`);
  if (policy.overflow !== "saturate" && policy.overflow !== "reject")
    problems.push(`${path}.overflow must be "saturate" or "reject"`);
  return problems;
}

export type NumberResult =
  | { readonly ok: true; readonly value: number }
  | { readonly ok: false; readonly reason: "out-of-range"; readonly message: string };

function normalize(value: number): number {
  return Object.is(value, -0) ? 0 : value;
}

export function roundValue(value: number, rounding: RoundingRule): number {
  if (rounding.mode === "none") return normalize(value);
  const scale = 10 ** rounding.precision;
  const scaled = value * scale;
  switch (rounding.mode) {
    case "truncate":
      return normalize(Math.trunc(scaled) / scale);
    case "floor":
      return normalize(Math.floor(scaled) / scale);
    case "ceil":
      return normalize(Math.ceil(scaled) / scale);
    default:
      return normalize((Math.sign(scaled) * Math.round(Math.abs(scaled))) / scale);
  }
}

/** Smallest representable step away from a bound, used by exclusive saturation. */
function stepInside(bound: number, direction: 1 | -1): number {
  const step = Math.max(Number.EPSILON * Math.abs(bound), Number.MIN_VALUE);
  return normalize(bound + direction * step);
}

export function isWithinRange(value: number, range: NumberRange): boolean {
  const belowMin = range.min !== null && (range.boundary === "inclusive" ? value < range.min : value <= range.min);
  const aboveMax = range.max !== null && (range.boundary === "inclusive" ? value > range.max : value >= range.max);
  return !belowMin && !aboveMax;
}

/**
 * Final normalization of a numeric value: rounding, then range, then overflow.
 * `reject` reports an out-of-range result instead of silently clamping it.
 */
export function applyNumberPolicy(value: number, policy: NumberPolicy): NumberResult {
  if (!Number.isFinite(value))
    return {
      ok: false,
      reason: "out-of-range",
      message: `Value ${String(value)} in unit ${policy.unit} is not finite`,
    };
  const rounded = roundValue(value, policy.rounding);
  if (isWithinRange(rounded, policy.range)) return { ok: true, value: rounded };
  if (policy.overflow === "reject")
    return {
      ok: false,
      reason: "out-of-range",
      message: `Value ${String(rounded)} ${policy.unit} falls outside the declared range`,
    };
  const { min, max, boundary } = policy.range;
  let saturated = rounded;
  if (min !== null && (boundary === "inclusive" ? saturated < min : saturated <= min))
    saturated = boundary === "inclusive" ? min : stepInside(min, 1);
  if (max !== null && (boundary === "inclusive" ? saturated > max : saturated >= max))
    saturated = boundary === "inclusive" ? max : stepInside(max, -1);
  return { ok: true, value: roundValue(saturated, policy.rounding) };
}

/** Out-of-range behaviour of a mapping; `invalid` fails the evaluation loudly. */
export type RangeMode =
  { readonly kind: "clamp" } | { readonly kind: "value"; readonly value: number } | { readonly kind: "invalid" };

export interface ThresholdMapping {
  readonly kind: "threshold";
  readonly inputUnit: string;
  /** Band switch point on the input scale. */
  readonly at: number;
  /** Which side `at` itself belongs to; never inferred from the operator used. */
  readonly boundary: "lower" | "upper";
  readonly below: number;
  readonly above: number;
  readonly policy: NumberPolicy;
}

export interface PiecewiseConstantBand {
  /** Lower edge of the band; `null` is only valid for the first band. */
  readonly from: number | null;
  readonly value: number;
}

export interface PiecewiseConstantMapping {
  readonly kind: "piecewise-constant";
  readonly inputUnit: string;
  readonly bands: readonly PiecewiseConstantBand[];
  readonly outOfRange: RangeMode;
  readonly policy: NumberPolicy;
}

export interface PiecewiseLinearPoint {
  readonly x: number;
  readonly y: number;
}

export interface PiecewiseLinearMapping {
  readonly kind: "piecewise-linear";
  readonly inputUnit: string;
  readonly points: readonly PiecewiseLinearPoint[];
  readonly outOfRange: RangeMode;
  readonly policy: NumberPolicy;
}

export type ValueMap = ThresholdMapping | PiecewiseConstantMapping | PiecewiseLinearMapping;

export function mapUnit(mapping: ValueMap): string {
  return mapping.policy.unit;
}

export function validateOutOfRange(behaviour: RangeMode, path: string): string[] {
  if (typeof behaviour !== "object" || behaviour === null) return [`${path} must declare an out-of-range behaviour`];
  switch (behaviour.kind) {
    case "clamp":
    case "invalid":
      return [];
    case "value":
      return Number.isFinite(behaviour.value) ? [] : [`${path}.value must be finite`];
    default:
      return [`${path} is not a supported out-of-range behaviour`];
  }
}

/**
 * Structural validation of a mapping. Piecewise bands must be strictly
 * increasing (no undeclared overlap) and the out-of-range behaviour must be
 * declared (no undeclared gap).
 */
export function checkMap(mapping: ValueMap, path: string): string[] {
  const problems: string[] = [];
  if (typeof mapping.inputUnit !== "string" || mapping.inputUnit.trim() === "")
    problems.push(`${path}.inputUnit must be a non-empty unit name`);
  problems.push(...checkNumberPolicy(mapping.policy, `${path}.policy`));
  switch (mapping.kind) {
    case "threshold": {
      for (const [label, value] of [
        ["at", mapping.at],
        ["below", mapping.below],
        ["above", mapping.above],
      ] as const) {
        if (!Number.isFinite(value)) problems.push(`${path}.${label} must be finite`);
      }
      if (mapping.boundary !== "lower" && mapping.boundary !== "upper")
        problems.push(`${path}.boundary must be "lower" or "upper"`);
      break;
    }
    case "piecewise-constant": {
      if (mapping.bands.length === 0) problems.push(`${path}.bands must declare at least one band`);
      mapping.bands.forEach((band, index) => {
        if (band.from === null) {
          if (index !== 0) problems.push(`${path}.bands[${index}].from may be null only for the first band`);
        } else if (!Number.isFinite(band.from)) {
          problems.push(`${path}.bands[${index}].from must be finite or null`);
        } else {
          const previous = mapping.bands[index - 1]?.from;
          if (previous !== null && previous !== undefined && band.from <= previous)
            problems.push(`${path}.bands[${index}].from must increase strictly (overlapping bands are not allowed)`);
        }
        if (!Number.isFinite(band.value)) problems.push(`${path}.bands[${index}].value must be finite`);
      });
      problems.push(...validateOutOfRange(mapping.outOfRange, `${path}.outOfRange`));
      break;
    }
    case "piecewise-linear": {
      if (mapping.points.length < 2) problems.push(`${path}.points must declare at least two points`);
      mapping.points.forEach((point, index) => {
        if (!Number.isFinite(point.x) || !Number.isFinite(point.y))
          problems.push(`${path}.points[${index}] must be finite`);
        const previous = mapping.points[index - 1];
        if (previous !== undefined && point.x <= previous.x)
          problems.push(`${path}.points[${index}].x must increase strictly (overlapping segments are not allowed)`);
      });
      problems.push(...validateOutOfRange(mapping.outOfRange, `${path}.outOfRange`));
      break;
    }
    default:
      problems.push(`${path} is not a supported mapping form`);
  }
  return problems;
}

export type MapResult =
  | { readonly ok: true; readonly value: number }
  | { readonly ok: false; readonly reason: "not-finite" | "out-of-range"; readonly message: string };

function resolveOutOfRange(behaviour: RangeMode, clampValue: number, message: string): MapResult {
  switch (behaviour.kind) {
    case "clamp":
      return { ok: true, value: clampValue };
    case "invalid":
      return { ok: false, reason: "out-of-range", message };
    default:
      return { ok: true, value: behaviour.value };
  }
}

/** Evaluates a declared mapping; the result still carries the mapping's policy. */
export function runMap(mapping: ValueMap, input: number): MapResult {
  if (!Number.isFinite(input))
    return { ok: false, reason: "not-finite", message: `Mapping input ${String(input)} is not a finite number` };
  switch (mapping.kind) {
    case "threshold": {
      const inLowerBand = mapping.boundary === "lower" ? input < mapping.at : input <= mapping.at;
      return { ok: true, value: inLowerBand ? mapping.below : mapping.above };
    }
    case "piecewise-constant": {
      let selected: number | undefined;
      for (const band of mapping.bands) {
        if (band.from === null || band.from <= input) selected = band.value;
        else break;
      }
      if (selected !== undefined) return { ok: true, value: selected };
      const lowest = mapping.bands[0]?.value;
      return resolveOutOfRange(mapping.outOfRange, lowest ?? 0, `Input ${String(input)} is below every declared band`);
    }
    case "piecewise-linear": {
      const first = mapping.points[0];
      const last = mapping.points[mapping.points.length - 1];
      if (first === undefined || last === undefined)
        return { ok: false, reason: "out-of-range", message: "Mapping has no usable points" };
      if (input <= first.x)
        return input === first.x
          ? { ok: true, value: first.y }
          : resolveOutOfRange(mapping.outOfRange, first.y, `Input ${String(input)} is below the first point`);
      if (input >= last.x)
        return input === last.x
          ? { ok: true, value: last.y }
          : resolveOutOfRange(mapping.outOfRange, last.y, `Input ${String(input)} is above the last point`);
      for (let index = 1; index < mapping.points.length; index += 1) {
        const left = mapping.points[index - 1];
        const right = mapping.points[index];
        if (left === undefined || right === undefined || right.x <= input) continue;
        const ratio = (input - left.x) / (right.x - left.x);
        return { ok: true, value: left.y + (right.y - left.y) * ratio };
      }
      return { ok: false, reason: "out-of-range", message: `Input ${String(input)} is outside the declared points` };
    }
    default:
      return { ok: false, reason: "out-of-range", message: "Unsupported mapping form" };
  }
}
