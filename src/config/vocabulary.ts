import { scalarKind, schemaProperties, type OutputTargetDeclaration, type RegisteredExtension } from "./extension.js";
import { parsePartialNumericPolicy } from "./source.js";
import { resolveNumericPolicy, validateNumericPolicy, type NumericPolicy } from "./numeric.js";
import { isName, parseQualifiedName } from "./identifiers.js";
import type { TSchema } from "typebox";

/**
 * The vocabulary of one runtime configuration: every readable member and every
 * writable target the compiled rules may name.
 *
 * Static views and targets are declared by extensions directly. Value families
 * are expanded from the definitions of the pack, so a domain never hard-codes the
 * names of the values it stores: the definition declares the value, the family
 * decides which members it contributes and how they are addressed.
 */
export type ValueType = "number" | "boolean" | "string";

export interface ValueMember {
  /** Member key inside its view: `<id>` or `<id>.<memberKey>`. */
  readonly key: string;
  readonly owner: string;
  readonly view: string;
  readonly target: string;
  readonly valueType: ValueType;
  readonly unit: string;
  /** Declared policy, or `null` when the member constrains nothing. */
  readonly policy: NumericPolicy | null;
  /** Closed vocabulary for string members; `null` means any string is accepted. */
  readonly allowedValues: readonly string[] | null;
  /** Contract members are core values: exactly one rule may write them. */
  readonly contract: boolean;
  /** Definition that contributed this member. */
  readonly definition: string;
}

export interface ViewScope {
  readonly ref: string;
  readonly owner: string;
  readonly exposedTo: readonly string[];
  readonly members: ReadonlyMap<string, ValueMember>;
  /** Declared schema of a static view; `null` for a value family. */
  readonly schema: TSchema | null;
}

interface MutableViewScope extends ViewScope {
  readonly members: Map<string, ValueMember>;
}

export interface TargetScope {
  readonly ref: string;
  readonly owner: string;
  readonly exposedTo: readonly string[];
  readonly valueType: ValueType;
  readonly unit: string;
  readonly policy: NumericPolicy | null;
  readonly allowedValues: readonly string[] | null;
  readonly contract: boolean;
}

export interface VocabularyProblem {
  readonly scope: "structure" | "compatibility";
  readonly message: string;
  readonly subject?: string;
}

/** Definition input to family expansion; `values` are the definition's declared fields. */
export interface VocabularyDefinition {
  readonly ref: string;
  readonly typeRef: string;
  readonly namespace: string;
  /** Definition id from the document itself; it names the member as well. */
  readonly name: string;
  readonly values: Readonly<Record<string, unknown>>;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asValueType(value: unknown): ValueType | undefined {
  return value === "number" || value === "boolean" || value === "string" ? value : undefined;
}

function asStringList(value: unknown): readonly string[] | undefined {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string")
    ? (value as readonly string[])
    : undefined;
}

function matchesType(value: unknown, type: ValueType): boolean {
  if (type === "number") return typeof value === "number" && Number.isFinite(value);
  if (type === "boolean") return typeof value === "boolean";
  return typeof value === "string";
}

export class ConfigVocabulary {
  private readonly views = new Map<string, MutableViewScope>();
  private readonly targets = new Map<string, TargetScope>();
  private readonly members = new Map<string, ValueMember>();
  /** Declared names of every extension, used to tell "unknown" from "wrong kind". */
  private readonly declared = new Map<string, string>();

  /** Category of a declared name; `undefined` means no extension declares it. */
  category(ref: string): string | undefined {
    return this.declared.get(ref);
  }

  constructor(
    private readonly extensions: readonly RegisteredExtension[],
    definitions: readonly VocabularyDefinition[],
    problems: VocabularyProblem[],
  ) {
    for (const registered of extensions) this.declareExtension(registered);
    for (const definition of definitions) this.expand(definition, problems);
  }

  view(ref: string): ViewScope | undefined {
    return this.views.get(ref);
  }

  target(ref: string): TargetScope | undefined {
    return this.targets.get(ref);
  }

  private declareExtension(registered: RegisteredExtension): void {
    const extension = registered.extension;
    for (const view of extension.views) {
      const ref = `${extension.namespace}/${view.name}`;
      this.declared.set(ref, "view");
      const members = new Map<string, ValueMember>();
      for (const [field, schema] of Object.entries(schemaProperties(view.fields))) {
        const valueType = scalarKind(schema);
        if (valueType === null) continue;
        members.set(field, {
          key: field,
          owner: registered.ref,
          view: ref,
          target: "",
          valueType,
          unit: valueType === "number" ? (view.units?.[field] ?? "") : "",
          policy: null,
          allowedValues: null,
          contract: false,
          definition: "",
        });
      }
      this.views.set(ref, {
        ref,
        owner: registered.ref,
        exposedTo: view.exposedTo,
        members,
        schema: view.fields,
      });
    }
    for (const target of extension.outputTargets) {
      const ref = `${extension.namespace}/${target.name}`;
      this.declared.set(ref, "output target");
      this.targets.set(ref, this.staticTarget(registered.ref, target));
    }
    for (const trigger of extension.triggers) this.declared.set(`${extension.namespace}/${trigger}`, "trigger");
    for (const process of extension.processes ?? [])
      this.declared.set(`${extension.namespace}/${process.name}`, "process");
    for (const declaration of extension.configTypes) {
      const typeRef = `${extension.namespace}/${declaration.kind}`;
      this.declared.set(typeRef, "config type");
      const family = declaration.family;
      if (family === undefined) continue;
      const ref = `${extension.namespace}/${family.name}`;
      this.declared.set(ref, "value family");
      if (family.view !== undefined && !this.views.has(ref))
        this.views.set(ref, {
          ref,
          owner: registered.ref,
          exposedTo: family.view.exposedTo,
          members: new Map(),
          schema: null,
        });
    }
  }

