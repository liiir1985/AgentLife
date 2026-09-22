import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { evaluateCondition } from "../src/config/conditions.js";
import type { DomainExtension } from "../src/config/extension.js";
import { ExtensionRegistry } from "../src/config/extension.js";
import {
  applyNumericPolicy,
  evaluateMapping,
  isWithinRange,
  validateMapping,
  validateNumericPolicy,
  type NumericMapping,
  type NumericPolicy,
} from "../src/config/numeric.js";
import { resolveNumericPolicy } from "../src/config/numeric.js";
import { defineValueContainer } from "../src/config/value-shapes.js";
import { evaluateValue, type ValueScope } from "../src/config/values.js";

const POLICY: NumericPolicy = {
  unit: "points",
  rounding: { mode: "half-away-from-zero", precision: 1 },
  range: { min: 0, max: 100, boundary: "inclusive" },
  overflow: "saturate",
};

function scopeOf(values: Readonly<Record<string, unknown>>): ValueScope {
  return {
    read: (alias) => (alias in values ? { found: true, value: values[alias] } : { found: false }),
    unitOf: () => "points",
    derive: (ref) => ({ ok: false, reason: "inexpressible", message: `no derivation ${ref}` }),
    simulationTime: { tick: 5, seconds: 50 },
  };
}

describe("numeric policy", () => {
  it("rounds by the declared mode and precision", () => {
    expect(applyNumericPolicy(2.25, POLICY)).toEqual({ ok: true, value: 2.3 });
    expect(applyNumericPolicy(-2.25, POLICY)).toEqual({ ok: true, value: 0 });
    expect(applyNumericPolicy(-0.05, { ...POLICY, range: { min: -10, max: 10, boundary: "inclusive" } })).toEqual({
      ok: true,
      value: -0.1,
    });
    const flooring: NumericPolicy = { ...POLICY, rounding: { mode: "floor", precision: 0 } };
    expect(applyNumericPolicy(2.9, flooring)).toEqual({ ok: true, value: 2 });
    const ceiling: NumericPolicy = { ...POLICY, rounding: { mode: "ceil", precision: 0 } };
    expect(applyNumericPolicy(2.1, ceiling)).toEqual({ ok: true, value: 3 });
    const truncating: NumericPolicy = { ...POLICY, rounding: { mode: "truncate", precision: 0 } };
    expect(applyNumericPolicy(-2.9, { ...truncating, range: { min: -10, max: 10, boundary: "inclusive" } })).toEqual({
      ok: true,
      value: -2,
    });
  });

  it("saturates or refuses an out-of-range result as declared", () => {
    expect(applyNumericPolicy(140, POLICY)).toEqual({ ok: true, value: 100 });
    expect(applyNumericPolicy(-40, POLICY)).toEqual({ ok: true, value: 0 });
    const exclusive: NumericPolicy = {
      ...POLICY,
      rounding: { mode: "none", precision: 0 },
      range: { min: 0, max: 1, boundary: "exclusive" },
    };
    const saturated = applyNumericPolicy(2, exclusive);
    expect(saturated.ok && saturated.value > 0 && saturated.value < 1).toBe(true);
    expect(isWithinRange(saturated.ok ? saturated.value : 0, exclusive.range)).toBe(true);
    expect(applyNumericPolicy(140, { ...POLICY, overflow: "reject" })).toEqual({
      ok: false,
      reason: "out-of-range",
      message: expect.any(String),
    });
    expect(applyNumericPolicy(Number.NaN, POLICY).ok).toBe(false);
  });

  it("requires every part of the numeric semantics to be declared", () => {
    expect(validateNumericPolicy(POLICY, "policy")).toEqual([]);
    expect(validateNumericPolicy({ ...POLICY, unit: "" }, "policy")).toEqual([]);
    expect(validateNumericPolicy({ ...POLICY, unit: "two words" }, "policy")).toContain(
      "policy.unit is not a unit name",
    );
    expect(validateNumericPolicy({ ...POLICY, rounding: { mode: "none", precision: 2 } }, "policy")).toContain(
      'policy.rounding.precision must be 0 when the rounding mode is "none"',
    );
    expect(
      validateNumericPolicy({ ...POLICY, rounding: { mode: "half-away-from-zero", precision: 12 } }, "policy"),
    ).toContain("policy.rounding.precision must be an integer between 0 and 9");
    expect(validateNumericPolicy({ ...POLICY, range: { min: 10, max: 1, boundary: "inclusive" } }, "policy")).toContain(
      "policy.range.min must not exceed range.max",
    );
    expect(validateNumericPolicy({ ...POLICY, range: { min: 5, max: 5, boundary: "exclusive" } }, "policy")).toContain(
      "policy.range has an empty interval",
    );
  });

  it("refuses a mapping whose bands overlap or whose out-of-range behaviour is undeclared", () => {
    const overlapping: NumericMapping = {
      kind: "piecewise-constant",
      inputUnit: "points",
      bands: [
        { from: null, value: 0 },
        { from: 10, value: 1 },
        { from: 10, value: 2 },
      ],
      outOfRange: { kind: "clamp" },
      policy: POLICY,
    };
    expect(validateMapping(overlapping, "mapping").join(" ")).toContain("increase strictly");

    const displaced: NumericMapping = {
      ...overlapping,
      bands: [
        { from: 5, value: 0 },
        { from: null, value: 1 },
      ],
    };
    expect(validateMapping(displaced, "mapping").join(" ")).toContain("only for the first band");

    const undeclared = {
      kind: "piecewise-linear",
      inputUnit: "points",
      points: [
        { x: 0, y: 0 },
        { x: 1, y: 1 },
      ],
      policy: POLICY,
    } as unknown as NumericMapping;
    expect(validateMapping(undeclared, "mapping").join(" ")).toContain("out-of-range behaviour");

    const singlePoint: NumericMapping = {
      kind: "piecewise-linear",
      inputUnit: "points",
      points: [{ x: 0, y: 0 }],
      outOfRange: { kind: "invalid" },
      policy: POLICY,
    };
    expect(validateMapping(singlePoint, "mapping").join(" ")).toContain("at least two points");
  });

  it("fills an absent policy part with the constraint-free default instead of guessing", () => {
    expect(resolveNumericPolicy(undefined)).toBeNull();
    expect(resolveNumericPolicy({})).toEqual({
      unit: "",
      rounding: { mode: "none", precision: 0 },
      range: { min: null, max: null, boundary: "inclusive" },
      overflow: "saturate",
    });
    expect(resolveNumericPolicy({ unit: "lux", range: { max: 10 } })).toEqual({
      unit: "lux",
      rounding: { mode: "none", precision: 0 },
      range: { min: null, max: 10, boundary: "inclusive" },
      overflow: "saturate",
    });
  });
});

