import {
  itemTypeRef,
  parseSystemVersionRef,
  scalarKind,
  schemaProperties,
  type ItemSpec,
  type SystemRule,
  type SystemCheck,
  type LoadedSystem,
  type StateScope,
} from "./system-spec.js";
import type { SystemIndex } from "./system-index.js";
import { conditionFormulas, conditionInputs, type Condition } from "./conditions.js";
import { IssueList, error, warning, type ConfigIssue } from "./diagnostics.js";
import { KERNEL_VERSION, satisfiesVersion } from "./identifiers.js";
import { RATIO_UNIT, mapUnit, checkMap, type CombineMode } from "./numeric.js";
import type { PackSet } from "./packs.js";
import type { MergedItem } from "./config-merge.js";
import type { ParsedFormula, ParsedPack, ParsedInput, ParsedRule } from "./source.js";
import { RuleCatalog, type RuleItem, type CatalogIssue } from "./rule-catalog.js";
import { formulaRefs, inputNames, type ValueExpr } from "./value-expr.js";
import type { TSchema } from "typebox";

/**
 * Stages two to seven of the shared pipeline.
 *
 * Stage one (structure) happens while the system declarations and the pack
 * documents are parsed. This module binds every rule to the systems that own
 * its vocabulary, which both produces the compiled artifact and gives each
 * stage a single, explicit set of facts to check.
 */

export type StaticType = "number" | "boolean" | "string";

export interface CheckedInput {
  readonly name: string;
  readonly stateRef: string;
  readonly field: string;
  readonly unit: string | null;
  readonly valueType: StaticType;
  readonly scope: StateScope;
}

export interface CheckedStateChange {
  readonly kind: "state";
  readonly stateRef: string;
  /** System that owns the state and decides whether to apply the request. */
  readonly system: string;
  readonly combine: CombineMode;
  readonly priority: number | null;
  readonly value: ValueExpr;
  readonly unit: string | null;
  readonly valueType: StaticType | null;
  readonly scope: StateScope;
}

export interface CheckedProcessChange {
  readonly kind: "process";
  readonly processRef: string;
  readonly system: string;
  readonly action: "establish" | "advance" | "pause" | "end" | "cancel";
  readonly params: readonly { readonly name: string; readonly value: ValueExpr }[];
  readonly scope: StateScope;
}

export type CheckedChange = CheckedStateChange | CheckedProcessChange;

export interface CheckedRule {
  readonly ref: string;
  readonly system: string;
  readonly systemSpec: LoadedSystem;
  readonly source: ParsedRule;
  readonly triggers: readonly string[];
  readonly inputs: readonly CheckedInput[];
  readonly condition: Condition;
  readonly changes: readonly CheckedChange[];
  readonly dependsOn: readonly string[];
  readonly evaluationScope: StateScope;
}

export interface CheckedFormula {
  readonly ref: string;
  readonly system: string;
  readonly systemSpec: LoadedSystem;
  readonly source: ParsedFormula;
  readonly inputs: readonly CheckedInput[];
  readonly outputUnit: string;
  readonly value: ValueExpr;
  readonly evaluationScope: StateScope;
}

export interface CheckedConfig {
  readonly packs: PackSet;
  readonly systemIndex: SystemIndex;
  readonly catalog: RuleCatalog;
  readonly items: readonly MergedItem[];
  readonly rules: readonly CheckedRule[];
  readonly formulas: readonly CheckedFormula[];
}

function readValueType(schema: TSchema | undefined): StaticType | null {
  return scalarKind(schema);
}

function staticTypeOf(source: ValueExpr, inputs: Map<string, CheckedInput>): StaticType | null {
  switch (source.kind) {
    case "literal":
      return typeof source.value === "number" ? "number" : typeof source.value === "boolean" ? "boolean" : "string";
    case "read":
      return inputs.get(source.name)?.valueType ?? null;
    case "compare":
      return "boolean";
    case "select": {
      const thenType = staticTypeOf(source.then, inputs);
      const elseType = staticTypeOf(source.otherwise, inputs);
      return thenType !== null && thenType === elseType ? thenType : null;
    }
    case "formula":
      return "number";
    default:
      return "number";
  }
}

