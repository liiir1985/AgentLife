import { describe, expect, it } from "vitest";
import {
  applyDemoPack,
  causeCodes,
  createRegistry,
  FIXTURE_WORLD,
  messages,
  removeDirectory,
  withTempDirectory,
  writePack,
} from "./helpers/demo-pack.js";
import type { DomainExtension } from "../src/config/extension.js";
import { loadPack } from "./helpers/demo-pack.js";
import { Type } from "typebox";
import { defineValueContainer } from "../src/config/value-shapes.js";

const DEMO_MANIFEST = `pack: agentlife.demo
version: "1.0.0"
kernel: ">=1.0.0 <2.0.0"
dependencies: []
extensions:
  - agentlife.world/extension@1.0.0
  - agentlife.body/extension@1.0.0
  - agentlife.character/extension@1.0.0
sections:
  world: agentlife.world/world
  locations: agentlife.world/location
  items: agentlife.world/item
  environment: agentlife.world/fact
  values: agentlife.body/value
  channels: agentlife.body/channel
  characters: agentlife.character/character
`;

interface RefusalCase {
  readonly name: string;
  readonly overrides: Readonly<Record<string, string | null>>;
  readonly code: string;
  readonly message: string;
  /** Extensions registered on top of the three demo domains. */
  readonly extensions?: readonly DomainExtension[];
}

const restRecovery = (mutate: (source: string) => string): string => mutate(SOURCE_REST_RECOVERY);
const SOURCE_REST_RECOVERY = `kind: rule
id: rest-recovery
domain: agentlife.body/extension
triggers:
  - agentlife.body/tick-elapsed
reads:
  - alias: stamina
    view: agentlife.body/values
    field: stamina
  - alias: light
    view: agentlife.world/environment
    field: light-level
condition:
  op: all
  operands:
    - op: simulation-time
      operator: at-or-after
      tick: 1
    - op: within
      value:
        kind: read
        alias: stamina
      min: 0
      max: 60
      boundary: exclusive
    - op: compare
      left:
        kind: read
        alias: light
      right:
        kind: literal
        value: 10
        unit: lux
      operator: gt
effects:
  - target: agentlife.body/values.stamina
    composition: add
    value:
      kind: map
      input:
        kind: read
        alias: stamina
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

/** A minimal domain used to exercise one composition method end to end. */
const FIXTURE_LIMITS: DomainExtension = {
  name: "extension",
  namespace: "test.limits",
  version: "1.0.0",
  kernel: ">=1.0.0 <2.0.0",
  requires: [],
  configTypes: [
    defineValueContainer({
      kind: "signal",
      family: "signals",
      contract: false,
      view: { exposedTo: [] },
      target: { exposedTo: [] },
    }),
  ],
  views: [
    {
      name: "state",
      fields: Type.Object({ value: Type.Number() }),
      units: { value: "points" },
      exposedTo: [],
    },
  ],
  triggers: ["changed"],
  outputTargets: [],
};

/**
 * A domain that still declares one process, so the kernel's process checks stay
 * covered while no shipped domain uses them yet.
 */
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
    name: "a read of a view no extension exposed",
    overrides: {
      "rules/exertion-cost.yaml": `kind: rule
id: exertion-cost
domain: agentlife.body/extension
triggers:
  - agentlife.body/value-changed
reads:
  - alias: tier
    view: agentlife.character/schedule
    field: tier
condition:
  op: always
