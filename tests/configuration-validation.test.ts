import { describe, expect, it } from "vitest";
import {
  applyDemoPack,
  causeCodes,
  createRegistry,
  FIXTURE_WORLD,
  messages,
  removeDirectory,
  demoManifest,
  demoSystemPins,
  withSystemVersion,
  withTempDirectory,
  writePack,
} from "./helpers/demo-pack.js";
import type { SystemSpec } from "../src/config/system-spec.js";
import { loadPack } from "./helpers/demo-pack.js";
import { Type } from "typebox";
import { defineValueContainer } from "../src/config/value-shapes.js";

interface RefusalCase {
  readonly name: string;
  readonly overrides: Readonly<Record<string, string | null>>;
  readonly code: string;
  readonly message: string;
  /** Extensions registered on top of the three demo systems. */
  readonly systems?: readonly SystemSpec[];
}

const restRecovery = (mutate: (source: string) => string): string => mutate(SOURCE_REST_RECOVERY);
const SOURCE_REST_RECOVERY = `kind: rule
id: rest-recovery
system: agentlife.body
triggers:
  - agentlife.body/tick-elapsed
inputs:
  - name: stamina
    state: agentlife.body/values.stamina
  - name: light
    state: agentlife.world/environment.light-level
condition:
  op: all
  operands:
    - op: simulation-time
      operator: at-or-after
      tick: 1
    - op: within
      value:
        kind: read
        name: stamina
      min: 0
      max: 60
      boundary: exclusive
    - op: compare
      left:
        kind: read
        name: light
      right:
        kind: literal
        value: 10
        unit: lux
      operator: gt
changes:
  - state: agentlife.body/values.stamina
    combine: add
    value:
      kind: map
      input:
        kind: read
        name: stamina
      mapping:
        kind: threshold
        inputUnit: points
        at: 30
        boundary: lower
        below: 5
        above: 1
        policy:
          unit: points
          rounding:
            mode: half-away-from-zero
            precision: 1
          range:
            min: 0
            max: 10
            boundary: inclusive
          overflow: saturate
`;

/** A minimal system used to exercise one combine method end to end. */
const FIXTURE_LIMITS: SystemSpec = {
  name: "system",
  namespace: "test.limits",
  version: "1.0.0",
  kernel: ">=1.0.0 <2.0.0",
  requires: [],
  items: [
    defineValueContainer({
      kind: "signal",
      valueSet: "signals",
      contract: false,
      input: { scope: "entity", exposedTo: [] },
      output: { scope: "entity", exposedTo: [] },
    }),
  ],
  inputs: [
    {
      name: "state",
      scope: "entity",
      fields: Type.Object({ value: Type.Number() }),
      units: { value: "points" },
      exposedTo: [],
    },
  ],
  triggers: ["changed"],
  outputs: [],
};

/**
 * A system that still declares one process, so the kernel's process checks stay
 * covered while no shipped system uses them yet.
 */
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
  ],
};