function staticUnitOf(
  source: ValueExpr,
  inputs: Map<string, CheckedInput>,
  formulas: Map<string, CheckedFormula>,
): string | null {
  switch (source.kind) {
    case "literal":
      return typeof source.value === "number" ? source.unit : null;
    case "read":
      return inputs.get(source.name)?.unit ?? null;
    case "formula":
      return formulas.get(source.formulaRef)?.outputUnit ?? null;
    case "combine": {
      const first = source.operands[0];
      if (first === undefined) return null;
      return source.method === "multiply" ? "" : staticUnitOf(first, inputs, formulas);
    }
    case "compare":
      return null;
    case "select": {
      const thenUnit = staticUnitOf(source.then, inputs, formulas);
      const elseUnit = staticUnitOf(source.otherwise, inputs, formulas);
      return thenUnit !== null && thenUnit === elseUnit ? thenUnit : null;
    }
    default:
      return mapUnit(source.mapping);
  }
}

function bindingFailure(bag: IssueList, subject: string, message: string): void {
  bag.add(error("structure", "structure-invalid", message, { subject }));
}

function missingReference(bag: IssueList, subject: string, message: string): void {
  bag.add(error("reference", "unknown-reference", message, { subject }));
}

/** Stage two and five: bind inputs, checking existence, permission and units. */
function bindInputs(
  inputs: readonly ParsedInput[],
  subject: string,
  systemId: string,
  systemIndex: SystemIndex,
  catalog: RuleCatalog,
  bag: IssueList,
): Map<string, CheckedInput> | undefined {
  const bound = new Map<string, CheckedInput>();
  for (const read of inputs) {
    if (bound.has(read.name)) {
      bindingFailure(bag, subject, `${subject} declares read name ${read.name} twice`);
      continue;
    }
    const separator = read.stateRef.lastIndexOf(".");
    const inputRef = separator === -1 ? read.stateRef : read.stateRef.slice(0, separator);
    const fieldName = separator === -1 ? "" : read.stateRef.slice(separator + 1);
    const input = catalog.input(inputRef);
    if (input === undefined) {
      const other = catalog.category(inputRef) ?? systemIndex.all(inputRef)?.ref;
      bag.add(
        error(
          "reference",
          other === undefined ? "unknown-reference" : "reference-type-mismatch",
          other === undefined
            ? `${subject} inputs unknown input ${inputRef}`
            : `${subject} inputs ${inputRef}, which is a ${catalog.category(inputRef) ?? "declared name but not an input"}`,
          { subject },
        ),
      );
      continue;
    }
    if (!systemIndex.grants(input.exposedTo, input.system, systemId)) {
      bag.add(
        error(
          "permission",
          "unauthorized-read",
          `${subject} (${systemId}) is not allowed to read input ${inputRef} handled by ${input.system}`,
          { subject },
        ),
      );
      continue;
    }
    const field = input.fields.get(fieldName);
    if (field === undefined) {
      const declared = input.schema === null ? undefined : schemaProperties(input.schema)[fieldName];
      if (declared === undefined)
        missingReference(bag, subject, `${subject} inputs unknown field ${fieldName} of input ${inputRef}`);
      else bindingFailure(bag, subject, `${subject} inputs ${read.stateRef}, which is not a scalar field`);
      continue;
    }
    bound.set(read.name, {
      name: read.name,
      stateRef: inputRef,
      field: fieldName,
      unit: field.valueType === "number" ? field.unit : null,
      valueType: field.valueType,
      scope: input.scope,
    });
  }
  return bound.size === inputs.length ? bound : bound.size === 0 ? undefined : bound;
}

function findSystem(
  systemId: string,
  subject: string,
  systemIndex: SystemIndex,
  bag: IssueList,
): LoadedSystem | undefined {
  const system = systemIndex.system(systemId);
  if (system !== undefined) return system;
  const other = systemIndex.all(systemId);
  bag.add(
    error(
      "reference",
      other === undefined ? "unknown-reference" : "reference-type-mismatch",
      other === undefined
        ? `${subject} declares unknown system ${systemId}`
        : `${subject} declares ${systemId} as a system, which is a ${other?.declaration === undefined ? "different declaration" : "non-system declaration"}`,
      { subject },
    ),
  );
  return undefined;
}