  private staticTarget(ownerRef: string, target: OutputTargetDeclaration): TargetScope {
    const policy = target.policy ?? null;
    const namespace = ownerRef.slice(0, ownerRef.indexOf("/"));
    return {
      ref: `${namespace}/${target.name}`,
      owner: ownerRef,
      exposedTo: target.exposedTo,
      valueType: target.valueType,
      unit: policy?.unit ?? "",
      policy,
      allowedValues: target.allowedValues ?? null,
      contract: true,
    };
  }

  /**
   * Expands one definition into its family members. Failures are reported instead
   * of thrown, so a single malformed definition never hides the rest of the pack.
   */
  private expand(definition: VocabularyDefinition, problems: VocabularyProblem[]): void {
    // The type ref carries the *extension* namespace, the definition carries the
    // pack namespace; a value family always belongs to its declaring extension.
    let owner: string;
    let kind: string;
    try {
      const parsed = parseQualifiedName(definition.typeRef, "config type");
      owner = parsed.namespace;
      kind = parsed.name;
    } catch {
      return;
    }
    const registered = this.extensions.find((candidate) => candidate.ref === `${owner}/extension`);
    const declaration = registered?.extension.configTypes.find((type) => type.kind === kind);
    const family = declaration?.family;
    if (registered === undefined || family === undefined) return;
    const familyRef = `${owner}/${family.name}`;
    const id = definition.name;
    if (id === "" || !isName(id)) {
      problems.push({
        scope: "structure",
        message: `Definition ${definition.ref} is named ${id}, which cannot address a value member`,
        subject: definition.ref,
      });
      return;
    }
    for (const member of family.members) {
      const key = member.key === "" ? id : `${id}.${member.key}`;
      const targetRef = `${familyRef}.${key}`;
      const valueType = member.valueType ?? asValueType(definition.values[member.typeField ?? ""]);
      if (valueType === undefined) {
        problems.push({
          scope: "structure",
          message: `Definition ${definition.ref} does not declare a known type for member ${key}`,
          subject: definition.ref,
        });
        continue;
      }
      const state = definition.values[member.stateField];
      if (!matchesType(state, valueType)) {
        problems.push({
          scope: "structure",
          message: `Definition ${definition.ref} member ${key} state is not a ${valueType}`,
          subject: definition.ref,
        });
        continue;
      }
      const unit = member.unitField === undefined ? "" : (asString(definition.values[member.unitField]) ?? "");
      const allowedValues =
        member.allowedValuesField === undefined
          ? undefined
          : asStringList(definition.values[member.allowedValuesField]);
      if (allowedValues !== undefined && !allowedValues.includes(state as string)) {
        problems.push({
          scope: "compatibility",
          message: `Definition ${definition.ref} member ${key} state ${String(state)} is outside its declared vocabulary`,
          subject: definition.ref,
        });
        continue;
      }
      let policy: NumericPolicy | null = null;
      if (valueType === "number") {
        const declared = member.policyField === undefined ? undefined : definition.values[member.policyField];
        try {
          policy =
            declared === undefined
              ? resolveNumericPolicy(unit === "" ? undefined : { unit })
              : resolveNumericPolicy(parsePartialNumericPolicy(declared, `${definition.ref}.policy`));
        } catch (failure) {
          problems.push({
            scope: "structure",
            message: failure instanceof Error ? failure.message : String(failure),
            subject: definition.ref,
          });
          continue;
        }
        if (policy !== null && policy.unit === "" && unit !== "") policy = { ...policy, unit };
        if (policy !== null)
          for (const problem of validateNumericPolicy(policy, `${definition.ref}.policy`))
            problems.push({ scope: "compatibility", message: problem, subject: definition.ref });
      }
      if (this.members.has(targetRef)) {
        problems.push({
          scope: "structure",
          message: `Definition ${definition.ref} redeclares value member ${targetRef}`,
          subject: definition.ref,
        });
        continue;
      }
      const expanded: ValueMember = {
        key,
        owner: registered.ref,
        view: familyRef,
        target: targetRef,
        valueType,
        unit: policy?.unit ?? unit,
        policy,
        allowedValues: valueType === "string" ? (allowedValues ?? null) : null,
        contract: member.contract === true,
        definition: definition.ref,
      };
      this.members.set(targetRef, expanded);
      this.declared.set(targetRef, "value member");
      this.views.get(familyRef)?.members.set(key, expanded);
      const familyTarget = family.target;
      if (familyTarget !== undefined)
        this.targets.set(targetRef, {
          ref: targetRef,
          owner: registered.ref,
          exposedTo: familyTarget.exposedTo,
          valueType,
          unit: expanded.unit,
          policy,
          allowedValues: expanded.allowedValues,
          contract: expanded.contract,
        });
    }
  }
}
