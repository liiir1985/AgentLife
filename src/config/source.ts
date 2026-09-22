import type { Condition, CompareOperator } from "./conditions.js";
import type { CombineMode, ValueMap, NumberPolicy, RangeMode, PartialNumberPolicy, RoundingMode } from "./numeric.js";
import type { SimpleValue, ValueExpr } from "./value-expr.js";

/**
 * Source-pack parsing.
 *
 * This is the structure stage of the pipeline: every shape, type and enum in a
 * YAML document is checked here, and a failure names the file and the field
 * path. Nothing is defaulted from a name, a directory or a display label.
 */

export const RESERVED_SECTIONS = ["behaviors", "prompts", "texts"] as const;
export const RULES_SECTION = "rules";
export const MANIFEST_PATH = "manifest.yaml";

export interface PackManifest {
  readonly namespace: string;
  readonly version: string;
  readonly kernel: string;
  /** Namespaces this pack is allowed to reference. */
  readonly dependencies: readonly string[];
  /** `<system-ref>@<version>` requirements, checked against the registry. */
  readonly systems: readonly string[];
  /** Directory name to config type ref. */
  readonly sections: Readonly<Record<string, string>>;
}

export interface ParsedInput {
  readonly name: string;
  readonly stateRef: string;
}

export type RuleChange =
  | {
      readonly kind: "state";
      readonly stateRef: string;
      readonly combine: CombineMode;
      readonly priority: number | null;
      readonly value: ValueExpr;
    }
  | {
      readonly kind: "process";
      readonly processRef: string;
      readonly action: "establish" | "advance" | "pause" | "end" | "cancel";
      readonly params: Readonly<Record<string, ValueExpr>>;
    };

export interface ParsedItem {
  readonly ref: string;
  readonly id: string;
  readonly namespace: string;
  readonly typeRef: string;
  readonly relativePath: string;
  readonly isPublic: boolean;
  readonly templates: readonly string[];
  readonly fields: Readonly<Record<string, unknown>>;
}

export interface ParsedRule {
  readonly kind: "rule";
  readonly ref: string;
  readonly id: string;
  readonly namespace: string;
  readonly system: string;
  readonly relativePath: string;
  readonly triggers: readonly string[];
  readonly inputs: readonly ParsedInput[];
  readonly condition: Condition;
  readonly changes: readonly RuleChange[];
  readonly dependsOn: readonly string[];
}

export interface ParsedFormula {
  readonly kind: "formula";
  readonly ref: string;
  readonly id: string;
  readonly namespace: string;
  readonly system: string;
  readonly relativePath: string;
  readonly inputs: readonly ParsedInput[];
  readonly outputUnit: string;
  readonly value: ValueExpr;
}

export interface ParsedPack {
  readonly manifest: PackManifest;
  /** SHA-256 id of the exact pack bytes this document set came from. */
  readonly contentId: string;
  readonly items: readonly ParsedItem[];
  readonly rules: readonly ParsedRule[];
  readonly formulas: readonly ParsedFormula[];
}

function asObject(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${path} must be a mapping`);
  return value as Record<string, unknown>;
}

function asArray(value: unknown, path: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new Error(`${path} must be a list`);
  return value;
}

function asString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${path} must be a non-empty string`);
  return value.trim();
}

function asNumber(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${path} must be a finite number`);
  return value;
}

function asBoolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${path} must be a boolean`);
  return value;
}

function enumValue<T extends string>(value: unknown, allowed: readonly T[], path: string): T {
  const text = asString(value, path);
  const match = allowed.find((candidate) => candidate === text);
  if (match === undefined) throw new Error(`${path} must be one of ${allowed.join(", ")}`);
  return match;
}

function expectKnownKeys(value: Record<string, unknown>, allowed: readonly string[], path: string): void {
  for (const key of Object.keys(value))
    if (!allowed.includes(key)) throw new Error(`${path}.${key} is not a supported field`);
}

