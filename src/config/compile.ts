import { deepFreeze, identityOf } from "./canonical.js";
import { conditionDerivations, conditionReads, type Condition } from "./conditions.js";
import type { ExtensionCapabilities } from "./capabilities.js";
import type { RegisteredExtension } from "./extension.js";
import { KERNEL_VERSION } from "./identifiers.js";
import type { CompositionKind, NumericPolicy } from "./numeric.js";
import type { ResolvedDefinition } from "./resolve.js";
import type { SourcePack } from "./source.js";
import { valueDerivations, valueReads, type ValueSource } from "./values.js";
import type { BoundDerivation, BoundEffect, BoundRead, BoundRule, ValidatedConfiguration } from "./validate.js";

/**
 * Compilation: validated declarations become one immutable runtime artifact.
 *
 * The artifact fixes references and types, builds the trigger index, the stable
 * evaluation order, the read and output sets and the composition plan for every
 * output target. Its identity is content-addressed over the compiled plan, so
 * two runtime configs that differ in any observable way get different versions
 * and the same content always gets the same version.
 */

export interface CompiledRule {
  readonly ref: string;
  readonly domain: string;
  readonly triggers: readonly string[];
  readonly reads: readonly BoundRead[];
  /** Reads the rule actually resolves, in declaration order. */
  readonly usedReads: readonly BoundRead[];
  readonly condition: Condition;
  readonly effects: readonly BoundEffect[];
  readonly dependsOn: readonly string[];
  readonly order: number;
}

export interface CompiledDerivation {
  readonly ref: string;
  readonly domain: string;
  readonly reads: readonly BoundRead[];
  readonly usedReads: readonly BoundRead[];
  readonly outputUnit: string;
  readonly value: ValueSource;
  readonly order: number;
}

export interface CompositionPlan {
  readonly target: string;
  readonly owner: string;
  readonly composition: CompositionKind;
  readonly valueType: "number" | "boolean" | "string";
  readonly policy: NumericPolicy | null;
  /** Closed vocabulary of a string target; `null` when any string is accepted. */
  readonly allowedValues: readonly string[] | null;
  readonly contributors: readonly string[];
}

export interface PackIdentity {
  readonly namespace: string;
  readonly version: string;
  readonly kernel: string;
  /** Content identity of the pack bytes that produced this runtime config. */
  readonly contentIdentity: string;
}

export interface CompiledRuntimeConfig {
  readonly identity: string;
  readonly kernelVersion: string;
  readonly extensions: readonly { readonly ref: string; readonly version: string; readonly fingerprint: string }[];
  readonly packs: readonly PackIdentity[];
  readonly definitions: readonly ResolvedDefinition[];
  readonly rules: readonly CompiledRule[];
  readonly derivations: readonly CompiledDerivation[];
  /** Trigger to the rules it makes candidates, in stable order. */
  readonly triggerIndex: Readonly<Record<string, readonly string[]>>;
  readonly compositionPlans: Readonly<Record<string, CompositionPlan>>;
  /** The exact content that can rebuild this artifact after a restore. */
  readonly sourceDocument: unknown;
}

function usedReads(reads: readonly BoundRead[], aliases: ReadonlySet<string>): readonly BoundRead[] {
  return reads.filter((read) => aliases.has(read.alias));
}

function ruleAliases(rule: BoundRule): Set<string> {
  const aliases = new Set<string>(conditionReads(rule.condition));
  for (const effect of rule.effects) {
    const sources = effect.kind === "process" ? effect.parameters.map((parameter) => parameter.value) : [effect.value];
    for (const source of sources) for (const alias of valueReads(source)) aliases.add(alias);
  }
  return aliases;
}

function derivationAliases(derivation: BoundDerivation): Set<string> {
  return new Set(valueReads(derivation.value));
}

function dependencyRefs(rule: BoundRule): readonly string[] {
  const refs = new Set<string>(rule.dependsOn);
  for (const ref of conditionDerivations(rule.condition)) refs.add(ref);
  for (const effect of rule.effects) {
    const sources = effect.kind === "process" ? effect.parameters.map((parameter) => parameter.value) : [effect.value];
    for (const source of sources) for (const ref of valueDerivations(source)) refs.add(ref);
  }
  return [...refs].sort();
}

