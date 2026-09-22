import type { Condition, CompareOperator } from "./conditions.js";
import type {
  CompositionKind,
  NumericMapping,
  NumericPolicy,
  OutOfRangeBehaviour,
  PartialNumericPolicy,
  RoundingMode,
} from "./numeric.js";
import type { Scalar, ValueSource } from "./values.js";

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

export interface SourceManifest {
  readonly namespace: string;
  readonly version: string;
  readonly kernel: string;
  /** Namespaces this pack is allowed to reference. */
  readonly dependencies: readonly string[];
  /** `<extension-ref>@<version>` requirements, checked against the registry. */
  readonly extensions: readonly string[];
  /** Directory name to config type ref. */
  readonly sections: Readonly<Record<string, string>>;
}

export interface SourceRead {
  readonly alias: string;
  readonly view: string;
  readonly field: string;
}

export type SourceEffect =
  | {
      readonly kind: "target";
      readonly target: string;
      readonly composition: CompositionKind;
      readonly priority: number | null;
      readonly value: ValueSource;
    }
  | {
      readonly kind: "process";
      readonly process: string;
      readonly operation: "establish" | "advance" | "pause" | "end" | "cancel";
      readonly parameters: Readonly<Record<string, ValueSource>>;
    };

export interface SourceDefinition {
  readonly ref: string;
  readonly id: string;
  readonly namespace: string;
  readonly typeRef: string;
  readonly relativePath: string;
  readonly isPublic: boolean;
  readonly templates: readonly string[];
  readonly fields: Readonly<Record<string, unknown>>;
}

export interface SourceRule {
  readonly kind: "rule";
  readonly ref: string;
  readonly id: string;
  readonly namespace: string;
  readonly domain: string;
  readonly relativePath: string;
  readonly triggers: readonly string[];
  readonly reads: readonly SourceRead[];
  readonly condition: Condition;
  readonly effects: readonly SourceEffect[];
  readonly dependsOn: readonly string[];
}

export interface SourceDerivation {
  readonly kind: "derivation";
  readonly ref: string;
  readonly id: string;
  readonly namespace: string;
  readonly domain: string;
  readonly relativePath: string;
  readonly reads: readonly SourceRead[];
  readonly outputUnit: string;
  readonly value: ValueSource;
}

