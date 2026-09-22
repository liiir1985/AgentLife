import { Value } from "typebox/value";
import type { TSchema } from "typebox";
import { hashId } from "./canonical.js";
import { error, warning, type ConfigIssue } from "./diagnostics.js";
import {
  KERNEL_NAMESPACE,
  KERNEL_VERSION,
  isName,
  isNamespace,
  isVersion,
  isVersionConstraint,
  parseQualifiedName,
  satisfiesVersion,
} from "./identifiers.js";
import { checkNumberPolicy, type NumberPolicy } from "./numeric.js";

/** How two values for the same config field are combined while merging. */
export type MergeStrategy = "replace" | "append" | "merge" | "reject";

/** Simple value types a value-set field may hold. */
export const VALUE_TYPES: readonly ValueType[] = ["number", "boolean", "string"];
export type ValueType = "number" | "boolean" | "string";
/** Whether a runtime capability exists once per snapshot or once per entity. */
export type StateScope = "shared" | "entity";

const MERGE_STRATEGIES: readonly MergeStrategy[] = ["replace", "append", "merge", "reject"];

/** Field-level inputs a system validator may inspect; never the raw system state. */
export interface SystemItem {
  readonly ref: string;
  readonly type: string;
  readonly namespace: string;
  readonly name: string;
  readonly isPublic: boolean;
  readonly values: Readonly<Record<string, unknown>>;
}

export interface SystemRule {
  readonly ref: string;
  readonly system: string;
  readonly triggers: readonly string[];
  readonly targets: readonly string[];
}

export interface SystemCheck {
  readonly packNamespace: string;
  /** Resolved items whose config type belongs to this system. */
  readonly items: readonly SystemItem[];
  /** Compiled rules that this system owns. */
  readonly rules: readonly SystemRule[];
  /** Existence and type lookup only; the validator never sees foreign values. */
  readonly lookup: (ref: string) => { readonly type: string } | undefined;
  readonly report: (diagnostic: ConfigIssue) => void;
}

/**
 * One field a config item contributes to a value-set input and output.
 *
 * A field is addressed as `<id>` when `key` is empty and as `<id>.<key>` otherwise,
 * so a single item may expose several independently readable and writable
 * values (a channel exposes both an availability flag and an efficiency number).
 */
export interface ValueField {
  /** Suffix after `<id>.`; empty means the field key is the item id itself. */
  readonly key: string;
  /** Fixed field value type; omit when the item's own `typeField` decides. */
  readonly valueType?: "number" | "boolean" | "string";
  /** Field naming the field type when `valueType` is absent. */
  readonly typeField?: string;
  /** Field holding the field's declared initial value. */
  readonly stateField: string;
  /** Field holding the field's unit; a field without one is dimensionless. */
  readonly unitField?: string;
  /** Field holding the field's optional numeric policy block. */
  readonly policyField?: string;
  /** Field holding the field's optional closed string vocabulary. */
  readonly allowedValuesField?: string;
  /** Contract fields are core values: exactly one rule may write them. */
  readonly contract?: boolean;
}

/**
 * A per-item value set: every item of the config type adds fields
 * to one readable input and one writable output (`<namespace>/<name>`).
 */
export interface ValueSet {
  readonly name: string;
  readonly fields: readonly ValueField[];
  readonly input?: { readonly scope: StateScope; readonly exposedTo: readonly string[] };
  readonly output?: { readonly scope: StateScope; readonly exposedTo: readonly string[] };
}

