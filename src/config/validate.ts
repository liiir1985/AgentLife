import {
  configTypeRef,
  scalarKind,
  schemaProperties,
  type ConfigTypeDeclaration,
  type DomainRuleView,
  type DomainValidationInput,
  type RegisteredExtension,
} from "./extension.js";
import type { ExtensionCapabilities } from "./capabilities.js";
import { conditionDerivations, conditionReads, type Condition } from "./conditions.js";
import { DiagnosticBag, error, warning, type Diagnostic } from "./diagnostics.js";
import { KERNEL_VERSION, parseQualifiedName, satisfiesVersion } from "./identifiers.js";
import { RATIO_UNIT, mappingUnit, validateMapping, type CompositionKind } from "./numeric.js";
import type { PackSet } from "./packs.js";
import type { ResolvedDefinition } from "./resolve.js";
import type { SourceDerivation, SourcePack, SourceRead, SourceRule } from "./source.js";
import { ConfigVocabulary, type VocabularyDefinition, type VocabularyProblem } from "./vocabulary.js";
import { valueDerivations, valueReads, type ValueSource } from "./values.js";
import type { TSchema } from "typebox";

/**
 * Stages two to seven of the shared pipeline.
 *
 * Stage one (structure) happens while the extension declarations and the pack
 * documents are parsed. This module binds every rule to the extensions that own
 * its vocabulary, which both produces the compiled artifact and gives each
 * stage a single, explicit set of facts to check.
 */

export type StaticType = "number" | "boolean" | "string";

export interface BoundRead {
  readonly alias: string;
  readonly view: string;
  readonly field: string;
  readonly unit: string | null;
  readonly valueType: StaticType;
}

export interface BoundTargetEffect {
  readonly kind: "target";
  readonly target: string;
  /** Extension that owns the target and has to validate the candidate. */
  readonly owner: string;
  readonly composition: CompositionKind;
  readonly priority: number | null;
  readonly value: ValueSource;
  readonly unit: string | null;
  readonly valueType: StaticType | null;
}

export interface BoundProcessEffect {
  readonly kind: "process";
  readonly process: string;
  readonly owner: string;
  readonly operation: "establish" | "advance" | "pause" | "end" | "cancel";
  readonly parameters: readonly { readonly name: string; readonly value: ValueSource }[];
}

export type BoundEffect = BoundTargetEffect | BoundProcessEffect;

export interface BoundRule {
  readonly ref: string;
  readonly domain: string;
  readonly extension: RegisteredExtension;
  readonly source: SourceRule;
  readonly triggers: readonly string[];
  readonly reads: readonly BoundRead[];
  readonly condition: Condition;
  readonly effects: readonly BoundEffect[];
  readonly dependsOn: readonly string[];
}

export interface BoundDerivation {
  readonly ref: string;
  readonly domain: string;
  readonly extension: RegisteredExtension;
  readonly source: SourceDerivation;
  readonly reads: readonly BoundRead[];
  readonly outputUnit: string;
  readonly value: ValueSource;
}

export interface ValidatedConfiguration {
  readonly packs: PackSet;
  readonly capabilities: ExtensionCapabilities;
  readonly vocabulary: ConfigVocabulary;
  readonly definitions: readonly ResolvedDefinition[];
  readonly rules: readonly BoundRule[];
  readonly derivations: readonly BoundDerivation[];
}

function readValueType(schema: TSchema | undefined): StaticType | null {
  return scalarKind(schema);
}

function staticTypeOf(source: ValueSource, reads: Map<string, BoundRead>): StaticType | null {
  switch (source.kind) {
    case "literal":
      return typeof source.value === "number" ? "number" : typeof source.value === "boolean" ? "boolean" : "string";
    case "read":
      return reads.get(source.alias)?.valueType ?? null;
    case "compare":
      return "boolean";
    case "select": {
      const thenType = staticTypeOf(source.then, reads);
      const elseType = staticTypeOf(source.otherwise, reads);
      return thenType !== null && thenType === elseType ? thenType : null;
    }
    case "derived":
      return "number";
    default:
      return "number";
  }
}

