import { describe, expect, it } from "vitest";
import { runRules, type RuleResult, type ScopeTrace } from "../src/config/rule-engine.js";
import type { RuntimeConfig } from "../src/config/config-builder.js";
import type { SystemSpec } from "../src/config/system-spec.js";
import { Type } from "typebox";
import {
  applyDemoPack,
  createRegistry,
  DEMO_ENTITY,
  DEMO_SHARED,
  demoRequest,
  FIXTURE_WORLD,
  loadPack,
  messages,
  removeDirectory,
  withTempDirectory,
  writePack,
} from "./helpers/demo-pack.js";

function entityTrace(result: RuleResult, entityId = "agentlife.demo/companion"): ScopeTrace {
  const trace = result.trace.entities.find((candidate) => candidate.entityId === entityId);
  if (trace === undefined) throw new Error(`Missing trace for ${entityId}`);
  return trace;
}

/**
 * The lamp's two reactions as one rule, each half its own branch.
 *
 * The second branch does not test the lamp's state: with the first branch written
 * before it, it answers everything the first one does not, so which half applies is
 * decided by the order they are written in.
 */
const BRANCHED_LAMP = `kind: rule
id: operate-influence
system: agentlife.world
triggers:
  - agentlife.world/influence-accepted
inputs:
  - name: kind
    state: agentlife.world/influence.kind
  - name: accepted
    state: agentlife.world/influence.accepted
  - name: lamp
    state: agentlife.world/environment.lamp-state
branches:
  - when:
      op: all
      operands:
        - op: compare
          left:
            kind: read
            name: kind
          right:
            kind: literal
            value: agentlife.demo/operate-item
          operator: eq
        - op: compare
          left:
            kind: read
            name: accepted
          right:
            kind: literal
            value: true
          operator: eq
        - op: compare
          left:
            kind: read
            name: lamp
          right:
            kind: literal
            value: 0
            unit: state
          operator: eq
    changes:
      - state: agentlife.world/environment.lamp-state
        combine: priority
        priority: 1
        value:
          kind: literal
          value: 1
          unit: state
    notice: 灯亮了起来
  - when:
      op: all
      operands:
        - op: compare
          left:
            kind: read
            name: kind
          right:
            kind: literal
            value: agentlife.demo/operate-item
          operator: eq
        - op: compare
          left:
            kind: read
            name: accepted
          right:
            kind: literal
            value: true
          operator: eq
    changes:
      - state: agentlife.world/environment.lamp-state
        combine: priority
        priority: 1
        value:
          kind: literal
          value: 0
          unit: state
    notice: 灯灭了
`;

/** A system that still declares one process, used to exercise the runtime path. */
const FIXTURE_PROCESS: SystemSpec = {
  name: "system",
  namespace: "test.process",
  version: "1.0.0",
  kernel: ">=1.0.0 <2.0.0",
  requires: [],
  items: [],
  inputs: [],
  triggers: [],
  outputs: [],
  processes: [
    {
      name: "recovery",
      scope: "entity",
      operations: ["establish", "advance", "pause", "end", "cancel"],
      parameters: Type.Object({ target: Type.String(), amount: Type.Number() }),
    },
    {
      name: "global-recovery",
      scope: "shared",
      operations: ["establish"],
      parameters: Type.Object({ amount: Type.Number() }),
    },
  ],
};