const ROUNDING_MODES = ["none", "half-away-from-zero", "floor", "ceil", "truncate"] as const;
const COMPOSITIONS = ["priority", "min", "max", "add", "multiply"] as const;
const COMBINE_METHODS = ["min", "max", "add", "multiply"] as const;
const PROCESS_OPERATIONS = ["establish", "advance", "pause", "end", "cancel"] as const;
const COMPARE_OPERATORS = ["eq", "ne", "lt", "lte", "gt", "gte"] as const;

/** A mapping policy states its unit only when the mapped value is not dimensionless. */
export function parseNumberPolicy(value: unknown, path: string): NumberPolicy {
  const object = asObject(value, path);
  expectKnownKeys(object, ["unit", "rounding", "range", "overflow"], path);
  const rounding = asObject(object.rounding, `${path}.rounding`);
  expectKnownKeys(rounding, ["mode", "precision"], `${path}.rounding`);
  const range = asObject(object.range, `${path}.range`);
  expectKnownKeys(range, ["min", "max", "boundary"], `${path}.range`);
  return {
    unit: object.unit === undefined ? "" : asString(object.unit, `${path}.unit`),
    rounding: {
      mode: enumValue(rounding.mode, ROUNDING_MODES, `${path}.rounding.mode`),
      precision: asNumber(rounding.precision, `${path}.rounding.precision`),
    },
    range: {
      min: range.min === null ? null : asNumber(range.min, `${path}.range.min`),
      max: range.max === null ? null : asNumber(range.max, `${path}.range.max`),
      boundary: enumValue(range.boundary, ["inclusive", "exclusive"] as const, `${path}.range.boundary`),
    },
    overflow: enumValue(object.overflow, ["saturate", "reject"] as const, `${path}.overflow`),
  };
}

/** A declared policy block may state any subset of its parts; absent parts carry no constraint. */
export function parsePartialNumberPolicy(value: unknown, path: string): PartialNumberPolicy {
  const object = asObject(value, path);
  expectKnownKeys(object, ["unit", "rounding", "range", "overflow"], path);
  const partial: {
    unit?: string;
    rounding?: { mode?: RoundingMode; precision?: number };
    range?: { min?: number | null; max?: number | null; boundary?: "inclusive" | "exclusive" };
    overflow?: "saturate" | "reject";
  } = {};
  if (object.unit !== undefined) partial.unit = asString(object.unit, `${path}.unit`);
  if (object.rounding !== undefined) {
    const rounding = asObject(object.rounding, `${path}.rounding`);
    expectKnownKeys(rounding, ["mode", "precision"], `${path}.rounding`);
    partial.rounding = {
      ...(rounding.mode === undefined
        ? {}
        : { mode: enumValue(rounding.mode, ROUNDING_MODES, `${path}.rounding.mode`) }),
      ...(rounding.precision === undefined
        ? {}
        : { precision: asNumber(rounding.precision, `${path}.rounding.precision`) }),
    };
  }
  if (object.range !== undefined) {
    const range = asObject(object.range, `${path}.range`);
    expectKnownKeys(range, ["min", "max", "boundary"], `${path}.range`);
    partial.range = {
      ...(range.min === undefined ? {} : { min: range.min === null ? null : asNumber(range.min, `${path}.range.min`) }),
      ...(range.max === undefined ? {} : { max: range.max === null ? null : asNumber(range.max, `${path}.range.max`) }),
      ...(range.boundary === undefined
        ? {}
        : { boundary: enumValue(range.boundary, ["inclusive", "exclusive"] as const, `${path}.range.boundary`) }),
    };
  }
  if (object.overflow !== undefined)
    partial.overflow = enumValue(object.overflow, ["saturate", "reject"] as const, `${path}.overflow`);
  return partial;
}