function staticUnitOf(
  source: ValueSource,
  reads: Map<string, BoundRead>,
  derivations: Map<string, BoundDerivation>,
): string | null {
  switch (source.kind) {
    case "literal":
      return typeof source.value === "number" ? source.unit : null;
    case "read":
      return reads.get(source.alias)?.unit ?? null;
    case "derived":
      return derivations.get(source.ref)?.outputUnit ?? null;
    case "combine": {
      const first = source.operands[0];
      if (first === undefined) return null;
      return source.method === "multiply" ? "" : staticUnitOf(first, reads, derivations);
    }
    case "compare":
      return null;
    case "select": {
      const thenUnit = staticUnitOf(source.then, reads, derivations);
      const elseUnit = staticUnitOf(source.otherwise, reads, derivations);
      return thenUnit !== null && thenUnit === elseUnit ? thenUnit : null;
    }
    default:
      return mappingUnit(source.mapping);
  }
}

function bindingFailure(bag: DiagnosticBag, subject: string, message: string): void {
  bag.add(error("structure", "structure-invalid", message, { subject }));
}

function missingReference(bag: DiagnosticBag, subject: string, message: string): void {
  bag.add(error("reference", "unknown-reference", message, { subject }));
}

/** Stage two and five: bind reads, checking existence, permission and units. */
function bindReads(
  reads: readonly SourceRead[],
  subject: string,
  domainRef: string,
  capabilities: ExtensionCapabilities,
  vocabulary: ConfigVocabulary,
  bag: DiagnosticBag,
): Map<string, BoundRead> | undefined {
  const bound = new Map<string, BoundRead>();
  for (const read of reads) {
    if (bound.has(read.alias)) {
      bindingFailure(bag, subject, `${subject} declares read alias ${read.alias} twice`);
      continue;
    }
    const view = vocabulary.view(read.view);
    if (view === undefined) {
      const other = vocabulary.category(read.view) ?? capabilities.all(read.view)?.ref;
      bag.add(
        error(
          "reference",
          other === undefined ? "unknown-reference" : "reference-type-mismatch",
          other === undefined
            ? `${subject} reads unknown view ${read.view}`
            : `${subject} reads ${read.view}, which is a ${vocabulary.category(read.view) ?? "declared name but not a view"}`,
          { subject },
        ),
      );
      continue;
    }
    if (!capabilities.grants(view.exposedTo, view.owner, domainRef)) {
      bag.add(
        error(
          "permission",
          "unauthorized-read",
          `${subject} (${domainRef}) is not allowed to read view ${read.view} owned by ${view.owner}`,
          { subject },
        ),
      );
      continue;
    }
    const member = view.members.get(read.field);
    if (member === undefined) {
      const declared = view.schema === null ? undefined : schemaProperties(view.schema)[read.field];
      if (declared === undefined)
        missingReference(bag, subject, `${subject} reads unknown field ${read.field} of view ${read.view}`);
      else bindingFailure(bag, subject, `${subject} reads ${read.view}.${read.field}, which is not a scalar field`);
      continue;
    }
    bound.set(read.alias, {
      alias: read.alias,
      view: read.view,
      field: read.field,
      unit: member.valueType === "number" ? member.unit : null,
      valueType: member.valueType,
    });
  }
  return bound.size === reads.length ? bound : bound.size === 0 ? undefined : bound;
}

function domainExtension(
  domainRef: string,
  subject: string,
  capabilities: ExtensionCapabilities,
  bag: DiagnosticBag,
): RegisteredExtension | undefined {
  const extension = capabilities.extension(domainRef);
  if (extension !== undefined) return extension;
  const other = capabilities.all(domainRef);
  bag.add(
    error(
      "reference",
      other === undefined ? "unknown-reference" : "reference-type-mismatch",
      other === undefined
        ? `${subject} declares unknown domain extension ${domainRef}`
        : `${subject} declares domain ${domainRef}, which is not an extension`,
      { subject },
    ),
  );
  return undefined;
}