export interface ItemSpec {
  readonly kind: string;
  /** Object schema of the resolved config value. */
  readonly fields: TSchema;
  /** Expands every item of this type into input and output fields. */
  readonly valueSet?: ValueSet;
  /** Field defaults supplied by the shared infrastructure, never guessed. */
  readonly defaults?: Readonly<Record<string, unknown>>;
  /**
   * Fields whose values are identities of other items. The kernel checks
   * existence, visibility and target type before any system sees them.
   */
  readonly references?: Readonly<Record<string, readonly string[]>>;
  /**
   * Fields holding a mapping whose keys are identities of other items (the
   * `portable: true` an entity declares for one attribute). A key is checked
   * exactly like a `references` value: it must exist, be visible and have one of
   * the listed config types.
   */
  readonly memberReferences?: Readonly<Record<string, readonly string[]>>;
  /**
   * Fields holding local-view member names. Every member must name a granted
   * runtime view (`<stateRef>.<field>`), so a behaviour tree can never be
   * pointed at a view no system granted.
   */
  readonly viewMembers?: readonly string[];
  /** Fields that an explicit pack override may target. */
  readonly overridable: readonly string[];
  /** Merge strategy per field; a duplicate field without an entry is rejected. */
  readonly merge: Readonly<Record<string, MergeStrategy>>;
  readonly validate?: (input: SystemCheck) => void;
}

export interface InputSpec {
  readonly name: string;
  readonly scope: StateScope;
  /** Object schema of the input value exposed to rules. */
  readonly fields: TSchema;
  /** Unit per numeric field path; required for every field a rule compares. */
  readonly units?: Readonly<Record<string, string>>;
  /** Systems allowed to read this input; wildcards are not granted. */
  readonly exposedTo: readonly string[];
}

export interface OutputSpec {
  readonly name: string;
  readonly scope: StateScope;
  readonly valueType: "number" | "boolean" | "string";
  /** Optional numeric policy; without one the target accepts any finite number unnormalized. */
  readonly policy?: NumberPolicy;
  /** Optional closed vocabulary for string targets; without one any string is accepted. */
  readonly allowedValues?: readonly string[];
  readonly exposedTo: readonly string[];
}

export interface ProcessSpec {
  readonly name: string;
  readonly scope: StateScope;
  readonly operations: readonly ("establish" | "advance" | "pause" | "end" | "cancel")[];
  readonly parameters: TSchema;
}

/**
 * A declaration of which trigger re-evaluates rules after state under one
 * prefix changed. The scheduler never scans every rule: it reads the changed
 * state refs, looks up their prefix here and runs only the selected rules.
 */
export interface PropagationSpec {
  /** Declared input or output the changed state refs start with. */
  readonly stateRef: string;
  /** Declared trigger of the same system. */
  readonly trigger: string;
}

export interface SystemSpec {
  readonly name: string;
  readonly namespace: string;
  readonly version: string;
  /** Version constraint on the shared kernel this system was written against. */
  readonly kernel: string;
  /** Peer systems required at the same runtime config version. */
  readonly requires?: readonly string[];
  readonly items: readonly ItemSpec[];
  readonly inputs: readonly InputSpec[];
  readonly triggers: readonly string[];
  readonly outputs: readonly OutputSpec[];
  readonly processes?: readonly ProcessSpec[];
  readonly propagation?: readonly PropagationSpec[];
  readonly validate?: (input: SystemCheck) => void;
}

export interface LoadedSystem {
  readonly spec: SystemSpec;
  readonly systemId: string;
  readonly specHash: string;
}

export type LoadStatus =
  "registered" | "identity-conflict" | "semantic-incompatible" | "unsupported-semantics" | "unauthorized-capability";

export interface LoadResult {
  readonly status: LoadStatus;
  readonly diagnostics: readonly ConfigIssue[];
  readonly loadedSystem?: LoadedSystem;
}

/** A schema holding a mapping: fixed fields, or free keys with one value type. */
function isMappingSchema(schema: TSchema | undefined): boolean {
  const kind = schemaKind(schema);
  return kind === "Object" || kind === "Record";
}

/** Schema kinds the kernel understands; everything else is unsupported semantics. */
const SUPPORTED_SCHEMA_KINDS: readonly string[] = [
  "Object",
  "Array",
  "String",
  "Number",
  "Integer",
  "Boolean",
  "Null",
  "Literal",
  "Union",
  // A mapping with free keys and one declared value type: what an entity declares
  // for the attributes of its pack (`portable: true`).
  "Record",
  // A JSON document the kernel carries but never interprets: a behaviour tree
  // definition is content, and only the owning system can validate its shape.
  "Unknown",
];

function schemaKind(schema: unknown): string | undefined {
  if (typeof schema !== "object" || schema === null) return undefined;
  const kind: unknown = Reflect.get(schema, "~kind");
  return typeof kind === "string" ? kind : undefined;
}

