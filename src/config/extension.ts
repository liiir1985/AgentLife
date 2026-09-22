import { Value } from "typebox/value";
import type { TSchema } from "typebox";
import { identityOf } from "./canonical.js";
import { error, warning, type Diagnostic } from "./diagnostics.js";
import {
  KERNEL_NAMESPACE,
  KERNEL_VERSION,
  formatQualifiedName,
  isName,
  isNamespace,
  isVersion,
  isVersionConstraint,
  parseQualifiedName,
  satisfiesVersion,
} from "./identifiers.js";
import { validateNumericPolicy, type NumericPolicy } from "./numeric.js";

/** How two contributions to the same config field are combined during resolution. */
export type MergeStrategy = "replace" | "append" | "merge" | "reject";

/** Scalar types a family member may hold. */
export const VALUE_TYPES: readonly FamilyValueType[] = ["number", "boolean", "string"];
export type FamilyValueType = "number" | "boolean" | "string";

const MERGE_STRATEGIES: readonly MergeStrategy[] = ["replace", "append", "merge", "reject"];

/** Field-level views a domain validator may inspect; never the raw domain state. */
export interface DomainDefinitionView {
  readonly ref: string;
  readonly type: string;
  readonly namespace: string;
  readonly name: string;
  readonly isPublic: boolean;
  readonly values: Readonly<Record<string, unknown>>;
}

export interface DomainRuleView {
  readonly ref: string;
  readonly domain: string;
  readonly triggers: readonly string[];
  readonly targets: readonly string[];
}

export interface DomainValidationInput {
  readonly packNamespace: string;
  /** Resolved definitions whose config type belongs to this extension. */
  readonly definitions: readonly DomainDefinitionView[];
  /** Compiled rules that this extension owns. */
  readonly rules: readonly DomainRuleView[];
  /** Existence and type lookup only; the validator never sees foreign values. */
  readonly lookup: (ref: string) => { readonly type: string } | undefined;
  readonly report: (diagnostic: Diagnostic) => void;
}

/**
 * One member a config definition contributes to a family view and target.
 *
 * A member is addressed as `<id>` when `key` is empty and as `<id>.<key>` otherwise,
 * so a single definition may expose several independently readable and writable
 * values (a channel exposes both an availability flag and an efficiency number).
 */
export interface FamilyMemberDeclaration {
  /** Suffix after `<id>.`; empty means the member key is the definition id itself. */
  readonly key: string;
  /** Fixed member value type; omit when the definition's own `typeField` decides. */
  readonly valueType?: "number" | "boolean" | "string";
  /** Field naming the member type when `valueType` is absent. */
  readonly typeField?: string;
  /** Field holding the member's declared initial value. */
  readonly stateField: string;
  /** Field holding the member's unit; a member without one is dimensionless. */
  readonly unitField?: string;
  /** Field holding the member's optional numeric policy block. */
  readonly policyField?: string;
  /** Field holding the member's optional closed string vocabulary. */
  readonly allowedValuesField?: string;
  /** Contract members are core values: exactly one rule may write them. */
  readonly contract?: boolean;
}

/**
 * A per-definition value family: every definition of the config type adds members
 * to one readable view and one writable target ref (`<namespace>/<name>`).
 */
export interface FamilyDeclaration {
  readonly name: string;
  readonly members: readonly FamilyMemberDeclaration[];
  readonly view?: { readonly exposedTo: readonly string[] };
  readonly target?: { readonly exposedTo: readonly string[] };
}

export interface ConfigTypeDeclaration {
  readonly kind: string;
  /** Object schema of the resolved config value. */
  readonly fields: TSchema;
  /** Expands every definition of this type into view and target members. */
  readonly family?: FamilyDeclaration;
  /** Field defaults supplied by the shared infrastructure, never guessed. */
  readonly defaults?: Readonly<Record<string, unknown>>;
  /**
   * Fields whose values are identities of other definitions. The kernel checks
   * existence, visibility and target type before any domain sees them.
   */
  readonly references?: Readonly<Record<string, readonly string[]>>;
  /** Fields that an explicit pack override may target. */
  readonly overridable: readonly string[];
  /** Merge strategy per field; a duplicate field without an entry is rejected. */
  readonly merge: Readonly<Record<string, MergeStrategy>>;
  readonly validate?: (input: DomainValidationInput) => void;
}