function checkValueUnits(
  source: ValueSource,
  subject: string,
  reads: Map<string, BoundRead>,
  derivations: Map<string, BoundDerivation>,
  bag: DiagnosticBag,
): void {
  if (source.kind === "map") {
    bag.addAll(
      validateMapping(source.mapping, `${subject}.value`).map((problem) =>
        error("structure", "structure-invalid", problem, { subject }),
      ),
    );
    const inputUnit = staticUnitOf(source.input, reads, derivations);
    const declaredInput = source.mapping.inputUnit;
    if (inputUnit !== null && inputUnit !== declaredInput)
      bag.add(
        error(
          "composition",
          "unit-mismatch",
          `${subject}: mapping expects ${declaredInput === "" ? "a dimensionless input" : declaredInput} but its input carries ${
            inputUnit === "" ? "no unit" : inputUnit
          }`,
          { subject },
        ),
      );
    checkValueUnits(source.input, subject, reads, derivations, bag);
    return;
  }
  if (source.kind === "compare") {
    const leftType = staticTypeOf(source.left, reads);
    const rightType = staticTypeOf(source.right, reads);
    if (leftType !== null && rightType !== null && leftType !== rightType)
      bag.add(
        error("composition", "incompatible-output-type", `${subject}: comparison mixes ${leftType} and ${rightType}`, {
          subject,
        }),
      );
    else if (leftType === "number") {
      const leftUnit = staticUnitOf(source.left, reads, derivations);
      const rightUnit = staticUnitOf(source.right, reads, derivations);
      if (leftUnit !== null && rightUnit !== null && leftUnit !== rightUnit)
        bag.add(
          error("composition", "unit-mismatch", `${subject}: comparison mixes units ${leftUnit} and ${rightUnit}`, {
            subject,
          }),
        );
    }
    checkValueUnits(source.left, subject, reads, derivations, bag);
    checkValueUnits(source.right, subject, reads, derivations, bag);
    return;
  }
  if (source.kind === "select") {
    const leftType = staticTypeOf(source.left, reads);
    const rightType = staticTypeOf(source.right, reads);
    if (leftType !== null && rightType !== null && leftType !== rightType)
      bag.add(
        error(
          "composition",
          "incompatible-output-type",
          `${subject}: selection compares ${leftType} with ${rightType}`,
          { subject },
        ),
      );
    else if (leftType === "number") {
      const leftUnit = staticUnitOf(source.left, reads, derivations);
      const rightUnit = staticUnitOf(source.right, reads, derivations);
      if (leftUnit !== null && rightUnit !== null && leftUnit !== rightUnit)
        bag.add(
          error("composition", "unit-mismatch", `${subject}: selection compares units ${leftUnit} and ${rightUnit}`, {
            subject,
          }),
        );
    }
    const thenType = staticTypeOf(source.then, reads);
    const elseType = staticTypeOf(source.otherwise, reads);
    if (thenType !== null && elseType !== null && thenType !== elseType)
      bag.add(
        error(
          "composition",
          "incompatible-output-type",
          `${subject}: selection branches produce ${thenType} and ${elseType}`,
          { subject },
        ),
      );
    else if (thenType === "number") {
      const thenUnit = staticUnitOf(source.then, reads, derivations);
      const elseUnit = staticUnitOf(source.otherwise, reads, derivations);
      if (thenUnit !== null && elseUnit !== null && thenUnit !== elseUnit)
        bag.add(
          error(
            "composition",
            "unit-mismatch",
            `${subject}: selection branches produce units ${thenUnit} and ${elseUnit}`,
            { subject },
          ),
        );
    }
    for (const branch of [source.left, source.right, source.then, source.otherwise])
      checkValueUnits(branch, subject, reads, derivations, bag);
    return;
  }
  if (source.kind !== "combine") return;
  if (source.operands.length < 2)
    bindingFailure(bag, subject, `${subject}: combination ${source.method} needs at least two operands`);
  const multiplicative = source.method === "multiply";
  const firstOperand = source.operands[0];
  const expected = multiplicative || firstOperand === undefined ? null : staticUnitOf(firstOperand, reads, derivations);
  for (const operand of source.operands) {
    const type = staticTypeOf(operand, reads);
    if (type !== null && type !== "number")
      bag.add(
        error(
          "composition",
          "incompatible-output-type",
          `${subject}: combination ${source.method} requires numbers but receives ${type}`,
          { subject },
        ),
      );
    const unit = staticUnitOf(operand, reads, derivations);
    if (unit === null) continue;
    if (multiplicative) {
      if (unit !== "" && unit !== RATIO_UNIT)
        bag.add(
          error(
            "composition",
            "unit-mismatch",
            `${subject}: combination multiply requires dimensionless operands but receives ${unit}`,
            { subject },
          ),
        );
    } else if (expected !== null && unit !== expected)
      bag.add(
        error(
          "composition",
          "unit-mismatch",
          `${subject}: combination ${source.method} mixes units ${expected} and ${unit}`,
          { subject },
        ),
      );
    checkValueUnits(operand, subject, reads, derivations, bag);
  }
}