/** A contract value is read through one input and written through one target. */
function isViewTargetPair(left: string, right: string): boolean {
  return (left === "input" && right === "output target") || (left === "output target" && right === "input");
}

/** SimpleValue types a schema can hold; empty when it holds no scalar. */
function scalarKindsOf(schema: TSchema | undefined): readonly ValueType[] {
  const kind = schemaKind(schema);
  if (kind === "Union") {
    const variants = (Reflect.get(schema as object, "anyOf") ?? []) as TSchema[];
    const kinds = new Set<ValueType>();
    for (const variant of variants) for (const scalar of scalarKindsOf(variant)) kinds.add(scalar);
    return [...kinds];
  }
  if (kind === "Number" || kind === "Integer") return ["number"];
  if (kind === "Boolean") return ["boolean"];
  if (kind === "String" || kind === "Literal") return ["string"];
  return [];
}

/** String literals a schema pins, used to read a schema-level type vocabulary. */
function literalWords(schema: TSchema | undefined): readonly string[] {
  const kind = schemaKind(schema);
  if (kind === "Literal") {
    const value: unknown = Reflect.get(schema as object, "const");
    return typeof value === "string" ? [value] : [];
  }
  if (kind === "Union") {
    const variants = (Reflect.get(schema as object, "anyOf") ?? []) as TSchema[];
    return variants.flatMap((variant) => literalWords(variant));
  }
  return [];
}

/** Rejects arbitrary/unknown schema constructs so no system widens the model. */
function assertSupportedSchema(schema: TSchema, path: string, problems: string[]): void {
  const kind = schemaKind(schema);
  if (kind === undefined || !SUPPORTED_SCHEMA_KINDS.includes(kind)) {
    problems.push(`${path} uses unsupported schema kind ${kind ?? "unknown"}`);
    return;
  }
  const record = schema as Record<string, unknown>;
  if (kind === "Object") {
    const properties = (record.properties ?? {}) as Record<string, TSchema>;
    for (const [name, property] of Object.entries(properties))
      assertSupportedSchema(property, `${path}.${name}`, problems);
    if (record.additionalProperties !== undefined && record.additionalProperties !== false)
      problems.push(`${path} must not allow additional properties`);
  }
  if (kind === "Array") {
    const items = record.items as TSchema | undefined;
    if (items === undefined) problems.push(`${path} must declare item schema`);
    else assertSupportedSchema(items, `${path}[]`, problems);
  }
  if (kind === "Record") {
    const values = Object.values((record.patternProperties ?? {}) as Record<string, TSchema>)[0];
    if (values === undefined) problems.push(`${path} must declare its member value schema`);
    else assertSupportedSchema(values, `${path}.*`, problems);
  }
  if (kind === "Union") {
    const variants = (record.anyOf ?? []) as TSchema[];
    if (variants.length === 0) problems.push(`${path} must declare union variants`);
    variants.forEach((variant, index) => assertSupportedSchema(variant, `${path}|${index}`, problems));
  }
}

/**
 * Validates a value-valueSet declaration: every field must name existing fields of
 * the config type with a compatible kind, so expansion can bind fields to values
 * without ever reading an undeclared field.
 */
