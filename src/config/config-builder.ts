import { deepFreeze, hashId } from "./canonical.js";
import { conditionFormulas, conditionInputs, type Condition } from "./conditions.js";
import type { SystemIndex } from "./system-index.js";
import type { LoadedSystem } from "./system-spec.js";
import { KERNEL_VERSION } from "./identifiers.js";
import type { CombineMode, NumberPolicy } from "./numeric.js";
import type { MergedItem } from "./config-merge.js";
import type { ParsedPack } from "./source.js";
import { formulaRefs, inputNames, type ValueExpr } from "./value-expr.js";
import type { CheckedFormula, CheckedChange, CheckedInput, CheckedRule, CheckedConfig } from "./config-checker.js";

/**
 * Compilation: validated declarations become one immutable runtime artifact.
 *
 * The artifact fixes references and types, builds the trigger index, the stable
 * evaluation order, the read and output sets and the combine plan for every
 * output stateRef. Its identity is content-addressed over the compiled plan, so
 * two runtime configs that differ in any observable way get different versions
 * and the same content always gets the same version.
 */

export interface RuntimeRule {
  readonly ref: string;
  readonly system: string;
  readonly triggers: readonly string[];
  readonly inputs: readonly CheckedInput[];
  /** Reads the rule actually resolves, in declaration order. */
  readonly usedInputs: readonly CheckedInput[];
  readonly condition: Condition;
  readonly changes: readonly CheckedChange[];
  readonly dependsOn: readonly string[];
  readonly order: number;
}

export interface RuntimeFormula {
  readonly ref: string;
  readonly system: string;
  readonly inputs: readonly CheckedInput[];
  readonly usedInputs: readonly CheckedInput[];
  readonly outputUnit: string;
  readonly value: ValueExpr;
  readonly order: number;
}

export interface CombinePlan {
  readonly stateRef: string;
  readonly system: string;
  readonly combine: CombineMode;
  readonly valueType: "number" | "boolean" | "string";
  readonly policy: NumberPolicy | null;
  /** Closed vocabulary of a string stateRef; `null` when any string is accepted. */
  readonly allowedValues: readonly string[] | null;
  readonly sourceRules: readonly string[];
}

export interface PackInfo {
  readonly namespace: string;
  readonly version: string;
  readonly kernel: string;
  /** Content identity of the pack bytes that produced this runtime config. */
  readonly contentId: string;
}

export interface RuntimeConfig {
  readonly configId: string;
  readonly kernelVersion: string;
  readonly systems: readonly { readonly systemId: string; readonly version: string; readonly specHash: string }[];
  readonly packs: readonly PackInfo[];
  readonly items: readonly MergedItem[];
  readonly rules: readonly RuntimeRule[];
  readonly formulas: readonly RuntimeFormula[];
  /** Trigger to selected rules, in stable order. */
  readonly triggerIndex: Readonly<Record<string, readonly string[]>>;
  readonly combinePlans: Readonly<Record<string, CombinePlan>>;
  /** The exact content that can rebuild this artifact after a restore. */
  readonly sourceData: unknown;
}

function usedInputs(inputs: readonly CheckedInput[], aliases: ReadonlySet<string>): readonly CheckedInput[] {
  return inputs.filter((read) => aliases.has(read.name));
}

function ruleInputs(rule: CheckedRule): Set<string> {
  const aliases = new Set<string>(conditionInputs(rule.condition));
  for (const change of rule.changes) {
    const sources = change.kind === "process" ? change.params.map((parameter) => parameter.value) : [change.value];
    for (const source of sources) for (const name of inputNames(source)) aliases.add(name);
  }
  return aliases;
}

function formulaInputs(formula: CheckedFormula): Set<string> {
  return new Set(inputNames(formula.value));
}

function dependencyRefs(rule: CheckedRule): readonly string[] {
  const refs = new Set<string>(rule.dependsOn);
  for (const ref of conditionFormulas(rule.condition)) refs.add(ref);
  for (const change of rule.changes) {
    const sources = change.kind === "process" ? change.params.map((parameter) => parameter.value) : [change.value];
    for (const source of sources) for (const ref of formulaRefs(source)) refs.add(ref);
  }
  return [...refs].sort();
}