/** Stage four: value type and unit compatibility of one declared value. */
function checkValueCompatibility(
  source: ValueSource,
  expectedType: StaticType,
  expectedUnit: string | null,
  subject: string,
  reads: Map<string, BoundRead>,
  derivations: Map<string, BoundDerivation>,
  bag: DiagnosticBag,
): void {
  // The source's own consistency is checked first: an inconsistent source is
  // inexpressible even when the target's declared type cannot be compared to it.
  checkValueUnits(source, subject, reads, derivations, bag);
  const type = staticTypeOf(source, reads);
  if (type !== null && type !== expectedType)
    bag.add(
      error(
        "composition",
        "incompatible-output-type",
        `${subject}: value of type ${type} cannot feed a ${expectedType} target`,
        { subject },
      ),
    );
  if (expectedType !== "number") return;
  const unit = staticUnitOf(source, reads, derivations);
  if (unit !== null && unit !== expectedUnit)
    bag.add(
      error(
        "composition",
        "unit-mismatch",
        `${subject}: value carries unit ${unit}, the target declares ${String(expectedUnit)}`,
        { subject },
      ),
    );
}

function bindEffects(
  rule: SourceRule,
  domainRef: string,
  reads: Map<string, BoundRead>,
  derivations: Map<string, BoundDerivation>,
  capabilities: ExtensionCapabilities,
  vocabulary: ConfigVocabulary,
  bag: DiagnosticBag,
): BoundEffect[] {
  const effects: BoundEffect[] = [];
  for (const effect of rule.effects) {
    if (effect.kind === "process") {
      const process = capabilities.process(effect.process);
      if (process === undefined) {
        missingReference(bag, rule.ref, `${rule.ref} declares unknown process ${effect.process}`);
        continue;
      }
      if (process.extension.ref !== domainRef) {
        bag.add(
          error(
            "permission",
            "unauthorized-effect",
            `${rule.ref} may not operate process ${effect.process} owned by ${process.extension.ref}`,
            { subject: rule.ref },
          ),
        );
        continue;
      }
      if (!process.declaration.operations.includes(effect.operation)) {
        bag.add(
          error(
            "composition",
            "composition-not-allowed",
            `${rule.ref} declares operation ${effect.operation}, which process ${effect.process} does not allow`,
            { subject: rule.ref },
          ),
        );
        continue;
      }
      const parameters = Object.entries(effect.parameters).map(([name, value]) => ({ name, value }));
      const declared = schemaProperties(process.declaration.parameters);
      for (const parameter of parameters) {
        const schema = declared[parameter.name];
        if (schema === undefined) {
          bindingFailure(
            bag,
            rule.ref,
            `${rule.ref} passes unknown parameter ${parameter.name} to process ${effect.process}`,
          );
          continue;
        }
        const expected = readValueType(schema);
        const actual = staticTypeOf(parameter.value, reads);
        if (expected !== null && actual !== null && expected !== actual)
          bag.add(
            error(
              "composition",
              "incompatible-output-type",
              `${rule.ref}: parameter ${parameter.name} of ${effect.process} is ${expected} but receives ${actual}`,
              { subject: rule.ref },
            ),
          );
      }
      for (const name of Object.keys(declared))
        if (!(name in effect.parameters))
          bindingFailure(bag, rule.ref, `${rule.ref} must declare parameter ${name} of process ${effect.process}`);
      effects.push({
        kind: "process",
        process: effect.process,
        owner: process.extension.ref,
        operation: effect.operation,
        parameters,
      });
      for (const parameter of parameters)
        checkValueUnits(parameter.value, `${rule.ref}.${effect.process}.${parameter.name}`, reads, derivations, bag);
      continue;
    }

    const target = vocabulary.target(effect.target);
    if (target === undefined) {
      const kind = vocabulary.category(effect.target);
      const other = kind ?? capabilities.all(effect.target)?.ref;
      bag.add(
        error(
          "reference",
          other === undefined ? "unknown-reference" : "reference-type-mismatch",
          other === undefined
            ? `${rule.ref} declares unknown output target ${effect.target}`
            : `${rule.ref} declares ${effect.target} as a target, which is a ${kind ?? "declared name but not a target"}`,
          { subject: rule.ref },
        ),
      );
      continue;
    }
    if (!capabilities.grants(target.exposedTo, target.owner, domainRef)) {
      bag.add(
        error(
          "permission",
          "unauthorized-effect",
          `${rule.ref} (${domainRef}) may not write target ${effect.target} owned by ${target.owner}`,
          { subject: rule.ref },
        ),
      );
      continue;
    }
    if (effect.composition === "priority" && effect.priority === null) {
      bag.add(
        error(
          "structure",
          "structure-invalid",
          `${rule.ref} composes ${effect.target} by priority without a priority`,
          {
            subject: rule.ref,
          },
        ),
      );
      continue;
    }
    if (effect.composition !== "priority" && effect.priority !== null) {
      bag.add(
        error(
          "structure",
          "structure-invalid",
          `${rule.ref} declares a priority for the non-priority target ${effect.target}`,
          { subject: rule.ref },
        ),
      );
      continue;
    }
    if (effect.composition !== "priority" && target.valueType !== "number") {
      bag.add(
        error(
          "composition",
          "incompatible-output-type",
          `${rule.ref} composes ${effect.target} with ${effect.composition}, which requires a numeric target`,
          { subject: rule.ref },
        ),
      );
      continue;
    }
    if (effect.composition === "multiply" && target.unit !== RATIO_UNIT) {
      bag.add(
        error(
          "composition",
          "composition-not-allowed",
          `${rule.ref} multiplies ${effect.target}, whose declared unit "${target.unit}" is not "${RATIO_UNIT}"`,
          { subject: rule.ref },
        ),
      );
      continue;
    }
    checkValueCompatibility(
      effect.value,
      target.valueType,
      target.valueType === "number" ? target.unit : null,
      `${rule.ref}->${effect.target}`,
      reads,
      derivations,
      bag,
    );
    effects.push({
      kind: "target",
      target: effect.target,
      owner: target.owner,
      composition: effect.composition,
      priority: effect.priority,
      value: effect.value,
      unit: staticUnitOf(effect.value, reads, derivations),
      valueType: staticTypeOf(effect.value, reads),
    });
  }
  return effects;
}

