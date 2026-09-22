import { error, type IssueList } from "./diagnostics.js";
import type { ParsedItem, ParsedFormula, ParsedPack, ParsedRule } from "./source.js";

/**
 * The set of packs that participate in one runtime config: the root pack plus
 * the packs it explicitly depends on.
 *
 * Visibility is deliberately narrow: a item is addressable from another
 * namespace only when the referencing pack declares that namespace as a
 * dependency *and* the target item is explicitly public.
 */
export class PackSet {
  private readonly definitionsByRef = new Map<string, ParsedItem>();
  private readonly rulesByRef = new Map<string, ParsedRule>();
  private readonly derivationsByRef = new Map<string, ParsedFormula>();
  private readonly packByNamespace = new Map<string, ParsedPack>();
  private readonly dependentsByNamespace = new Map<string, readonly string[]>();

  private constructor(readonly root: ParsedPack) {}

  static build(root: ParsedPack, dependencies: readonly ParsedPack[], bag: IssueList): PackSet {
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
      for (const item of pack.items) set.indexDefinition(item, bag);
      for (const rule of pack.rules) set.indexRule(rule, bag);
      for (const formula of pack.formulas) set.indexFormula(formula, bag);
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

  private indexDefinition(item: ParsedItem, bag: IssueList): void {
    if (this.definitionsByRef.has(item.ref)) {
      bag.add(
        error("structure", "identity-conflict", `Identity ${item.ref} is declared more than once`, {
          subject: item.ref,
        }),
      );
      return;
    }
    this.definitionsByRef.set(item.ref, item);
  }

  private indexRule(rule: ParsedRule, bag: IssueList): void {
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

  private indexFormula(formula: ParsedFormula, bag: IssueList): void {
    if (
      this.definitionsByRef.has(formula.ref) ||
      this.rulesByRef.has(formula.ref) ||
      this.derivationsByRef.has(formula.ref)
    ) {
      bag.add(
        error("structure", "identity-conflict", `Identity ${formula.ref} is declared more than once`, {
          subject: formula.ref,
        }),
      );
      return;
    }
    this.derivationsByRef.set(formula.ref, formula);
  }

  item(ref: string): ParsedItem | undefined {
    return this.definitionsByRef.get(ref);
  }

  rule(ref: string): ParsedRule | undefined {
    return this.rulesByRef.get(ref);
  }

  formula(ref: string): ParsedFormula | undefined {
    return this.derivationsByRef.get(ref);
  }

  items(): readonly ParsedItem[] {
    return [...this.definitionsByRef.values()].sort((left, right) => (left.ref < right.ref ? -1 : 1));
  }

  rules(): readonly ParsedRule[] {
    return [...this.rulesByRef.values()].sort((left, right) => (left.ref < right.ref ? -1 : 1));
  }

  formulas(): readonly ParsedFormula[] {
    return [...this.derivationsByRef.values()].sort((left, right) => (left.ref < right.ref ? -1 : 1));
  }

  pack(namespace: string): ParsedPack | undefined {
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
    const item = this.definitionsByRef.get(ref);
    const rule = this.rulesByRef.get(ref);
    const formula = this.derivationsByRef.get(ref);
    if (item === undefined && rule === undefined && formula === undefined) return false;
    const targetNamespace = (item ?? rule ?? formula)?.namespace ?? "";
    if (targetNamespace === fromNamespace) return true;
    if (item !== undefined && !item.isPublic) return false;
    return (this.dependentsByNamespace.get(fromNamespace) ?? []).includes(targetNamespace);
  }

  /** Explains a visibility failure for diagnostics. */
  explainVisibility(fromNamespace: string, ref: string): string {
    const item = this.definitionsByRef.get(ref);
    const targetNamespace = item?.namespace ?? ref.split("/")[0] ?? "";
    if (item !== undefined && !item.isPublic) return `${ref} is not public in ${targetNamespace}`;
    return `${fromNamespace} does not declare a dependency on ${targetNamespace}`;
  }
}
