import { describe, expect, it } from "vitest";
import type { RuntimeConfig } from "../src/config/config-builder.js";
import type { PublishResult } from "../src/config/core-runtime.js";
import type { SystemSpec } from "../src/config/system-spec.js";
import { createSystemSpecs } from "../src/systems/index.js";
import {
  applyDemoPack,
  causeCodes,
  createRegistry,
  demoManifest,
  demoSystemPins,
  removeDirectory,
  withSystemVersion,
} from "./helpers/demo-pack.js";
import { declaredAttributes } from "../src/simulation/config-view.js";
import { publishDemoWith } from "./helpers/phase2.js";

/**
 * Phase 2 configuration acceptance: the exit conditions of the P2.0 config
 * model, each exercised against the real demo pack through single-file
 * overrides, so every refusal is produced by full content rather than by a
 * hand-built document that could drift from the pack format.
 */

/** Publishes the demo pack with per-file overrides and returns the raw outcome. */
async function publishWith(overrides: Readonly<Record<string, string | null>>): Promise<PublishResult> {
  const { result, directory } = await applyDemoPack(createRegistry(), overrides);
  removeDirectory(directory);
  return result;
}

/** Publishes content that must pass, so a failure names every diagnostic. */
async function publishedConfig(overrides: Readonly<Record<string, string | null>>): Promise<RuntimeConfig> {
  const result = await publishWith(overrides);
  if (result.config === undefined)
    throw new Error(`demo pack did not publish: ${JSON.stringify(result.diagnostics, null, 2)}`);
  expect(result.status).toBe("valid");
  return result.config;
}

function attributeMember(config: RuntimeConfig, id: string) {
  const input = config.catalog.input("agentlife.world/attributes");
  if (input === undefined) throw new Error("the demo pack exposes no attribute input");
  return input.fields.get(id);
}

function systemEntry(config: RuntimeConfig, systemId: string) {
  const entry = config.systems.find((system) => system.systemId === systemId);
  if (entry === undefined) throw new Error(`runtime config does not declare system ${systemId}`);
  return entry;
}

function ropeItem(body: readonly string[]): string {
  return [
    "id: rope",
    "type: agentlife.world/item",
    "public: true",
    "fields:",
    "  name: 麻绳",
    "  description: 一段被反复打成结又解开的麻绳，握起来比看起来更硬。",
    "  tags:",
    "    - tool",
    ...body,
    "",
  ].join("\n");
}

function attributeItem(id: string, name: string, body: readonly string[]): string {
  const head = [`id: ${id}`, "type: agentlife.world/attribute", "public: true", "fields:", `  name: ${name}`];
  return [...head, ...body, ""].join("\n");
}

function warden(fields: readonly string[]): string {
  return [
    "id: gate-warden",
    "type: agentlife.character/character",
    "public: true",
    "fields:",
    "  name: 门口的护卫",
    "  identity: 领一份口粮，守一段路。",
    "  tier: degraded",
    "  main: false",
    "  control:",
    "    kind: behaviour-tree",
    "  modules:",
    "    - behaviour-tree",
    "  homeLocation: agentlife.demo/lantern-square",
    ...fields,
    "",
  ].join("\n");
}

function sayAction(fields: readonly string[]): string {
  return [
    "id: say",
    "type: agentlife.body/action",
    "public: true",
    "fields:",
    "  name: 说话",
    "  description: 说话的完整动作定义，包含每一个阶段占用的资源。",
    "  interruptible: true",
    ...fields,
    "",
  ].join("\n");
}

function humanoid(abilities: readonly string[]): string {
  return [
    "id: humanoid",
    "type: agentlife.body/body",
    "public: true",
    "fields:",
    "  name: 人形身体",
    "  description: 一个有两手两脚、能说话也能搬东西的身体。",
    "  abilities:",
    ...abilities.map((ability) => `    - ${ability}`),
    "  resources:",
    "    - agentlife.demo/speech",
    "    - agentlife.demo/locomotion",
    "    - agentlife.demo/hands",
    "  modes:",
    "    - agentlife.demo/awake",
    "    - agentlife.demo/drowsy",
    "  initialMode: agentlife.demo/awake",
    "",
  ].join("\n");
}