function checkCondition(
  condition: Condition,
  subject: string,
  reads: Map<string, BoundRead>,
  derivations: Map<string, BoundDerivation>,
  capabilities: ExtensionCapabilities,
  bag: DiagnosticBag,
): void {
  switch (condition.op) {
    case "all":
    case "any":
      for (const operand of condition.operands) checkCondition(operand, subject, reads, derivations, capabilities, bag);
      return;
    case "not":
      checkCondition(condition.operand, subject, reads, derivations, capabilities, bag);
      return;
    case "compare": {
      const leftUnit = staticUnitOf(condition.left, reads, derivations);
      const rightUnit = staticUnitOf(condition.right, reads, derivations);
      const leftType = staticTypeOf(condition.left, reads);
      const rightType = staticTypeOf(condition.right, reads);
      if (leftType !== null && rightType !== null && leftType !== rightType)
        bag.add(
          error(
            "composition",
            "incompatible-output-type",
            `${subject}: comparison mixes ${leftType} and ${rightType}`,
            { subject },
          ),
        );
      else if (leftType === "number" && leftUnit !== rightUnit)
        bag.add(
          error(
            "composition",
            "unit-mismatch",
            `${subject}: comparison mixes units ${String(leftUnit)} and ${String(rightUnit)}`,
            { subject },
          ),
        );
      checkValueUnits(condition.left, subject, reads, derivations, bag);
      checkValueUnits(condition.right, subject, reads, derivations, bag);
      return;
    }
    case "within":
      checkValueUnits(condition.value, subject, reads, derivations, bag);
      if (staticTypeOf(condition.value, reads) === "number" && condition.min === null && condition.max === null)
        bag.add(
          error("structure", "structure-invalid", `${subject}: interval condition declares no bound`, {
            subject,
          }),
        );
      return;
    default:
      return;
  }
}

/** Stage two: identities held in config fields must exist, be visible and match. */
function checkDefinitionReferences(
  packs: PackSet,
  capabilities: ExtensionCapabilities,
  definitions: readonly ResolvedDefinition[],
  bag: DiagnosticBag,
): void {
  for (const definition of definitions) {
    const capability = capabilities.configType(definition.typeRef);
    if (capability === undefined) continue;
    for (const [field, allowed] of Object.entries(capability.declaration.references ?? {})) {
      const value = definition.values[field];
      if (value === undefined) continue;
      const targets = Array.isArray(value) ? value : [value];
      for (const target of targets) {
        if (typeof target !== "string") {
          bindingFailure(bag, definition.ref, `${definition.ref}.${field} must hold definition identities`);
          continue;
        }
        const resolved = packs.definition(target);
        if (resolved === undefined) {
          missingReference(bag, definition.ref, `${definition.ref}.${field} references unknown ${target}`);
          continue;
        }
        if (!packs.checkVisibility(definition.namespace, target)) {
          bag.add(
            error(
              "reference",
              "namespace-not-visible",
              `${definition.ref}.${field} references ${target}, which ${definition.namespace} cannot address: ${packs.explainVisibility(
                definition.namespace,
                target,
              )}`,
              { subject: definition.ref },
            ),
          );
          continue;
        }
        if (!allowed.includes(resolved.typeRef)) {
          bag.add(
            error(
              "reference",
              "reference-type-mismatch",
              `${definition.ref}.${field} must reference ${allowed.join(" or ")}, not ${resolved.typeRef}`,
              { subject: definition.ref },
            ),
          );
        }
      }
    }
  }
}

