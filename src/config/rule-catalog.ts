import { scalarKind, schemaProperties, type OutputSpec, type LoadedSystem } from "./system-spec.js";
import { parsePartialNumberPolicy } from "./source.js";
import { resolveNumberPolicy, checkNumberPolicy, type NumberPolicy } from "./numeric.js";
import { isName, parseQualifiedName } from "./identifiers.js";
import type { TSchema } from "typebox";

/**
 * The vocabulary of one runtime configuration: every readable field and every
 * writable state output the runtime rules may name.
 *
 * Static inputs and targets are declared by systems directly. Value families
 * are expanded from the items of the pack, so a system never hard-codes the
 * names of the values it stores: the item declares the value, the valueSet
 * decides which fields it contributes and how they are addressed.
 */
export type ValueType = "number" | "boolean" | "string";

export interface ValueMember {
  /** Member key inside its input: `<id>` or `<id>.<memberKey>`. */
  readonly key: string;
  readonly system: string;
  readonly input: string;
  readonly stateRef: string;
  readonly valueType: ValueType;
  readonly unit: string;
  /** Declared policy, or `null` when the field constrains nothing. */
  readonly policy: NumberPolicy | null;
  /** Closed vocabulary for string fields; `null` means any string is accepted. */
  readonly allowedValues: readonly string[] | null;
  /** Contract fields are core values: exactly one rule may write them. */
  readonly contract: boolean;
  /** Definition that contributed this field. */
  readonly itemRef: string;
}

export interface InputInfo {
  readonly ref: string;
  readonly system: string;
  readonly exposedTo: readonly string[];
  readonly fields: ReadonlyMap<string, ValueMember>;
  /** Declared schema of a static input; `null` for a value valueSet. */
  readonly schema: TSchema | null;
}

interface MutableViewScope extends InputInfo {
  readonly fields: Map<string, ValueMember>;
}

export interface OutputInfo {
  readonly ref: string;
  readonly system: string;
  readonly exposedTo: readonly string[];
  readonly valueType: ValueType;
  readonly unit: string;
  readonly policy: NumberPolicy | null;
  readonly allowedValues: readonly string[] | null;
  readonly contract: boolean;
}

export interface CatalogIssue {
  readonly scope: "structure" | "compatibility";
  readonly message: string;
  readonly subject?: string;
}

/** Definition input to valueSet expansion; `values` are the item's declared fields. */
export interface RuleItem {
  readonly ref: string;
  readonly typeRef: string;
  readonly namespace: string;
  /** Definition id from the document itself; it names the field as well. */
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

export class RuleCatalog {
  private readonly inputs = new Map<string, MutableViewScope>();
  private readonly outputs = new Map<string, OutputInfo>();
  private readonly fields = new Map<string, ValueMember>();
  /** Declared names of every system, used to tell "unknown" from "wrong kind". */
  private readonly declared = new Map<string, string>();

  /** Category of a declared name; `undefined` means no system declares it. */
  category(ref: string): string | undefined {
    return this.declared.get(ref);
  }

  constructor(
    private readonly systems: readonly LoadedSystem[],
    items: readonly RuleItem[],
    problems: CatalogIssue[],
  ) {
    for (const registered of systems) this.declareSystem(registered);
    for (const item of items) this.expand(item, problems);
  }

  input(ref: string): InputInfo | undefined {
    return this.inputs.get(ref);
  }

  output(ref: string): OutputInfo | undefined {
    return this.outputs.get(ref);
  }

  private declareSystem(registered: LoadedSystem): void {
    const system = registered.spec;
    for (const input of system.inputs) {
      const ref = `${system.namespace}/${input.name}`;
      this.declared.set(ref, "input");
      const fields = new Map<string, ValueMember>();
      for (const [field, schema] of Object.entries(schemaProperties(input.fields))) {
        const valueType = scalarKind(schema);
        if (valueType === null) continue;
        fields.set(field, {
          key: field,
          system: registered.systemId,
          input: ref,
          stateRef: "",
          valueType,
          unit: valueType === "number" ? (input.units?.[field] ?? "") : "",
          policy: null,
          allowedValues: null,
          contract: false,
          itemRef: "",
        });
      }
      this.inputs.set(ref, {
        ref,
        system: registered.systemId,
        exposedTo: input.exposedTo,
        fields,
        schema: input.fields,
      });
    }
    for (const target of system.outputs) {
      const ref = `${system.namespace}/${target.name}`;
      this.declared.set(ref, "output target");
      this.outputs.set(ref, this.staticTarget(registered.systemId, target));
    }
    for (const trigger of system.triggers) this.declared.set(`${system.namespace}/${trigger}`, "trigger");
    for (const process of system.processes ?? []) this.declared.set(`${system.namespace}/${process.name}`, "process");
    for (const declaration of system.items) {
      const typeRef = `${system.namespace}/${declaration.kind}`;
      this.declared.set(typeRef, "config type");
      const valueSet = declaration.valueSet;
      if (valueSet === undefined) continue;
      const ref = `${system.namespace}/${valueSet.name}`;
      this.declared.set(ref, "value valueSet");
      if (valueSet.input !== undefined && !this.inputs.has(ref))
        this.inputs.set(ref, {
          ref,
          system: registered.systemId,
          exposedTo: valueSet.input.exposedTo,
          fields: new Map(),
          schema: null,
        });
    }
  }