function checkValueUnits(
  source: ValueExpr,
  subject: string,
  inputs: Map<string, CheckedInput>,
  formulas: Map<string, CheckedFormula>,
  bag: IssueList,
): void {
  if (source.kind === "map") {
    bag.addAll(
      checkMap(source.mapping, `${subject}.value`).map((problem) =>
        error("structure", "structure-invalid", problem, { subject }),
      ),
    );
    const inputUnit = staticUnitOf(source.input, inputs, formulas);
    const declaredInput = source.mapping.inputUnit;
    if (inputUnit !== null && inputUnit !== declaredInput)
      bag.add(
        error(
          "combine",
          "unit-mismatch",
          `${subject}: mapping expects ${declaredInput === "" ? "a dimensionless input" : declaredInput} but its input carries ${
            inputUnit === "" ? "no unit" : inputUnit
          }`,
          { subject },
        ),
      );
    checkValueUnits(source.input, subject, inputs, formulas, bag);
    return;
  }
  if (source.kind === "compare") {
    const leftType = staticTypeOf(source.left, inputs);
    const rightType = staticTypeOf(source.right, inputs);
    if (leftType !== null && rightType !== null && leftType !== rightType)
      bag.add(
        error("combine", "incompatible-output-type", `${subject}: comparison mixes ${leftType} and ${rightType}`, {
          subject,
        }),
      );
    else if (leftType === "number") {
      const leftUnit = staticUnitOf(source.left, inputs, formulas);
      const rightUnit = staticUnitOf(source.right, inputs, formulas);
      if (leftUnit !== null && rightUnit !== null && leftUnit !== rightUnit)
        bag.add(
          error("combine", "unit-mismatch", `${subject}: comparison mixes units ${leftUnit} and ${rightUnit}`, {
            subject,
          }),
        );
    }
    checkValueUnits(source.left, subject, inputs, formulas, bag);
    checkValueUnits(source.right, subject, inputs, formulas, bag);
    return;
  }
  if (source.kind === "select") {
    const leftType = staticTypeOf(source.left, inputs);
    const rightType = staticTypeOf(source.right, inputs);
    if (leftType !== null && rightType !== null && leftType !== rightType)
      bag.add(
        error("combine", "incompatible-output-type", `${subject}: selection compares ${leftType} with ${rightType}`, {
          subject,
        }),
      );
    else if (leftType === "number") {
      const leftUnit = staticUnitOf(source.left, inputs, formulas);
      const rightUnit = staticUnitOf(source.right, inputs, formulas);
      if (leftUnit !== null && rightUnit !== null && leftUnit !== rightUnit)
        bag.add(
          error("combine", "unit-mismatch", `${subject}: selection compares units ${leftUnit} and ${rightUnit}`, {
            subject,
          }),
        );
    }
    const thenType = staticTypeOf(source.then, inputs);
    const elseType = staticTypeOf(source.otherwise, inputs);
    if (thenType !== null && elseType !== null && thenType !== elseType)
      bag.add(
        error(
          "combine",
          "incompatible-output-type",
          `${subject}: selection branches produce ${thenType} and ${elseType}`,
          { subject },
        ),
      );
    else if (thenType === "number") {
      const thenUnit = staticUnitOf(source.then, inputs, formulas);
      const elseUnit = staticUnitOf(source.otherwise, inputs, formulas);
      if (thenUnit !== null && elseUnit !== null && thenUnit !== elseUnit)
        bag.add(
          error(
            "combine",
            "unit-mismatch",
            `${subject}: selection branches produce units ${thenUnit} and ${elseUnit}`,
            { subject },
          ),
        );
    }
    for (const branch of [source.left, source.right, source.then, source.otherwise])
      checkValueUnits(branch, subject, inputs, formulas, bag);
    return;
  }
  if (source.kind !== "combine") return;
  if (source.operands.length < 2)
    bindingFailure(bag, subject, `${subject}: combination ${source.method} needs at least two operands`);
  const multiplicative = source.method === "multiply";
  const firstOperand = source.operands[0];
  const expected = multiplicative || firstOperand === undefined ? null : staticUnitOf(firstOperand, inputs, formulas);
  for (const operand of source.operands) {
    const type = staticTypeOf(operand, inputs);
    if (type !== null && type !== "number")
      bag.add(
        error(
          "combine",
          "incompatible-output-type",
          `${subject}: combination ${source.method} requires numbers but receives ${type}`,
          { subject },
        ),
      );
    const unit = staticUnitOf(operand, inputs, formulas);
    if (unit === null) continue;
    if (multiplicative) {
      if (unit !== "" && unit !== RATIO_UNIT)
        bag.add(
          error(
            "combine",
            "unit-mismatch",
            `${subject}: combination multiply requires dimensionless operands but receives ${unit}`,
            { subject },
          ),
        );
    } else if (expected !== null && unit !== expected)
      bag.add(
        error(
          "combine",
          "unit-mismatch",
          `${subject}: combination ${source.method} mixes units ${expected} and ${unit}`,
          { subject },
        ),
      );
    checkValueUnits(operand, subject, inputs, formulas, bag);
  }
}