/** Stage two: dependency graph over rules and derivations. */
function dependencyOrder(
  nodes: readonly { readonly ref: string; readonly deps: readonly string[] }[],
  bag: DiagnosticBag,
): readonly string[] {
  const byRef = new Map(nodes.map((node) => [node.ref, node]));
  const state = new Map<string, "visiting" | "done">();
  const ordered: string[] = [];
  const visit = (ref: string, path: readonly string[]): void => {
    const status = state.get(ref);
    if (status === "done") return;
    if (status === "visiting") {
      const cycle = [...path.slice(path.indexOf(ref)), ref].sort();
      bag.add(error("dependency", "cyclic-dependency", `Dependency cycle: ${cycle.join(" -> ")}`, { subject: ref }));
      return;
    }
    const node = byRef.get(ref);
    if (node === undefined) return;
    state.set(ref, "visiting");
    for (const dependency of [...node.deps].sort()) visit(dependency, [...path, ref]);
    state.set(ref, "done");
    ordered.push(ref);
  };
  for (const ref of [...byRef.keys()].sort()) visit(ref, []);
  return ordered;
}

function classifyDependencies(rule: SourceRule): readonly string[] {
  return [
    ...rule.dependsOn,
    ...conditionDerivations(rule.condition),
    ...rule.effects.flatMap((effect) =>
      effect.kind === "process"
        ? Object.values(effect.parameters).flatMap(valueDerivations)
        : valueDerivations(effect.value),
    ),
  ];
}

function ruleReads(rule: SourceRule): readonly string[] {
  return [
    ...conditionReads(rule.condition),
    ...rule.effects.flatMap((effect) =>
      effect.kind === "process" ? Object.values(effect.parameters).flatMap(valueReads) : valueReads(effect.value),
    ),
  ];
}