effects:
  - target: agentlife.body/values.stamina
    composition: add
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
    name: "a write to a target the domain does not own or expose",
    overrides: {
      "rules/fog-visibility.yaml": `kind: rule
id: fog-visibility
domain: agentlife.world/extension
triggers:
  - agentlife.world/environment-changed
reads:
  - alias: fog
    view: agentlife.world/environment
    field: fog-density
condition:
  op: always
effects:
  - target: agentlife.body/values.wakefulness
    composition: priority
    priority: 1
    value:
      kind: literal
      value: 10
      unit: points
`,
    },
    code: "unauthorized-effect",
    message: "may not write target",
  },
  {
    name: "a trigger no extension declares",
    overrides: {
      "rules/rest-recovery.yaml": restRecovery((source) =>
        source.replace("agentlife.body/tick-elapsed", "agentlife.body/never-declared"),
      ),
    },
    code: "unknown-trigger",
    message: "never-declared",
  },
  {
    name: "two sources writing one target with different composition methods",
    overrides: {
      "rules/rest-recovery.yaml": restRecovery((source) =>
        source.replace("    composition: add", "    composition: min"),
      ),
    },
    code: "missing-composition",
    message: "agentlife.body/values.stamina",
  },
  {
    name: "a composition method the target's unit cannot support",
    overrides: {
      "rules/rest-recovery.yaml": restRecovery((source) =>
        source.replace("    composition: add", "    composition: multiply"),
      ),
    },
    code: "composition-not-allowed",
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
domain: agentlife.body/extension
triggers:
  - agentlife.world/environment-changed
reads:
  - alias: light
    view: agentlife.world/environment
    field: light-level
  - alias: fog
    view: agentlife.world/environment
    field: fog-density
condition:
  op: always
effects:
  - target: agentlife.body/values.move-cost-factor
    composition: multiply
    value:
      kind: combine
      method: min
      operands:
        - kind: read
          alias: light
        - kind: read
          alias: fog
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
domain: agentlife.body/extension
triggers:
  - agentlife.world/environment-changed
reads:
  - alias: fog
    view: agentlife.world/environment
    field: fog-density
condition:
  op: always
effects:
  - target: agentlife.body/channels.vision.available
    composition: priority
    priority: 1
    value:
      kind: select
      left:
        kind: read
        alias: fog
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
domain: agentlife.body/extension
triggers:
  - agentlife.body/value-changed
reads:
  - alias: slope
    view: agentlife.world/environment
    field: slope
condition:
  op: always
effects:
  - target: agentlife.body/values.move-cost-factor
    composition: multiply
    value:
      kind: map
      input:
        kind: read
        alias: slope
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
    name: "a definition whose type does not match its section",
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
    name: "a read of a field no view declares",
    overrides: {
      "rules/rest-recovery.yaml": restRecovery((source) => source.replace("    field: stamina", "    field: vigour")),
    },
    code: "unknown-reference",
    message: "vigour",
  },
  {
    name: "a rule without any candidate effect",
    overrides: {
      "rules/lamp-stimulus.yaml": `kind: rule
id: lamp-stimulus
domain: agentlife.body/extension
triggers:
  - agentlife.body/tick-elapsed
condition:
  op: always
effects: []
`,
    },
    code: "structure-invalid",
    message: "declares no candidate effect",
  },
  {
    name: "a kernel version the pack cannot run against",
    overrides: {
      "manifest.yaml": DEMO_MANIFEST.replace('kernel: ">=1.0.0 <2.0.0"', 'kernel: ">=3.0.0"'),
    },
    code: "incompatible-extension",
    message: "requires kernel",
  },
  {
    name: "an extension version the pack pins differently",
    overrides: {
      "manifest.yaml": DEMO_MANIFEST.replace("agentlife.body/extension@1.0.0", "agentlife.body/extension@2.0.0"),
    },
    code: "incompatible-extension",
    message: "agentlife.body/extension",
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
    code: "domain-rejected",
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
    code: "domain-rejected",
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
    code: "domain-rejected",
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
    code: "domain-rejected",
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
    name: "a value id that cannot address a member",
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
    message: "cannot address a value member",
  },
  {
    name: "a second writer for a contract channel member",
    overrides: {
      "rules/vision-availability.yaml": `kind: rule
id: vision-availability
domain: agentlife.body/extension
triggers:
  - agentlife.world/environment-changed
reads:
  - alias: fog
    view: agentlife.world/environment
    field: fog-density
condition:
  op: always
effects:
  - target: agentlife.body/channels.vision.available
    composition: priority
    priority: 1
    value:
      kind: literal
      value: true
  - target: agentlife.body/channels.vision.efficiency
    composition: priority
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
    name: "a container item without capacity",
    overrides: {
      "items/rope.yaml": `id: rope
type: agentlife.world/item
public: true
fields:
  name: 麻绳
  description: 一段麻绳。
  roles:
    - container
`,
    },
    code: "domain-rejected",
    message: "declares no capacity",
  },
  {
    name: "a rule depending on a derivation that does not exist",
    overrides: {
      "rules/exhaustion-move-cost-factor.yaml": `kind: rule
id: exhaustion-move-cost-factor
domain: agentlife.body/extension
triggers:
  - agentlife.body/value-changed
reads:
  - alias: stamina
    view: agentlife.body/values
    field: stamina
condition:
  op: always
dependsOn:
  - agentlife.demo/absent-derivation
effects:
  - target: agentlife.body/values.move-cost-factor
    composition: multiply
    value:
      kind: derived
      ref: agentlife.demo/absent-derivation
`,
    },
    code: "unknown-reference",
    message: "absent-derivation",
  },
  {
    name: "a derivation whose value unit differs from its declared output unit",
    overrides: {
      "rules/exhaustion-factor.yaml": `kind: derivation
id: exhaustion-factor
domain: agentlife.body/extension
reads:
  - alias: stamina
    view: agentlife.body/values
    field: stamina
outputUnit: points
value:
  kind: map
  input:
    kind: read
    alias: stamina
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
    name: "a process operation a foreign domain does not own",
    overrides: {
      "rules/lamp-stimulus.yaml": `kind: rule
id: lamp-stimulus
domain: test.limits/extension
triggers:
  - test.limits/changed
reads:
  - alias: value
    view: test.limits/state
    field: value
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
    },
    code: "unauthorized-effect",
    message: "may not operate process",
    extensions: [FIXTURE_LIMITS, FIXTURE_PROCESS],
  },
  {
    name: "a process parameter the declaration does not accept",
    overrides: {
      "rules/lamp-stimulus.yaml": `kind: rule
id: lamp-stimulus
domain: test.process/extension
triggers:
  - test.limits/changed
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
      duration:
        kind: literal
        value: 3
        unit: ticks
`,
    },
    code: "structure-invalid",
    message: "unknown parameter duration",
    extensions: [FIXTURE_LIMITS, FIXTURE_PROCESS],
  },
  {
    name: "a read that names a value member instead of its view",
    overrides: {
      "rules/base-move-cost.yaml": `kind: rule
id: base-move-cost
domain: agentlife.body/extension
triggers:
  - agentlife.body/value-changed
reads:
  - alias: stamina
    view: agentlife.body/values.stamina
    field: stamina
condition:
  op: always
effects:
  - target: agentlife.body/values.move-cost
    composition: add
    value:
      kind: literal
      value: 2
      unit: points
`,
    },
    code: "reference-type-mismatch",
    message: "which is a value member",
  },
];
describe("configuration validation", () => {
  it.each(CASES.map((scenario) => [scenario.name, scenario] as const))("rejects %s", async (_name, scenario) => {
    const registry = createRegistry(scenario.extensions ?? []);
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

  it("rejects a duplicated field with no declared merge strategy", async () => {
    await withTempDirectory(async (directory) => {
      writePack(directory, {
        "manifest.yaml": `pack: test.fixture
version: "1.0.0"
kernel: ">=1.0.0 <2.0.0"
dependencies: []
extensions: []
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
extensions: []
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

  it("accepts a definition whose fields come from defaults and a template", async () => {
    await withTempDirectory(async (directory) => {
      writePack(directory, {
        "manifest.yaml": `pack: test.fixture
version: "1.0.0"
kernel: ">=1.0.0 <2.0.0"
dependencies: []
extensions: []
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
      const derived = applied.config?.definitions.find((definition) => definition.ref === "test.fixture/derived");
      expect(derived?.values).toEqual({ label: "默认", extra: 2, flavour: "a", sealed: "固定" });
      expect(derived?.fields.label?.contributions.map((contribution) => contribution.layer)).toEqual([
        "default",
        "template",
      ]);
      expect(derived?.fields.extra?.contributions.map((contribution) => contribution.layer)).toEqual([
        "template",
        "override",
      ]);
    });
  });

  it("composes the largest of several sources for a max target", async () => {
    await withTempDirectory(async (directory) => {
      const mapped = (id: string, value: string, reads: string): string => `kind: rule
id: ${id}
domain: test.limits/extension
triggers:
  - test.limits/changed
${reads}condition:
  op: always
effects:
  - target: test.limits/signals.limit
    composition: max
    value:
${value}
`;
      writePack(directory, {
        "manifest.yaml": `pack: test.limits
version: "1.0.0"
kernel: ">=1.0.0 <2.0.0"
dependencies: []
extensions: []
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
        alias: value
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
          `reads:
  - alias: value
    view: test.limits/state
    field: value
`,
        ),
      });
      const registry = createRegistry([FIXTURE_LIMITS]);
      const applied = await loadPack(registry, directory);
      expect(applied.status, messages(applied.diagnostics)).toBe("valid");
      const evaluated = registry.evaluate({
        requestId: "limits",
        trigger: "test.limits/changed",
        snapshot: {
          stateVersion: "state-1",
          simulationTime: { tick: 1, seconds: 10 },
          views: { "test.limits/state": { value: 80 } },
        },
      });
      expect(evaluated.status).toBe("candidates");
      const composition = evaluated.trace.compositions[0];
      expect(composition?.composition).toBe("max");
      expect(composition?.contributions.map((contribution) => contribution.value)).toEqual([40, 70]);
      expect(composition?.result).toBe(70);
      expect(evaluated.trace.candidates[0]?.value).toBe(70);
    });
  });
});

/**
 * A config type whose `extra` field declares no merge strategy: any second
 * contribution to it must be refused rather than resolved by load order.
 */
const FIXTURE_WIDGET: DomainExtension = {
  name: "extension",
  namespace: "test.fixture",
  version: "1.0.0",
  kernel: ">=1.0.0 <2.0.0",
  requires: [],
  configTypes: [
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
      // contribution to it must be refused instead of resolved by load order.
      overridable: ["extra", "flavour"],
      merge: { label: "replace", extra: "replace", sealed: "replace" },
    },
  ],
  views: [],
  triggers: [],
  outputTargets: [],
};