describe("declared mappings", () => {
  const threshold: NumericMapping = {
    kind: "threshold",
    inputUnit: "points",
    at: 30,
    boundary: "lower",
    below: 5,
    above: 1,
    policy: POLICY,
  };

  it("assigns the switch point to the band the declaration names", () => {
    expect(evaluateMapping(threshold, 29.9)).toEqual({ ok: true, value: 5 });
    expect(evaluateMapping(threshold, 30)).toEqual({ ok: true, value: 1 });
    const upper: NumericMapping = { ...threshold, boundary: "upper" };
    expect(evaluateMapping(upper, 30)).toEqual({ ok: true, value: 5 });
    expect(evaluateMapping(upper, 30.1)).toEqual({ ok: true, value: 1 });
  });

  it("maps piecewise-constant bands and clamps below the first anchor", () => {
    const mapping: NumericMapping = {
      kind: "piecewise-constant",
      inputUnit: "points",
      bands: [
        { from: null, value: 1 },
        { from: 20, value: 1.5 },
      ],
      outOfRange: { kind: "clamp" },
      policy: POLICY,
    };
    expect(evaluateMapping(mapping, 5)).toEqual({ ok: true, value: 1 });
    expect(evaluateMapping(mapping, 20)).toEqual({ ok: true, value: 1.5 });
    expect(evaluateMapping(mapping, 900)).toEqual({ ok: true, value: 1.5 });

    const anchored: NumericMapping = {
      ...mapping,
      bands: [
        { from: 10, value: 2 },
        { from: 20, value: 3 },
      ],
    };
    expect(evaluateMapping(anchored, 5)).toEqual({ ok: true, value: 2 });
    const refusing: NumericMapping = { ...anchored, outOfRange: { kind: "invalid" } };
    expect(evaluateMapping(refusing, 5).ok).toBe(false);
    const constant: NumericMapping = { ...anchored, outOfRange: { kind: "value", value: 9 } };
    expect(evaluateMapping(constant, 5)).toEqual({ ok: true, value: 9 });
  });

  it("interpolates piecewise-linear segments and reports an undeclared interval", () => {
    const mapping: NumericMapping = {
      kind: "piecewise-linear",
      inputUnit: "points",
      points: [
        { x: 0, y: 0 },
        { x: 50, y: 0.3 },
        { x: 500, y: 1 },
      ],
      outOfRange: { kind: "clamp" },
      policy: { ...POLICY, rounding: { mode: "half-away-from-zero", precision: 4 } },
    };
    expect(evaluateMapping(mapping, 25)).toEqual({ ok: true, value: 0.15 });
    expect(evaluateMapping(mapping, 50)).toEqual({ ok: true, value: 0.3 });
    expect(evaluateMapping(mapping, 0)).toEqual({ ok: true, value: 0 });
    expect(evaluateMapping(mapping, -5)).toEqual({ ok: true, value: 0 });
    expect(evaluateMapping(mapping, 5000)).toEqual({ ok: true, value: 1 });
    const refusing: NumericMapping = { ...mapping, outOfRange: { kind: "invalid" } };
    expect(evaluateMapping(refusing, -5)).toEqual({
      ok: false,
      reason: "out-of-range",
      message: expect.any(String),
    });
    expect(evaluateMapping(mapping, Number.POSITIVE_INFINITY).ok).toBe(false);
  });
});

