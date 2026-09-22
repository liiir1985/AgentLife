import { Value } from "typebox/value";
import type { TSchema } from "typebox";
import { error, type IssueList } from "./diagnostics.js";
import {
  itemTypeRef,
  type ItemSpec,
  type SystemItem,
  type SystemCatalog,
  type MergeStrategy,
  type LoadedSystem,
} from "./system-spec.js";
import type { PackSet } from "./packs.js";
import type { ParsedItem } from "./source.js";

/**
 * Resolution: defaults, template combine and explicit overrides.
 *
 * The order is fixed by the shared infrastructure and identical for every
 * config type: type defaults, then templates in declared order, then the
 * item's own override layer. Every field keeps the ordered list of the
 * ruleValues that produced it, so an effective value can always be traced
 * back to a default, a template or an explicit override.
 */

export type SourceLayer = "default" | "template" | "override";

export interface FieldSource {
  readonly layer: SourceLayer;
  readonly source: string;
  readonly value: unknown;
}

export interface MergedField {
  readonly value: unknown;
  readonly merge: MergeStrategy;
  readonly ruleValues: readonly FieldSource[];
}

export interface MergedItem extends SystemItem {
  readonly typeRef: string;
  readonly relativePath: string;
  readonly templates: readonly string[];
  readonly fields: Readonly<Record<string, MergedField>>;
}