/** Source text kept with the artifact so a restore can rebuild the same plan. */
function sourceDocumentOf(validation: ValidatedConfiguration, capabilities: ExtensionCapabilities): unknown {
  const packs = validation.packs.namespaces().map((namespace) => validation.packs.pack(namespace));
  return {
    kernelVersion: KERNEL_VERSION,
    extensions: capabilities.extensionsSorted().map((extension) => ({
      ref: extension.ref,
      version: extension.extension.version,
      fingerprint: extension.fingerprint,
    })),
    packs: packs
      .filter((pack): pack is SourcePack => pack !== undefined)
      .map((pack) => ({
        namespace: pack.manifest.namespace,
        root: pack === validation.packs.root,
        manifest: pack.manifest,
        identity: pack.identity,
        definitions: pack.definitions,
        rules: pack.rules,
        derivations: pack.derivations,
      })),
  };
}

export function compileConfiguration(validation: ValidatedConfiguration): CompiledRuntimeConfig {
  const { packs, capabilities } = validation;

  const compiledRules: CompiledRule[] = validation.rules.map((rule, order) => {
    const aliases = ruleAliases(rule);
    return {
      ref: rule.ref,
      domain: rule.domain,
      triggers: [...rule.triggers].sort(),
      reads: rule.reads,
      usedReads: usedReads(rule.reads, aliases),
      condition: rule.condition,
      effects: rule.effects,
      dependsOn: dependencyRefs(rule),
      order,
    };
  });

  const compiledDerivations: CompiledDerivation[] = validation.derivations.map((derivation, order) => ({
    ref: derivation.ref,
    domain: derivation.domain,
    reads: derivation.reads,
    usedReads: usedReads(derivation.reads, derivationAliases(derivation)),
    outputUnit: derivation.outputUnit,
    value: derivation.value,
    order,
  }));

  const triggerIndex: Record<string, string[]> = {};
  for (const rule of compiledRules) {
    for (const trigger of rule.triggers) {
      const bucket = triggerIndex[trigger];
      if (bucket === undefined) triggerIndex[trigger] = [rule.ref];
      else bucket.push(rule.ref);
    }
  }

  const compositionPlans: Record<string, CompositionPlan> = {};
  for (const rule of compiledRules) {
    for (const effect of rule.effects) {
      if (effect.kind !== "target") continue;
      const target = validation.vocabulary.target(effect.target);
      const existing = compositionPlans[effect.target];
      if (existing === undefined) {
        compositionPlans[effect.target] = {
          target: effect.target,
          owner: effect.owner,
          composition: effect.composition,
          valueType: target?.valueType ?? "number",
          policy: target?.policy ?? null,
          allowedValues: target?.allowedValues ?? null,
          contributors: [rule.ref],
        };
        continue;
      }
      compositionPlans[effect.target] = { ...existing, contributors: [...existing.contributors, rule.ref] };
    }
  }

  const extensions: readonly { ref: string; version: string; fingerprint: string }[] = capabilities
    .extensionsSorted()
    .map((extension: RegisteredExtension) => ({
      ref: extension.ref,
      version: extension.extension.version,
      fingerprint: extension.fingerprint,
    }));

  const packs_: readonly PackIdentity[] = packs
    .namespaces()
    .map((namespace) => packs.pack(namespace))
    .filter((pack): pack is SourcePack => pack !== undefined)
    .map((pack) => ({
      namespace: pack.manifest.namespace,
      version: pack.manifest.version,
      kernel: pack.manifest.kernel,
      contentIdentity: pack.identity,
    }));

  const planDocument = {
    kernelVersion: KERNEL_VERSION,
    extensions,
    packs: packs_,
    definitions: validation.definitions.map((definition) => ({
      ref: definition.ref,
      type: definition.typeRef,
      isPublic: definition.isPublic,
      values: definition.values,
      fields: Object.fromEntries(
        Object.entries(definition.fields).map(([field, resolved]) => [
          field,
          { merge: resolved.merge, contributions: resolved.contributions },
        ]),
      ),
    })),
    rules: compiledRules,
    derivations: compiledDerivations,
    triggerIndex,
    compositionPlans,
  };

  return deepFreeze({
    identity: identityOf(planDocument),
    kernelVersion: KERNEL_VERSION,
    extensions,
    packs: packs_,
    definitions: validation.definitions,
    rules: compiledRules,
    derivations: compiledDerivations,
    triggerIndex,
    compositionPlans,
    sourceDocument: sourceDocumentOf(validation, capabilities),
  });
}
