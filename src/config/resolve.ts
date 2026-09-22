import { Value } from "typebox/value";
import type { TSchema } from "typebox";
import { error, type DiagnosticBag } from "./diagnostics.js";
import {
  configTypeRef,
  type ConfigTypeDeclaration,
  type DomainDefinitionView,
  type ExtensionRegistry,
  type MergeStrategy,
  type RegisteredExtension,
} from "./extension.js";
import type { PackSet } from "./packs.js";
import type { SourceDefinition } from "./source.js";

/**
 * Resolution: defaults, template composition and explicit overrides.
 *
 * The order is fixed by the shared infrastructure and identical for every
 * config type: type defaults, then templates in declared order, then the
 * definition's own override layer. Every field keeps the ordered list of the
 * contributions that produced it, so an effective value can always be traced
 * back to a default, a template or an explicit override.
 */

export type OriginLayer = "default" | "template" | "override";

export interface FieldContribution {
  readonly layer: OriginLayer;
  readonly source: string;
  readonly value: unknown;
}

export interface ResolvedField {
  readonly value: unknown;
  readonly merge: MergeStrategy;
  readonly contributions: readonly FieldContribution[];
}

export interface ResolvedDefinition extends DomainDefinitionView {
  readonly typeRef: string;
  readonly relativePath: string;
  readonly templates: readonly string[];
  readonly fields: Readonly<Record<string, ResolvedField>>;
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
  contributions: readonly FieldContribution[],
): { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly reason: string } {
  if (contributions.length === 0) return { ok: true, value: undefined };
  if (strategy === "reject" && contributions.length > 1)
    return {
      ok: false,
      reason: `field is written by ${contributions.map((item) => item.source).join(", ")} but declares no merge strategy`,
    };
  const last = contributions[contributions.length - 1];
  if (contributions.length === 1 || strategy === "replace") return { ok: true, value: last?.value };
  if (strategy === "append") {
    const result: unknown[] = [];
    for (const contribution of contributions) {
      if (!Array.isArray(contribution.value))
        return { ok: false, reason: `field declares "append" but ${contribution.source} is not a list` };
      result.push(...contribution.value);
    }
    return { ok: true, value: result };
  }
  if (strategy === "merge") {
    const result: Record<string, unknown> = {};
    for (const contribution of contributions) {
      if (typeof contribution.value !== "object" || contribution.value === null || Array.isArray(contribution.value))
        return { ok: false, reason: `field declares "merge" but ${contribution.source} is not a mapping` };
      Object.assign(result, contribution.value);
    }
    return { ok: true, value: result };
  }
  return { ok: false, reason: `unsupported merge strategy ${String(strategy)}` };
}

interface ResolveContext {
  readonly packs: PackSet;
  readonly registry: ExtensionRegistry;
  readonly bag: DiagnosticBag;
  readonly resolved: Map<string, ResolvedDefinition>;
  readonly resolving: Set<string>;
}