export interface SourcePack {
  readonly manifest: SourceManifest;
  /** SHA-256 identity of the exact pack bytes this document set came from. */
  readonly identity: string;
  readonly definitions: readonly SourceDefinition[];
  readonly rules: readonly SourceRule[];
  readonly derivations: readonly SourceDerivation[];
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
export function parseNumericPolicy(value: unknown, path: string): NumericPolicy {
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
export function parsePartialNumericPolicy(value: unknown, path: string): PartialNumericPolicy {
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

function parseOutOfRange(value: unknown, path: string): OutOfRangeBehaviour {
  const object = asObject(value, path);
  const kind = enumValue(object.kind, ["clamp", "value", "invalid"] as const, `${path}.kind`);
  if (kind === "value") {
    expectKnownKeys(object, ["kind", "value"], path);
    return { kind, value: asNumber(object.value, `${path}.value`) };
  }
  expectKnownKeys(object, ["kind"], path);
  return { kind };
}

export function parseMapping(value: unknown, path: string): NumericMapping {
  const object = asObject(value, path);
  const kind = enumValue(object.kind, ["threshold", "piecewise-constant", "piecewise-linear"] as const, `${path}.kind`);
  const inputUnit = object.inputUnit === undefined ? "" : asString(object.inputUnit, `${path}.inputUnit`);
  const policy = parseNumericPolicy(object.policy, `${path}.policy`);
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

function parseScalar(value: unknown, path: string): Scalar {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "boolean") return value;
  if (typeof value === "string") return value;
  throw new Error(`${path} must be a finite number, boolean or string`);
}

export function parseValueSource(value: unknown, path: string): ValueSource {
  const object = asObject(value, path);
  const kind = enumValue(
    object.kind,
    ["literal", "read", "derived", "map", "combine", "compare", "select"] as const,
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
      expectKnownKeys(object, ["kind", "alias"], path);
      return { kind, alias: asString(object.alias, `${path}.alias`) };
    case "derived":
      expectKnownKeys(object, ["kind", "ref"], path);
      return { kind, ref: asString(object.ref, `${path}.ref`) };
    case "combine":
      expectKnownKeys(object, ["kind", "method", "operands"], path);
      return {
        kind,
        method: enumValue(object.method, COMBINE_METHODS, `${path}.method`),
        operands: asArray(object.operands, `${path}.operands`).map((operand, index) =>
          parseValueSource(operand, `${path}.operands[${index}]`),
        ),
      };
    case "compare":
      expectKnownKeys(object, ["kind", "left", "right", "operator"], path);
      return {
        kind,
        left: parseValueSource(object.left, `${path}.left`),
        right: parseValueSource(object.right, `${path}.right`),
        operator: enumValue<CompareOperator>(object.operator, COMPARE_OPERATORS, `${path}.operator`),
      };
    case "select":
      expectKnownKeys(object, ["kind", "left", "right", "operator", "then", "otherwise"], path);
      return {
        kind,
        left: parseValueSource(object.left, `${path}.left`),
        right: parseValueSource(object.right, `${path}.right`),
        operator: enumValue<CompareOperator>(object.operator, COMPARE_OPERATORS, `${path}.operator`),
        then: parseValueSource(object.then, `${path}.then`),
        otherwise: parseValueSource(object.otherwise, `${path}.otherwise`),
      };
    default:
      expectKnownKeys(object, ["kind", "mapping", "input"], path);
      return {
        kind,
        mapping: parseMapping(object.mapping, `${path}.mapping`),
        input: parseValueSource(object.input, `${path}.input`),
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
        left: parseValueSource(object.left, `${path}.left`),
        right: parseValueSource(object.right, `${path}.right`),
        operator: enumValue<CompareOperator>(object.operator, COMPARE_OPERATORS, `${path}.operator`),
      };
    case "within":
      expectKnownKeys(object, ["op", "value", "min", "max", "boundary"], path);
      return {
        op,
        value: parseValueSource(object.value, `${path}.value`),
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

function parseReads(value: unknown, path: string): SourceRead[] {
  return asArray(value, path).map((entry, index) => {
    const object = asObject(entry, `${path}[${index}]`);
    expectKnownKeys(object, ["alias", "view", "field"], `${path}[${index}]`);
    return {
      alias: asString(object.alias, `${path}[${index}].alias`),
      view: asString(object.view, `${path}[${index}].view`),
      field: asString(object.field, `${path}[${index}].field`),
    };
  });
}

function parseEffects(value: unknown, path: string): SourceEffect[] {
  return asArray(value, path).map((entry, index) => {
    const object = asObject(entry, `${path}[${index}]`);
    if (object.process !== undefined) {
      expectKnownKeys(object, ["process", "operation", "parameters"], `${path}[${index}]`);
      const parameters = asObject(object.parameters, `${path}[${index}].parameters`);
      const parsed: Record<string, ValueSource> = {};
      for (const [name, parameter] of Object.entries(parameters))
        parsed[name] = parseValueSource(parameter, `${path}[${index}].parameters.${name}`);
      return {
        kind: "process",
        process: asString(object.process, `${path}[${index}].process`),
        operation: enumValue(object.operation, PROCESS_OPERATIONS, `${path}[${index}].operation`),
        parameters: parsed,
      };
    }
    expectKnownKeys(object, ["target", "composition", "priority", "value"], `${path}[${index}]`);
    return {
      kind: "target",
      target: asString(object.target, `${path}[${index}].target`),
      composition: enumValue<CompositionKind>(object.composition, COMPOSITIONS, `${path}[${index}].composition`),
      priority: object.priority === undefined ? null : asNumber(object.priority, `${path}[${index}].priority`),
      value: parseValueSource(object.value, `${path}[${index}].value`),
    };
  });
}

export function parseManifest(value: unknown, path = MANIFEST_PATH): SourceManifest {
  const object = asObject(value, path);
  expectKnownKeys(object, ["pack", "version", "kernel", "dependencies", "extensions", "sections"], path);
  const dependencies = asArray(object.dependencies ?? [], `${path}.dependencies`).map((entry, index) =>
    asString(entry, `${path}.dependencies[${index}]`),
  );
  const extensions = asArray(object.extensions, `${path}.extensions`).map((entry, index) =>
    asString(entry, `${path}.extensions[${index}]`),
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
    extensions,
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
): SourceDefinition {
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

function ruleFromDocument(document: unknown, relativePath: string, namespace: string): SourceRule | SourceDerivation {
  const object = asObject(document, relativePath);
  const kind = enumValue(object.kind, ["rule", "derivation"] as const, `${relativePath}.kind`);
  const id = asString(object.id, `${relativePath}.id`);
  const ref = `${namespace}/${id}`;
  if (kind === "derivation") {
    expectKnownKeys(object, ["kind", "id", "domain", "reads", "outputUnit", "value"], relativePath);
    return {
      kind,
      ref,
      id,
      namespace,
      domain: asString(object.domain, `${relativePath}.domain`),
      relativePath,
      reads: parseReads(object.reads ?? [], `${relativePath}.reads`),
      outputUnit: asString(object.outputUnit, `${relativePath}.outputUnit`),
      value: parseValueSource(object.value, `${relativePath}.value`),
    };
  }
  expectKnownKeys(
    object,
    ["kind", "id", "domain", "triggers", "reads", "condition", "effects", "dependsOn"],
    relativePath,
  );
  return {
    kind,
    ref,
    id,
    namespace,
    domain: asString(object.domain, `${relativePath}.domain`),
    relativePath,
    triggers: asArray(object.triggers, `${relativePath}.triggers`).map((entry, index) =>
      asString(entry, `${relativePath}.triggers[${index}]`),
    ),
    reads: parseReads(object.reads ?? [], `${relativePath}.reads`),
    condition: parseCondition(object.condition, `${relativePath}.condition`),
    effects: parseEffects(object.effects, `${relativePath}.effects`),
    dependsOn: asArray(object.dependsOn ?? [], `${relativePath}.dependsOn`).map((entry, index) =>
      asString(entry, `${relativePath}.dependsOn[${index}]`),
    ),
  };
}

/**
 * Turns the raw documents of one loaded pack into source definitions.
 * Structural failures throw; the caller records them as structure diagnostics
 * so a single malformed document never hides the rest of the pack.
 */
export function parseSourcePack(
  manifest: unknown,
  documents: readonly { readonly path: string; readonly document: unknown }[],
  report: (relativePath: string, message: string) => void,
  identity: string,
  resolveText: (target: string) => string | undefined,
): SourcePack {
  const parsedManifest = parseManifest(manifest);
  const definitions: SourceDefinition[] = [];
  const rules: SourceRule[] = [];
  const derivations: SourceDerivation[] = [];

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
      else derivations.push(candidate);
      continue;
    }
    const sectionType = parsedManifest.sections[directory];
    if (sectionType === undefined) {
      report(file.path, `${directory}/ is not a declared section of this pack`);
      continue;
    }
    const definition = (() => {
      try {
        return definitionFromDocument(file.document, file.path, parsedManifest.namespace, sectionType, resolveText);
      } catch (failure) {
        report(file.path, failure instanceof Error ? failure.message : String(failure));
        return undefined;
      }
    })();
    if (definition !== undefined) definitions.push(definition);
  }

  return {
    manifest: parsedManifest,
    identity,
    definitions: definitions.sort((left, right) => (left.ref < right.ref ? -1 : 1)),
    rules: rules.sort((left, right) => (left.ref < right.ref ? -1 : 1)),
    derivations: derivations.sort((left, right) => (left.ref < right.ref ? -1 : 1)),
  };
}