/** Stage four: value type and unit compatibility of one declared value. */
function checkValueCompatibility(
  source: ValueExpr,
  expectedType: StaticType,
  expectedUnit: string | null,
  subject: string,
  inputs: Map<string, CheckedInput>,
  formulas: Map<string, CheckedFormula>,
  bag: IssueList,
): void {
  // The source's own consistency is checked first: an inconsistent source is
  // inexpressible even when the target's declared type cannot be compared to it.
  checkValueUnits(source, subject, inputs, formulas, bag);
  const type = staticTypeOf(source, inputs);
  if (type !== null && type !== expectedType)
    bag.add(
      error(
        "combine",
        "incompatible-output-type",
        `${subject}: value of type ${type} cannot feed a ${expectedType} target`,
        { subject },
      ),
    );
  if (expectedType !== "number") return;
  const unit = staticUnitOf(source, inputs, formulas);
  if (unit !== null && unit !== expectedUnit)
    bag.add(
      error(
        "combine",
        "unit-mismatch",
        `${subject}: value carries unit ${unit}, the target declares ${String(expectedUnit)}`,
        { subject },
      ),
    );
}

function bindChanges(
  rule: ParsedRule,
  systemId: string,
  inputs: Map<string, CheckedInput>,
  formulas: Map<string, CheckedFormula>,
  systemIndex: SystemIndex,
  catalog: RuleCatalog,
  bag: IssueList,
): CheckedChange[] {
  const changes: CheckedChange[] = [];
  for (const change of rule.changes) {
    if (change.kind === "process") {
      const process = systemIndex.process(change.processRef);
      if (process === undefined) {
        missingReference(bag, rule.ref, `${rule.ref} declares unknown process ${change.processRef}`);
        continue;
      }
      if (process.system.systemId !== systemId) {
        bag.add(
          error(
            "permission",
            "unauthorized-change",
            `${rule.ref} may not operate process ${change.processRef} handled by ${process.system.systemId}`,
            { subject: rule.ref },
          ),
        );
        continue;
      }
      if (!process.declaration.operations.includes(change.action)) {
        bag.add(
          error(
            "combine",
            "combine-not-allowed",
            `${rule.ref} declares action ${change.action}, which process ${change.processRef} does not allow`,
            { subject: rule.ref },
          ),
        );
        continue;
      }
      const parameters = Object.entries(change.params).map(([name, value]) => ({ name, value }));
      const declared = schemaProperties(process.declaration.parameters);
      for (const parameter of parameters) {
        const schema = declared[parameter.name];
        if (schema === undefined) {
          bindingFailure(
            bag,
            rule.ref,
            `${rule.ref} passes unknown parameter ${parameter.name} to process ${change.processRef}`,
          );
          continue;
        }
        const expected = readValueType(schema);
        const actual = staticTypeOf(parameter.value, inputs);
        if (expected !== null && actual !== null && expected !== actual)
          bag.add(
            error(
              "combine",
              "incompatible-output-type",
              `${rule.ref}: parameter ${parameter.name} of ${change.processRef} is ${expected} but receives ${actual}`,
              { subject: rule.ref },
            ),
          );
      }
      for (const name of Object.keys(declared))
        if (!(name in change.params))
          bindingFailure(bag, rule.ref, `${rule.ref} must declare parameter ${name} of process ${change.processRef}`);
      changes.push({
        kind: "process",
        processRef: change.processRef,
        system: process.system.systemId,
        action: change.action,
        params: parameters,
        scope: process.declaration.scope,
      });
      for (const parameter of parameters)
        checkValueUnits(parameter.value, `${rule.ref}.${change.processRef}.${parameter.name}`, inputs, formulas, bag);
      continue;
    }

    const target = catalog.output(change.stateRef);
    if (target === undefined) {
      const kind = catalog.category(change.stateRef);
      const other = kind ?? systemIndex.all(change.stateRef)?.ref;
      bag.add(
        error(
          "reference",
          other === undefined ? "unknown-reference" : "reference-type-mismatch",
          other === undefined
            ? `${rule.ref} declares unknown state output ${change.stateRef}`
            : `${rule.ref} declares ${change.stateRef} as state output, which is a ${kind ?? "different declared name"}`,
          { subject: rule.ref },
        ),
      );
      continue;
    }
    if (!systemIndex.grants(target.exposedTo, target.system, systemId)) {
      bag.add(
        error(
          "permission",
          "unauthorized-change",
          `${rule.ref} (${systemId}) may not request state ${change.stateRef} handled by ${target.system}`,
          { subject: rule.ref },
        ),
      );
      continue;
    }
    if (change.combine === "priority" && change.priority === null) {
      bag.add(
        error(
          "structure",
          "structure-invalid",
          `${rule.ref} combines ${change.stateRef} by priority without a priority`,
          {
            subject: rule.ref,
          },
        ),
      );
      continue;
    }
    if (change.combine !== "priority" && change.priority !== null) {
      bag.add(
        error(
          "structure",
          "structure-invalid",
          `${rule.ref} declares a priority for the non-priority state ${change.stateRef}`,
          { subject: rule.ref },
        ),
      );
      continue;
    }
    if (change.combine !== "priority" && target.valueType !== "number") {
      bag.add(
        error(
          "combine",
          "incompatible-output-type",
          `${rule.ref} combines ${change.stateRef} with ${change.combine}, which requires a numeric state`,
          { subject: rule.ref },
        ),
      );
      continue;
    }
    if (change.combine === "multiply" && target.unit !== RATIO_UNIT) {
      bag.add(
        error(
          "combine",
          "combine-not-allowed",
          `${rule.ref} multiplies ${change.stateRef}, whose declared unit "${target.unit}" is not "${RATIO_UNIT}"`,
          { subject: rule.ref },
        ),
      );
      continue;
    }
    checkValueCompatibility(
      change.value,
      target.valueType,
      target.valueType === "number" ? target.unit : null,
      `${rule.ref}->${change.stateRef}`,
      inputs,
      formulas,
      bag,
    );
    changes.push({
      kind: "state",
      stateRef: change.stateRef,
      system: target.system,
      combine: change.combine,
      priority: change.priority,
      value: change.value,
      unit: staticUnitOf(change.value, inputs, formulas),
      valueType: staticTypeOf(change.value, inputs),
      scope: target.scope,
    });
  }
  return changes;
}