function familyProblems(
  declaration: ItemSpec,
  properties: Record<string, TSchema>,
  problems: string[],
  semantics: string[],
): void {
  const valueSet = declaration.valueSet;
  if (valueSet === undefined) return;
  const where = `Config type ${declaration.kind} valueSet ${valueSet.name}`;
  if (!isName(valueSet.name)) problems.push(`Family name is invalid: ${valueSet.name}`);
  if (valueSet.fields.length === 0) problems.push(`${where} declares no field`);
  const memberKeys = new Set<string>();
  if (valueSet.input !== undefined && valueSet.input.scope !== "shared" && valueSet.input.scope !== "entity")
    problems.push(`${where} input declares invalid scope ${String(valueSet.input.scope)}`);
  if (valueSet.output !== undefined && valueSet.output.scope !== "shared" && valueSet.output.scope !== "entity")
    problems.push(`${where} output declares invalid scope ${String(valueSet.output.scope)}`);
  if (valueSet.input !== undefined && valueSet.output !== undefined && valueSet.input.scope !== valueSet.output.scope)
    problems.push(`${where} input and output must use the same scope`);
  for (const field of valueSet.fields) {
    const label = `${where} field ${field.key === "" ? "<id>" : field.key}`;
    if (field.key !== "" && !isName(field.key)) problems.push(`Family field key is invalid: ${field.key}`);
    if (memberKeys.has(field.key)) problems.push(`${where} declares field ${field.key} twice`);
    memberKeys.add(field.key);
    if (field.valueType === undefined && field.typeField === undefined)
      problems.push(`${label} declares neither a value type nor a type field`);
    if (field.valueType !== undefined && field.typeField !== undefined)
      problems.push(`${label} declares both a value type and a type field`);
    if (field.valueType !== undefined && !VALUE_TYPES.includes(field.valueType))
      semantics.push(`${label} requests unsupported value type ${String(field.valueType)}`);
    const declaredTypes: string[] = [];
    if (field.typeField !== undefined) {
      const typeSchema = properties[field.typeField];
      if (typeSchema === undefined) problems.push(`${label} declares unknown type field ${field.typeField}`);
      else if (!scalarKindsOf(typeSchema).includes("string"))
        semantics.push(`${label} type field ${field.typeField} is not a string field`);
      else {
        for (const word of literalWords(typeSchema)) {
          declaredTypes.push(word);
          if (!VALUE_TYPES.includes(word as ValueType))
            semantics.push(`${label} type field ${field.typeField} names unknown value type ${word}`);
        }
      }
    }
    const stateSchema = properties[field.stateField];
    if (stateSchema === undefined) problems.push(`${label} declares unknown state field ${field.stateField}`);
    else {
      const kinds = scalarKindsOf(stateSchema);
      if (field.valueType !== undefined) {
        if (kinds.length !== 1 || kinds[0] !== field.valueType)
          semantics.push(`${label} state field ${field.stateField} is not a ${field.valueType} field`);
      } else if (kinds.length === 0)
        semantics.push(`${label} state field ${field.stateField} cannot hold a scalar value`);
      else
        for (const declared of declaredTypes)
          if (!kinds.includes(declared as ValueType))
            semantics.push(
              `${label} type field ${field.typeField} names ${declared} but the state field cannot hold it`,
            );
    }
    for (const [fieldName, expected] of [
      [field.unitField, "String"],
      [field.policyField, "Object"],
      [field.allowedValuesField, "Array"],
    ] as const) {
      if (fieldName === undefined) continue;
      if (!(fieldName in properties)) problems.push(`${label} declares unknown field ${fieldName}`);
      else if (schemaKind(properties[fieldName]) !== expected)
        semantics.push(`${label} field ${fieldName} is not a ${expected.toLowerCase()} field`);
    }
    if (field.allowedValuesField !== undefined) {
      const items = Reflect.get(properties[field.allowedValuesField] as object, "items") as TSchema | undefined;
      if (items !== undefined && schemaKind(items) !== "String")
        semantics.push(`${label} vocabulary field ${field.allowedValuesField} is not a string list`);
    }
  }
  for (const [exposure, exposedTo] of [
    ["input", valueSet.input?.exposedTo],
    ["output", valueSet.output?.exposedTo],
  ] as const) {
    if (exposedTo === undefined) continue;
    for (const reader of exposedTo) {
      if (reader === "*")
        problems.push(`${where} valueSet ${exposure} requests wildcard exposure, which the kernel never grants`);
      else if (!isNamespace(reader)) problems.push(`Invalid valueSet ${exposure}: ${reader}`);
    }
  }
}

/** SimpleValue type a schema holds, or `null` when the schema holds no scalar. */
export function scalarKind(schema: TSchema | undefined): "number" | "boolean" | "string" | null {
  switch (schemaKind(schema)) {
    case "Number":
    case "Integer":
      return "number";
    case "Boolean":
      return "boolean";
    case "String":
    case "Literal":
      return "string";
    default:
      return null;
  }
}