const CASES: readonly RefusalCase[] = [
  {
    name: "a template that does not exist",
    overrides: {
      "characters/gate-warden.yaml": `id: gate-warden
type: agentlife.character/character
public: true
templates:
  - agentlife.demo/absent-entity
fields:
  name: 门口的护卫
  identity: 领一份口粮，守一段路。
  tier: degraded
  main: false
  control:
    kind: behaviour-tree
  modules:
    - behaviour-tree
  homeLocation: agentlife.demo/kiln
`,
    },
    code: "unknown-reference",
    message: "does not exist",
  },
  {
    name: "a template cycle",
    overrides: {
      "characters/gate-warden.yaml": `id: gate-warden
type: agentlife.character/character
public: true
templates:
  - agentlife.demo/companion
fields:
  name: 门口的护卫
  identity: 领一份口粮，守一段路。
  tier: degraded
  main: false
  control:
    kind: behaviour-tree
  modules:
    - behaviour-tree
  homeLocation: agentlife.demo/kiln
`,
      "characters/companion.yaml": `id: companion
type: agentlife.character/character
public: true
templates:
  - agentlife.demo/gate-warden
fields:
  name: 阿禾
  identity: 在果园长大，认得每一棵树的脾气。
  main: true
  homeLocation: agentlife.demo/orchard
`,
    },
    code: "cyclic-dependency",
    message: "Template cycle detected",
  },
  {
    name: "a read of a input no system exposed",
    overrides: {
      "rules/exertion-cost.yaml": `kind: rule
id: exertion-cost
system: agentlife.body
triggers:
  - agentlife.body/value-changed
inputs:
  - name: tier
    state: agentlife.character/schedule.tier
condition:
  op: always
changes:
  - state: agentlife.body/values.stamina
    combine: add
    value:
      kind: literal
      value: 1
      unit: points
`,
    },
    code: "unauthorized-read",
    message: "agentlife.character/schedule",
  },
  {
    name: "a write to a target the system does not own or expose",
    overrides: {
      "rules/fog-visibility.yaml": `kind: rule
id: fog-visibility
system: agentlife.world
triggers:
  - agentlife.world/environment-changed
inputs:
  - name: fog
    state: agentlife.world/environment.fog-density
condition:
  op: always
changes:
  - state: agentlife.body/values.stamina
    combine: priority
    priority: 1
    value:
      kind: literal
      value: 10
      unit: points
`,
    },
    code: "unauthorized-change",
    message: "may not request state",
  },
  {
    name: "a trigger no system declares",
    overrides: {
      "rules/rest-recovery.yaml": restRecovery((source) =>
        source.replace("agentlife.body/tick-elapsed", "agentlife.body/never-declared"),
      ),
    },
    code: "unknown-trigger",
    message: "never-declared",
  },
  {
    name: "two sources writing one target with different combine methods",
    overrides: {
      "rules/rest-recovery.yaml": restRecovery((source) => source.replace("    combine: add", "    combine: min")),
    },
    code: "missing-combine",
    message: "agentlife.body/values.stamina",
  },
  {
    name: "a combine method the target's unit cannot support",
    overrides: {
      "rules/rest-recovery.yaml": restRecovery((source) => source.replace("    combine: add", "    combine: multiply")),
    },
    code: "combine-not-allowed",
    message: 'is not "ratio"',
  },
  {
    name: "a value whose unit does not match the target",
    overrides: {
      "rules/rest-recovery.yaml": restRecovery((source) =>
        source.replace("          unit: points\n          rounding:", "          unit: mass\n          rounding:"),
      ),
    },
    code: "unit-mismatch",
    message: "unit",
  },
  {
    name: "a comparison mixing two units",
    overrides: {
      "rules/rest-recovery.yaml": restRecovery((source) =>
        source.replace("        value: 10\n        unit: lux", "        value: 10\n        unit: mass"),
      ),
    },
    code: "unit-mismatch",
    message: "comparison mixes units",
  },
  {
    name: "a numeric policy without a declared range",
    overrides: {
      "rules/rest-recovery.yaml": restRecovery((source) =>
        source.replace(
          "          range:\n            min: 0\n            max: 10\n            boundary: inclusive\n",
          "",
        ),
      ),
    },
    code: "structure-invalid",
    message: "policy.range must be a mapping",
  },
  {
    name: "a combination mixing two units",
    overrides: {
      "rules/vision-availability.yaml": `kind: rule
id: vision-availability
system: agentlife.body
triggers:
  - agentlife.world/environment-changed
inputs:
  - name: light
    state: agentlife.world/environment.light-level
  - name: fog
    state: agentlife.world/environment.fog-density
condition:
  op: always
changes:
  - state: agentlife.body/values.move-cost-factor
    combine: multiply
    value:
      kind: combine
      method: min
      operands:
        - kind: read
          name: light
        - kind: read
          name: fog
`,
    },
    code: "unit-mismatch",
    message: "combination min mixes units",
  },
  {
    name: "a selection whose branches produce different types",
    overrides: {
      "rules/vision-availability.yaml": `kind: rule
id: vision-availability
system: agentlife.body
triggers:
  - agentlife.world/environment-changed
inputs:
  - name: fog
    state: agentlife.world/environment.fog-density
condition:
  op: always
changes:
  - state: agentlife.body/channels.vision.available
    combine: priority
    priority: 1
    value:
      kind: select
      left:
        kind: read
        name: fog
      right:
        kind: literal
        value: 0.9
        unit: ratio
      operator: gt
      then:
        kind: literal
        value: 1
        unit: ratio
      otherwise:
        kind: literal
        value: false
`,
    },
    code: "incompatible-output-type",
    message: "selection branches produce",
  },
  {
    name: "piecewise bands that overlap",
    overrides: {
      "rules/terrain-move-cost-factor.yaml": `kind: rule
id: terrain-move-cost-factor
system: agentlife.body
triggers:
  - agentlife.body/value-changed
inputs:
  - name: slope
    state: agentlife.world/environment.slope
condition:
  op: always
changes:
  - state: agentlife.body/values.move-cost-factor
    combine: multiply
    value:
      kind: map
      input:
        kind: read
        name: slope
      mapping:
        kind: piecewise-constant
        inputUnit: ratio
        bands:
          - from: null
            value: 1
          - from: 0.4
            value: 1.4
          - from: 0.4
            value: 2
        outOfRange:
          kind: clamp
        policy:
          unit: ratio
          rounding:
            mode: half-away-from-zero
            precision: 2
          range:
            min: 0.25
            max: 4
            boundary: inclusive
          overflow: saturate
`,
    },
    code: "structure-invalid",
    message: "increase strictly",
  },
  {
    name: "a item whose type does not match its section",
    overrides: {
      "locations/orchard.yaml": `id: orchard
type: agentlife.world/item
public: true
fields:
  name: 老果园
  description: 一排排修剪过的果树。
`,
    },
    code: "structure-invalid",
    message: "must be agentlife.world/location for this section",
  },
  {
    name: "a read of a field no input declares",
    overrides: {
      "rules/rest-recovery.yaml": restRecovery((source) =>
        source.replace("    state: agentlife.body/values.stamina", "    state: agentlife.body/values.vigour"),
      ),
    },
    code: "unknown-reference",
    message: "vigour",
  },
  {
    name: "a rule without any state change",
    overrides: {
      "rules/recovery-request.yaml": `kind: rule
id: recovery-request
system: agentlife.body
triggers:
  - agentlife.body/tick-elapsed
condition:
  op: always
changes: []
`,
    },
    code: "structure-invalid",
    message: "declares no state change",
  },
  {
    name: "a branch that declares neither a change nor words",
    overrides: {
      "rules/recovery-request.yaml": `kind: rule
id: recovery-request
system: agentlife.body
triggers:
  - agentlife.body/tick-elapsed
branches:
  - when:
      op: always
    changes: []
`,
    },
    code: "structure-invalid",
    message: "declares no state change",
  },
  {
    name: "a rule that declares its effect both flat and as branches",
    overrides: {
      "rules/recovery-request.yaml": `kind: rule
id: recovery-request
system: agentlife.body
triggers:
  - agentlife.body/tick-elapsed
condition:
  op: always
changes: []
notice: 什么也没有发生
branches:
  - when:
      op: always
    changes: []
    notice: 什么也没有发生
`,
    },
    code: "structure-invalid",
    message: "declares both branches and condition",
  },
  {
    name: "a branch whose guard is spelled condition",
    overrides: {
      "rules/recovery-request.yaml": `kind: rule
id: recovery-request
system: agentlife.body
triggers:
  - agentlife.body/tick-elapsed
branches:
  - condition:
      op: always
    changes: []
    notice: 什么也没有发生
`,
    },
    code: "structure-invalid",
    message: "rules/recovery-request.yaml.branches[0].condition is not a supported field",
  },
  {
    name: "a kernel version the pack cannot run against",
    overrides: {
      "manifest.yaml": demoManifest({ kernel: ">=3.0.0" }),
    },
    code: "incompatible-system",
    message: "requires kernel",
  },
  {
    name: "an system version the pack pins differently",
    overrides: {
      "manifest.yaml": demoManifest({
        systems: withSystemVersion(demoSystemPins(), "agentlife.body", "2.0.0"),
      }),
    },
    code: "incompatible-system",
    message: "agentlife.body",
  },
  {
    name: "a degraded entity that claims to be a main entity",
    overrides: {
      "characters/gate-warden.yaml": `id: gate-warden
type: agentlife.character/character
public: true
fields:
  name: 门口的护卫
  identity: 领一份口粮，守一段路。
  tier: degraded
  main: true
  control:
    kind: behaviour-tree
  modules:
    - behaviour-tree
  homeLocation: agentlife.demo/kiln
`,
    },
    code: "system-rejected",
    message: "cannot be a main entity",
  },
  {
    name: "a degraded entity that references cognition",
    overrides: {
      "characters/gate-warden.yaml": `id: gate-warden
type: agentlife.character/character
public: true
fields:
  name: 门口的护卫
  identity: 领一份口粮，守一段路。
  tier: degraded
  main: false
  control:
    kind: behaviour-tree
  modules:
    - behaviour-tree
    - cognition
  homeLocation: agentlife.demo/kiln
`,
    },
    code: "system-rejected",
    message: "must not reference cognition",
  },
  {
    name: "a normal entity that also runs a behaviour tree",
    overrides: {
      "characters/companion.yaml": `id: companion
type: agentlife.character/character
public: true
fields:
  name: 阿禾
  identity: 在果园长大，认得每一棵树的脾气。
  tier: normal
  main: true
  control:
    kind: cognition
  modules:
    - perception
    - cognition
    - memory
    - behaviour-tree
  homeLocation: agentlife.demo/orchard
`,
    },
    code: "system-rejected",
    message: "must not run a behaviour tree",
  },
  {
    name: "a character without an initial identity",
    overrides: {
      "characters/player.yaml": `id: player
type: agentlife.character/character
public: true
fields:
  name: 旅人
  identity: "  "
  tier: normal
  main: true
  control:
    kind: user
  modules:
    - perception
    - cognition
    - memory
  homeLocation: agentlife.demo/lantern-square
`,
    },
    code: "system-rejected",
    message: "must carry an initial version",
  },
  {
    name: "a location exit that points at a non-location",
    overrides: {
      "locations/orchard.yaml": `id: orchard
type: agentlife.world/location
public: true
fields:
  name: 老果园
  description: 一排排修剪过的果树。
  exits:
    - agentlife.demo/rope
`,
    },
    code: "reference-type-mismatch",
    message: "must reference agentlife.world/location",
  },
  {
    name: "a value whose initial state does not match its declared type",
    overrides: {
      "values/stamina.yaml": `id: stamina
type: agentlife.body/value
public: true
fields:
  type: number
  initial: "70"
  unit: points
`,
    },
    code: "structure-invalid",
    message: "state is not a number",
  },
  {
    name: "a value whose declared scalar type is not supported",
    overrides: {
      "values/load.yaml": `id: load
type: agentlife.body/value
public: true
fields:
  type: integer
  initial: 0
  unit: mass
`,
    },
    code: "structure-invalid",
    message: "does not match value",
  },
  {
    name: "a string value whose initial state is outside its vocabulary",
    overrides: {
      "values/mood.yaml": `id: mood
type: agentlife.body/value
public: true
fields:
  type: string
  initial: angry
  allowedValues:
    - calm
    - tense
`,
    },
    code: "invalid-value",
    message: "outside its declared vocabulary",
  },
  {
    name: "a value whose declared unit is not a unit name",
    overrides: {
      "values/load.yaml": `id: load
type: agentlife.body/value
public: true
fields:
  type: number
  initial: 0
  unit: two words
`,
    },
    code: "invalid-value",
    message: "unit is not a unit name",
  },
  {
    name: "a value id that cannot address a field",
    overrides: {
      "values/extra-load.yaml": `id: extraLoad
type: agentlife.body/value
public: true
fields:
  type: number
  initial: 0
  unit: mass
`,
    },
    code: "structure-invalid",
    message: "cannot address a value field",
  },
  {
    name: "a second writer for a contract channel field",
    overrides: {
      "rules/vision-availability.yaml": `kind: rule
id: vision-availability
system: agentlife.body
triggers:
  - agentlife.world/environment-changed
inputs:
  - name: fog
    state: agentlife.world/environment.fog-density
condition:
  op: always
changes:
  - state: agentlife.body/channels.vision.available
    combine: priority
    priority: 1
    value:
      kind: literal
      value: true
  - state: agentlife.body/channels.vision.efficiency
    combine: priority
    priority: 2
    value:
      kind: literal
      value: 0.5
      unit: ratio
`,
    },
    code: "multiple-writers",
    message: "exactly one writer",
  },
  {
    name: "an item that declares an interaction role",
    overrides: {
      "items/rope.yaml": `id: rope
type: agentlife.world/item
public: true
fields:
  name: 麻绳
  description: 一段麻绳。
  roles:
    - carryable
`,
    },
    code: "structure-invalid",
    message: "roles is not declared by item",
  },
  {
    name: "a rule depending on a formula that does not exist",
    overrides: {
      "rules/exhaustion-move-cost-factor.yaml": `kind: rule
id: exhaustion-move-cost-factor
system: agentlife.body
triggers:
  - agentlife.body/value-changed
inputs:
  - name: stamina
    state: agentlife.body/values.stamina
condition:
  op: always
dependsOn:
  - agentlife.demo/absent-formula
changes:
  - state: agentlife.body/values.move-cost-factor
    combine: multiply
    value:
      kind: formula
      formulaRef: agentlife.demo/absent-formula
`,
    },
    code: "unknown-reference",
    message: "absent-formula",
  },
  {
    name: "a formula whose value unit differs from its declared output unit",
    overrides: {
      "rules/exhaustion-factor.yaml": `kind: formula
id: exhaustion-factor
system: agentlife.body
inputs:
  - name: stamina
    state: agentlife.body/values.stamina
outputUnit: points
value:
  kind: map
  input:
    kind: read
    name: stamina
  mapping:
    kind: piecewise-constant
    inputUnit: points
    bands:
      - from: null
        value: 1
    outOfRange:
      kind: clamp
    policy:
      unit: ratio
      rounding:
        mode: half-away-from-zero
        precision: 2
      range:
        min: 0.5
        max: 3
        boundary: inclusive
      overflow: saturate
`,
    },
    code: "unit-mismatch",
    message: "declares output unit points",
  },
  {
    name: "a process operation a foreign system does not own",
    overrides: {
      "rules/recovery-request.yaml": `kind: rule
id: recovery-request
system: test.limits
triggers:
  - test.limits/changed
inputs:
  - name: value
    state: test.limits/state.value
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
    },
    code: "unauthorized-change",
    message: "may not operate process",
    systems: [FIXTURE_LIMITS, FIXTURE_PROCESS],
  },
  {
    name: "a process parameter the declaration does not accept",
    overrides: {
      "rules/recovery-request.yaml": `kind: rule
id: recovery-request
system: test.process
triggers:
  - test.limits/changed
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
      duration:
        kind: literal
        value: 3
        unit: ticks
`,
    },
    code: "structure-invalid",
    message: "unknown parameter duration",
    systems: [FIXTURE_LIMITS, FIXTURE_PROCESS],
  },
  {
    name: "a read that names a value field instead of its input",
    overrides: {
      "rules/base-move-cost.yaml": `kind: rule
id: base-move-cost
system: agentlife.body
triggers:
  - agentlife.body/value-changed
inputs:
  - name: stamina
    state: agentlife.body/values.stamina.stamina
condition:
  op: always
changes:
  - state: agentlife.body/values.move-cost
    combine: add
    value:
      kind: literal
      value: 2
      unit: points
`,
    },
    code: "reference-type-mismatch",
    message: "which is a value field",
  },
  {
    name: "cognition settings that name a model",
    overrides: {
      "cognitionSettings/cognition-settings.yaml": `id: cognition-settings
type: agentlife.cognition/settings
public: true
fields:
  name: 演示认知设置
  description: 短计划、有限等待、模型次数与容量都写在内容里；模型选择由系统配置决定。
  observationCapacity: 6
  intentionReservation: 2
  attentionCapacity: 3
  maxPlanSteps: 3
  maxAttempts: 2
  requestTimeoutSeconds: 60
  idleReviewTicks: 3
  idleWaitLimitTicks: 12
  provider: faux
  model: faux/faux-cognition
  allowedActions:
    - agentlife.demo/walk
    - agentlife.demo/grasp
    - agentlife.demo/lay-down
    - agentlife.demo/use
    - agentlife.demo/wave
    - agentlife.demo/say
`,
    },
    code: "structure-invalid",
    message: "is not declared by settings",
  },
];
describe("configuration validation", () => {
  it.each(CASES.map((scenario) => [scenario.name, scenario] as const))("rejects %s", async (_name, scenario) => {
    const registry = createRegistry(scenario.systems ?? []);
    const { result, directory } = await applyDemoPack(registry, scenario.overrides);
    try {
      expect(result.status).toBe("rejected");
      expect(causeCodes(result.diagnostics)).toContain(scenario.code);
      expect(messages(result.diagnostics)).toContain(scenario.message);
      expect(registry.current()).toBeUndefined();
    } finally {
      removeDirectory(directory);
    }
  });

  it("accepts a rule whose declared effect is words instead of a state change", async () => {
    const { result, directory } = await applyDemoPack(createRegistry(), {
      // The answer an operation on a state that stays the same is entitled to. The
      // notice is the effect; without one the same rule is still refused above.
      "rules/exhaustion-move-cost-factor.yaml": `kind: rule
id: exhaustion-move-cost-factor
system: agentlife.body
triggers:
  - agentlife.body/value-changed
inputs:
  - name: stamina
    state: agentlife.body/values.stamina
condition:
  op: compare
  left:
    kind: read
    name: stamina
  right:
    kind: literal
    value: 20
    unit: points
  operator: lt
changes: []
notice: 体力不济，走不动了
`,
    });
    try {
      expect(result.status, messages(result.diagnostics)).toBe("valid");
      const rule = result.config?.rules.find(
        (candidate) => candidate.ref === "agentlife.demo/exhaustion-move-cost-factor",
      );
      // Written flat, so the rule has exactly one branch: the same shape a rule with
      // several branches is made of.
      expect(rule?.branches).toHaveLength(1);
      expect(rule?.branches[0]?.changes).toEqual([]);
      expect(rule?.branches[0]?.notice).toBe("体力不济，走不动了");
      // A notice about a body's own state belongs to that body: the scope comes
      // from what the rule reads, exactly as the change it replaces would have.
      expect(rule?.evaluationScope).toBe("entity");
    } finally {
      removeDirectory(directory);
    }
  });

  it("accepts one rule whose branches declare the effect of each state", async () => {
    const { result, directory } = await applyDemoPack(createRegistry(), {
      // One rule, two branches: the same body value answers differently depending on
      // what it is, and each branch says what that answer is. The rule still has one
      // scope, taken from what its branches read.
      "rules/exhaustion-move-cost-factor.yaml": `kind: rule
id: exhaustion-move-cost-factor
system: agentlife.body
triggers:
  - agentlife.body/value-changed
inputs:
  - name: stamina
    state: agentlife.body/values.stamina
dependsOn:
  - agentlife.demo/exhaustion-factor
branches:
  - when:
      op: compare
      left:
        kind: read
        name: stamina
      right:
        kind: literal
        value: 0
        unit: points
      operator: gt
    changes:
      - state: agentlife.body/values.move-cost-factor
        combine: multiply
        value:
          kind: formula
          formulaRef: agentlife.demo/exhaustion-factor
  - when:
      op: compare
      left:
        kind: read
        name: stamina
      right:
        kind: literal
        value: 0
        unit: points
      operator: eq
    changes: []
    notice: 一点力气也没有了
`,
    });
    try {
      expect(result.status, messages(result.diagnostics)).toBe("valid");
      const rule = result.config?.rules.find(
        (candidate) => candidate.ref === "agentlife.demo/exhaustion-move-cost-factor",
      );
      // Two branches, in source order, each with its own effect and its own words.
      expect(rule?.branches).toHaveLength(2);
      expect(rule?.branches[0]?.changes.map((change) => change.kind)).toEqual(["state"]);
      expect(rule?.branches[0]?.notice).toBeNull();
      expect(rule?.branches[1]?.changes).toEqual([]);
      expect(rule?.branches[1]?.notice).toBe("一点力气也没有了");
      expect(rule?.evaluationScope).toBe("entity");
    } finally {
      removeDirectory(directory);
    }
  });

  it("rejects a duplicated field with no declared merge strategy", async () => {
    await withTempDirectory(async (directory) => {
      writePack(directory, {
        "manifest.yaml": `pack: test.fixture
version: "1.0.0"
kernel: ">=1.0.0 <2.0.0"
dependencies: []
systems: []
sections:
  world: agentlife.world/world
  widgets: test.fixture/widget
`,
        "world/settings.yaml": FIXTURE_WORLD,
        "widgets/base.yaml": `id: base
type: test.fixture/widget
public: true
fields:
  extra: 1
  flavour: a
`,
        "widgets/derived.yaml": `id: derived
type: test.fixture/widget
public: true
templates:
  - test.fixture/base
fields:
  flavour: b
`,
      });
      const applied = await loadPack(createRegistry([FIXTURE_WIDGET]), directory);
      expect(applied.status).toBe("rejected");
      expect(causeCodes(applied.diagnostics)).toContain("ambiguous-merge");
      expect(messages(applied.diagnostics)).toContain("declares no merge strategy");
    });
  });

  it("rejects an override of a field the config type does not allow overriding", async () => {
    await withTempDirectory(async (directory) => {
      writePack(directory, {
        "manifest.yaml": `pack: test.fixture
version: "1.0.0"
kernel: ">=1.0.0 <2.0.0"
dependencies: []
systems: []
sections:
  world: agentlife.world/world
  widgets: test.fixture/widget
`,
        "world/settings.yaml": FIXTURE_WORLD,
        "widgets/derived.yaml": `id: derived
type: test.fixture/widget
public: true
fields:
  sealed: 覆写
`,
      });
      const applied = await loadPack(createRegistry([FIXTURE_WIDGET]), directory);
      expect(applied.status).toBe("rejected");
      expect(causeCodes(applied.diagnostics)).toContain("field-not-overridable");
    });
  });

  it("accepts a item whose fields come from defaults and a template", async () => {
    await withTempDirectory(async (directory) => {
      writePack(directory, {
        "manifest.yaml": `pack: test.fixture
version: "1.0.0"
kernel: ">=1.0.0 <2.0.0"
dependencies: []
systems: []
sections:
  world: agentlife.world/world
  widgets: test.fixture/widget
`,
        "world/settings.yaml": FIXTURE_WORLD,
        "widgets/base.yaml": `id: base
type: test.fixture/widget
public: true
fields:
  extra: 1
  flavour: a
`,
        "widgets/derived.yaml": `id: derived
type: test.fixture/widget
public: true
templates:
  - test.fixture/base
fields:
  extra: 2
`,
      });
      const applied = await loadPack(createRegistry([FIXTURE_WIDGET]), directory);
      expect(applied.status, messages(applied.diagnostics)).toBe("valid");
      const derived = applied.config?.items.find((item) => item.ref === "test.fixture/derived");
      expect(derived?.values).toEqual({ label: "默认", extra: 2, flavour: "a", sealed: "固定" });
      expect(derived?.fields.label?.ruleValues.map((ruleValue) => ruleValue.layer)).toEqual(["default", "template"]);
      expect(derived?.fields.extra?.ruleValues.map((ruleValue) => ruleValue.layer)).toEqual(["template", "override"]);
    });
  });

  it("composes the largest of several sources for a max target", async () => {
    await withTempDirectory(async (directory) => {
      const mapped = (id: string, value: string, inputs: string): string => `kind: rule
id: ${id}
system: test.limits
triggers:
  - test.limits/changed
${inputs}condition:
  op: always
changes:
  - state: test.limits/signals.limit
    combine: max
    value:
${value}
`;
      writePack(directory, {
        "manifest.yaml": `pack: test.limits
version: "1.0.0"
kernel: ">=1.0.0 <2.0.0"
dependencies: []
systems: []
sections:
  world: agentlife.world/world
  signals: test.limits/signal
`,
        "world/settings.yaml": FIXTURE_WORLD,
        "signals/limit.yaml": `id: limit
type: test.limits/signal
fields:
  type: number
  initial: 0
  unit: points
`,
        "rules/lower.yaml": mapped("lower", "      kind: literal\n      value: 40\n      unit: points", ""),
        "rules/upper.yaml": mapped(
          "upper",
          `      kind: map
      input:
        kind: read
        name: value
      mapping:
        kind: threshold
        inputUnit: points
        at: 50
        boundary: upper
        below: 10
        above: 70
        policy:
          unit: points
          rounding:
            mode: half-away-from-zero
            precision: 1
          range:
            min: 0
            max: 100
            boundary: inclusive
          overflow: saturate`,
          `inputs:
  - name: value
    state: test.limits/state.value
`,
        ),
      });
      const registry = createRegistry([FIXTURE_LIMITS]);
      const applied = await loadPack(registry, directory);
      expect(applied.status, messages(applied.diagnostics)).toBe("valid");
      const evaluated = registry.runRules({
        runId: "limits",
        trigger: "test.limits/changed",
        entityIds: ["test.entity"],
        input: {
          stateVersion: "state-1",
          simTime: { tick: 1, seconds: 10 },
          shared: {},
          entities: { "test.entity": { "test.limits/state": { value: 80 } } },
        },
      });
      expect(evaluated.status).toBe("changes");
      const combine = evaluated.trace.entities[0]?.combines[0];
      expect(combine?.combine).toBe("max");
      expect(combine?.ruleValues.map((ruleValue) => ruleValue.value)).toEqual([40, 70]);
      expect(combine?.result).toBe(70);
      expect(evaluated.trace.stateChanges[0]?.newValue).toBe(70);
    });
  });
});

/**
 * A config type whose `extra` field declares no merge strategy: any second
 * ruleValue to it must be refused rather than resolved by load order.
 */
const FIXTURE_WIDGET: SystemSpec = {
  name: "system",
  namespace: "test.fixture",
  version: "1.0.0",
  kernel: ">=1.0.0 <2.0.0",
  requires: [],
  items: [
    {
      kind: "widget",
      fields: Type.Object({
        label: Type.String(),
        extra: Type.Number(),
        flavour: Type.String(),
        sealed: Type.String(),
      }),
      defaults: { label: "默认", sealed: "固定" },
      // `flavour` deliberately declares no merge strategy: a second
      // ruleValue to it must be refused instead of resolved by load order.
      overridable: ["extra", "flavour"],
      merge: { label: "replace", extra: "replace", sealed: "replace" },
    },
  ],
  inputs: [],
  triggers: [],
  outputs: [],
};

const FIXTURE_SCOPE: SystemSpec = {
  name: "system",
  namespace: "test.scope",
  version: "1.0.0",
  kernel: ">=1.0.0 <2.0.0",
  requires: [],
  items: [],
  inputs: [
    {
      name: "entity-state",
      scope: "entity",
      fields: Type.Object({ value: Type.Number() }),
      units: { value: "points" },
      exposedTo: [],
    },
  ],
  triggers: ["changed"],
  outputs: [{ name: "shared-result", scope: "shared", valueType: "number", exposedTo: [] }],
};

describe("configuration evaluation scopes", () => {
  it("refuses an entity read that produces a shared change", async () => {
    await withTempDirectory(async (directory) => {
      writePack(directory, {
        "manifest.yaml": `pack: test.scope
version: "1.0.0"
kernel: ">=1.0.0 <2.0.0"
dependencies: []
systems: []
sections:
  world: agentlife.world/world
`,
        "world/settings.yaml": FIXTURE_WORLD,
        "rules/invalid-scope.yaml": `kind: rule
id: invalid-scope
system: test.scope
triggers:
  - test.scope/changed
inputs:
  - name: entity-value
    state: test.scope/entity-state.value
condition:
  op: always
changes:
  - state: test.scope/shared-result
    combine: add
    value:
      kind: read
      name: entity-value
`,
      });
      const applied = await loadPack(createRegistry([FIXTURE_SCOPE]), directory);
      expect(applied.status).toBe("rejected");
      expect(applied.diagnostics.map((diagnostic) => diagnostic.message).join(" ")).toContain(
        "cannot use entity state to produce a shared change",
      );
    });
  });
});
