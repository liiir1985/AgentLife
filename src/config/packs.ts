import { error, type DiagnosticBag } from "./diagnostics.js";
import type { SourceDefinition, SourceDerivation, SourcePack, SourceRule } from "./source.js";

/**
 * The set of packs that participate in one runtime config: the root pack plus
 * the packs it explicitly depends on.
 *
 * Visibility is deliberately narrow: a definition is addressable from another
 * namespace only when the referencing pack declares that namespace as a
 * dependency *and* the target definition is explicitly public.
 */
export class PackSet {
  private readonly definitionsByRef = new Map<string, SourceDefinition>();
  private readonly rulesByRef = new Map<string, SourceRule>();
  private readonly derivationsByRef = new Map<string, SourceDerivation>();
  private readonly packByNamespace = new Map<string, SourcePack>();
  private readonly dependentsByNamespace = new Map<string, readonly string[]>();

  private constructor(readonly root: SourcePack) {}

  static build(root: SourcePack, dependencies: readonly SourcePack[], bag: DiagnosticBag): PackSet {
    const set = new PackSet(root);
    const packs = [root, ...dependencies];
    for (const pack of packs) {
      const namespace = pack.manifest.namespace;
      const existing = set.packByNamespace.get(namespace);
      if (existing !== undefined) {
        bag.add(
          error("structure", "structure-invalid", `Namespace ${namespace} is provided by more than one pack`, {
            subject: namespace,
          }),
        );
        continue;
      }
      set.packByNamespace.set(namespace, pack);
      set.dependentsByNamespace.set(namespace, pack.manifest.dependencies);
      for (const definition of pack.definitions) set.indexDefinition(definition, bag);
      for (const rule of pack.rules) set.indexRule(rule, bag);
      for (const derivation of pack.derivations) set.indexDerivation(derivation, bag);
    }
    for (const dependency of root.manifest.dependencies) {
      if (!set.packByNamespace.has(dependency))
        bag.add(
          error("reference", "unknown-reference", `Root pack declares dependency ${dependency}, which was not loaded`, {
            subject: root.manifest.namespace,
          }),
        );
    }
    return set;
  }

  private indexDefinition(definition: SourceDefinition, bag: DiagnosticBag): void {
    if (this.definitionsByRef.has(definition.ref)) {
      bag.add(
        error("structure", "identity-conflict", `Identity ${definition.ref} is declared more than once`, {
          subject: definition.ref,
        }),
      );
      return;
    }
    this.definitionsByRef.set(definition.ref, definition);
  }

  private indexRule(rule: SourceRule, bag: DiagnosticBag): void {
    if (this.definitionsByRef.has(rule.ref) || this.rulesByRef.has(rule.ref) || this.derivationsByRef.has(rule.ref)) {
      bag.add(
        error("structure", "identity-conflict", `Identity ${rule.ref} is declared more than once`, {
          subject: rule.ref,
        }),
      );
      return;
    }
    this.rulesByRef.set(rule.ref, rule);
  }

  private indexDerivation(derivation: SourceDerivation, bag: DiagnosticBag): void {
    if (
      this.definitionsByRef.has(derivation.ref) ||
      this.rulesByRef.has(derivation.ref) ||
      this.derivationsByRef.has(derivation.ref)
    ) {
      bag.add(
        error("structure", "identity-conflict", `Identity ${derivation.ref} is declared more than once`, {
          subject: derivation.ref,
        }),
      );
      return;
    }
    this.derivationsByRef.set(derivation.ref, derivation);
  }

  definition(ref: string): SourceDefinition | undefined {
    return this.definitionsByRef.get(ref);
  }

  rule(ref: string): SourceRule | undefined {
    return this.rulesByRef.get(ref);
  }

  derivation(ref: string): SourceDerivation | undefined {
    return this.derivationsByRef.get(ref);
  }

  definitions(): readonly SourceDefinition[] {
    return [...this.definitionsByRef.values()].sort((left, right) => (left.ref < right.ref ? -1 : 1));
  }

  rules(): readonly SourceRule[] {
    return [...this.rulesByRef.values()].sort((left, right) => (left.ref < right.ref ? -1 : 1));
  }

  derivations(): readonly SourceDerivation[] {
    return [...this.derivationsByRef.values()].sort((left, right) => (left.ref < right.ref ? -1 : 1));
  }

  pack(namespace: string): SourcePack | undefined {
    return this.packByNamespace.get(namespace);
  }

  namespaces(): readonly string[] {
    return [...this.packByNamespace.keys()].sort();
  }

  /**
   * Cross-namespace reference check. Returns a diagnostic when the target is
   * missing, not public, or declared by a namespace the reader never depended on.
   */
  checkVisibility(fromNamespace: string, ref: string): boolean {
    const definition = this.definitionsByRef.get(ref);
    const rule = this.rulesByRef.get(ref);
    const derivation = this.derivationsByRef.get(ref);
    if (definition === undefined && rule === undefined && derivation === undefined) return false;
    const targetNamespace = (definition ?? rule ?? derivation)?.namespace ?? "";
    if (targetNamespace === fromNamespace) return true;
    if (definition !== undefined && !definition.isPublic) return false;
    return (this.dependentsByNamespace.get(fromNamespace) ?? []).includes(targetNamespace);
  }

  /** Explains a visibility failure for diagnostics. */
  explainVisibility(fromNamespace: string, ref: string): string {
    const definition = this.definitionsByRef.get(ref);
    const targetNamespace = definition?.namespace ?? ref.split("/")[0] ?? "";
    if (definition !== undefined && !definition.isPublic) return `${ref} is not public in ${targetNamespace}`;
    return `${fromNamespace} does not declare a dependency on ${targetNamespace}`;
  }
}