export function schemaProperties(schema: TSchema): Record<string, TSchema> {
  if (schemaKind(schema) !== "Object") return {};
  const properties: unknown = Reflect.get(schema as object, "properties");
  return typeof properties === "object" && properties !== null ? (properties as Record<string, TSchema>) : {};
}

export function itemTypeRef(system: LoadedSystem, kind: string): string {
  return `${system.spec.namespace}/${kind}`;
}

export function inputRef(system: LoadedSystem, name: string): string {
  return `${system.spec.namespace}/${name}`;
}

export function outputRef(system: LoadedSystem, name: string): string {
  return `${system.spec.namespace}/${name}`;
}

export function systemRef(system: SystemSpec): string {
  return system.namespace;
}

export interface SystemVersionRef {
  readonly systemId: string;
  readonly version?: string;
}

/** Parses the `system.id@version` form used by manifests. */
export function parseSystemVersionRef(value: string, label: string): SystemVersionRef {
  const separator = value.lastIndexOf("@");
  const systemId = separator === -1 ? value : value.slice(0, separator);
  const version = separator === -1 ? undefined : value.slice(separator + 1);
  if (!isNamespace(systemId)) throw new Error(`${label} is not a system id: ${value}`);
  if (version !== undefined && !isVersion(version)) throw new Error(`${label} has an invalid version: ${value}`);
  return version === undefined ? { systemId } : { systemId, version };
}

