import { describe, expect, it } from "vitest";
import { evaluate } from "../src/config/evaluate.js";
import type { CompiledRuntimeConfig } from "../src/config/compile.js";
import type { DomainExtension } from "../src/config/extension.js";
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

/** A domain that still declares one process, used to exercise the runtime path. */
const FIXTURE_PROCESS: DomainExtension = {
  name: "extension",
  namespace: "test.process",
  version: "1.0.0",
  kernel: ">=1.0.0 <2.0.0",
  requires: [],
  configTypes: [],
  views: [],
  triggers: [],
  outputTargets: [],
  processes: [
    {
      name: "recovery",
      operations: ["establish", "advance", "pause", "end", "cancel"],
      parameters: Type.Object({ target: Type.String(), amount: Type.Number() }),
    },
  ],
};

describe("deterministic evaluation", () => {
  it("produces the same candidates and trace for the same config, snapshot and time", async () => {
    const registry = createRegistry();
    const { result, directory } = await applyDemoPack(registry);
    try {
      expect(result.status).toBe("valid");
      const first = registry.evaluate(demoRequest("agentlife.body/value-changed"));
      const second = registry.evaluate(demoRequest("agentlife.body/value-changed"));
      expect(JSON.stringify(first)).toBe(JSON.stringify(second));
      expect(first.configIdentity).toBe(result.config?.identity);

      const values = Object.fromEntries(first.trace.candidates.map((entry) => [entry.target, entry.value]));
      expect(values["agentlife.body/values.stamina"]).toBe(0);
      expect(values["agentlife.body/values.move-cost"]).toBe(5.7);
      expect(values["agentlife.body/values.move-cost-factor"]).toBe(2.52);
      expect(values["agentlife.body/cognitive-participation"]).toBe("restricted");
      expect(first.status).toBe("candidates");
    } finally {
      removeDirectory(directory);
    }
  });

  it("composes additive, multiplicative, min and priority sources in stable order", async () => {
    const registry = createRegistry();
    const { result, directory } = await applyDemoPack(registry);
    try {
      expect(result.status).toBe("valid");

      const perTick = registry.evaluate(demoRequest("agentlife.body/tick-elapsed", "tick"));
      const wakefulness = perTick.trace.compositions.find(
        (composition) => composition.target === "agentlife.body/values.wakefulness",
      );
      expect(wakefulness?.composition).toBe("priority");
      expect(wakefulness?.contributions.map((contribution) => contribution.rule)).toEqual([
        "agentlife.demo/daylight-wakefulness",
        "agentlife.demo/lamp-stimulus",
      ]);
      expect(wakefulness?.result).toBe(80);
      const stamina = perTick.trace.compositions.find(
        (composition) => composition.target === "agentlife.body/values.stamina",
      );
      expect(stamina?.composition).toBe("add");
      expect(stamina?.result).toBe(5);

      const environment = registry.evaluate(demoRequest("agentlife.world/environment-changed", "environment"));
      const visibility = environment.trace.compositions.find(
        (composition) => composition.target === "agentlife.world/environment.visibility",
      );
      expect(visibility?.composition).toBe("min");
      expect(visibility?.result).toBe(0.15);

      const cost = registry.evaluate(demoRequest("agentlife.body/value-changed", "cost"));
      const factor = cost.trace.compositions.find(
        (composition) => composition.target === "agentlife.body/values.move-cost-factor",
      );
      expect(factor?.composition).toBe("multiply");
      expect(factor?.contributions.map((contribution) => contribution.value)).toEqual([1.5, 1.2, 1.4]);
      expect(factor?.result).toBe(2.52);

      const participation = registry.evaluate(demoRequest("agentlife.body/value-changed", "participation"));
      expect(participation.trace.compositions.map((entry) => entry.target)).toContain(
        "agentlife.body/cognitive-participation",
      );
      const permission = participation.trace.candidates.find(
        (candidate) => candidate.target === "agentlife.body/cognitive-participation",
      );
      expect(permission?.value).toBe("restricted");
      expect(participation.trace.candidates.map((candidate) => candidate.target)).not.toContain(
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
      const result_ = registry.evaluate(demoRequest("agentlife.body/tick-elapsed"));
      expect(result_.trace.indexed).toEqual([
        "agentlife.demo/daylight-wakefulness",
        "agentlife.demo/lamp-stimulus",
        "agentlife.demo/rest-recovery",
      ]);
      expect(result_.trace.notIndexed).toContain("agentlife.demo/fog-visibility");
      expect(result_.trace.rules.map((rule) => rule.rule)).toEqual(result_.trace.indexed);

      const unmatched = registry.evaluate(demoRequest("agentlife.character/lifecycle-changed"));
      expect(unmatched.status).toBe("no-match");
      expect(unmatched.trace.indexed).toEqual([]);
      expect(unmatched.trace.candidates).toEqual([]);
      expect(unmatched.trace.notIndexed).toHaveLength(result.config?.rules.length ?? 0);
    } finally {
      removeDirectory(directory);
    }
  });

  it("reports a priority tie as a structured conflict instead of choosing a source", async () => {
    const registry = createRegistry();
    const { result, directory } = await applyDemoPack(registry, {
      "rules/lamp-stimulus.yaml": `kind: rule
id: lamp-stimulus
domain: agentlife.body/extension
triggers:
  - agentlife.body/tick-elapsed
reads:
  - alias: lamp
    view: agentlife.world/environment
    field: lamp-state
condition:
  op: compare
  left:
    kind: read
    alias: lamp
  right:
    kind: literal
    value: 1
    unit: state
  operator: eq
effects:
  - target: agentlife.body/values.wakefulness
    composition: priority
    priority: 10
    value:
      kind: map
      input:
        kind: read
        alias: lamp
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
      const evaluated = registry.evaluate(demoRequest("agentlife.body/tick-elapsed"));
      expect(evaluated.status).toBe("conflict");
      const conflict = evaluated.trace.compositions.find(
        (composition) => composition.target === "agentlife.body/values.wakefulness",
      );
      expect(conflict?.status).toBe("conflict");
      expect(conflict?.conflicting).toEqual(["agentlife.demo/daylight-wakefulness", "agentlife.demo/lamp-stimulus"]);
      expect(evaluated.trace.candidates.map((candidate) => candidate.target)).toEqual([
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
domain: agentlife.body/extension
triggers:
  - agentlife.body/value-changed
reads:
  - alias: load
    view: agentlife.body/values
    field: load
condition:
  op: always
effects:
  - target: agentlife.body/values.move-cost
    composition: add
    value:
      kind: literal
      value: 500
      unit: points
`,
    });
    try {
      expect(result.status).toBe("valid");
      const evaluated = registry.evaluate(demoRequest("agentlife.body/value-changed"));
      expect(evaluated.status).toBe("inexpressible");
      const composition = evaluated.trace.compositions.find(
        (trace) => trace.target === "agentlife.body/values.move-cost",
      );
      expect(composition?.status).toBe("rejected");
      expect(composition?.message).toContain("declared range");
      expect(evaluated.trace.candidates.map((candidate) => candidate.target)).not.toContain(
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
      const evaluated = registry.evaluate({
        requestId: "missing-view",
        trigger: "agentlife.body/value-changed",
        snapshot: {
          stateVersion: "state-1",
          simulationTime: { tick: 3, seconds: 30 },
          views: {
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
      const rule = evaluated.trace.rules.find((trace) => trace.rule === "agentlife.demo/base-move-cost");
      expect(rule?.outcome).toBe("input-missing");
      expect(rule?.message).toContain("load");
      // Rules that could be answered still report their candidates; the status
      // marks the evaluation as incomplete, so a partial set is never mistaken
      // for a complete one.
      expect(evaluated.trace.candidates.map((candidate) => candidate.target)).toEqual([
        "agentlife.body/values.move-cost-factor",
      ]);
    } finally {
      removeDirectory(directory);
    }
  });

  it("refuses to evaluate a deferred request against a newer state version", async () => {
    const registry = createRegistry();
    const { result, directory } = await applyDemoPack(registry);
    try {
      expect(result.status).toBe("valid");
      const evaluated = registry.evaluate({
        ...demoRequest("agentlife.body/value-changed"),
        dependsOnStateVersion: "state-0",
      });
      expect(evaluated.status).toBe("state-version-stale");
      expect(evaluated.trace.rules).toEqual([]);
      expect(evaluated.trace.candidates).toEqual([]);
      expect(evaluated.trace.indexed.length).toBeGreaterThan(0);
    } finally {
      removeDirectory(directory);
    }
  });

  it("proposes process operations as candidates without advancing time", async () => {
    // No shipped domain declares a process yet, so the runtime path is exercised
    // against a synthetic domain that still does.
    await withTempDirectory(async (directory) => {
      writePack(directory, {
        "manifest.yaml": `pack: test.process
version: "1.0.0"
kernel: ">=1.0.0 <2.0.0"
dependencies: []
extensions: []
sections:
  world: agentlife.world/world
`,
        "world/settings.yaml": FIXTURE_WORLD,
        "rules/recovery.yaml": `kind: rule
id: recovery
domain: test.process/extension
triggers:
  - agentlife.body/tick-elapsed
condition:
  op: always
effects:
  - process: test.process/recovery
    operation: establish
    parameters:
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
      const evaluated = registry.evaluate(demoRequest("agentlife.body/tick-elapsed", "process"));
      expect(evaluated.status).toBe("candidates");
      expect(evaluated.trace.processOperations).toEqual([
        {
          operationId: expect.any(String),
          process: "test.process/recovery",
          owner: "test.process/extension",
          operation: "establish",
          parameters: { target: "stamina", amount: 5 },
          rule: "test.process/recovery",
        },
      ]);
      const again = registry.evaluate(demoRequest("agentlife.body/tick-elapsed", "process"));
      expect(again.trace.processOperations[0]?.operationId).toBe(evaluated.trace.processOperations[0]?.operationId);
    });
  });

  it("answers config-unavailable before any version is published", async () => {
    const registry = createRegistry();
    const evaluated = registry.evaluate(demoRequest("agentlife.body/tick-elapsed"));
    expect(evaluated.status).toBe("config-unavailable");
    expect(evaluated.trace.candidates).toEqual([]);
  });

  it("completes an evaluation against the version it started with", async () => {
    const registry = createRegistry();
    const first = await applyDemoPack(registry);
    const started = registry.current();
    const updated = await applyDemoPack(registry, {
      "rules/lamp-stimulus.yaml": `kind: rule
id: lamp-stimulus
domain: agentlife.body/extension
triggers:
  - agentlife.body/tick-elapsed
reads:
  - alias: lamp
    view: agentlife.world/environment
    field: lamp-state
condition:
  op: always
effects:
  - target: agentlife.body/values.wakefulness
    composition: priority
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
      expect(updated.result.config?.identity).not.toBe(started?.identity);

      const before = evaluate(started as CompiledRuntimeConfig, demoRequest("agentlife.body/tick-elapsed"));
      expect(before.configIdentity).toBe(started?.identity);
      expect(
        before.trace.compositions.find((entry) => entry.target === "agentlife.body/values.wakefulness")?.result,
      ).toBe(80);

      const after = registry.evaluate(demoRequest("agentlife.body/tick-elapsed"));
      expect(after.configIdentity).toBe(updated.result.config?.identity);
      expect(
        after.trace.compositions.find((entry) => entry.target === "agentlife.body/values.wakefulness")?.result,
      ).toBe(10);
    } finally {
      removeDirectory(first.directory);
      removeDirectory(updated.directory);
    }
  });

  it("traces the version, state snapshot and simulated time it used", async () => {
    const registry = createRegistry();
    const { result, directory } = await applyDemoPack(registry);
    try {
      const evaluated = registry.evaluate(demoRequest("agentlife.body/tick-elapsed", "traced"));
      expect(evaluated.trace.configIdentity).toBe(result.config?.identity);
      expect(evaluated.trace.stateVersion).toBe("state-1");
      expect(evaluated.trace.simulationTime).toEqual({ tick: 3, seconds: 30 });
      expect(evaluated.trace.requestId).toBe("traced");
      expect(evaluated.trace.trigger).toBe("agentlife.body/tick-elapsed");
    } finally {
      removeDirectory(directory);
    }
  });
});