  private staticTarget(ownerRef: string, target: OutputSpec): OutputInfo {
    const policy = target.policy ?? null;
    const namespace = ownerRef.slice(0, ownerRef.indexOf("/"));
    return {
      ref: `${namespace}/${target.name}`,
      system: ownerRef,
      exposedTo: target.exposedTo,
      valueType: target.valueType,
      unit: policy?.unit ?? "",
      policy,
      allowedValues: target.allowedValues ?? null,
      contract: true,
    };
  }

  /**
   * Expands one item into its valueSet fields. Failures are reported instead
   * of thrown, so a single malformed item never hides the rest of the pack.
   */
  private expand(item: RuleItem, problems: CatalogIssue[]): void {
    // The type ref carries the *system* namespace, the item carries the
    // pack namespace; a value valueSet always belongs to its declaring system.
    let owner: string;
    let kind: string;
    try {
      const parsed = parseQualifiedName(item.typeRef, "config type");
      owner = parsed.namespace;
      kind = parsed.name;
    } catch {
      return;
    }
    const registered = this.systems.find((candidate) => candidate.systemId === owner);
    const declaration = registered?.spec.items.find((type) => type.kind === kind);
    const valueSet = declaration?.valueSet;
    if (registered === undefined || valueSet === undefined) return;
    const familyRef = `${owner}/${valueSet.name}`;
    const id = item.name;
    if (id === "" || !isName(id)) {
      problems.push({
        scope: "structure",
        message: `Definition ${item.ref} is named ${id}, which cannot address a value field`,
        subject: item.ref,
      });
      return;
    }
    for (const field of valueSet.fields) {
      const key = field.key === "" ? id : `${id}.${field.key}`;
      const outputRef = `${familyRef}.${key}`;
      const valueType = field.valueType ?? asValueType(item.values[field.typeField ?? ""]);
      if (valueType === undefined) {
        problems.push({
          scope: "structure",
          message: `Definition ${item.ref} does not declare a known type for field ${key}`,
          subject: item.ref,
        });
        continue;
      }
      const state = item.values[field.stateField];
      if (!matchesType(state, valueType)) {
        problems.push({
          scope: "structure",
          message: `Definition ${item.ref} field ${key} state is not a ${valueType}`,
          subject: item.ref,
        });
        continue;
      }
      const unit = field.unitField === undefined ? "" : (asString(item.values[field.unitField]) ?? "");
      const allowedValues =
        field.allowedValuesField === undefined ? undefined : asStringList(item.values[field.allowedValuesField]);
      if (allowedValues !== undefined && !allowedValues.includes(state as string)) {
        problems.push({
          scope: "compatibility",
          message: `Definition ${item.ref} field ${key} state ${String(state)} is outside its declared vocabulary`,
          subject: item.ref,
        });
        continue;
      }
      let policy: NumberPolicy | null = null;
      if (valueType === "number") {
        const declared = field.policyField === undefined ? undefined : item.values[field.policyField];
        try {
          policy =
            declared === undefined
              ? resolveNumberPolicy(unit === "" ? undefined : { unit })
              : resolveNumberPolicy(parsePartialNumberPolicy(declared, `${item.ref}.policy`));
        } catch (failure) {
          problems.push({
            scope: "structure",
            message: failure instanceof Error ? failure.message : String(failure),
            subject: item.ref,
          });
          continue;
        }
        if (policy !== null && policy.unit === "" && unit !== "") policy = { ...policy, unit };
        if (policy !== null)
          for (const problem of checkNumberPolicy(policy, `${item.ref}.policy`))
            problems.push({ scope: "compatibility", message: problem, subject: item.ref });
      }
      if (this.fields.has(outputRef)) {
        problems.push({
          scope: "structure",
          message: `Definition ${item.ref} redeclares value field ${outputRef}`,
          subject: item.ref,
        });
        continue;
      }
      const expanded: ValueMember = {
        key,
        system: registered.systemId,
        input: familyRef,
        stateRef: outputRef,
        valueType,
        unit: policy?.unit ?? unit,
        policy,
        allowedValues: valueType === "string" ? (allowedValues ?? null) : null,
        contract: field.contract === true,
        itemRef: item.ref,
      };
      this.fields.set(outputRef, expanded);
      this.declared.set(outputRef, "value field");
      this.inputs.get(familyRef)?.fields.set(key, expanded);
      const familyOutput = valueSet.output;
      if (familyOutput !== undefined)
        this.outputs.set(outputRef, {
          ref: outputRef,
          system: registered.systemId,
          exposedTo: familyOutput.exposedTo,
          valueType,
          unit: expanded.unit,
          policy,
          allowedValues: expanded.allowedValues,
          contract: expanded.contract,
        });
    }
  }
}