describe("value sources", () => {
  it("refuses a missing read instead of defaulting it", () => {
    const result = evaluateValue({ kind: "read", alias: "stamina" }, scopeOf({}));
    expect(result).toEqual({ ok: false, reason: "input-missing", message: expect.any(String) });
  });

  it("refuses a mapping applied to the wrong unit", () => {
    const mapping: NumericMapping = {
      kind: "threshold",
      inputUnit: "mass",
      at: 10,
      boundary: "lower",
      below: 1,
      above: 2,
      policy: POLICY,
    };
    const result = evaluateValue(
      { kind: "map", mapping, input: { kind: "literal", value: 12, unit: "points" } },
      scopeOf({}),
    );
    expect(result).toEqual({
      ok: false,
      reason: "input-invalid",
      message: "Mapping expects unit mass but received points",
    });
  });

  it("combines declared operands under one declared method and one unit", () => {
    const scope = scopeOf({ light: 40, fog: 0.9 });
    const operands = [{ kind: "read", alias: "light" } as const];
    const minimum = evaluateValue(
      { kind: "combine", method: "min", operands: [...operands, { kind: "literal", value: 5, unit: "points" }] },
      scope,
    );
    expect(minimum).toEqual({ ok: true, value: 5, unit: "points" });
    const additive = evaluateValue(
      { kind: "combine", method: "add", operands: [...operands, { kind: "literal", value: 2, unit: "points" }] },
      scope,
    );
    expect(additive).toEqual({ ok: true, value: 42, unit: "points" });
    const mixed = evaluateValue(
      {
        kind: "combine",
        method: "min",
        operands: [...operands, { kind: "literal", value: 2, unit: "mass" }],
      },
      scope,
    );
    expect(mixed).toEqual({
      ok: false,
      reason: "input-invalid",
      message: "Combination min requires one unit but received points and mass",
    });
    const factored = evaluateValue(
      {
        kind: "combine",
        method: "multiply",
        operands: [
          { kind: "literal", value: 3, unit: "" },
          { kind: "literal", value: 4, unit: "" },
        ],
      },
      scope,
    );
    expect(factored).toEqual({ ok: true, value: 12, unit: "" });
    const dimensional = evaluateValue(
      {
        kind: "combine",
        method: "multiply",
        operands: [
          { kind: "literal", value: 3, unit: "" },
          { kind: "literal", value: 4, unit: "points" },
        ],
      },
      scope,
    );
    expect(dimensional.ok).toBe(false);
  });

  it("compares declared values into a boolean and selects one of two declared values", () => {
    const scope = scopeOf({ stamina: 25 });
    expect(
      evaluateValue(
        {
          kind: "compare",
          left: { kind: "read", alias: "stamina" },
          right: { kind: "literal", value: 20, unit: "points" },
          operator: "lt",
        },
        scope,
      ),
    ).toEqual({ ok: true, value: false, unit: "" });
    expect(
      evaluateValue(
        {
          kind: "select",
          left: { kind: "read", alias: "stamina" },
          right: { kind: "literal", value: 20, unit: "points" },
          operator: "lt",
          then: { kind: "literal", value: "forbidden", unit: "" },
          otherwise: {
            kind: "select",
            left: { kind: "read", alias: "stamina" },
            right: { kind: "literal", value: 60, unit: "points" },
            operator: "lt",
            then: { kind: "literal", value: "restricted", unit: "" },
            otherwise: { kind: "literal", value: "allowed", unit: "" },
          },
        },
        scope,
      ),
    ).toEqual({ ok: true, value: "restricted", unit: "" });
  });

  it("keeps the declared unit of literals and derived values", () => {
    const literal = evaluateValue({ kind: "literal", value: 5, unit: "points" }, scopeOf({}));
    expect(literal).toEqual({ ok: true, value: 5, unit: "points" });
    const text = evaluateValue({ kind: "literal", value: "stamina", unit: "" }, scopeOf({}));
    expect(text).toEqual({ ok: true, value: "stamina", unit: "" });
  });
});