export function validateConfiguration(
  packs: PackSet,
  capabilities: ExtensionCapabilities,
  definitions: readonly ResolvedDefinition[],
  bag: DiagnosticBag,
): ValidatedConfiguration | undefined {
  checkDefinitionReferences(packs, capabilities, definitions, bag);

  const vocabularyProblems: VocabularyProblem[] = [];
  const vocabularyDefinitions: VocabularyDefinition[] = definitions.map((definition) => ({
    ref: definition.ref,
    typeRef: definition.typeRef,
    namespace: definition.namespace,
    name: definition.name,
    values: definition.values,
  }));
  const vocabulary = new ConfigVocabulary(capabilities.extensionsSorted(), vocabularyDefinitions, vocabularyProblems);
  for (const problem of vocabularyProblems)
    bag.add(
      problem.scope === "structure"
        ? error("structure", "structure-invalid", problem.message, {
            ...(problem.subject === undefined ? {} : { subject: problem.subject }),
          })
        : error("domain", "invalid-value", problem.message, {
            ...(problem.subject === undefined ? {} : { subject: problem.subject }),
          }),
    );

  const boundRules: BoundRule[] = [];
  const boundDerivations: BoundDerivation[] = [];

  for (const derivation of packs.derivations()) {
    const extension = domainExtension(derivation.domain, derivation.ref, capabilities, bag);
    if (extension === undefined) continue;
    const reads = bindReads(derivation.reads, derivation.ref, extension.ref, capabilities, vocabulary, bag);
    if (reads === undefined) continue;
    for (const read of derivation.reads)
      if (!valueReads(derivation.value).includes(read.alias))
        bag.add(
          warning("structure", "unused-read", `${derivation.ref} declares read alias ${read.alias} but never uses it`),
        );
    checkValueUnits(derivation.value, derivation.ref, reads, new Map(), bag);
    if (staticTypeOf(derivation.value, reads) !== "number")
      bag.add(
        error(
          "composition",
          "incompatible-output-type",
          `${derivation.ref} must resolve to a number to expose an output unit`,
          { subject: derivation.ref },
        ),
      );
    else {
      const unit = staticUnitOf(derivation.value, reads, new Map());
      if (unit !== derivation.outputUnit)
        bag.add(
          error(
            "composition",
            "unit-mismatch",
            `${derivation.ref} declares output unit ${derivation.outputUnit} but produces ${String(unit)}`,
            { subject: derivation.ref },
          ),
        );
    }
    boundDerivations.push({
      ref: derivation.ref,
      domain: extension.ref,
      extension,
      source: derivation,
      reads: [...reads.values()],
      outputUnit: derivation.outputUnit,
      value: derivation.value,
    });
  }

  for (const rule of packs.rules()) {
    const extension = domainExtension(rule.domain, rule.ref, capabilities, bag);
    if (extension === undefined) continue;
    const reads = bindReads(rule.reads, rule.ref, extension.ref, capabilities, vocabulary, bag);
    if (reads === undefined) continue;
    const triggers: string[] = [];
    for (const trigger of rule.triggers) {
      if (capabilities.trigger(trigger) === undefined)
        bag.add(
          error("reference", "unknown-trigger", `${rule.ref} subscribes to unknown trigger ${trigger}`, {
            subject: rule.ref,
          }),
        );
      else triggers.push(trigger);
    }
    const usedAliases = new Set(ruleReads(rule));
    for (const read of rule.reads)
      if (!usedAliases.has(read.alias))
        bag.add(warning("structure", "unused-read", `${rule.ref} declares read alias ${read.alias} but never uses it`));
    const derivations = new Map(boundDerivations.map((item) => [item.ref, item]));
    checkCondition(rule.condition, rule.ref, reads, derivations, capabilities, bag);
    if (rule.effects.length === 0) bindingFailure(bag, rule.ref, `${rule.ref} declares no candidate effect`);
    const effects = bindEffects(rule, extension.ref, reads, derivations, capabilities, vocabulary, bag);
    const dependsOn = classifyDependencies(rule);
    for (const dependency of dependsOn)
      if (!packs.rule(dependency) && !packs.derivation(dependency))
        missingReference(bag, rule.ref, `${rule.ref} depends on unknown ${dependency}`);
    boundRules.push({
      ref: rule.ref,
      domain: extension.ref,
      extension,
      source: rule,
      triggers,
      reads: [...reads.values()],
      condition: rule.condition,
      effects,
      dependsOn,
    });
  }

  const flatDerivations = boundDerivations.map((item) => ({
    ref: item.ref,
    deps: [...valueDerivations(item.value)],
  }));
  const flatRules = boundRules.map((item) => ({ ref: item.ref, deps: [...item.dependsOn] }));
  dependencyOrder([...flatDerivations, ...flatRules], bag);

  checkCompositionPlan(boundRules, vocabulary, bag);
  runDomainValidation(packs, capabilities, definitions, boundRules, boundDerivations, bag);
  checkCompatibility(packs, capabilities, bag);

  if (bag.hasErrors) return undefined;

  const order = new Map<string, number>();
  const ordered = dependencyOrder([...flatDerivations, ...flatRules], new DiagnosticBag());
  ordered.forEach((ref, index) => order.set(ref, index));
  const sortByOrder = <T extends { readonly ref: string }>(items: readonly T[]): T[] =>
    [...items].sort((left, right) => {
      const leftIndex = order.get(left.ref);
      const rightIndex = order.get(right.ref);
      const leftKey = leftIndex ?? Number.MAX_SAFE_INTEGER;
      const rightKey = rightIndex ?? Number.MAX_SAFE_INTEGER;
      if (leftKey !== rightKey) return leftKey - rightKey;
      return left.ref < right.ref ? -1 : left.ref > right.ref ? 1 : 0;
    });

  return {
    packs,
    capabilities,
    vocabulary,
    definitions,
    rules: sortByOrder(boundRules),
    derivations: sortByOrder(boundDerivations),
  };
}

/** Stage four: one unambiguous composition plan per output target. */
function checkCompositionPlan(rules: readonly BoundRule[], vocabulary: ConfigVocabulary, bag: DiagnosticBag): void {
  const plans = new Map<string, { composition: CompositionKind; contributors: string[] }>();
  for (const rule of rules) {
    for (const effect of rule.effects) {
      if (effect.kind !== "target") continue;
      const existing = plans.get(effect.target);
      if (existing === undefined) {
        plans.set(effect.target, { composition: effect.composition, contributors: [rule.ref] });
        continue;
      }
      if (existing.composition !== effect.composition) {
        bag.add(
          error(
            "composition",
            "missing-composition",
            `${effect.target} is written with ${existing.composition} by ${existing.contributors.join(", ")} and with ${
              effect.composition
            } by ${rule.ref}`,
            { subject: effect.target },
          ),
        );
        continue;
      }
      existing.contributors.push(rule.ref);
    }
  }
  for (const [target, plan] of plans) {
    if (vocabulary.target(target)?.contract !== true || plan.contributors.length <= 1) continue;
    bag.add(
      error(
        "composition",
        "multiple-writers",
        `Contract value ${target} is written by ${plan.contributors.join(", ")}; a core value has exactly one writer`,
        { subject: target },
      ),
    );
  }
}