function checkCondition(
  condition: Condition,
  subject: string,
  inputs: Map<string, CheckedInput>,
  formulas: Map<string, CheckedFormula>,
  systemIndex: SystemIndex,
  bag: IssueList,
): void {
  switch (condition.op) {
    case "all":
    case "any":
      for (const operand of condition.operands) checkCondition(operand, subject, inputs, formulas, systemIndex, bag);
      return;
    case "not":
      checkCondition(condition.operand, subject, inputs, formulas, systemIndex, bag);
      return;
    case "compare": {
      const leftUnit = staticUnitOf(condition.left, inputs, formulas);
      const rightUnit = staticUnitOf(condition.right, inputs, formulas);
      const leftType = staticTypeOf(condition.left, inputs);
      const rightType = staticTypeOf(condition.right, inputs);
      if (leftType !== null && rightType !== null && leftType !== rightType)
        bag.add(
          error("combine", "incompatible-output-type", `${subject}: comparison mixes ${leftType} and ${rightType}`, {
            subject,
          }),
        );
      else if (leftType === "number" && leftUnit !== rightUnit)
        bag.add(
          error(
            "combine",
            "unit-mismatch",
            `${subject}: comparison mixes units ${String(leftUnit)} and ${String(rightUnit)}`,
            { subject },
          ),
        );
      checkValueUnits(condition.left, subject, inputs, formulas, bag);
      checkValueUnits(condition.right, subject, inputs, formulas, bag);
      return;
    }
    case "within":
      checkValueUnits(condition.value, subject, inputs, formulas, bag);
      if (staticTypeOf(condition.value, inputs) === "number" && condition.min === null && condition.max === null)
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
  systemIndex: SystemIndex,
  items: readonly MergedItem[],
  bag: IssueList,
): void {
  for (const item of items) {
    const capability = systemIndex.configType(item.typeRef);
    if (capability === undefined) continue;
    for (const [field, allowed] of Object.entries(capability.declaration.references ?? {})) {
      const value = item.values[field];
      if (value === undefined) continue;
      const targets = Array.isArray(value) ? value : [value];
      for (const target of targets) {
        if (typeof target !== "string") {
          bindingFailure(bag, item.ref, `${item.ref}.${field} must hold item identities`);
          continue;
        }
        const resolved = packs.item(target);
        if (resolved === undefined) {
          missingReference(bag, item.ref, `${item.ref}.${field} references unknown ${target}`);
          continue;
        }
        if (!packs.checkVisibility(item.namespace, target)) {
          bag.add(
            error(
              "reference",
              "namespace-not-visible",
              `${item.ref}.${field} references ${target}, which ${item.namespace} cannot address: ${packs.explainVisibility(
                item.namespace,
                target,
              )}`,
              { subject: item.ref },
            ),
          );
          continue;
        }
        if (!allowed.includes(resolved.typeRef)) {
          bag.add(
            error(
              "reference",
              "reference-type-mismatch",
              `${item.ref}.${field} must reference ${allowed.join(" or ")}, not ${resolved.typeRef}`,
              { subject: item.ref },
            ),
          );
        }
      }
    }
  }
}

/** Stage two: dependency graph over rules and formulas. */
function dependencyOrder(
  nodes: readonly { readonly ref: string; readonly deps: readonly string[] }[],
  bag: IssueList,
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

function classifyDependencies(rule: ParsedRule): readonly string[] {
  return [
    ...rule.dependsOn,
    ...conditionFormulas(rule.condition),
    ...rule.changes.flatMap((change) =>
      change.kind === "process" ? Object.values(change.params).flatMap(formulaRefs) : formulaRefs(change.value),
    ),
  ];
}

function ruleReads(rule: ParsedRule): readonly string[] {
  return [
    ...conditionInputs(rule.condition),
    ...rule.changes.flatMap((change) =>
      change.kind === "process" ? Object.values(change.params).flatMap(inputNames) : inputNames(change.value),
    ),
  ];
}

function scopeFromInputs(inputs: readonly CheckedInput[], usedAliases: ReadonlySet<string>): StateScope {
  return inputs.some((input) => usedAliases.has(input.name) && input.scope === "entity") ? "entity" : "shared";
}

function resolveFormulaScopes(formulas: readonly CheckedFormula[]): CheckedFormula[] {
  const byRef = new Map(formulas.map((formula) => [formula.ref, formula]));
  const memo = new Map<string, StateScope>();
  const visiting = new Set<string>();
  const resolve = (formula: CheckedFormula): StateScope => {
    const cached = memo.get(formula.ref);
    if (cached !== undefined) return cached;
    if (visiting.has(formula.ref)) return formula.evaluationScope;
    visiting.add(formula.ref);
    const scope =
      formula.evaluationScope === "entity" ||
      formulaRefs(formula.value).some((ref) => {
        const dependency = byRef.get(ref);
        return dependency !== undefined && resolve(dependency) === "entity";
      })
        ? "entity"
        : "shared";
    visiting.delete(formula.ref);
    memo.set(formula.ref, scope);
    return scope;
  };
  return formulas.map((formula) => ({ ...formula, evaluationScope: resolve(formula) }));
}

export function checkConfig(
  packs: PackSet,
  systemIndex: SystemIndex,
  items: readonly MergedItem[],
  bag: IssueList,
): CheckedConfig | undefined {
  checkDefinitionReferences(packs, systemIndex, items, bag);

  const catalogProblems: CatalogIssue[] = [];
  const catalogItems: RuleItem[] = items.map((item) => ({
    ref: item.ref,
    typeRef: item.typeRef,
    namespace: item.namespace,
    name: item.name,
    values: item.values,
  }));
  const catalog = new RuleCatalog(systemIndex.systemsSorted(), catalogItems, catalogProblems);
  for (const problem of catalogProblems)
    bag.add(
      problem.scope === "structure"
        ? error("structure", "structure-invalid", problem.message, {
            ...(problem.subject === undefined ? {} : { subject: problem.subject }),
          })
        : error("system", "invalid-value", problem.message, {
            ...(problem.subject === undefined ? {} : { subject: problem.subject }),
          }),
    );

  const checkedRules: CheckedRule[] = [];
  let checkedFormulas: CheckedFormula[] = [];

  for (const formula of packs.formulas()) {
    const system = findSystem(formula.system, formula.ref, systemIndex, bag);
    if (system === undefined) continue;
    const inputs = bindInputs(formula.inputs, formula.ref, system.systemId, systemIndex, catalog, bag);
    if (inputs === undefined) continue;
    for (const read of formula.inputs)
      if (!inputNames(formula.value).includes(read.name))
        bag.add(
          warning("structure", "unused-read", `${formula.ref} declares read name ${read.name} but never uses it`),
        );
    checkValueUnits(formula.value, formula.ref, inputs, new Map(), bag);
    if (staticTypeOf(formula.value, inputs) !== "number")
      bag.add(
        error(
          "combine",
          "incompatible-output-type",
          `${formula.ref} must resolve to a number to expose an output unit`,
          { subject: formula.ref },
        ),
      );
    else {
      const unit = staticUnitOf(formula.value, inputs, new Map());
      if (unit !== formula.outputUnit)
        bag.add(
          error(
            "combine",
            "unit-mismatch",
            `${formula.ref} declares output unit ${formula.outputUnit} but produces ${String(unit)}`,
            { subject: formula.ref },
          ),
        );
    }
    checkedFormulas.push({
      ref: formula.ref,
      system: system.systemId,
      systemSpec: system,
      source: formula,
      inputs: [...inputs.values()],
      outputUnit: formula.outputUnit,
      value: formula.value,
      evaluationScope: scopeFromInputs([...inputs.values()], new Set(inputNames(formula.value))),
    });
  }

  checkedFormulas = resolveFormulaScopes(checkedFormulas);

  for (const rule of packs.rules()) {
    const system = findSystem(rule.system, rule.ref, systemIndex, bag);
    if (system === undefined) continue;
    const inputs = bindInputs(rule.inputs, rule.ref, system.systemId, systemIndex, catalog, bag);
    if (inputs === undefined) continue;
    const triggers: string[] = [];
    for (const trigger of rule.triggers) {
      if (systemIndex.trigger(trigger) === undefined)
        bag.add(
          error("reference", "unknown-trigger", `${rule.ref} subscribes to unknown trigger ${trigger}`, {
            subject: rule.ref,
          }),
        );
      else triggers.push(trigger);
    }
    const usedAliases = new Set(ruleReads(rule));
    for (const read of rule.inputs)
      if (!usedAliases.has(read.name))
        bag.add(warning("structure", "unused-read", `${rule.ref} declares read name ${read.name} but never uses it`));
    const formulas = new Map(checkedFormulas.map((item) => [item.ref, item]));
    checkCondition(rule.condition, rule.ref, inputs, formulas, systemIndex, bag);
    if (rule.changes.length === 0) bindingFailure(bag, rule.ref, `${rule.ref} declares no state change`);
    const changes = bindChanges(rule, system.systemId, inputs, formulas, systemIndex, catalog, bag);
    const dependsOn = classifyDependencies(rule);
    for (const dependency of dependsOn)
      if (!packs.rule(dependency) && !packs.formula(dependency))
        missingReference(bag, rule.ref, `${rule.ref} depends on unknown ${dependency}`);
    const changeScopes = [...new Set(changes.map((change) => change.scope))];
    if (changeScopes.length > 1)
      bag.add(
        error(
          "combine",
          "incompatible-output-type",
          `${rule.ref} mixes shared and entity changes; one rule must have one evaluation scope`,
          { subject: rule.ref },
        ),
      );
    const evaluationScope = changeScopes[0] ?? "shared";
    const readScope = scopeFromInputs([...inputs.values()], usedAliases);
    const formulaScope = dependsOn.some((ref) => formulas.get(ref)?.evaluationScope === "entity") ? "entity" : "shared";
    if (evaluationScope === "shared" && (readScope === "entity" || formulaScope === "entity"))
      bag.add(
        error("permission", "unauthorized-change", `${rule.ref} cannot use entity state to produce a shared change`, {
          subject: rule.ref,
        }),
      );
    checkedRules.push({
      ref: rule.ref,
      system: system.systemId,
      systemSpec: system,
      source: rule,
      triggers,
      inputs: [...inputs.values()],
      condition: rule.condition,
      changes,
      dependsOn,
      evaluationScope,
    });
  }

  const flatFormulas = checkedFormulas.map((item) => ({
    ref: item.ref,
    deps: [...formulaRefs(item.value)],
  }));
  const flatRules = checkedRules.map((item) => ({ ref: item.ref, deps: [...item.dependsOn] }));
  dependencyOrder([...flatFormulas, ...flatRules], bag);

  checkCombinePlan(checkedRules, catalog, bag);
  checkSystems(packs, systemIndex, items, checkedRules, checkedFormulas, bag);
  checkCompatibility(packs, systemIndex, bag);

  if (bag.hasErrors) return undefined;

  const order = new Map<string, number>();
  const ordered = dependencyOrder([...flatFormulas, ...flatRules], new IssueList());
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
    systemIndex,
    catalog,
    items,
    rules: sortByOrder(checkedRules),
    formulas: sortByOrder(checkedFormulas),
  };
}

/** Stage four: one unambiguous combine plan per output target. */
function checkCombinePlan(rules: readonly CheckedRule[], catalog: RuleCatalog, bag: IssueList): void {
  const plans = new Map<string, { combine: CombineMode; sourceRules: string[] }>();
  for (const rule of rules) {
    for (const change of rule.changes) {
      if (change.kind !== "state") continue;
      const existing = plans.get(change.stateRef);
      if (existing === undefined) {
        plans.set(change.stateRef, { combine: change.combine, sourceRules: [rule.ref] });
        continue;
      }
      if (existing.combine !== change.combine) {
        bag.add(
          error(
            "combine",
            "missing-combine",
            `${change.stateRef} is written with ${existing.combine} by ${existing.sourceRules.join(", ")} and with ${
              change.combine
            } by ${rule.ref}`,
            { subject: change.stateRef },
          ),
        );
        continue;
      }
      existing.sourceRules.push(rule.ref);
    }
  }
  for (const [stateRef, plan] of plans) {
    if (catalog.output(stateRef)?.contract !== true || plan.sourceRules.length <= 1) continue;
    bag.add(
      error(
        "combine",
        "multiple-writers",
        `Contract value ${stateRef} is written by ${plan.sourceRules.join(", ")}; a core value has exactly one writer`,
        { subject: stateRef },
      ),
    );
  }
}

/** Stage six: each system checks its own semantics and invariants. */
function checkSystems(
  packs: PackSet,
  systemIndex: SystemIndex,
  items: readonly MergedItem[],
  rules: readonly CheckedRule[],
  formulas: readonly CheckedFormula[],
  bag: IssueList,
): void {
  const definitionIndex = new Map(items.map((item) => [item.ref, item]));
  const ruleViews: readonly SystemRule[] = rules.map((rule) => ({
    ref: rule.ref,
    system: rule.system,
    triggers: rule.triggers,
    targets: rule.changes.filter((change) => change.kind === "state").map((change) => change.stateRef),
  }));
  const lookup = (ref: string): { readonly type: string } | undefined => {
    const item = definitionIndex.get(ref);
    if (item !== undefined) return { type: item.typeRef };
    const rule = rules.find((candidate) => candidate.ref === ref);
    if (rule !== undefined) return { type: "rule" };
    const formula = formulas.find((candidate) => candidate.ref === ref);
    if (formula !== undefined) return { type: "formula" };
    return undefined;
  };
  const reportFor =
    (subject: string) =>
    (diagnostic: ConfigIssue): void => {
      bag.add(diagnostic.subject === undefined ? { ...diagnostic, subject } : diagnostic);
    };

  for (const system of systemIndex.systemsSorted()) {
    const ownRules = ruleViews.filter((rule) => rule.system === system.systemId);
    const declarations: readonly ItemSpec[] = system.spec.items;
    for (const declaration of declarations) {
      if (declaration.validate === undefined) continue;
      const typeRef = itemTypeRef(system, declaration.kind);
      const input: SystemCheck = {
        packNamespace: packs.root.manifest.namespace,
        items: items.filter((item) => item.typeRef === typeRef),
        rules: ownRules,
        lookup,
        report: reportFor(typeRef),
      };
      declaration.validate(input);
    }
    if (system.spec.validate === undefined) continue;
    const input: SystemCheck = {
      packNamespace: packs.root.manifest.namespace,
      items: items.filter((item) =>
        declarations.some((declaration) => itemTypeRef(system, declaration.kind) === item.typeRef),
      ),
      rules: ownRules,
      lookup,
      report: reportFor(system.systemId),
    };
    system.spec.validate(input);
  }
}

/** Stage seven: kernel version and required systems must line up. */
function checkCompatibility(packs: PackSet, systemIndex: SystemIndex, bag: IssueList): void {
  for (const namespace of packs.namespaces()) {
    const pack: ParsedPack | undefined = packs.pack(namespace);
    if (pack === undefined) continue;
    if (!satisfiesVersion(KERNEL_VERSION, pack.manifest.kernel))
      bag.add(
        error(
          "compatibility",
          "incompatible-system",
          `Pack ${namespace} requires kernel ${pack.manifest.kernel}, kernel is ${KERNEL_VERSION}`,
          { subject: namespace },
        ),
      );
    for (const requirement of pack.manifest.systems) {
      const reference = parseSystemVersionRef(requirement, "system requirement");
      const registered = systemIndex.system(reference.systemId);
      if (registered === undefined) {
        bag.add(
          error(
            "compatibility",
            "incompatible-system",
            `Pack ${namespace} requires ${requirement}, which is not registered`,
            {
              subject: namespace,
            },
          ),
        );
        continue;
      }
      if (reference.version !== undefined && registered.spec.version !== reference.version)
        bag.add(
          error(
            "compatibility",
            "incompatible-system",
            `Pack ${namespace} requires ${requirement} but ${registered.systemId} is ${registered.spec.version}`,
            { subject: namespace },
          ),
        );
    }
  }
}