describe("conditions", () => {
  it("compares declared values and refuses mismatched units", () => {
    const scope = scopeOf({ stamina: 25 });
    expect(
      evaluateCondition(
        {
          op: "compare",
          left: { kind: "read", alias: "stamina" },
          right: { kind: "literal", value: 20, unit: "points" },
          operator: "gt",
        },
        scope,
      ),
    ).toEqual({ ok: true, value: true });
    expect(
      evaluateCondition(
        {
          op: "compare",
          left: { kind: "read", alias: "stamina" },
          right: { kind: "literal", value: 20, unit: "mass" },
          operator: "gt",
        },
        scope,
      ),
    ).toEqual({ ok: false, reason: "input-invalid", message: "Cannot compare points with mass" });
  });

  it("treats booleans as equality-only and strings as ordered", () => {
    const scope = scopeOf({ mode: "sleep", awake: true });
    expect(
      evaluateCondition(
        {
          op: "compare",
          left: { kind: "read", alias: "mode" },
          right: { kind: "literal", value: "rest", unit: "" },
          operator: "gt",
        },
        scope,
      ),
    ).toEqual({ ok: true, value: true });
    expect(
      evaluateCondition(
        {
          op: "compare",
          left: { kind: "read", alias: "awake" },
          right: { kind: "literal", value: true, unit: "" },
          operator: "lt",
        },
        scope,
      ),
    ).toEqual({ ok: false, reason: "input-invalid", message: "Operator lt does not apply to booleans" });
  });

  it("reads the explicit simulated time and never the machine clock", () => {
    const scope = scopeOf({});
    expect(evaluateCondition({ op: "simulation-time", operator: "before", tick: 6 }, scope)).toEqual({
      ok: true,
      value: true,
    });
    expect(evaluateCondition({ op: "simulation-time", operator: "at-or-after", tick: 5 }, scope)).toEqual({
      ok: true,
      value: true,
    });
  });

  it("short-circuits all, keeps a later success in any, and checks intervals", () => {
    const scope = scopeOf({ stamina: 25 });
    const missing: {
      readonly op: "compare";
      readonly left: { readonly kind: "read"; readonly alias: string };
      readonly right: { readonly kind: "literal"; readonly value: number; readonly unit: string };
      readonly operator: "gt";
    } = {
      op: "compare",
      left: { kind: "read", alias: "absent" },
      right: { kind: "literal", value: 1, unit: "points" },
      operator: "gt",
    };
    expect(evaluateCondition({ op: "any", operands: [missing, { op: "always" }] }, scope)).toEqual({
      ok: true,
      value: true,
    });
    expect(
      evaluateCondition(
        {
          op: "all",
          operands: [
            { op: "within", value: { kind: "read", alias: "stamina" }, min: 0, max: 25, boundary: "exclusive" },
            { op: "always" },
          ],
        },
        scope,
      ),
    ).toEqual({ ok: true, value: false });
    expect(
      evaluateCondition(
        { op: "within", value: { kind: "read", alias: "stamina" }, min: 0, max: 50, boundary: "exclusive" },
        scope,
      ),
    ).toEqual({ ok: true, value: true });
    expect(evaluateCondition({ op: "not", operand: missing }, scope)).toEqual({
      ok: false,
      reason: "input-missing",
      message: expect.any(String),
    });
  });
});