function loadIssues(system: SystemSpec): {
  readonly status: LoadStatus;
  readonly diagnostics: readonly ConfigIssue[];
} {
  const diagnostics: ConfigIssue[] = [];
  const problems: string[] = [];
  const semantics: string[] = [];
  const systemIndex: string[] = [];

  if (!isNamespace(system.namespace)) problems.push(`System namespace is invalid: ${system.namespace}`);
  if (!isName(system.name)) problems.push(`System name is invalid: ${system.name}`);
  if (!isVersion(system.version)) problems.push(`System version is invalid: ${system.version}`);
  if (!isVersionConstraint(system.kernel)) problems.push(`Kernel constraint is not a version range: ${system.kernel}`);
  for (const requirement of system.requires ?? []) {
    try {
      parseSystemVersionRef(requirement, "system requirement");
    } catch (failure) {
      problems.push(failure instanceof Error ? failure.message : String(failure));
    }
  }

  for (const declaration of system.items) {
    if (!isName(declaration.kind)) problems.push(`Config type name is invalid: ${declaration.kind}`);
    assertSupportedSchema(declaration.fields, `config type ${declaration.kind}.fields`, semantics);
    const properties = schemaProperties(declaration.fields);
    for (const field of declaration.overridable)
      if (!(field in properties))
        problems.push(`Config type ${declaration.kind} marks unknown field ${field} overridable`);
    for (const [field, strategy] of Object.entries(declaration.merge)) {
      if (!MERGE_STRATEGIES.includes(strategy))
        semantics.push(`Config type ${declaration.kind} uses unknown merge strategy ${strategy}`);
      const fieldSchema = properties[field];
      if (fieldSchema === undefined)
        problems.push(`Config type ${declaration.kind} declares a merge strategy for unknown field ${field}`);
      else if (strategy === "append" && schemaKind(fieldSchema) !== "Array")
        semantics.push(`Config type ${declaration.kind}.${field} uses "append" on a non-array field`);
      else if (strategy === "merge" && !isMappingSchema(fieldSchema))
        semantics.push(`Config type ${declaration.kind}.${field} uses "merge" on a non-object field`);
    }
    for (const [field, value] of Object.entries(declaration.defaults ?? {})) {
      const fieldSchema = properties[field];
      if (fieldSchema === undefined)
        problems.push(`Config type ${declaration.kind} declares a default for unknown field ${field}`);
      else if (!Value.Check(fieldSchema, value))
        semantics.push(`Config type ${declaration.kind}.${field} default does not match its declared type`);
    }
    if (declaration.overridable.some((field) => declaration.merge[field] === "reject"))
      semantics.push(`Config type ${declaration.kind} marks a rejected field overridable`);
    for (const field of Object.keys(declaration.memberReferences ?? {}))
      if (!(field in properties))
        problems.push(`Config type ${declaration.kind} declares member references for unknown field ${field}`);
    for (const field of declaration.viewMembers ?? []) {
      const fieldSchema = properties[field];
      if (fieldSchema === undefined) {
        problems.push(`Config type ${declaration.kind} declares view members for unknown field ${field}`);
        continue;
      }
      const kind = schemaKind(fieldSchema);
      const memberKind = kind === "Array" ? schemaKind(Reflect.get(fieldSchema as object, "items")) : kind;
      if (memberKind !== "String")
        semantics.push(`Config type ${declaration.kind}.${field} holds view members but is not a string list`);
    }
    for (const [field, allowed] of Object.entries(declaration.references ?? {})) {
      const fieldSchema = properties[field];
      if (fieldSchema === undefined) {
        problems.push(`Config type ${declaration.kind} declares references for unknown field ${field}`);
        continue;
      }
      const kind = schemaKind(fieldSchema);
      const itemKind = kind === "Array" ? schemaKind(Reflect.get(fieldSchema as object, "items")) : kind;
      if (itemKind !== "String")
        semantics.push(`Config type ${declaration.kind}.${field} holds references but is not a string field`);
      for (const target of allowed)
        try {
          parseQualifiedName(target, "reference target");
        } catch (failure) {
          problems.push(failure instanceof Error ? failure.message : String(failure));
        }
    }
    familyProblems(declaration, properties, problems, semantics);
  }

  for (const input of system.inputs) {
    if (!isName(input.name)) problems.push(`View name is invalid: ${input.name}`);
    if (input.scope !== "shared" && input.scope !== "entity")
      problems.push(`Input ${input.name} declares invalid scope ${String(input.scope)}`);
    assertSupportedSchema(input.fields, `input ${input.name}.fields`, semantics);
    for (const field of Object.keys(input.units ?? {}))
      if (!(field in schemaProperties(input.fields)))
        problems.push(`View ${input.name} declares a unit for unknown field ${field}`);
    for (const reader of input.exposedTo) {
      if (reader === "*")
        systemIndex.push(`View ${input.name} requests wildcard exposure, which the kernel never grants`);
      else if (!isNamespace(reader)) problems.push(`Invalid input exposure: ${reader}`);
    }
  }

  for (const target of system.outputs) {
    if (!isName(target.name)) problems.push(`Output target name is invalid: ${target.name}`);
    if (target.scope !== "shared" && target.scope !== "entity")
      problems.push(`Output target ${target.name} declares invalid scope ${String(target.scope)}`);
    if (!VALUE_TYPES.includes(target.valueType))
      systemIndex.push(`Output target ${target.name} requests unsupported value type ${String(target.valueType)}`);
    if (target.policy !== undefined) {
      if (target.valueType !== "number")
        semantics.push(`Output target ${target.name} declares a numeric policy but holds ${target.valueType}`);
      semantics.push(...checkNumberPolicy(target.policy, `target ${target.name}.policy`));
    }
    if (target.allowedValues !== undefined) {
      if (target.valueType !== "string")
        semantics.push(`Output target ${target.name} declares a vocabulary but holds ${target.valueType}`);
      if (target.allowedValues.length === 0) problems.push(`Output target ${target.name} declares an empty vocabulary`);
      if (new Set(target.allowedValues).size !== target.allowedValues.length)
        problems.push(`Output target ${target.name} repeats a vocabulary entry`);
      for (const value of target.allowedValues)
        if (!isName(value)) problems.push(`Output target ${target.name} vocabulary entry is invalid: ${value}`);
    }
    for (const writer of target.exposedTo) {
      if (writer === "*")
        systemIndex.push(`Output target ${target.name} requests wildcard exposure, which the kernel never grants`);
      else if (!isNamespace(writer)) problems.push(`Invalid output exposure: ${writer}`);
    }
  }

  for (const trigger of system.triggers) if (!isName(trigger)) problems.push(`Trigger name is invalid: ${trigger}`);

  const declaredStatePrefixes = new Set<string>([
    ...system.inputs.map((input) => `${system.namespace}/${input.name}`),
    ...system.outputs.map((target) => `${system.namespace}/${target.name}`),
    ...system.items.flatMap((declaration) => {
      const valueSet = declaration.valueSet;
      if (valueSet === undefined) return [];
      const ref = `${system.namespace}/${valueSet.name}`;
      return [ref];
    }),
  ]);
  for (const propagation of system.propagation ?? []) {
    if (!declaredStatePrefixes.has(propagation.stateRef))
      problems.push(
        `Propagation of ${systemRef(system)} names ${propagation.stateRef}, which is not a declared input or output`,
      );
    if (!system.triggers.some((trigger) => `${system.namespace}/${trigger}` === propagation.trigger))
      problems.push(
        `Propagation of ${systemRef(system)} names trigger ${propagation.trigger}, which the system does not declare`,
      );
  }

  for (const process of system.processes ?? []) {
    if (!isName(process.name)) problems.push(`Process name is invalid: ${process.name}`);
    if (process.scope !== "shared" && process.scope !== "entity")
      problems.push(`Process ${process.name} declares invalid scope ${String(process.scope)}`);
    if (process.operations.length === 0) problems.push(`Process ${process.name} declares no operation`);
    if (schemaKind(process.parameters) !== "Object")
      semantics.push(`Process ${process.name}.parameters must be an object schema`);
    else assertSupportedSchema(process.parameters, `process ${process.name}.parameters`, semantics);
  }

  const seen = new Map<string, string>();
  const families = system.items
    .map((declaration) => declaration.valueSet)
    .filter((valueSet) => valueSet !== undefined)
    .map(({ name }) => ({ name }));
  const categories: readonly (readonly [string, readonly { readonly name?: string; readonly kind?: string }[]])[] = [
    ["config type", system.items],
    ["valueSet", families],
    ["input", system.inputs],
    ["trigger", system.triggers.map((name) => ({ name }))],
    ["output target", system.outputs],
    ["process", (system.processes ?? []).map((process) => ({ name: process.name }))],
  ];
  for (const [category, items] of categories) {
    for (const item of items) {
      const name = item.name ?? item.kind ?? "";
      const previous = seen.get(name);
      // A input and a target of the same name are the read side and the write side
      // of one contract value; every other reuse of a name stays forbidden.
      if (previous !== undefined && !isViewTargetPair(previous, category))
        problems.push(`Name ${name} is declared twice in ${system.namespace} (${previous} and ${category})`);
      else seen.set(name, category);
    }
  }

  for (const problem of problems)
    diagnostics.push(error("structure", "structure-invalid", problem, { subject: systemRef(system) }));
  for (const semantic of semantics)
    diagnostics.push(error("compatibility", "unsupported-semantics", semantic, { subject: systemRef(system) }));
  if (!satisfiesVersion(KERNEL_VERSION, system.kernel))
    diagnostics.push(
      error(
        "compatibility",
        "incompatible-system",
        `System ${systemRef(system)} requires kernel ${system.kernel}, kernel is ${KERNEL_VERSION}`,
        { subject: systemRef(system) },
      ),
    );
  for (const capability of systemIndex)
    diagnostics.push(error("permission", "unauthorized-change", capability, { subject: systemRef(system) }));

  if (problems.length > 0) return { status: "unsupported-semantics", diagnostics };
  if (semantics.length > 0) return { status: "unsupported-semantics", diagnostics };
  if (systemIndex.length > 0) return { status: "unauthorized-capability", diagnostics };
  if (diagnostics.some((diagnostic) => diagnostic.code === "incompatible-system"))
    return { status: "semantic-incompatible", diagnostics };
  return { status: "registered", diagnostics };
}