function parseOutOfRange(value: unknown, path: string): RangeMode {
  const object = asObject(value, path);
  const kind = enumValue(object.kind, ["clamp", "value", "invalid"] as const, `${path}.kind`);
  if (kind === "value") {
    expectKnownKeys(object, ["kind", "value"], path);
    return { kind, value: asNumber(object.value, `${path}.value`) };
  }
  expectKnownKeys(object, ["kind"], path);
  return { kind };
}

export function parseMapping(value: unknown, path: string): ValueMap {
  const object = asObject(value, path);
  const kind = enumValue(object.kind, ["threshold", "piecewise-constant", "piecewise-linear"] as const, `${path}.kind`);
  const inputUnit = object.inputUnit === undefined ? "" : asString(object.inputUnit, `${path}.inputUnit`);
  const policy = parseNumberPolicy(object.policy, `${path}.policy`);
  if (kind === "threshold") {
    expectKnownKeys(object, ["kind", "inputUnit", "at", "boundary", "below", "above", "policy"], path);
    return {
      kind,
      inputUnit,
      at: asNumber(object.at, `${path}.at`),
      boundary: enumValue(object.boundary, ["lower", "upper"] as const, `${path}.boundary`),
      below: asNumber(object.below, `${path}.below`),
      above: asNumber(object.above, `${path}.above`),
      policy,
    };
  }
  if (kind === "piecewise-constant") {
    expectKnownKeys(object, ["kind", "inputUnit", "bands", "outOfRange", "policy"], path);
    const bands = asArray(object.bands, `${path}.bands`).map((band, index) => {
      const entry = asObject(band, `${path}.bands[${index}]`);
      expectKnownKeys(entry, ["from", "value"], `${path}.bands[${index}]`);
      return {
        from: entry.from === null ? null : asNumber(entry.from, `${path}.bands[${index}].from`),
        value: asNumber(entry.value, `${path}.bands[${index}].value`),
      };
    });
    return {
      kind,
      inputUnit,
      bands,
      outOfRange: parseOutOfRange(object.outOfRange, `${path}.outOfRange`),
      policy,
    };
  }
  expectKnownKeys(object, ["kind", "inputUnit", "points", "outOfRange", "policy"], path);
  const points = asArray(object.points, `${path}.points`).map((point, index) => {
    const entry = asObject(point, `${path}.points[${index}]`);
    expectKnownKeys(entry, ["x", "y"], `${path}.points[${index}]`);
    return {
      x: asNumber(entry.x, `${path}.points[${index}].x`),
      y: asNumber(entry.y, `${path}.points[${index}].y`),
    };
  });
  return {
    kind,
    inputUnit,
    points,
    outOfRange: parseOutOfRange(object.outOfRange, `${path}.outOfRange`),
    policy,
  };
}

function parseScalar(value: unknown, path: string): SimpleValue {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "boolean") return value;
  if (typeof value === "string") return value;
  throw new Error(`${path} must be a finite number, boolean or string`);
}