export interface ViewDeclaration {
  readonly name: string;
  /** Object schema of the view value exposed to rules. */
  readonly fields: TSchema;
  /** Unit per numeric field path; required for every field a rule compares. */
  readonly units?: Readonly<Record<string, string>>;
  /** Extensions allowed to read this view; wildcards are not granted. */
  readonly exposedTo: readonly string[];
}

export interface OutputTargetDeclaration {
  readonly name: string;
  readonly valueType: "number" | "boolean" | "string";
  /** Optional numeric policy; without one the target accepts any finite number unnormalized. */
  readonly policy?: NumericPolicy;
  /** Optional closed vocabulary for string targets; without one any string is accepted. */
  readonly allowedValues?: readonly string[];
  readonly exposedTo: readonly string[];
}

export interface ProcessDeclaration {
  readonly name: string;
  readonly operations: readonly ("establish" | "advance" | "pause" | "end" | "cancel")[];
  readonly parameters: TSchema;
}

export interface DomainExtension {
  readonly name: string;
  readonly namespace: string;
  readonly version: string;
  /** Version constraint on the shared kernel this extension was written against. */
  readonly kernel: string;
  /** Peer extensions required at the same runtime config version. */
  readonly requires?: readonly string[];
  readonly configTypes: readonly ConfigTypeDeclaration[];
  readonly views: readonly ViewDeclaration[];
  readonly triggers: readonly string[];
  readonly outputTargets: readonly OutputTargetDeclaration[];
  readonly processes?: readonly ProcessDeclaration[];
  readonly validate?: (input: DomainValidationInput) => void;
}

export interface RegisteredExtension {
  readonly extension: DomainExtension;
  /** `<namespace>/extension`; the identity of the extension itself. */
  readonly ref: string;
  readonly fingerprint: string;
}

export type RegistrationStatus =
  "registered" | "identity-conflict" | "semantic-incompatible" | "unsupported-semantics" | "unauthorized-capability";

export interface RegistrationResult {
  readonly status: RegistrationStatus;
  readonly diagnostics: readonly Diagnostic[];
  readonly extension?: RegisteredExtension;
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
];

function schemaKind(schema: unknown): string | undefined {
  if (typeof schema !== "object" || schema === null) return undefined;
  const kind: unknown = Reflect.get(schema, "~kind");
  return typeof kind === "string" ? kind : undefined;
}

/** A contract value is read through one view and written through one target. */
function isViewTargetPair(left: string, right: string): boolean {
  return (left === "view" && right === "output target") || (left === "output target" && right === "view");
}