function specHashOf(system: SystemSpec): string {
  return hashId({
    namespace: system.namespace,
    name: system.name,
    version: system.version,
    kernel: system.kernel,
    requires: system.requires ?? [],
    items: system.items.map((declaration) => ({
      kind: declaration.kind,
      fields: declaration.fields,
      valueSet: declaration.valueSet ?? null,
      overridable: [...declaration.overridable],
      merge: declaration.merge,
      references: declaration.references ?? {},
    })),
    inputs: system.inputs,
    triggers: system.triggers,
    outputs: system.outputs,
    processes: system.processes ?? [],
    propagation: system.propagation ?? [],
  });
}

/**
 * Catalog of loaded systems.
 *
 * Registration is content-addressed: re-registering the same declaration is a
 * no-op, registering different content under the same identity is an integrity
 * error. Cross-system requirements are checked by `finalize`, so the outcome
 * never depends on the order modules happened to register themselves.
 */
export class SystemCatalog {
  private readonly byId = new Map<string, LoadedSystem>();

  add(system: SystemSpec): LoadResult {
    const { status, diagnostics } = loadIssues(system);
    if (status !== "registered") return { status, diagnostics };
    const systemId = systemRef(system);
    const specHash = specHashOf(system);
    const existing = this.byId.get(systemId);
    if (existing !== undefined) {
      if (existing.specHash === specHash) return { status: "registered", diagnostics, loadedSystem: existing };
      return {
        status: "identity-conflict",
        diagnostics: [
          error("compatibility", "identity-conflict", `System ${systemId} is already loaded with different content`, {
            subject: systemId,
          }),
        ],
      };
    }
    const registered: LoadedSystem = Object.freeze({
      spec: Object.freeze(system),
      systemId,
      specHash,
    });
    this.byId.set(systemId, registered);
    return { status: "registered", diagnostics, loadedSystem: registered };
  }