function resolveDefinition(context: ResolveContext, definition: SourceDefinition): ResolvedDefinition | undefined {
  const cached = context.resolved.get(definition.ref);
  if (cached !== undefined) return cached;

  const typeLookup = lookupConfigType(context.registry, definition.typeRef, definition.ref, context.bag);
  if (typeLookup === undefined) {
    context.resolved.set(definition.ref, unresolvedView(definition));
    return context.resolved.get(definition.ref);
  }
  const { extension, declaration } = typeLookup;

  if (context.resolving.has(definition.ref)) {
    context.bag.add(
      error("dependency", "cyclic-dependency", `Template cycle detected at ${definition.ref}`, {
        subject: definition.ref,
      }),
    );
    return undefined;
  }
  context.resolving.add(definition.ref);

  const fields: Record<string, ResolvedField> = {};
  const contributions = new Map<string, FieldContribution[]>();
  const push = (field: string, contribution: FieldContribution): void => {
    const list = contributions.get(field);
    if (list === undefined) contributions.set(field, [contribution]);
    else list.push(contribution);
  };

  const overrideKeys = Object.keys(definition.fields).sort();
  for (const field of overrideKeys) {
    if (!declaration.overridable.includes(field))
      context.bag.add(
        error(
          "structure",
          "field-not-overridable",
          `Field ${field} of ${definition.ref} is not overridable by ${declaration.kind}`,
          {
            subject: definition.ref,
            source: { pack: definition.namespace, file: definition.relativePath, path: field },
          },
        ),
      );
  }

  for (const [field, value] of Object.entries(declaration.defaults ?? {}).sort())
    push(field, { layer: "default", source: configTypeRef(extension, declaration.kind), value });

  for (const template of definition.templates) {
    if (template === definition.ref) {
      context.bag.add(
        error("dependency", "cyclic-dependency", `${definition.ref} lists itself as a template`, {
          subject: definition.ref,
        }),
      );
      continue;
    }
    const source = context.packs.definition(template);
    if (source === undefined) {
      context.bag.add(
        error("reference", "unknown-reference", `Template ${template} of ${definition.ref} does not exist`, {
          subject: definition.ref,
        }),
      );
      continue;
    }
    if (!context.packs.checkVisibility(definition.namespace, template)) {
      context.bag.add(
        error(
          "reference",
          "namespace-not-visible",
          `Template ${template} is not visible to ${definition.namespace}: ${context.packs.explainVisibility(definition.namespace, template)}`,
          { subject: definition.ref },
        ),
      );
      continue;
    }
    if (source.typeRef !== definition.typeRef) {
      context.bag.add(
        error(
          "reference",
          "reference-type-mismatch",
          `Template ${template} has type ${source.typeRef}, expected ${definition.typeRef}`,
          { subject: definition.ref },
        ),
      );
      continue;
    }
    const resolvedTemplate = resolveDefinition(context, source);
    if (resolvedTemplate === undefined) continue;
    for (const [field, value] of Object.entries(resolvedTemplate.values).sort())
      push(field, { layer: "template", source: template, value });
  }

  for (const [field, value] of overrideKeys.map((field) => [field, definition.fields[field]] as const))
    push(field, { layer: "override", source: definition.ref, value });

  const properties = schemaPropertiesOf(declaration.fields);
  for (const field of Object.keys(properties).sort()) {
    const list = contributions.get(field) ?? [];
    if (list.length === 0) continue;
    const strategy = declaration.merge[field] ?? "reject";
    const merged = mergeValues(strategy, list);
    if (!merged.ok) {
      context.bag.add(
        error("structure", "ambiguous-merge", `${definition.ref}.${field}: ${merged.reason}`, {
          subject: definition.ref,
          source: { pack: definition.namespace, file: definition.relativePath, path: field },
        }),
      );
      continue;
    }
    fields[field] = { value: merged.value, merge: strategy, contributions: list };
  }
  for (const field of contributions.keys())
    if (!(field in properties))
      context.bag.add(
        error("structure", "structure-invalid", `${definition.ref}.${field} is not declared by ${declaration.kind}`, {
          subject: definition.ref,
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
        `${definition.ref} does not match ${declaration.kind}: ${describeSchemaFailure(declaration.fields, values)}`,
        {
          subject: definition.ref,
          source: { pack: definition.namespace, file: definition.relativePath },
        },
      ),
    );
  }

  context.resolving.delete(definition.ref);
  const result: ResolvedDefinition = Object.freeze({
    ref: definition.ref,
    type: definition.typeRef,
    typeRef: definition.typeRef,
    namespace: definition.namespace,
    name: definition.id,
    isPublic: definition.isPublic,
    relativePath: definition.relativePath,
    templates: Object.freeze([...definition.templates]),
    values: Object.freeze(values),
    fields: Object.freeze(fields),
  });
  context.resolved.set(definition.ref, result);
  return result;
}

function schemaPropertiesOf(schema: TSchema): Record<string, TSchema> {
  const properties: unknown = Reflect.get(schema as object, "properties");
  return typeof properties === "object" && properties !== null ? (properties as Record<string, TSchema>) : {};
}

/** Placeholder kept for definitions whose config type is unknown. */
function unresolvedView(definition: SourceDefinition): ResolvedDefinition {
  return {
    ref: definition.ref,
    type: definition.typeRef,
    typeRef: definition.typeRef,
    namespace: definition.namespace,
    name: definition.id,
    isPublic: definition.isPublic,
    relativePath: definition.relativePath,
    templates: definition.templates,
    values: {},
    fields: {},
  };
}

export function lookupConfigType(
  registry: ExtensionRegistry,
  typeRef: string,
  subject: string,
  bag: DiagnosticBag,
): { readonly extension: RegisteredExtension; readonly declaration: ConfigTypeDeclaration } | undefined {
  for (const extension of registry.sorted()) {
    const declaration = extension.extension.configTypes.find(
      (candidate) => configTypeRef(extension, candidate.kind) === typeRef,
    );
    if (declaration !== undefined) return { extension, declaration };
  }
  bag.add(
    error("reference", "unknown-reference", `${subject} declares unknown config type ${typeRef}`, {
      subject,
    }),
  );
  return undefined;
}

/** Resolves every definition of every participating pack. */
export function resolveDefinitions(
  packs: PackSet,
  registry: ExtensionRegistry,
  bag: DiagnosticBag,
): readonly ResolvedDefinition[] {
  const context: ResolveContext = { packs, registry, bag, resolved: new Map(), resolving: new Set() };
  const results: ResolvedDefinition[] = [];
  for (const definition of packs.definitions()) {
    const resolved = resolveDefinition(context, definition);
    if (resolved !== undefined) results.push(resolved);
  }
  return results;
}
