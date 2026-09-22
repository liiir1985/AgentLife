import { describe, expect, it } from "vitest";
import { runRules } from "../src/config/rule-engine.js";
import type { RuntimeConfig } from "../src/config/config-builder.js";
import type { SystemSpec } from "../src/config/system-spec.js";
import { Type } from "typebox";
import {
  applyDemoPack,
  createRegistry,
  demoRequest,
  FIXTURE_WORLD,
  loadPack,
  messages,
  removeDirectory,
  withTempDirectory,
  writePack,
} from "./helpers/demo-pack.js";

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
      operations: ["establish", "advance", "pause", "end", "cancel"],
      parameters: Type.Object({ target: Type.String(), amount: Type.Number() }),
    },
  ],
};

describe("deterministic evaluation", () => {
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
      expect(values["agentlife.body/values.stamina"]).toBe(0);
      expect(values["agentlife.body/values.move-cost"]).toBe(5.7);
      expect(values["agentlife.body/values.move-cost-factor"]).toBe(2.52);
      expect(values["agentlife.body/cognitive-participation"]).toBe("restricted");
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
      const wakefulness = perTick.trace.combines.find(
        (combine) => combine.stateRef === "agentlife.body/values.wakefulness",
      );
      expect(wakefulness?.combine).toBe("priority");
      expect(wakefulness?.ruleValues.map((ruleValue) => ruleValue.ruleId)).toEqual([
        "agentlife.demo/daylight-wakefulness",
        "agentlife.demo/lamp-stimulus",
      ]);
      expect(wakefulness?.result).toBe(80);
      const stamina = perTick.trace.combines.find((combine) => combine.stateRef === "agentlife.body/values.stamina");
      expect(stamina?.combine).toBe("add");
      expect(stamina?.result).toBe(5);

      const environment = registry.runRules(demoRequest("agentlife.world/environment-changed", "environment"));
      const visibility = environment.trace.combines.find(
        (combine) => combine.stateRef === "agentlife.world/environment.visibility",
      );
      expect(visibility?.combine).toBe("min");
      expect(visibility?.result).toBe(0.15);

      const cost = registry.runRules(demoRequest("agentlife.body/value-changed", "cost"));
      const factor = cost.trace.combines.find(
        (combine) => combine.stateRef === "agentlife.body/values.move-cost-factor",
      );
      expect(factor?.combine).toBe("multiply");
      expect(factor?.ruleValues.map((ruleValue) => ruleValue.value)).toEqual([1.5, 1.2, 1.4]);
      expect(factor?.result).toBe(2.52);

      const participation = registry.runRules(demoRequest("agentlife.body/value-changed", "participation"));
      expect(participation.trace.combines.map((entry) => entry.stateRef)).toContain(
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
      expect(result_.trace.selectedRules).toEqual([
        "agentlife.demo/daylight-wakefulness",
        "agentlife.demo/lamp-stimulus",
        "agentlife.demo/rest-recovery",
      ]);
      expect(result_.trace.skippedRules).toContain("agentlife.demo/fog-visibility");
      expect(result_.trace.rules.map((rule) => rule.ruleId)).toEqual(result_.trace.selectedRules);

      const unmatched = registry.runRules(demoRequest("agentlife.character/lifecycle-changed"));
      expect(unmatched.status).toBe("no-match");
      expect(unmatched.trace.selectedRules).toEqual([]);
      expect(unmatched.trace.stateChanges).toEqual([]);
      expect(unmatched.trace.skippedRules).toHaveLength(result.config?.rules.length ?? 0);
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
      const conflict = evaluated.trace.combines.find(
        (combine) => combine.stateRef === "agentlife.body/values.wakefulness",
      );
      expect(conflict?.status).toBe("conflict");
      expect(conflict?.conflicting).toEqual(["agentlife.demo/daylight-wakefulness", "agentlife.demo/lamp-stimulus"]);
      expect(evaluated.trace.stateChanges.map((candidate) => candidate.stateRef)).toEqual([
        "agentlife.body/values.stamina",
      ]);
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
      const combine = evaluated.trace.combines.find((trace) => trace.stateRef === "agentlife.body/values.move-cost");
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
        input: {
          stateVersion: "state-1",
          simTime: { tick: 3, seconds: 30 },
          inputs: {
            "agentlife.world/environment": {
              slope: 0.3,
              "light-level": 40,
              "fog-density": 0,
              "sun-angle": 90,
              "lamp-state": 0,
            },
          },
        },
      });
      expect(evaluated.status).toBe("input-invalid");
      const rule = evaluated.trace.rules.find((trace) => trace.ruleId === "agentlife.demo/base-move-cost");
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
      expect(evaluated.trace.rules).toEqual([]);
      expect(evaluated.trace.stateChanges).toEqual([]);
      expect(evaluated.trace.selectedRules.length).toBeGreaterThan(0);
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
      });
      const registry = createRegistry([FIXTURE_PROCESS]);
      const applied = await loadPack(registry, directory);
      expect(applied.status, messages(applied.diagnostics)).toBe("valid");
      const evaluated = registry.runRules(demoRequest("agentlife.body/tick-elapsed", "process"));
      expect(evaluated.status).toBe("changes");
      expect(evaluated.trace.processChanges).toEqual([
        {
          changeId: expect.any(String),
          processRef: "test.process/recovery",
          system: "test.process",
          action: "establish",
          params: { target: "stamina", amount: 5 },
          sourceRule: "test.process/recovery",
        },
      ]);
      const again = registry.runRules(demoRequest("agentlife.body/tick-elapsed", "process"));
      expect(again.trace.processChanges[0]?.changeId).toBe(evaluated.trace.processChanges[0]?.changeId);
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
        before.trace.combines.find((entry) => entry.stateRef === "agentlife.body/values.wakefulness")?.result,
      ).toBe(80);

      const after = registry.runRules(demoRequest("agentlife.body/tick-elapsed"));
      expect(after.configId).toBe(updated.result.config?.configId);
      expect(after.trace.combines.find((entry) => entry.stateRef === "agentlife.body/values.wakefulness")?.result).toBe(
        10,
      );
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