/** Scalar types a schema can hold; empty when it holds no scalar. */
function scalarKindsOf(schema: TSchema | undefined): readonly FamilyValueType[] {
  const kind = schemaKind(schema);
  if (kind === "Union") {
    const variants = (Reflect.get(schema as object, "anyOf") ?? []) as TSchema[];
    const kinds = new Set<FamilyValueType>();
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

/** Rejects arbitrary/unknown schema constructs so no extension widens the model. */
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
  if (kind === "Union") {
    const variants = (record.anyOf ?? []) as TSchema[];
    if (variants.length === 0) problems.push(`${path} must declare union variants`);
    variants.forEach((variant, index) => assertSupportedSchema(variant, `${path}|${index}`, problems));
  }
}

/**
 * Validates a value-family declaration: every member must name existing fields of
 * the config type with a compatible kind, so expansion can bind members to values
 * without ever reading an undeclared field.
 */
function familyProblems(
  declaration: ConfigTypeDeclaration,
  properties: Record<string, TSchema>,
  problems: string[],
  semantics: string[],
): void {
  const family = declaration.family;
  if (family === undefined) return;
  const where = `Config type ${declaration.kind} family ${family.name}`;
  if (!isName(family.name)) problems.push(`Family name is invalid: ${family.name}`);
  if (family.members.length === 0) problems.push(`${where} declares no member`);
  const memberKeys = new Set<string>();
  for (const member of family.members) {
    const label = `${where} member ${member.key === "" ? "<id>" : member.key}`;
    if (member.key !== "" && !isName(member.key)) problems.push(`Family member key is invalid: ${member.key}`);
    if (memberKeys.has(member.key)) problems.push(`${where} declares member ${member.key} twice`);
    memberKeys.add(member.key);
    if (member.valueType === undefined && member.typeField === undefined)
      problems.push(`${label} declares neither a value type nor a type field`);
    if (member.valueType !== undefined && member.typeField !== undefined)
      problems.push(`${label} declares both a value type and a type field`);
    if (member.valueType !== undefined && !VALUE_TYPES.includes(member.valueType))
      semantics.push(`${label} requests unsupported value type ${String(member.valueType)}`);
    const declaredTypes: string[] = [];
    if (member.typeField !== undefined) {
      const typeSchema = properties[member.typeField];
      if (typeSchema === undefined) problems.push(`${label} declares unknown type field ${member.typeField}`);
      else if (!scalarKindsOf(typeSchema).includes("string"))
        semantics.push(`${label} type field ${member.typeField} is not a string field`);
      else {
        for (const word of literalWords(typeSchema)) {
          declaredTypes.push(word);
          if (!VALUE_TYPES.includes(word as FamilyValueType))
            semantics.push(`${label} type field ${member.typeField} names unknown value type ${word}`);
        }
      }
    }
    const stateSchema = properties[member.stateField];
    if (stateSchema === undefined) problems.push(`${label} declares unknown state field ${member.stateField}`);
    else {
      const kinds = scalarKindsOf(stateSchema);
      if (member.valueType !== undefined) {
        if (kinds.length !== 1 || kinds[0] !== member.valueType)
          semantics.push(`${label} state field ${member.stateField} is not a ${member.valueType} field`);
      } else if (kinds.length === 0)
        semantics.push(`${label} state field ${member.stateField} cannot hold a scalar value`);
      else
        for (const declared of declaredTypes)
          if (!kinds.includes(declared as FamilyValueType))
            semantics.push(
              `${label} type field ${member.typeField} names ${declared} but the state field cannot hold it`,
            );
    }
    for (const [field, expected] of [
      [member.unitField, "String"],
      [member.policyField, "Object"],
      [member.allowedValuesField, "Array"],
    ] as const) {
      if (field === undefined) continue;
      if (!(field in properties)) problems.push(`${label} declares unknown field ${field}`);
      else if (schemaKind(properties[field]) !== expected)
        semantics.push(`${label} field ${field} is not a ${expected.toLowerCase()} field`);
    }
    if (member.allowedValuesField !== undefined) {
      const items = Reflect.get(properties[member.allowedValuesField] as object, "items") as TSchema | undefined;
      if (items !== undefined && schemaKind(items) !== "String")
        semantics.push(`${label} vocabulary field ${member.allowedValuesField} is not a string list`);
    }
  }
  for (const [exposure, exposedTo] of [
    ["view", family.view?.exposedTo],
    ["target", family.target?.exposedTo],
  ] as const) {
    if (exposedTo === undefined) continue;
    for (const reader of exposedTo) {
      if (reader === "*")
        problems.push(`${where} family ${exposure} requests wildcard exposure, which the kernel never grants`);
      else
        try {
          parseQualifiedName(reader, `family ${exposure}`);
        } catch (failure) {
          problems.push(failure instanceof Error ? failure.message : String(failure));
        }
    }
  }
}

/** Scalar type a schema holds, or `null` when the schema holds no scalar. */
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

export function configTypeRef(extension: RegisteredExtension, kind: string): string {
  return `${extension.extension.namespace}/${kind}`;
}

export function viewRef(extension: RegisteredExtension, name: string): string {
  return `${extension.extension.namespace}/${name}`;
}

export function targetRef(extension: RegisteredExtension, name: string): string {
  return `${extension.extension.namespace}/${name}`;
}

export function extensionRef(extension: DomainExtension): string {
  return `${extension.namespace}/extension`;
}

function registrationDiagnostics(extension: DomainExtension): {
  readonly status: RegistrationStatus;
  readonly diagnostics: readonly Diagnostic[];
} {
  const diagnostics: Diagnostic[] = [];
  const problems: string[] = [];
  const semantics: string[] = [];
  const capabilities: string[] = [];

  if (!isNamespace(extension.namespace)) problems.push(`Extension namespace is invalid: ${extension.namespace}`);
  if (!isName(extension.name)) problems.push(`Extension name is invalid: ${extension.name}`);
  if (!isVersion(extension.version)) problems.push(`Extension version is invalid: ${extension.version}`);
  if (!isVersionConstraint(extension.kernel))
    problems.push(`Kernel constraint is not a version range: ${extension.kernel}`);
  for (const requirement of extension.requires ?? []) {
    try {
      parseQualifiedName(requirement, "extension requirement");
    } catch (failure) {
      problems.push(failure instanceof Error ? failure.message : String(failure));
    }
  }

  for (const declaration of extension.configTypes) {
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
      else if (strategy === "merge" && schemaKind(fieldSchema) !== "Object")
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

  for (const view of extension.views) {
    if (!isName(view.name)) problems.push(`View name is invalid: ${view.name}`);
    assertSupportedSchema(view.fields, `view ${view.name}.fields`, semantics);
    for (const field of Object.keys(view.units ?? {}))
      if (!(field in schemaProperties(view.fields)))
        problems.push(`View ${view.name} declares a unit for unknown field ${field}`);
    for (const reader of view.exposedTo) {
      if (reader === "*")
        capabilities.push(`View ${view.name} requests wildcard exposure, which the kernel never grants`);
      else
        try {
          parseQualifiedName(reader, "view exposure");
        } catch (failure) {
          problems.push(failure instanceof Error ? failure.message : String(failure));
        }
    }
  }

  for (const target of extension.outputTargets) {
    if (!isName(target.name)) problems.push(`Output target name is invalid: ${target.name}`);
    if (!VALUE_TYPES.includes(target.valueType))
      capabilities.push(`Output target ${target.name} requests unsupported value type ${String(target.valueType)}`);
    if (target.policy !== undefined) {
      if (target.valueType !== "number")
        semantics.push(`Output target ${target.name} declares a numeric policy but holds ${target.valueType}`);
      semantics.push(...validateNumericPolicy(target.policy, `target ${target.name}.policy`));
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
        capabilities.push(`Output target ${target.name} requests wildcard exposure, which the kernel never grants`);
      else
        try {
          parseQualifiedName(writer, "target exposure");
        } catch (failure) {
          problems.push(failure instanceof Error ? failure.message : String(failure));
        }
    }
  }

  for (const trigger of extension.triggers) if (!isName(trigger)) problems.push(`Trigger name is invalid: ${trigger}`);

  for (const process of extension.processes ?? []) {
    if (!isName(process.name)) problems.push(`Process name is invalid: ${process.name}`);
    if (process.operations.length === 0) problems.push(`Process ${process.name} declares no operation`);
    if (schemaKind(process.parameters) !== "Object")
      semantics.push(`Process ${process.name}.parameters must be an object schema`);
    else assertSupportedSchema(process.parameters, `process ${process.name}.parameters`, semantics);
  }

  const seen = new Map<string, string>();
  const families = extension.configTypes
    .map((declaration) => declaration.family)
    .filter((family) => family !== undefined)
    .map(({ name }) => ({ name }));
  const categories: readonly (readonly [string, readonly { readonly name?: string; readonly kind?: string }[]])[] = [
    ["config type", extension.configTypes],
    ["family", families],
    ["view", extension.views],
    ["trigger", extension.triggers.map((name) => ({ name }))],
    ["output target", extension.outputTargets],
    ["process", (extension.processes ?? []).map((process) => ({ name: process.name }))],
  ];
  for (const [category, items] of categories) {
    for (const item of items) {
      const name = item.name ?? item.kind ?? "";
      const previous = seen.get(name);
      // A view and a target of the same name are the read side and the write side
      // of one contract value; every other reuse of a name stays forbidden.
      if (previous !== undefined && !isViewTargetPair(previous, category))
        problems.push(`Name ${name} is declared twice in ${extension.namespace} (${previous} and ${category})`);
      else seen.set(name, category);
    }
  }

  for (const problem of problems)
    diagnostics.push(error("structure", "structure-invalid", problem, { subject: extensionRef(extension) }));
  for (const semantic of semantics)
    diagnostics.push(error("compatibility", "unsupported-semantics", semantic, { subject: extensionRef(extension) }));
  if (!satisfiesVersion(KERNEL_VERSION, extension.kernel))
    diagnostics.push(
      error(
        "compatibility",
        "incompatible-extension",
        `Extension ${extensionRef(extension)} requires kernel ${extension.kernel}, kernel is ${KERNEL_VERSION}`,
        { subject: extensionRef(extension) },
      ),
    );
  for (const capability of capabilities)
    diagnostics.push(error("permission", "unauthorized-effect", capability, { subject: extensionRef(extension) }));

  if (problems.length > 0) return { status: "unsupported-semantics", diagnostics };
  if (semantics.length > 0) return { status: "unsupported-semantics", diagnostics };
  if (capabilities.length > 0) return { status: "unauthorized-capability", diagnostics };
  if (diagnostics.some((diagnostic) => diagnostic.code === "incompatible-extension"))
    return { status: "semantic-incompatible", diagnostics };
  return { status: "registered", diagnostics };
}

function fingerprintOf(extension: DomainExtension): string {
  return identityOf({
    namespace: extension.namespace,
    name: extension.name,
    version: extension.version,
    kernel: extension.kernel,
    requires: extension.requires ?? [],
    configTypes: extension.configTypes.map((declaration) => ({
      kind: declaration.kind,
      fields: declaration.fields,
      family: declaration.family ?? null,
      overridable: [...declaration.overridable],
      merge: declaration.merge,
      references: declaration.references ?? {},
    })),
    views: extension.views,
    triggers: extension.triggers,
    outputTargets: extension.outputTargets,
    processes: extension.processes ?? [],
  });
}

/**
 * Registry of domain extensions.
 *
 * Registration is content-addressed: re-registering the same declaration is a
 * no-op, registering different content under the same identity is an integrity
 * error. Cross-extension requirements are checked by `finalize`, so the outcome
 * never depends on the order modules happened to register themselves.
 */
export class ExtensionRegistry {
  private readonly byRef = new Map<string, RegisteredExtension>();

  register(extension: DomainExtension): RegistrationResult {
    const { status, diagnostics } = registrationDiagnostics(extension);
    if (status !== "registered") return { status, diagnostics };
    const ref = extensionRef(extension);
    const fingerprint = fingerprintOf(extension);
    const existing = this.byRef.get(ref);
    if (existing !== undefined) {
      if (existing.fingerprint === fingerprint) return { status: "registered", diagnostics, extension: existing };
      return {
        status: "identity-conflict",
        diagnostics: [
          error("compatibility", "identity-conflict", `Extension ${ref} is already registered with different content`, {
            subject: ref,
          }),
        ],
      };
    }
    const registered: RegisteredExtension = Object.freeze({
      extension: Object.freeze(extension),
      ref,
      fingerprint,
    });
    this.byRef.set(ref, registered);
    return { status: "registered", diagnostics, extension: registered };
  }

  /** Verifies peer requirements once every extension has been registered. */
  finalize(): readonly Diagnostic[] {
    const diagnostics: Diagnostic[] = [];
    for (const registered of this.sorted()) {
      const extension = registered.extension;
      const exposures: readonly (readonly [string, readonly string[]])[] = [
        ...extension.views.map((view) => [view.name, view.exposedTo] as const),
        ...extension.outputTargets.map((target) => [target.name, target.exposedTo] as const),
        ...extension.configTypes
          .filter((declaration) => declaration.family !== undefined)
          .flatMap((declaration) => {
            const family = declaration.family;
            if (family === undefined) return [];
            return [
              [`${family.name} view`, family.view?.exposedTo ?? []] as const,
              [`${family.name} target`, family.target?.exposedTo ?? []] as const,
            ];
          }),
      ];
      for (const [name, exposedTo] of exposures)
        for (const reader of exposedTo)
          if (this.byRef.get(reader) === undefined)
            diagnostics.push(
              warning(
                "permission",
                "unauthorized-read",
                `${name} of ${registered.ref} is exposed to ${reader}, which is not registered in this runtime; the grant stays inert until it is`,
              ),
            );
      for (const requirement of extension.requires ?? []) {
        const target = parseQualifiedName(requirement, "extension requirement");
        const found = this.byRef.get(formatQualifiedName({ namespace: target.namespace, name: target.name }));
        if (found === undefined) {
          diagnostics.push(
            error(
              "compatibility",
              "incompatible-extension",
              `Extension ${registered.ref} requires ${requirement}, which is not registered`,
              { subject: registered.ref },
            ),
          );
          continue;
        }
        if (target.version !== undefined && found.extension.version !== target.version)
          diagnostics.push(
            error(
              "compatibility",
              "incompatible-extension",
              `Extension ${registered.ref} requires ${requirement} but ${found.ref} is ${found.extension.version}`,
              { subject: registered.ref },
            ),
          );
        if (found.extension.version !== registered.extension.version)
          diagnostics.push(
            warning(
              "compatibility",
              "incompatible-extension",
              `Extension ${registered.ref} and ${found.ref} are not on the same version`,
            ),
          );
      }
    }
    return diagnostics;
  }

  /** Extensions in stable identity order; never load order. */
  sorted(): readonly RegisteredExtension[] {
    return [...this.byRef.values()].sort((left, right) => (left.ref < right.ref ? -1 : left.ref > right.ref ? 1 : 0));
  }

  get(ref: string): RegisteredExtension | undefined {
    return this.byRef.get(ref);
  }

  kernelVersion(): string {
    return KERNEL_VERSION;
  }

  kernelNamespace(): string {
    return KERNEL_NAMESPACE;
  }
}