/** Stage six: each domain checks its own semantics and invariants. */
function runDomainValidation(
  packs: PackSet,
  capabilities: ExtensionCapabilities,
  definitions: readonly ResolvedDefinition[],
  rules: readonly BoundRule[],
  derivations: readonly BoundDerivation[],
  bag: DiagnosticBag,
): void {
  const definitionIndex = new Map(definitions.map((definition) => [definition.ref, definition]));
  const ruleViews: readonly DomainRuleView[] = rules.map((rule) => ({
    ref: rule.ref,
    domain: rule.domain,
    triggers: rule.triggers,
    targets: rule.effects.filter((effect) => effect.kind === "target").map((effect) => effect.target),
  }));
  const lookup = (ref: string): { readonly type: string } | undefined => {
    const definition = definitionIndex.get(ref);
    if (definition !== undefined) return { type: definition.typeRef };
    const rule = rules.find((candidate) => candidate.ref === ref);
    if (rule !== undefined) return { type: "rule" };
    const derivation = derivations.find((candidate) => candidate.ref === ref);
    if (derivation !== undefined) return { type: "derivation" };
    return undefined;
  };
  const reportFor =
    (subject: string) =>
    (diagnostic: Diagnostic): void => {
      bag.add(diagnostic.subject === undefined ? { ...diagnostic, subject } : diagnostic);
    };

  for (const extension of capabilities.extensionsSorted()) {
    const ownRules = ruleViews.filter((rule) => rule.domain === extension.ref);
    const declarations: readonly ConfigTypeDeclaration[] = extension.extension.configTypes;
    for (const declaration of declarations) {
      if (declaration.validate === undefined) continue;
      const typeRef = configTypeRef(extension, declaration.kind);
      const input: DomainValidationInput = {
        packNamespace: packs.root.manifest.namespace,
        definitions: definitions.filter((definition) => definition.typeRef === typeRef),
        rules: ownRules,
        lookup,
        report: reportFor(typeRef),
      };
      declaration.validate(input);
    }
    if (extension.extension.validate === undefined) continue;
    const input: DomainValidationInput = {
      packNamespace: packs.root.manifest.namespace,
      definitions: definitions.filter((definition) =>
        declarations.some((declaration) => configTypeRef(extension, declaration.kind) === definition.typeRef),
      ),
      rules: ownRules,
      lookup,
      report: reportFor(extension.ref),
    };
    extension.extension.validate(input);
  }
}

/** Stage seven: kernel version and required extensions must line up. */
function checkCompatibility(packs: PackSet, capabilities: ExtensionCapabilities, bag: DiagnosticBag): void {
  for (const namespace of packs.namespaces()) {
    const pack: SourcePack | undefined = packs.pack(namespace);
    if (pack === undefined) continue;
    if (!satisfiesVersion(KERNEL_VERSION, pack.manifest.kernel))
      bag.add(
        error(
          "compatibility",
          "incompatible-extension",
          `Pack ${namespace} requires kernel ${pack.manifest.kernel}, kernel is ${KERNEL_VERSION}`,
          { subject: namespace },
        ),
      );
    for (const requirement of pack.manifest.extensions) {
      const reference = parseQualifiedName(requirement, "extension requirement");
      const registered = capabilities.extension(`${reference.namespace}/${reference.name}`);
      if (registered === undefined) {
        bag.add(
          error(
            "compatibility",
            "incompatible-extension",
            `Pack ${namespace} requires ${requirement}, which is not registered`,
            {
              subject: namespace,
            },
          ),
        );
        continue;
      }
      if (reference.version !== undefined && registered.extension.version !== reference.version)
        bag.add(
          error(
            "compatibility",
            "incompatible-extension",
            `Pack ${namespace} requires ${requirement} but ${registered.ref} is ${registered.extension.version}`,
            { subject: namespace },
          ),
        );
    }
  }
}