export function parseValueExpr(value: unknown, path: string): ValueExpr {
  const object = asObject(value, path);
  const kind = enumValue(
    object.kind,
    ["literal", "read", "formula", "map", "combine", "compare", "select"] as const,
    `${path}.kind`,
  );
  switch (kind) {
    case "literal": {
      const literal = parseScalar(object.value, `${path}.value`);
      if (typeof literal === "number") {
        expectKnownKeys(object, ["kind", "value", "unit"], path);
        return { kind, value: literal, unit: object.unit === undefined ? "" : asString(object.unit, `${path}.unit`) };
      }
      expectKnownKeys(object, ["kind", "value"], path);
      return { kind, value: literal, unit: "" };
    }
    case "read":
      expectKnownKeys(object, ["kind", "name"], path);
      return { kind, name: asString(object.name, `${path}.name`) };
    case "formula":
      expectKnownKeys(object, ["kind", "formulaRef"], path);
      return { kind, formulaRef: asString(object.formulaRef, `${path}.formulaRef`) };
    case "combine":
      expectKnownKeys(object, ["kind", "method", "operands"], path);
      return {
        kind,
        method: enumValue(object.method, COMBINE_METHODS, `${path}.method`),
        operands: asArray(object.operands, `${path}.operands`).map((operand, index) =>
          parseValueExpr(operand, `${path}.operands[${index}]`),
        ),
      };
    case "compare":
      expectKnownKeys(object, ["kind", "left", "right", "operator"], path);
      return {
        kind,
        left: parseValueExpr(object.left, `${path}.left`),
        right: parseValueExpr(object.right, `${path}.right`),
        operator: enumValue<CompareOperator>(object.operator, COMPARE_OPERATORS, `${path}.operator`),
      };
    case "select":
      expectKnownKeys(object, ["kind", "left", "right", "operator", "then", "otherwise"], path);
      return {
        kind,
        left: parseValueExpr(object.left, `${path}.left`),
        right: parseValueExpr(object.right, `${path}.right`),
        operator: enumValue<CompareOperator>(object.operator, COMPARE_OPERATORS, `${path}.operator`),
        then: parseValueExpr(object.then, `${path}.then`),
        otherwise: parseValueExpr(object.otherwise, `${path}.otherwise`),
      };
    default:
      expectKnownKeys(object, ["kind", "mapping", "input"], path);
      return {
        kind,
        mapping: parseMapping(object.mapping, `${path}.mapping`),
        input: parseValueExpr(object.input, `${path}.input`),
      };
  }
}

export function parseCondition(value: unknown, path: string): Condition {
  const object = asObject(value, path);
  const op = enumValue(
    object.op,
    ["always", "all", "any", "not", "compare", "within", "simulation-time"] as const,
    `${path}.op`,
  );
  switch (op) {
    case "always":
      expectKnownKeys(object, ["op"], path);
      return { op };
    case "all":
    case "any":
      expectKnownKeys(object, ["op", "operands"], path);
      return {
        op,
        operands: asArray(object.operands, `${path}.operands`).map((operand, index) =>
          parseCondition(operand, `${path}.operands[${index}]`),
        ),
      };
    case "not":
      expectKnownKeys(object, ["op", "operand"], path);
      return { op, operand: parseCondition(object.operand, `${path}.operand`) };
    case "compare":
      expectKnownKeys(object, ["op", "left", "right", "operator"], path);
      return {
        op,
        left: parseValueExpr(object.left, `${path}.left`),
        right: parseValueExpr(object.right, `${path}.right`),
        operator: enumValue<CompareOperator>(object.operator, COMPARE_OPERATORS, `${path}.operator`),
      };
    case "within":
      expectKnownKeys(object, ["op", "value", "min", "max", "boundary"], path);
      return {
        op,
        value: parseValueExpr(object.value, `${path}.value`),
        min: object.min === null ? null : asNumber(object.min, `${path}.min`),
        max: object.max === null ? null : asNumber(object.max, `${path}.max`),
        boundary: enumValue(object.boundary, ["inclusive", "exclusive"] as const, `${path}.boundary`),
      };
    default:
      expectKnownKeys(object, ["op", "operator", "tick"], path);
      return {
        op,
        operator: enumValue(object.operator, ["before", "at-or-after"] as const, `${path}.operator`),
        tick: asNumber(object.tick, `${path}.tick`),
      };
  }
}

function parseInputs(value: unknown, path: string): ParsedInput[] {
  return asArray(value, path).map((entry, index) => {
    const object = asObject(entry, `${path}[${index}]`);
    expectKnownKeys(object, ["name", "state"], `${path}[${index}]`);
    return {
      name: asString(object.name, `${path}[${index}].name`),
      stateRef: asString(object.state, `${path}[${index}].state`),
    };
  });
}