describe("deterministic evaluation", () => {
  it("evaluates multiple entities independently in canonical entity order", async () => {
    const registry = createRegistry();
    const { result, directory } = await applyDemoPack(registry);
    try {
      expect(result.status).toBe("valid");
      const entities = {
        "entity-z": {
          ...DEMO_ENTITY,
          "agentlife.body/values": { stamina: 25, integrity: 1, wakefulness: 40, load: 30 },
        },
        "entity-a": {
          ...DEMO_ENTITY,
          "agentlife.body/values": { stamina: 25, integrity: 1, wakefulness: 40, load: 0 },
        },
      };
      const request = {
        runId: "multi-entity",
        trigger: "agentlife.body/value-changed",
        entityIds: ["entity-z", "entity-a", "entity-z"],
        input: {
          stateVersion: "state-1",
          simTime: { tick: 3, seconds: 30 },
          shared: DEMO_SHARED,
          entities,
        },
      };
      const first = registry.runRules(request);
      const second = registry.runRules({
        ...request,
        entityIds: ["entity-a", "entity-z"],
        input: { ...request.input, entities: Object.fromEntries(Object.entries(entities).reverse()) },
      });

      expect(first.trace.entities.map((trace) => trace.entityId)).toEqual(["entity-a", "entity-z"]);
      expect(JSON.stringify(first)).toBe(JSON.stringify(second));
      const moveCost = (entityId: string) =>
        entityTrace(first, entityId).stateChanges.find(
          (change) => change.stateRef === "agentlife.body/values.move-cost",
        );
      expect(moveCost("entity-a")?.newValue).toBe(2);
      expect(moveCost("entity-z")?.newValue).toBe(12);
      const sameValueA = entityTrace(first, "entity-a").stateChanges.find(
        (change) => change.stateRef === "agentlife.body/cognitive-participation",
      );
      const sameValueZ = entityTrace(first, "entity-z").stateChanges.find(
        (change) => change.stateRef === "agentlife.body/cognitive-participation",
      );
      expect(sameValueA?.newValue).toBe(sameValueZ?.newValue);
    } finally {
      removeDirectory(directory);
    }
  });

  it("runs shared rules once while entity rules consume the same shared projection", async () => {
    const registry = createRegistry();
    const { result, directory } = await applyDemoPack(registry);
    try {
      expect(result.status).toBe("valid");
      const shared = registry.runRules(demoRequest("agentlife.world/environment-changed"));
      expect(shared.trace.shared.selectedRules).toEqual([
        "agentlife.demo/darkness-visibility",
        "agentlife.demo/fog-visibility",
        "agentlife.demo/lamp-glow-start",
      ]);
      expect(shared.trace.shared.stateChanges).toHaveLength(1);
      expect(shared.trace.shared.rules).toHaveLength(3);
      // The same run also establishes the process the lamp light is advanced by.
      expect(shared.trace.processChanges).toHaveLength(1);
      expect(shared.trace.processChanges[0]?.processRef).toBe("agentlife.world/lamp-glow");
      expect(shared.trace.entities.every((trace) => trace.entityId !== null)).toBe(true);

      const entities = registry.runRules(demoRequest("agentlife.body/tick-elapsed"));
      expect(entities.trace.shared.selectedRules).toEqual([]);
      expect(entities.trace.entities).toHaveLength(2);
      expect(entities.trace.entities.every((trace) => trace.rules.length === 3)).toBe(true);
    } finally {
      removeDirectory(directory);
    }
  });

  it("answers an influence with the first branch whose condition holds", async () => {
    const registry = createRegistry();
    const { result, directory } = await applyDemoPack(registry, { "rules/operate-influence.yaml": BRANCHED_LAMP });
    try {
      expect(result.status).toBe("valid");
      const base = demoRequest("agentlife.world/influence-accepted", "branches");
      const environment = DEMO_SHARED["agentlife.world/environment"] as Record<string, unknown>;
      const influence = DEMO_SHARED["agentlife.world/influence"] as Record<string, unknown>;
      const withLamp = (lampState: number) => ({
        ...base,
        input: {
          ...base.input,
          shared: {
            ...DEMO_SHARED,
            "agentlife.world/environment": { ...environment, "lamp-state": lampState },
            // The rule answers operations, so the request has to be one.
            "agentlife.world/influence": { ...influence, kind: "agentlife.demo/operate-item" },
          },
        },
      });

      const written = (run: RuleResult): unknown =>
        run.trace.shared.stateChanges.find((change) => change.stateRef === "agentlife.world/environment.lamp-state")
          ?.newValue;
      // The lamp is off, so the first branch answers. The branch written after it holds
      // for this state as well - it is the lamp's other half, not a state test - and is
      // never consulted, which is what makes the order of the branches the precedence.
      const dark = registry.runRules(withLamp(0));
      expect(written(dark)).toBe(1);
      expect(dark.trace.shared.rules[0]?.branch).toBe(0);
      expect(dark.trace.shared.rules[0]?.notice).toBe("灯亮了起来");
      // The lamp is on: the first branch does not hold and the second one answers.
      const lit = registry.runRules(withLamp(1));
      expect(written(lit)).toBe(0);
      expect(lit.trace.shared.rules[0]?.branch).toBe(1);
      expect(lit.trace.shared.rules[0]?.notice).toBe("灯灭了");
    } finally {
      removeDirectory(directory);
    }
  });

  it("marks only a missing entity projection invalid and preserves other entity results", async () => {
    const registry = createRegistry();
    const { result, directory } = await applyDemoPack(registry);
    try {
      expect(result.status).toBe("valid");
      const base = demoRequest("agentlife.body/value-changed", "missing-entity");
      const evaluated = registry.runRules({
        ...base,
        entityIds: ["agentlife.demo/player", "missing-entity"],
        input: {
          ...base.input,
          entities: { "agentlife.demo/player": DEMO_ENTITY },
        },
      });
      expect(evaluated.status).toBe("input-invalid");
      expect(entityTrace(evaluated, "missing-entity").rules.every((rule) => rule.status === "input-missing")).toBe(
        true,
      );
      expect(entityTrace(evaluated, "agentlife.demo/player").stateChanges.length).toBeGreaterThan(0);
    } finally {
      removeDirectory(directory);
    }
  });

  it("produces the same stateChanges and trace for the same config, input and time", async () => {
    const registry = createRegistry();
    const { result, directory } = await applyDemoPack(registry);
    try {
      expect(result.status).toBe("valid");
      const first = registry.runRules(demoRequest("agentlife.body/value-changed"));
      const second = registry.runRules(demoRequest("agentlife.body/value-changed"));
      expect(JSON.stringify(first)).toBe(JSON.stringify(second));
      expect(first.configId).toBe(result.config?.configId);

      const values = Object.fromEntries(first.trace.stateChanges.map((entry) => [entry.stateRef, entry.newValue]));
      expect(values["agentlife.body/values.move-cost"]).toBe(5.7);
      expect(values["agentlife.body/values.move-cost-factor"]).toBe(2.52);
      expect(values["agentlife.body/cognitive-participation"]).toBe("restricted");
      expect(values["agentlife.body/current-mode"]).toBe("agentlife.demo/awake");
      // `value-changed` no longer writes stamina; only advancing an action costs it.
      expect(values).not.toHaveProperty("agentlife.body/values.stamina");
      expect(first.status).toBe("changes");
    } finally {
      removeDirectory(directory);
    }
  });

  it("composes additive, multiplicative, min and priority sources in stable order", async () => {
    const registry = createRegistry();
    const { result, directory } = await applyDemoPack(registry);
    try {
      expect(result.status).toBe("valid");

      const perTick = registry.runRules(demoRequest("agentlife.body/tick-elapsed", "tick"));
      const wakefulness = entityTrace(perTick).combines.find(
        (combine) => combine.stateRef === "agentlife.body/values.wakefulness",
      );
      expect(wakefulness?.combine).toBe("priority");
      expect(wakefulness?.ruleValues.map((ruleValue) => ruleValue.ruleId)).toEqual([
        "agentlife.demo/daylight-wakefulness",
        "agentlife.demo/lamp-stimulus",
      ]);
      expect(wakefulness?.result).toBe(80);

      // Advancing a walking action is what spends stamina now: one rule reads the
      // current stamina and both derived costs, and writes the resulting absolute
      // value under priority, so no other rule may claim the same state.
      const base = demoRequest("agentlife.body/action-advanced", "action");
      const values = DEMO_ENTITY["agentlife.body/values"] as Readonly<Record<string, unknown>>;
      const advanced = registry.runRules({
        ...base,
        entityIds: ["agentlife.demo/companion"],
        input: {
          ...base.input,
          entities: {
            "agentlife.demo/companion": {
              ...DEMO_ENTITY,
              "agentlife.body/values": { ...values, "move-cost": 5, "move-cost-factor": 2, stamina: 70 },
              "agentlife.body/activity": { action: "agentlife.demo/walk", stage: "", status: "" },
            },
          },
        },
      });
      const stamina = entityTrace(advanced).combines.find(
        (combine) => combine.stateRef === "agentlife.body/values.stamina",
      );
      expect(stamina?.combine).toBe("priority");
      expect(stamina?.ruleValues.map((ruleValue) => ruleValue.ruleId)).toEqual(["agentlife.demo/move-exertion"]);
      // 70 + (-2.5 cost at x=5) + (-2 factor at x=2)
      expect(stamina?.result).toBe(65.5);

      const environment = registry.runRules(demoRequest("agentlife.world/environment-changed", "environment"));
      const visibility = environment.trace.shared.combines.find(
        (combine) => combine.stateRef === "agentlife.world/environment.visibility",
      );
      expect(visibility?.combine).toBe("min");
      expect(visibility?.result).toBe(0.15);

      const cost = registry.runRules(demoRequest("agentlife.body/value-changed", "cost"));
      const factor = entityTrace(cost).combines.find(
        (combine) => combine.stateRef === "agentlife.body/values.move-cost-factor",
      );
      expect(factor?.combine).toBe("multiply");
      expect(factor?.ruleValues.map((ruleValue) => ruleValue.value)).toEqual([1.5, 1.2, 1.4]);
      expect(factor?.result).toBe(2.52);

      const participation = registry.runRules(demoRequest("agentlife.body/value-changed", "participation"));
      expect(entityTrace(participation).combines.map((entry) => entry.stateRef)).toContain(
        "agentlife.body/cognitive-participation",
      );
      const permission = participation.trace.stateChanges.find(
        (candidate) => candidate.stateRef === "agentlife.body/cognitive-participation",
      );
      expect(permission?.newValue).toBe("restricted");
      expect(participation.trace.stateChanges.map((candidate) => candidate.stateRef)).not.toContain(
        "agentlife.world/environment.visibility",
      );
    } finally {
      removeDirectory(directory);
    }
  });

  it("only checks the rules the trigger index selects", async () => {
    const registry = createRegistry();
    const { result, directory } = await applyDemoPack(registry);
    try {
      expect(result.status).toBe("valid");
      const result_ = registry.runRules(demoRequest("agentlife.body/tick-elapsed"));
      expect(entityTrace(result_).selectedRules).toEqual([
        "agentlife.demo/daylight-wakefulness",
        "agentlife.demo/lamp-stimulus",
        "agentlife.demo/recovery-request",
      ]);
      expect(entityTrace(result_).skippedRules).toContain("agentlife.demo/base-move-cost");
      expect(entityTrace(result_).rules.map((rule) => rule.ruleId)).toEqual(entityTrace(result_).selectedRules);

      const unmatched = registry.runRules(demoRequest("agentlife.character/lifecycle-changed"));
      expect(unmatched.status).toBe("no-match");
      expect(entityTrace(unmatched).selectedRules).toEqual([]);
      expect(unmatched.trace.stateChanges).toEqual([]);
      const skipped = unmatched.trace.shared.skippedRules.length + entityTrace(unmatched).skippedRules.length;
      expect(skipped).toBe(result.config?.rules.length ?? 0);
    } finally {
      removeDirectory(directory);
    }
  });

  it("reports a priority tie as a structured conflict instead of choosing a source", async () => {
    const registry = createRegistry();
    const { result, directory } = await applyDemoPack(registry, {
      "rules/lamp-stimulus.yaml": `kind: rule
id: lamp-stimulus
system: agentlife.body
triggers:
  - agentlife.body/tick-elapsed
inputs:
  - name: lamp
    state: agentlife.world/environment.lamp-state
condition:
  op: compare
  left:
    kind: read
    name: lamp
  right:
    kind: literal
    value: 1
    unit: state
  operator: eq
changes:
  - state: agentlife.body/values.wakefulness
    combine: priority
    priority: 10
    value:
      kind: map
      input:
        kind: read
        name: lamp
      mapping:
        kind: threshold
        inputUnit: state
        at: 1
        boundary: lower
        below: 0
        above: 60
        policy:
          unit: points
          rounding:
            mode: half-away-from-zero
            precision: 0
          range:
            min: 0
            max: 100
            boundary: inclusive
          overflow: saturate
`,
    });
    try {
      expect(result.status).toBe("valid");
      const evaluated = registry.runRules(demoRequest("agentlife.body/tick-elapsed"));
      expect(evaluated.status).toBe("conflict");
      const conflict = entityTrace(evaluated).combines.find(
        (combine) => combine.stateRef === "agentlife.body/values.wakefulness",
      );
      expect(conflict?.status).toBe("conflict");
      expect(conflict?.conflicting).toEqual(["agentlife.demo/daylight-wakefulness", "agentlife.demo/lamp-stimulus"]);
      // No rule writes a state change for this trigger any more: the only other
      // entity rule establishes a process, which a conflict does not suppress.
      expect(entityTrace(evaluated).stateChanges).toEqual([]);
    } finally {
      removeDirectory(directory);
    }
  });

  it("isolates a priority conflict to the entity whose values disagree", async () => {
    const registry = createRegistry();
    const { result, directory } = await applyDemoPack(registry, {
      "rules/lamp-stimulus.yaml": `kind: rule
id: lamp-stimulus
system: agentlife.body
triggers:
  - agentlife.body/tick-elapsed
inputs:
  - name: stamina
    state: agentlife.body/values.stamina
condition:
  op: always
changes:
  - state: agentlife.body/values.wakefulness
    combine: priority
    priority: 10
    value:
      kind: map
      input:
        kind: read
        name: stamina
      mapping:
        kind: threshold
        inputUnit: points
        at: 50
        boundary: lower
        below: 80
        above: 60
        policy:
          unit: points
          rounding:
            mode: half-away-from-zero
            precision: 0
          range:
            min: 0
            max: 100
            boundary: inclusive
          overflow: saturate
`,
    });
    try {
      expect(result.status).toBe("valid");
      const base = demoRequest("agentlife.body/tick-elapsed", "isolated-conflict");
      const evaluated = registry.runRules({
        ...base,
        entityIds: ["calm", "tired"],
        input: {
          ...base.input,
          entities: {
            calm: {
              ...DEMO_ENTITY,
              "agentlife.body/values": { stamina: 25, integrity: 1, wakefulness: 40, load: 12 },
            },
            tired: {
              ...DEMO_ENTITY,
              "agentlife.body/values": { stamina: 75, integrity: 1, wakefulness: 40, load: 12 },
            },
          },
        },
      });
      expect(evaluated.status).toBe("conflict");
      expect(
        entityTrace(evaluated, "calm").combines.find(
          (combine) => combine.stateRef === "agentlife.body/values.wakefulness",
        )?.status,
      ).toBe("composed");
      expect(
        entityTrace(evaluated, "tired").combines.find(
          (combine) => combine.stateRef === "agentlife.body/values.wakefulness",
        )?.status,
      ).toBe("conflict");
    } finally {
      removeDirectory(directory);
    }
  });

  it("refuses a value the declared target can no longer represent", async () => {
    const registry = createRegistry();
    const { result, directory } = await applyDemoPack(registry, {
      "rules/base-move-cost.yaml": `kind: rule
id: base-move-cost
system: agentlife.body
triggers:
  - agentlife.body/value-changed
inputs:
  - name: load
    state: agentlife.body/values.load
condition:
  op: always
changes:
  - state: agentlife.body/values.move-cost
    combine: add
    value:
      kind: literal
      value: 500
      unit: points
`,
    });
    try {
      expect(result.status).toBe("valid");
      const evaluated = registry.runRules(demoRequest("agentlife.body/value-changed"));
      expect(evaluated.status).toBe("inexpressible");
      const combine = entityTrace(evaluated).combines.find(
        (trace) => trace.stateRef === "agentlife.body/values.move-cost",
      );
      expect(combine?.status).toBe("rejected");
      expect(combine?.message).toContain("declared range");
      expect(evaluated.trace.stateChanges.map((candidate) => candidate.stateRef)).not.toContain(
        "agentlife.body/values.move-cost",
      );
    } finally {
      removeDirectory(directory);
    }
  });

  it("reports a missing declared read instead of treating it as false", async () => {
    const registry = createRegistry();
    const { result, directory } = await applyDemoPack(registry);
    try {
      expect(result.status).toBe("valid");
      const evaluated = registry.runRules({
        runId: "missing-input",
        trigger: "agentlife.body/value-changed",
        entityIds: ["test.entity"],
        input: {
          stateVersion: "state-1",
          simTime: { tick: 3, seconds: 30 },
          shared: {
            "agentlife.world/environment": {
              slope: 0.3,
              "light-level": 40,
              "fog-density": 0,
              "sun-angle": 90,
              "lamp-state": 0,
            },
          },
          entities: { "test.entity": {} },
        },
      });
      expect(evaluated.status).toBe("input-invalid");
      const rule = entityTrace(evaluated, "test.entity").rules.find(
        (trace) => trace.ruleId === "agentlife.demo/base-move-cost",
      );
      expect(rule?.status).toBe("input-missing");
      expect(rule?.message).toContain("load");
      // Rules that could be answered still report their stateChanges; the status
      // marks the evaluation as incomplete, so a partial set is never mistaken
      // for a complete one.
      expect(evaluated.trace.stateChanges.map((candidate) => candidate.stateRef)).toEqual([
        "agentlife.body/values.move-cost-factor",
      ]);
    } finally {
      removeDirectory(directory);
    }
  });

  it("refuses to runRules a deferred request against a newer state version", async () => {
    const registry = createRegistry();
    const { result, directory } = await applyDemoPack(registry);
    try {
      expect(result.status).toBe("valid");
      const evaluated = registry.runRules({
        ...demoRequest("agentlife.body/value-changed"),
        baseVersion: "state-0",
      });
      expect(evaluated.status).toBe("state-version-stale");
      expect(evaluated.trace.entities.every((trace) => trace.rules.length === 0)).toBe(true);
      expect(evaluated.trace.stateChanges).toEqual([]);
      expect(entityTrace(evaluated).selectedRules.length).toBeGreaterThan(0);
    } finally {
      removeDirectory(directory);
    }
  });

  it("returns process changes without advancing time", async () => {
    // No shipped system declares a process yet, so the runtime path is exercised
    // against a synthetic system that still does.
    await withTempDirectory(async (directory) => {
      writePack(directory, {
        "manifest.yaml": `pack: test.process
version: "1.0.0"
kernel: ">=1.0.0 <2.0.0"
dependencies: []
systems: []
sections:
  world: agentlife.world/world
`,
        "world/settings.yaml": FIXTURE_WORLD,
        "rules/recovery.yaml": `kind: rule
id: recovery
system: test.process
triggers:
  - agentlife.body/tick-elapsed
condition:
  op: always
changes:
  - processRef: test.process/recovery
    action: establish
    params:
      target:
        kind: literal
        value: stamina
      amount:
        kind: literal
        value: 5
        unit: points
`,
        "rules/global-recovery.yaml": `kind: rule
id: global-recovery
system: test.process
triggers:
  - agentlife.body/tick-elapsed
condition:
  op: always
changes:
  - processRef: test.process/global-recovery
    action: establish
    params:
      amount:
        kind: literal
        value: 1
`,
      });
      const registry = createRegistry([FIXTURE_PROCESS]);
      const applied = await loadPack(registry, directory);
      expect(applied.status, messages(applied.diagnostics)).toBe("valid");
      const evaluated = registry.runRules(demoRequest("agentlife.body/tick-elapsed", "process"));
      expect(evaluated.status).toBe("changes");
      expect(entityTrace(evaluated).processChanges).toEqual([
        {
          entityId: "agentlife.demo/companion",
          processRef: "test.process/recovery",
          system: "test.process",
          action: "establish",
          params: { target: "stamina", amount: 5 },
          sourceRule: "test.process/recovery",
        },
      ]);
      expect(evaluated.trace.shared.processChanges).toEqual([
        {
          entityId: null,
          processRef: "test.process/global-recovery",
          system: "test.process",
          action: "establish",
          params: { amount: 1 },
          sourceRule: "test.process/global-recovery",
        },
      ]);
      const again = registry.runRules(demoRequest("agentlife.body/tick-elapsed", "process"));
      expect(entityTrace(again).processChanges).toEqual(entityTrace(evaluated).processChanges);
    });
  });

  it("answers config-unavailable before any version is published", async () => {
    const registry = createRegistry();
    const evaluated = registry.runRules(demoRequest("agentlife.body/tick-elapsed"));
    expect(evaluated.status).toBe("config-unavailable");
    expect(evaluated.trace.stateChanges).toEqual([]);
  });

  it("completes an evaluation against the version it started with", async () => {
    const registry = createRegistry();
    const first = await applyDemoPack(registry);
    const started = registry.current();
    const updated = await applyDemoPack(registry, {
      "rules/lamp-stimulus.yaml": `kind: rule
id: lamp-stimulus
system: agentlife.body
triggers:
  - agentlife.body/tick-elapsed
inputs:
  - name: lamp
    state: agentlife.world/environment.lamp-state
condition:
  op: always
changes:
  - state: agentlife.body/values.wakefulness
    combine: priority
    priority: 20
    value:
      kind: literal
      value: 10
      unit: points
`,
    });
    try {
      expect(first.result.status).toBe("valid");
      expect(updated.result.status).toBe("valid");
      expect(updated.result.config?.configId).not.toBe(started?.configId);

      const before = runRules(started as RuntimeConfig, demoRequest("agentlife.body/tick-elapsed"));
      expect(before.configId).toBe(started?.configId);
      expect(
        entityTrace(before).combines.find((entry) => entry.stateRef === "agentlife.body/values.wakefulness")?.result,
      ).toBe(80);

      const after = registry.runRules(demoRequest("agentlife.body/tick-elapsed"));
      expect(after.configId).toBe(updated.result.config?.configId);
      expect(
        entityTrace(after).combines.find((entry) => entry.stateRef === "agentlife.body/values.wakefulness")?.result,
      ).toBe(10);
    } finally {
      removeDirectory(first.directory);
      removeDirectory(updated.directory);
    }
  });

  it("traces the version, state input and simulated time it used", async () => {
    const registry = createRegistry();
    const { result, directory } = await applyDemoPack(registry);
    try {
      const evaluated = registry.runRules(demoRequest("agentlife.body/tick-elapsed", "traced"));
      expect(evaluated.trace.configId).toBe(result.config?.configId);
      expect(evaluated.trace.stateVersion).toBe("state-1");
      expect(evaluated.trace.simTime).toEqual({ tick: 3, seconds: 30 });
      expect(evaluated.trace.runId).toBe("traced");
      expect(evaluated.trace.trigger).toBe("agentlife.body/tick-elapsed");
    } finally {
      removeDirectory(directory);
    }
  });
});