  /** Verifies peer requirements once every system has been registered. */
  finalize(): readonly ConfigIssue[] {
    const diagnostics: ConfigIssue[] = [];
    for (const registered of this.sorted()) {
      const system = registered.spec;
      const exposures: readonly (readonly [string, readonly string[]])[] = [
        ...system.inputs.map((input) => [input.name, input.exposedTo] as const),
        ...system.outputs.map((target) => [target.name, target.exposedTo] as const),
        ...system.items
          .filter((declaration) => declaration.valueSet !== undefined)
          .flatMap((declaration) => {
            const valueSet = declaration.valueSet;
            if (valueSet === undefined) return [];
            return [
              [`${valueSet.name} input`, valueSet.input?.exposedTo ?? []] as const,
              [`${valueSet.name} output`, valueSet.output?.exposedTo ?? []] as const,
            ];
          }),
      ];
      for (const [name, exposedTo] of exposures)
        for (const reader of exposedTo)
          if (this.byId.get(reader) === undefined)
            diagnostics.push(
              warning(
                "permission",
                "unauthorized-read",
                `${name} of ${registered.systemId} is exposed to ${reader}, which is not registered in this runtime; the grant stays inert until it is`,
              ),
            );
      for (const requirement of system.requires ?? []) {
        const target = parseSystemVersionRef(requirement, "system requirement");
        const found = this.byId.get(target.systemId);
        if (found === undefined) {
          diagnostics.push(
            error(
              "compatibility",
              "incompatible-system",
              `System ${registered.systemId} requires ${requirement}, which is not loaded`,
              { subject: registered.systemId },
            ),
          );
          continue;
        }
        if (target.version !== undefined && found.spec.version !== target.version)
          diagnostics.push(
            error(
              "compatibility",
              "incompatible-system",
              `System ${registered.systemId} requires ${requirement} but ${found.systemId} is ${found.spec.version}`,
              { subject: registered.systemId },
            ),
          );
        if (found.spec.version !== registered.spec.version)
          diagnostics.push(
            warning(
              "compatibility",
              "incompatible-system",
              `System ${registered.systemId} and ${found.systemId} are not on the same version`,
            ),
          );
      }
    }
    return diagnostics;
  }

  /** Systems in stable id order; never load order. */
  sorted(): readonly LoadedSystem[] {
    return [...this.byId.values()].sort((left, right) =>
      left.systemId < right.systemId ? -1 : left.systemId > right.systemId ? 1 : 0,
    );
  }

  get(systemId: string): LoadedSystem | undefined {
    return this.byId.get(systemId);
  }

  kernelVersion(): string {
    return KERNEL_VERSION;
  }

  kernelNamespace(): string {
    return KERNEL_NAMESPACE;
  }
}