describe("extension registration", () => {
  const base: DomainExtension = {
    name: "extension",
    namespace: "test.registry",
    version: "1.0.0",
    kernel: ">=1.0.0 <2.0.0",
    configTypes: [],
    views: [],
    triggers: [],
    outputTargets: [],
  };

  it("accepts a well-formed extension and keeps its fingerprint stable", () => {
    const registry = new ExtensionRegistry();
    const first = registry.register(base);
    expect(first.status).toBe("registered");
    const fingerprint = registry.get("test.registry/extension")?.fingerprint;
    expect(registry.register({ ...base }).status).toBe("registered");
    expect(registry.get("test.registry/extension")?.fingerprint).toBe(fingerprint);
  });

  it("refuses content that changes under the same identity", () => {
    const registry = new ExtensionRegistry();
    registry.register(base);
    const conflicting = registry.register({ ...base, version: "1.1.0" });
    expect(conflicting.status).toBe("identity-conflict");
    expect(conflicting.diagnostics[0]?.code).toBe("identity-conflict");
  });

  it("refuses schema constructs outside the supported model", () => {
    const registry = new ExtensionRegistry();
    const result = registry.register({
      ...base,
      configTypes: [
        {
          kind: "widget",
          fields: Type.Object({ payload: Type.Any() }),
          overridable: [],
          merge: {},
        },
      ],
    });
    expect(result.status).toBe("unsupported-semantics");
    expect(result.diagnostics.map((diagnostic) => diagnostic.message).join(" ")).toContain(
      "unsupported schema kind Any",
    );
  });

  it("refuses wildcard exposure, undeclared defaults and impossible merge strategies", () => {
    const wildcard = new ExtensionRegistry().register({
      ...base,
      views: [
        { name: "state", fields: Type.Object({ value: Type.Number() }), units: { value: "points" }, exposedTo: ["*"] },
      ],
    });
    expect(wildcard.status).toBe("unauthorized-capability");
    expect(wildcard.diagnostics[0]?.message).toContain("wildcard exposure");

    const defaults = new ExtensionRegistry().register({
      ...base,
      configTypes: [
        {
          kind: "widget",
          fields: Type.Object({ label: Type.String() }),
          defaults: { label: 1 },
          overridable: ["label"],
          merge: { label: "replace" },
        },
      ],
    });
    expect(defaults.status).toBe("unsupported-semantics");
    expect(defaults.diagnostics.map((diagnostic) => diagnostic.message).join(" ")).toContain(
      "default does not match its declared type",
    );

    const appending = new ExtensionRegistry().register({
      ...base,
      configTypes: [
        {
          kind: "widget",
          fields: Type.Object({ label: Type.String() }),
          overridable: ["label"],
          merge: { label: "append" },
        },
      ],
    });
    expect(appending.status).toBe("unsupported-semantics");
    expect(appending.diagnostics.map((diagnostic) => diagnostic.message).join(" ")).toContain(
      'uses "append" on a non-array field',
    );
  });

  it("accepts an unconstrained numeric target and refuses a vocabulary on a non-string target", () => {
    const unconstrained = new ExtensionRegistry().register({
      ...base,
      outputTargets: [{ name: "stamina", valueType: "number", exposedTo: [] }],
    });
    expect(unconstrained.status).toBe("registered");

    const vocabularied = new ExtensionRegistry().register({
      ...base,
      outputTargets: [{ name: "stamina", valueType: "number", allowedValues: ["low"], exposedTo: [] }],
    });
    expect(vocabularied.status).toBe("unsupported-semantics");
    expect(vocabularied.diagnostics.map((diagnostic) => diagnostic.message).join(" ")).toContain(
      "declares a vocabulary but holds number",
    );

    const duplicated = new ExtensionRegistry().register({
      ...base,
      configTypes: [{ kind: "state", fields: Type.Object({ value: Type.Number() }), overridable: [], merge: {} }],
      views: [
        { name: "state", fields: Type.Object({ value: Type.Number() }), units: { value: "points" }, exposedTo: [] },
      ],
    });
    expect(duplicated.status).toBe("unsupported-semantics");
    expect(duplicated.diagnostics.map((diagnostic) => diagnostic.message).join(" ")).toContain("declared twice");
  });

  it("refuses a value family whose member does not match the config type", () => {
    const unknownState = new ExtensionRegistry().register({
      ...base,
      configTypes: [defineValueContainer({ kind: "value", family: "values", contract: false })],
    });
    expect(unknownState.status).toBe("registered");

    const wrongKind = new ExtensionRegistry().register({
      ...base,
      configTypes: [
        {
          kind: "value",
          fields: Type.Object({ type: Type.String(), initial: Type.String() }),
          overridable: [],
          merge: {},
          family: {
            name: "values",
            members: [{ key: "", typeField: "type", stateField: "initial", policyField: "state" }],
          },
        },
      ],
    });
    expect(wrongKind.status).toBe("unsupported-semantics");
    expect(wrongKind.diagnostics.map((diagnostic) => diagnostic.message).join(" ")).toContain(
      "declares unknown field state",
    );

    const noType = new ExtensionRegistry().register({
      ...base,
      configTypes: [
        {
          kind: "value",
          fields: Type.Object({ initial: Type.Number() }),
          overridable: [],
          merge: {},
          family: { name: "values", members: [{ key: "", stateField: "initial" }] },
        },
      ],
    });
    expect(noType.status).toBe("unsupported-semantics");
    expect(noType.diagnostics.map((diagnostic) => diagnostic.message).join(" ")).toContain(
      "declares neither a value type nor a type field",
    );
  });

  it("warns about an exposure granted to an extension that is not registered yet", () => {
    const registry = new ExtensionRegistry();
    registry.register({
      ...base,
      views: [
        {
          name: "state",
          fields: Type.Object({ value: Type.Number() }),
          units: { value: "points" },
          exposedTo: ["test.future/extension"],
        },
      ],
    });
    const warnings = registry.finalize();
    expect(warnings.map((diagnostic) => diagnostic.code)).toEqual(["unauthorized-read"]);
    expect(warnings[0]?.message).toContain("test.future/extension");
  });

  it("refuses an extension written against an incompatible kernel", () => {
    const result = new ExtensionRegistry().register({ ...base, kernel: ">=9.0.0" });
    expect(result.status).toBe("semantic-incompatible");
    expect(result.diagnostics[0]?.code).toBe("incompatible-extension");
  });

  it("checks peer requirements independently of registration order", () => {
    const registry = new ExtensionRegistry();
    const consumer: DomainExtension = {
      ...base,
      namespace: "test.consumer",
      requires: ["test.registry/extension@1.0.0"],
    };
    registry.register(consumer);
    expect(registry.finalize().map((diagnostic) => diagnostic.code)).toEqual(["incompatible-extension"]);
    registry.register(base);
    expect(registry.finalize()).toEqual([]);
  });
});