const WEIGHT_POLICY = [
  "  unit: mass",
  "  policy:",
  "    range:",
  "      min: 0",
  "      max: 10",
  "      boundary: inclusive",
  "    overflow: saturate",
] as const;

/** The same policy with a range no value can satisfy: min exceeds max. */
const IMPOSSIBLE_RANGE_POLICY = [
  "  unit: mass",
  "  policy:",
  "    range:",
  "      min: 10",
  "      max: 0",
  "      boundary: inclusive",
  "    overflow: saturate",
] as const;

const MOOD_VOCABULARY = ["  allowedValues:", "    - calm", "    - alert"] as const;

function weightAttribute(initial: string, policy: readonly string[] = WEIGHT_POLICY): string {
  return attributeItem("weight", "重量", ["  type: number", `  initial: ${initial}`, ...policy]);
}

function moodAttribute(initial: string): string {
  return attributeItem("mood", "心情", ["  type: string", `  initial: ${initial}`, ...MOOD_VOCABULARY]);
}

/**
 * The demo manifest with the world version pin removed. The pack is otherwise
 * byte-identical to the shipped demo content, so two publishes that differ only
 * in their system declarations share one content identity.
 */
const MANIFEST_ANY_WORLD_VERSION = demoManifest({
  // The world pin is removed; every other declaration is the shipped one.
  systems: withSystemVersion(demoSystemPins(), "agentlife.world", "").map((pin) =>
    pin.endsWith("@") ? pin.slice(0, -1) : pin,
  ),
});

/** The demo systems with one version raised; the spec hash follows the version. */
const BUMPED_WORLD: readonly SystemSpec[] = createSystemSpecs().map((system) =>
  system.namespace === "agentlife.world" ? { ...system, version: "1.2.0" } : system,
);

/** The demo systems with one declaration changed but every version left alone. */
const EXTENDED_WORLD: readonly SystemSpec[] = createSystemSpecs().map((system) =>
  system.namespace === "agentlife.world" ? { ...system, triggers: [...system.triggers, "spec-hash-probe"] } : system,
);

interface RefusalScenario {
  readonly name: string;
  readonly overrides: Readonly<Record<string, string>>;
  readonly code: string;
}

const REFERENCE_SCENARIOS: readonly RefusalScenario[] = [
  {
    name: "a character whose behaviour tree does not exist",
    overrides: {
      "characters/gate-warden.yaml": warden([
        "  bodyConfig: agentlife.demo/humanoid",
        "  behaviourTree: agentlife.demo/absent-tree",
        "  localView: agentlife.demo/warden-view",
      ]),
    },
    code: "unknown-reference",
  },
  {
    name: "a character whose behaviour tree local view does not exist",
    overrides: {
      "characters/gate-warden.yaml": warden([
        "  bodyConfig: agentlife.demo/humanoid",
        "  behaviourTree: agentlife.demo/warden-patrol",
        "  localView: agentlife.demo/absent-view",
      ]),
    },
    code: "unknown-reference",
  },
  {
    name: "an action naming an ability that is not declared",
    overrides: {
      "actions/say.yaml": sayAction([
        "  ability: agentlife.demo/absent-ability",
        "  stages:",
        "    - name: 开口",
        "      ticks: 2",
        "      resource: agentlife.demo/speech",
      ]),
    },
    code: "unknown-reference",
  },
  {
    name: "an action naming a resource that is not declared",
    overrides: {
      "actions/say.yaml": sayAction([
        "  ability: agentlife.demo/speak",
        "  stages:",
        "    - name: 开口",
        "      ticks: 2",
        "      resource: agentlife.demo/absent-resource",
      ]),
    },
    code: "system-rejected",
  },
  {
    name: "a character naming a body template that does not exist",
    overrides: {
      "characters/gate-warden.yaml": warden([
        "  bodyConfig: agentlife.demo/absent-body",
        "  behaviourTree: agentlife.demo/warden-patrol",
        "  localView: agentlife.demo/warden-view",
      ]),
    },
    code: "unknown-reference",
  },
  {
    name: "a body naming an ability that does not exist",
    overrides: {
      "bodies/humanoid.yaml": humanoid([
        "agentlife.demo/speak",
        "agentlife.demo/move",
        "agentlife.demo/gesture",
        "agentlife.demo/take",
        "agentlife.demo/place",
        "agentlife.demo/operate",
        "agentlife.demo/absent-ability",
      ]),
    },
    code: "unknown-reference",
  },
];