/** Source text kept with the artifact so a restore can rebuild the same plan. */
function sourceDataOf(validation: CheckedConfig, systemIndex: SystemIndex): unknown {
  const packs = validation.packs.namespaces().map((namespace) => validation.packs.pack(namespace));
  return {
    kernelVersion: KERNEL_VERSION,
    systems: systemIndex.systemsSorted().map((system) => ({
      systemId: system.systemId,
      version: system.spec.version,
      specHash: system.specHash,
    })),
    packs: packs
      .filter((pack): pack is ParsedPack => pack !== undefined)
      .map((pack) => ({
        namespace: pack.manifest.namespace,
        root: pack === validation.packs.root,
        manifest: pack.manifest,
        contentId: pack.contentId,
        items: pack.items,
        rules: pack.rules,
        formulas: pack.formulas,
      })),
  };
}

export function buildConfig(validation: CheckedConfig): RuntimeConfig {
  const { packs, systemIndex } = validation;

  const runtimeRules: RuntimeRule[] = validation.rules.map((rule, order) => {
    const aliases = ruleInputs(rule);
    return {
      ref: rule.ref,
      system: rule.system,
      triggers: [...rule.triggers].sort(),
      inputs: rule.inputs,
      usedInputs: usedInputs(rule.inputs, aliases),
      condition: rule.condition,
      changes: rule.changes,
      dependsOn: dependencyRefs(rule),
      order,
    };
  });

  const runtimeFormulas: RuntimeFormula[] = validation.formulas.map((formula, order) => ({
    ref: formula.ref,
    system: formula.system,
    inputs: formula.inputs,
    usedInputs: usedInputs(formula.inputs, formulaInputs(formula)),
    outputUnit: formula.outputUnit,
    value: formula.value,
    order,
  }));

  const triggerIndex: Record<string, string[]> = {};
  for (const rule of runtimeRules) {
    for (const trigger of rule.triggers) {
      const bucket = triggerIndex[trigger];
      if (bucket === undefined) triggerIndex[trigger] = [rule.ref];
      else bucket.push(rule.ref);
    }
  }

  const combinePlans: Record<string, CombinePlan> = {};
  for (const rule of runtimeRules) {
    for (const change of rule.changes) {
      if (change.kind !== "state") continue;
      const stateRef = validation.catalog.output(change.stateRef);
      const existing = combinePlans[change.stateRef];
      if (existing === undefined) {
        combinePlans[change.stateRef] = {
          stateRef: change.stateRef,
          system: change.system,
          combine: change.combine,
          valueType: stateRef?.valueType ?? "number",
          policy: stateRef?.policy ?? null,
          allowedValues: stateRef?.allowedValues ?? null,
          sourceRules: [rule.ref],
        };
        continue;
      }
      combinePlans[change.stateRef] = { ...existing, sourceRules: [...existing.sourceRules, rule.ref] };
    }
  }

  const systems: readonly { systemId: string; version: string; specHash: string }[] = systemIndex
    .systemsSorted()
    .map((system: LoadedSystem) => ({
      systemId: system.systemId,
      version: system.spec.version,
      specHash: system.specHash,
    }));

  const packs_: readonly PackInfo[] = packs
    .namespaces()
    .map((namespace) => packs.pack(namespace))
    .filter((pack): pack is ParsedPack => pack !== undefined)
    .map((pack) => ({
      namespace: pack.manifest.namespace,
      version: pack.manifest.version,
      kernel: pack.manifest.kernel,
      contentId: pack.contentId,
    }));

  const planDocument = {
    kernelVersion: KERNEL_VERSION,
    systems,
    packs: packs_,
    items: validation.items.map((item) => ({
      ref: item.ref,
      type: item.typeRef,
      isPublic: item.isPublic,
      values: item.values,
      fields: Object.fromEntries(
        Object.entries(item.fields).map(([field, resolved]) => [
          field,
          { merge: resolved.merge, ruleValues: resolved.ruleValues },
        ]),
      ),
    })),
    rules: runtimeRules,
    formulas: runtimeFormulas,
    triggerIndex,
    combinePlans,
  };

  return deepFreeze({
    configId: hashId(planDocument),
    kernelVersion: KERNEL_VERSION,
    systems,
    packs: packs_,
    items: validation.items,
    rules: runtimeRules,
    formulas: runtimeFormulas,
    triggerIndex,
    combinePlans,
    sourceData: sourceDataOf(validation, systemIndex),
  });
}