function describeSchemaFailure(schema: TSchema, value: unknown): string {
  const first = Value.Errors(schema, value)[0];
  if (first === undefined) return "value does not match its declared type";
  const instancePath = typeof first.instancePath === "string" ? first.instancePath : "";
  const path = instancePath === "" ? "<root>" : instancePath.replace(/^\//, "").split("/").join(".");
  return `${path}: ${first.message}`;
}

function mergeValues(
  strategy: MergeStrategy,
  ruleValues: readonly FieldSource[],
): { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly reason: string } {
  if (ruleValues.length === 0) return { ok: true, value: undefined };
  if (strategy === "reject" && ruleValues.length > 1)
    return {
      ok: false,
      reason: `field is written by ${ruleValues.map((item) => item.source).join(", ")} but declares no merge strategy`,
    };
  const last = ruleValues[ruleValues.length - 1];
  if (ruleValues.length === 1 || strategy === "replace") return { ok: true, value: last?.value };
  if (strategy === "append") {
    const result: unknown[] = [];
    for (const ruleValue of ruleValues) {
      if (!Array.isArray(ruleValue.value))
        return { ok: false, reason: `field declares "append" but ${ruleValue.source} is not a list` };
      result.push(...ruleValue.value);
    }
    return { ok: true, value: result };
  }
  if (strategy === "merge") {
    const result: Record<string, unknown> = {};
    for (const ruleValue of ruleValues) {
      if (typeof ruleValue.value !== "object" || ruleValue.value === null || Array.isArray(ruleValue.value))
        return { ok: false, reason: `field declares "merge" but ${ruleValue.source} is not a mapping` };
      Object.assign(result, ruleValue.value);
    }
    return { ok: true, value: result };
  }
  return { ok: false, reason: `unsupported merge strategy ${String(strategy)}` };
}

interface ResolveContext {
  readonly packs: PackSet;
  readonly registry: SystemCatalog;
  readonly bag: IssueList;
  readonly resolved: Map<string, MergedItem>;
  readonly resolving: Set<string>;
}

function resolveDefinition(context: ResolveContext, item: ParsedItem): MergedItem | undefined {
  const cached = context.resolved.get(item.ref);
  if (cached !== undefined) return cached;

  const typeLookup = findItemSpec(context.registry, item.typeRef, item.ref, context.bag);
  if (typeLookup === undefined) {
    context.resolved.set(item.ref, unresolvedView(item));
    return context.resolved.get(item.ref);
  }
  const { system, declaration } = typeLookup;

  if (context.resolving.has(item.ref)) {
    context.bag.add(
      error("dependency", "cyclic-dependency", `Template cycle detected at ${item.ref}`, {
        subject: item.ref,
      }),
    );
    return undefined;
  }
  context.resolving.add(item.ref);

  const fields: Record<string, MergedField> = {};
  const ruleValues = new Map<string, FieldSource[]>();
  const push = (field: string, ruleValue: FieldSource): void => {
    const list = ruleValues.get(field);
    if (list === undefined) ruleValues.set(field, [ruleValue]);
    else list.push(ruleValue);
  };

  const overrideKeys = Object.keys(item.fields).sort();
  for (const field of overrideKeys) {
    if (!declaration.overridable.includes(field))
      context.bag.add(
        error(
          "structure",
          "field-not-overridable",
          `Field ${field} of ${item.ref} is not overridable by ${declaration.kind}`,
          {
            subject: item.ref,
            source: { pack: item.namespace, file: item.relativePath, path: field },
          },
        ),
      );
  }

  for (const [field, value] of Object.entries(declaration.defaults ?? {}).sort())
    push(field, { layer: "default", source: itemTypeRef(system, declaration.kind), value });

  for (const template of item.templates) {
    if (template === item.ref) {
      context.bag.add(
        error("dependency", "cyclic-dependency", `${item.ref} lists itself as a template`, {
          subject: item.ref,
        }),
      );
      continue;
    }
    const source = context.packs.item(template);
    if (source === undefined) {
      context.bag.add(
        error("reference", "unknown-reference", `Template ${template} of ${item.ref} does not exist`, {
          subject: item.ref,
        }),
      );
      continue;
    }
    if (!context.packs.checkVisibility(item.namespace, template)) {
      context.bag.add(
        error(
          "reference",
          "namespace-not-visible",
          `Template ${template} is not visible to ${item.namespace}: ${context.packs.explainVisibility(item.namespace, template)}`,
          { subject: item.ref },
        ),
      );
      continue;
    }
    if (source.typeRef !== item.typeRef) {
      context.bag.add(
        error(
          "reference",
          "reference-type-mismatch",
          `Template ${template} has type ${source.typeRef}, expected ${item.typeRef}`,
          { subject: item.ref },
        ),
      );
      continue;
    }
    const resolvedTemplate = resolveDefinition(context, source);
    if (resolvedTemplate === undefined) continue;
    for (const [field, value] of Object.entries(resolvedTemplate.values).sort())
      push(field, { layer: "template", source: template, value });
  }

  for (const [field, value] of overrideKeys.map((field) => [field, item.fields[field]] as const))
    push(field, { layer: "override", source: item.ref, value });

  const properties = schemaPropertiesOf(declaration.fields);
  for (const field of Object.keys(properties).sort()) {
    const list = ruleValues.get(field) ?? [];
    if (list.length === 0) continue;
    const strategy = declaration.merge[field] ?? "reject";
    const merged = mergeValues(strategy, list);
    if (!merged.ok) {
      context.bag.add(
        error("structure", "ambiguous-merge", `${item.ref}.${field}: ${merged.reason}`, {
          subject: item.ref,
          source: { pack: item.namespace, file: item.relativePath, path: field },
        }),
      );
      continue;
    }
    fields[field] = { value: merged.value, merge: strategy, ruleValues: list };
  }
  for (const field of ruleValues.keys())
    if (!(field in properties))
      context.bag.add(
        error("structure", "structure-invalid", `${item.ref}.${field} is not declared by ${declaration.kind}`, {
          subject: item.ref,
        }),
      );

  const values: Record<string, unknown> = {};
  for (const field of Object.keys(properties).sort()) {
    const resolved = fields[field];
    if (resolved === undefined || resolved.value === undefined) continue;
    values[field] = resolved.value;
  }

  if (!Value.Check(declaration.fields, values)) {
    context.bag.add(
      error(
        "structure",
        "structure-invalid",
        `${item.ref} does not match ${declaration.kind}: ${describeSchemaFailure(declaration.fields, values)}`,
        {
          subject: item.ref,
          source: { pack: item.namespace, file: item.relativePath },
        },
      ),
    );
  }

  context.resolving.delete(item.ref);
  const result: MergedItem = Object.freeze({
    ref: item.ref,
    type: item.typeRef,
    typeRef: item.typeRef,
    namespace: item.namespace,
    name: item.id,
    isPublic: item.isPublic,
    relativePath: item.relativePath,
    templates: Object.freeze([...item.templates]),
    values: Object.freeze(values),
    fields: Object.freeze(fields),
  });
  context.resolved.set(item.ref, result);
  return result;
}

function schemaPropertiesOf(schema: TSchema): Record<string, TSchema> {
  const properties: unknown = Reflect.get(schema as object, "properties");
  return typeof properties === "object" && properties !== null ? (properties as Record<string, TSchema>) : {};
}

/** Placeholder kept for items whose config type is unknown. */
function unresolvedView(item: ParsedItem): MergedItem {
  return {
    ref: item.ref,
    type: item.typeRef,
    typeRef: item.typeRef,
    namespace: item.namespace,
    name: item.id,
    isPublic: item.isPublic,
    relativePath: item.relativePath,
    templates: item.templates,
    values: {},
    fields: {},
  };
}

export function findItemSpec(
  registry: SystemCatalog,
  typeRef: string,
  subject: string,
  bag: IssueList,
): { readonly system: LoadedSystem; readonly declaration: ItemSpec } | undefined {
  for (const system of registry.sorted()) {
    const declaration = system.spec.items.find((candidate) => itemTypeRef(system, candidate.kind) === typeRef);
    if (declaration !== undefined) return { system, declaration };
  }
  bag.add(
    error("reference", "unknown-reference", `${subject} declares unknown config type ${typeRef}`, {
      subject,
    }),
  );
  return undefined;
}

/** Resolves every item of every participating pack. */
export function mergeItems(packs: PackSet, registry: SystemCatalog, bag: IssueList): readonly MergedItem[] {
  const context: ResolveContext = { packs, registry, bag, resolved: new Map(), resolving: new Set() };
  const results: MergedItem[] = [];
  for (const item of packs.items()) {
    const resolved = resolveDefinition(context, item);
    if (resolved !== undefined) results.push(resolved);
  }
  return results;
}