describe("phase 2 configuration", () => {
  it("refuses an item that declares interaction vocabulary the item schema no longer carries", async () => {
    const vocabulary: readonly { readonly field: string; readonly body: readonly string[] }[] = [
      { field: "roles", body: ["  roles:", "    - tool"] },
      { field: "carryable", body: ["  carryable: true"] },
      { field: "surface", body: ["  surface: true"] },
      { field: "container", body: ["  container: true"] },
      { field: "containerCapacity", body: ["  containerCapacity: 3"] },
    ];
    for (const entry of vocabulary) {
      const result = await publishWith({ "items/rope.yaml": ropeItem(entry.body) });
      expect(result.status, `${entry.field} must be refused`).toBe("rejected");
      expect(causeCodes(result.diagnostics), entry.field).toContain("structure-invalid");
      expect(causeCodes(result.diagnostics), entry.field).toContain("field-not-overridable");
    }
  });

  it("validates the attribute definitions and the values an item declares", async () => {
    const config = await publishedConfig({
      "attributes/weight.yaml": weightAttribute("5"),
      "attributes/mood.yaml": moodAttribute("calm"),
    });
    const weight = attributeMember(config, "weight");
    expect(weight?.valueType).toBe("number");
    expect(weight?.scope).toBe("entity");
    expect(weight?.initial).toBe(5);
    expect(weight?.unit).toBe("mass");
    expect(weight?.policy?.range).toEqual({ min: 0, max: 10, boundary: "inclusive" });
    const mood = attributeMember(config, "mood");
    expect(mood?.valueType).toBe("string");
    expect(mood?.initial).toBe("calm");
    expect(mood?.allowedValues).toEqual(["calm", "alert"]);

    const wrongDefault = await publishWith({ "attributes/weight.yaml": weightAttribute("heavy") });
    expect(wrongDefault.status).toBe("rejected");
    expect(causeCodes(wrongDefault.diagnostics)).toContain("structure-invalid");

    const unsupportedType = await publishWith({
      "attributes/weight.yaml": attributeItem("weight", "重量", ["  type: object", "  initial: 5"]),
    });
    expect(unsupportedType.status).toBe("rejected");
    expect(causeCodes(unsupportedType.diagnostics)).toContain("structure-invalid");

    const outsideVocabulary = await publishWith({ "attributes/mood.yaml": moodAttribute("angry") });
    expect(outsideVocabulary.status).toBe("rejected");
    expect(causeCodes(outsideVocabulary.diagnostics)).toContain("invalid-value");

    // The declared default has to satisfy the range it declares, exactly like a
    // declared string default has to be inside its vocabulary.
    const outsideRange = await publishWith({ "attributes/weight.yaml": weightAttribute("50") });
    expect(outsideRange.status).toBe("rejected");
    expect(causeCodes(outsideRange.diagnostics)).toContain("invalid-value");

    const impossibleRange = await publishWith({
      "attributes/weight.yaml": weightAttribute("5", IMPOSSIBLE_RANGE_POLICY),
    });
    expect(impossibleRange.status).toBe("rejected");
    expect(causeCodes(impossibleRange.diagnostics)).toContain("invalid-value");

    // An item carries its own values: a member has to name a declared attribute,
    // and the value has to be what that attribute says it may be.
    const unknownAttribute = await publishWith({
      "items/rope.yaml": ropeItem(["  attributes:", "    agentlife.demo/absent: true"]),
    });
    expect(unknownAttribute.status).toBe("rejected");
    expect(causeCodes(unknownAttribute.diagnostics)).toContain("unknown-reference");

    const wrongValueType = await publishWith({
      "items/rope.yaml": ropeItem(["  attributes:", "    agentlife.demo/portable: 5"]),
    });
    expect(wrongValueType.status).toBe("rejected");
    expect(causeCodes(wrongValueType.diagnostics)).toContain("structure-invalid");

    const outsideAttributeVocabulary = await publishWith({
      "attributes/mood.yaml": moodAttribute("calm"),
      "items/rope.yaml": ropeItem(["  attributes:", "    agentlife.demo/mood: angry"]),
    });
    expect(outsideAttributeVocabulary.status).toBe("rejected");
    expect(causeCodes(outsideAttributeVocabulary.diagnostics)).toContain("invalid-value");
  });

  it("publishes a new item attribute without touching the kernel module set", async () => {
    const { config, directory } = await publishDemoWith({
      "attributes/fragile.yaml": attributeItem("fragile", "易碎", ["  type: boolean", "  initial: false"]),
      "items/rope.yaml": ropeItem([
        "  attributes:",
        "    agentlife.demo/portable: true",
        "    agentlife.demo/fragile: true",
      ]),
    });
    try {
      const fragile = attributeMember(config, "fragile");
      expect(fragile?.valueType).toBe("boolean");
      expect(fragile?.initial).toBe(false);
      expect(fragile?.itemRef).toBe("agentlife.demo/fragile");
      expect(declaredAttributes(config)["agentlife.demo/rope"]).toEqual({ portable: true, fragile: true });
      expect(config.systems.map((system) => system.systemId)).toEqual(
        createSystemSpecs()
          .map((system) => system.namespace)
          .sort(),
      );
    } finally {
      removeDirectory(directory);
    }
  });

  it("refuses invalid behaviour tree, action resource and entity combination references", async () => {
    for (const scenario of REFERENCE_SCENARIOS) {
      const result = await publishWith(scenario.overrides);
      expect(result.status, scenario.name).toBe("rejected");
      expect(causeCodes(result.diagnostics), scenario.name).toContain(scenario.code);
    }
  });

  it("gives a changed system spec a new configId and an unchanged one the same configId", async () => {
    const overrides = { "manifest.yaml": MANIFEST_ANY_WORLD_VERSION };
    const first = await publishDemoWith(overrides);
    const again = await publishDemoWith(overrides);
    const bumped = await publishDemoWith(overrides, BUMPED_WORLD);
    const extended = await publishDemoWith(overrides, EXTENDED_WORLD);
    try {
      // The same pack with an unchanged system list publishes the same identity twice.
      expect(again.config.configId).toBe(first.config.configId);

      expect(systemEntry(bumped.config, "agentlife.world").version).toBe("1.2.0");
      expect(systemEntry(bumped.config, "agentlife.world").specHash).not.toBe(
        systemEntry(first.config, "agentlife.world").specHash,
      );
      expect(systemEntry(bumped.config, "agentlife.body").specHash).toBe(
        systemEntry(first.config, "agentlife.body").specHash,
      );
      expect(bumped.config.configId).not.toBe(first.config.configId);

      // A spec change under an unchanged version reaches the identity as well.
      expect(systemEntry(extended.config, "agentlife.world").version).toBe("1.1.0");
      expect(systemEntry(extended.config, "agentlife.world").specHash).not.toBe(
        systemEntry(first.config, "agentlife.world").specHash,
      );
      expect(extended.config.configId).not.toBe(first.config.configId);

      // Only the system declaration differs: the pack identity and content are the same.
      expect(bumped.config.packs).toEqual(first.config.packs);
      expect(extended.config.packs).toEqual(first.config.packs);
      expect(bumped.config.systems.map((system) => system.systemId)).toEqual(
        first.config.systems.map((system) => system.systemId),
      );
      expect(bumped.config.items.map((item) => item.ref)).toEqual(first.config.items.map((item) => item.ref));
      expect(bumped.config.rules.map((rule) => rule.ref)).toEqual(first.config.rules.map((rule) => rule.ref));
      expect(bumped.config.formulas.map((formula) => formula.ref)).toEqual(
        first.config.formulas.map((formula) => formula.ref),
      );
    } finally {
      removeDirectory(first.directory);
      removeDirectory(again.directory);
      removeDirectory(bumped.directory);
      removeDirectory(extended.directory);
    }
  });
});