function parseChanges(value: unknown, path: string): RuleChange[] {
  return asArray(value, path).map((entry, index) => {
    const object = asObject(entry, `${path}[${index}]`);
    if (object.processRef !== undefined) {
      expectKnownKeys(object, ["processRef", "action", "params"], `${path}[${index}]`);
      const parameters = asObject(object.params, `${path}[${index}].params`);
      const parsed: Record<string, ValueExpr> = {};
      for (const [name, parameter] of Object.entries(parameters))
        parsed[name] = parseValueExpr(parameter, `${path}[${index}].params.${name}`);
      return {
        kind: "process",
        processRef: asString(object.processRef, `${path}[${index}].processRef`),
        action: enumValue(object.action, PROCESS_OPERATIONS, `${path}[${index}].action`),
        params: parsed,
      };
    }
    expectKnownKeys(object, ["state", "combine", "priority", "value"], `${path}[${index}]`);
    return {
      kind: "state",
      stateRef: asString(object.state, `${path}[${index}].state`),
      combine: enumValue<CombineMode>(object.combine, COMPOSITIONS, `${path}[${index}].combine`),
      priority: object.priority === undefined ? null : asNumber(object.priority, `${path}[${index}].priority`),
      value: parseValueExpr(object.value, `${path}[${index}].value`),
    };
  });
}

export function parseManifest(value: unknown, path = MANIFEST_PATH): PackManifest {
  const object = asObject(value, path);
  expectKnownKeys(object, ["pack", "version", "kernel", "dependencies", "systems", "sections"], path);
  const dependencies = asArray(object.dependencies ?? [], `${path}.dependencies`).map((entry, index) =>
    asString(entry, `${path}.dependencies[${index}]`),
  );
  const systems = asArray(object.systems, `${path}.systems`).map((entry, index) =>
    asString(entry, `${path}.systems[${index}]`),
  );
  const sectionsObject = asObject(object.sections, `${path}.sections`);
  const sections: Record<string, string> = {};
  for (const [directory, typeRef] of Object.entries(sectionsObject)) {
    if (directory === RULES_SECTION || (RESERVED_SECTIONS as readonly string[]).includes(directory))
      throw new Error(`${path}.sections must not redeclare the reserved directory ${directory}`);
    sections[directory] = asString(typeRef, `${path}.sections.${directory}`);
  }
  return {
    namespace: asString(object.pack, `${path}.pack`),
    version: asString(object.version, `${path}.version`),
    kernel: asString(object.kernel, `${path}.kernel`),
    dependencies,
    systems,
    sections,
  };
}

/** Replaces a markdown reference held in a field with the referenced text. */
function resolveTexts(value: unknown, resolve: (target: string) => string | undefined): unknown {
  if (typeof value === "string") return resolve(value) ?? value;
  if (Array.isArray(value)) return value.map((item) => resolveTexts(item, resolve));
  if (typeof value === "object" && value !== null) {
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) result[key] = resolveTexts(item, resolve);
    return result;
  }
  return value;
}

function definitionFromDocument(
  document: unknown,
  relativePath: string,
  namespace: string,
  sectionType: string,
  resolveText: (target: string) => string | undefined,
): ParsedItem {
  const object = asObject(document, relativePath);
  expectKnownKeys(object, ["id", "type", "public", "templates", "fields"], relativePath);
  const id = asString(object.id, `${relativePath}.id`);
  const typeRef = asString(object.type, `${relativePath}.type`);
  if (typeRef !== sectionType)
    throw new Error(`${relativePath}.type must be ${sectionType} for this section, received ${typeRef}`);
  const templates = asArray(object.templates ?? [], `${relativePath}.templates`).map((entry, index) =>
    asString(entry, `${relativePath}.templates[${index}]`),
  );
  return {
    ref: `${namespace}/${id}`,
    id,
    namespace,
    typeRef,
    relativePath,
    isPublic: object.public === undefined ? false : asBoolean(object.public, `${relativePath}.public`),
    templates,
    fields: resolveTexts(asObject(object.fields ?? {}, `${relativePath}.fields`), resolveText) as Readonly<
      Record<string, unknown>
    >,
  };
}

function ruleFromDocument(document: unknown, relativePath: string, namespace: string): ParsedRule | ParsedFormula {
  const object = asObject(document, relativePath);
  const kind = enumValue(object.kind, ["rule", "formula"] as const, `${relativePath}.kind`);
  const id = asString(object.id, `${relativePath}.id`);
  const ref = `${namespace}/${id}`;
  if (kind === "formula") {
    expectKnownKeys(object, ["kind", "id", "system", "inputs", "outputUnit", "value"], relativePath);
    return {
      kind,
      ref,
      id,
      namespace,
      system: asString(object.system, `${relativePath}.system`),
      relativePath,
      inputs: parseInputs(object.inputs ?? [], `${relativePath}.inputs`),
      outputUnit: asString(object.outputUnit, `${relativePath}.outputUnit`),
      value: parseValueExpr(object.value, `${relativePath}.value`),
    };
  }
  expectKnownKeys(
    object,
    ["kind", "id", "system", "triggers", "inputs", "condition", "changes", "dependsOn"],
    relativePath,
  );
  return {
    kind,
    ref,
    id,
    namespace,
    system: asString(object.system, `${relativePath}.system`),
    relativePath,
    triggers: asArray(object.triggers, `${relativePath}.triggers`).map((entry, index) =>
      asString(entry, `${relativePath}.triggers[${index}]`),
    ),
    inputs: parseInputs(object.inputs ?? [], `${relativePath}.inputs`),
    condition: parseCondition(object.condition, `${relativePath}.condition`),
    changes: parseChanges(object.changes, `${relativePath}.changes`),
    dependsOn: asArray(object.dependsOn ?? [], `${relativePath}.dependsOn`).map((entry, index) =>
      asString(entry, `${relativePath}.dependsOn[${index}]`),
    ),
  };
}

/**
 * Turns the raw documents of one loaded pack into source items.
 * Structural failures throw; the caller records them as structure diagnostics
 * so a single malformed document never hides the rest of the pack.
 */
export function parsePack(
  manifest: unknown,
  documents: readonly { readonly path: string; readonly document: unknown }[],
  report: (relativePath: string, message: string) => void,
  contentId: string,
  resolveText: (target: string) => string | undefined,
): ParsedPack {
  const parsedManifest = parseManifest(manifest);
  const items: ParsedItem[] = [];
  const rules: ParsedRule[] = [];
  const formulas: ParsedFormula[] = [];

  for (const file of documents) {
    if (file.path === MANIFEST_PATH) continue;
    const directory = file.path.split("/")[0] ?? "";
    // Markdown carries long text and its references were already resolved by the loader.
    if (file.document === undefined) continue;
    // Reserved directories are carried verbatim; later stages interpret them.
    if ((RESERVED_SECTIONS as readonly string[]).includes(directory)) continue;
    if (directory === RULES_SECTION) {
      const candidate = (() => {
        try {
          return ruleFromDocument(file.document, file.path, parsedManifest.namespace);
        } catch (failure) {
          report(file.path, failure instanceof Error ? failure.message : String(failure));
          return undefined;
        }
      })();
      if (candidate === undefined) continue;
      if (candidate.kind === "rule") rules.push(candidate);
      else formulas.push(candidate);
      continue;
    }
    const sectionType = parsedManifest.sections[directory];
    if (sectionType === undefined) {
      report(file.path, `${directory}/ is not a declared section of this pack`);
      continue;
    }
    const item = (() => {
      try {
        return definitionFromDocument(file.document, file.path, parsedManifest.namespace, sectionType, resolveText);
      } catch (failure) {
        report(file.path, failure instanceof Error ? failure.message : String(failure));
        return undefined;
      }
    })();
    if (item !== undefined) items.push(item);
  }

  return {
    manifest: parsedManifest,
    contentId,
    items: items.sort((left, right) => (left.ref < right.ref ? -1 : 1)),
    rules: rules.sort((left, right) => (left.ref < right.ref ? -1 : 1)),
    formulas: formulas.sort((left, right) => (left.ref < right.ref ? -1 : 1)),
  };
}
