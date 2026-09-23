import path from "node:path";
import { describe, expect, it } from "vitest";
import { ContentPackLoader } from "../src/content/content-pack-loader.js";
import { CoreRuntime, packInput } from "../src/config/core-runtime.js";
import { createSystemSpecs } from "../src/systems/index.js";
import {
  applyDemoPack,
  causeCodes,
  createRegistry,
  FIXTURE_WORLD,
  loadPack,
  messages,
  removeDirectory,
  withTempDirectory,
  writePack,
} from "./helpers/demo-pack.js";

const LIBRARY_MANIFEST = (): string => `pack: agentlife.library
version: "1.0.0"
kernel: ">=1.0.0 <2.0.0"
dependencies: []
systems:
  - agentlife.world@1.1.0
sections:
  locations: agentlife.world/location
`;

const LIBRARY_LOCATION = (isPublic: boolean): string => `id: archive
type: agentlife.world/location
public: ${String(isPublic)}
fields:
  name: 档案室
  description: 一间存放旧账本的房间。
`;

const HOST_MANIFEST = (dependencies: readonly string[]): string => `pack: agentlife.host
version: "1.0.0"
kernel: ">=1.0.0 <2.0.0"
dependencies:${dependencies.length === 0 ? " []" : ""}
${dependencies.map((dependency) => `  - ${dependency}`).join("\n")}
systems:
  - agentlife.world@1.1.0
sections:
  world: agentlife.world/world
  locations: agentlife.world/location
`;

const HOST_LOCATION = `id: plaza
type: agentlife.world/location
public: true
fields:
  name: 广场
  description: 一个空广场。
  exits:
    - agentlife.library/archive
`;

describe("configuration registry", () => {
  it("turns the demo pack into one content-addressed runtime config version", async () => {
    const first = await applyDemoPack(createRegistry());
    const second = await applyDemoPack(createRegistry());
    const changed = await applyDemoPack(createRegistry(), {
      "locations/orchard.yaml": `id: orchard
type: agentlife.world/location
public: true
fields:
  name: 老果园（改名）
  description: 一排排修剪过的果树。
  exits:
    - agentlife.demo/lantern-square
  tags:
    - outdoors
`,
    });
    try {
      expect(first.result.status).toBe("valid");
      expect(first.result.diagnostics.filter((diagnostic) => diagnostic.severity === "error")).toEqual([]);
      const identity = first.result.config?.configId ?? "";
      expect(identity).toMatch(/^[0-9a-f]{64}$/);

      expect(second.result.config?.configId).toBe(identity);

      expect(changed.result.status).toBe("valid");
      expect(changed.result.config?.configId).not.toBe(identity);
    } finally {
      removeDirectory(first.directory);
      removeDirectory(second.directory);
      removeDirectory(changed.directory);
    }
  });

  it("resolves defaults, template combine and overrides with visible provenance", async () => {
    const { result, directory } = await applyDemoPack(createRegistry());
    try {
      const companion = result.config?.items.find((item) => item.ref === "agentlife.demo/companion");
      // `modules` comes from the shared template, `identity` and `name` override it.
      expect(companion?.values.modules).toEqual(["perception", "cognition", "memory"]);
      expect(companion?.values.name).toBe("阿禾");
      expect(companion?.values.main).toBe(true);
      const modules = companion?.fields.modules;
      expect(modules?.merge).toBe("append");
      expect(modules?.ruleValues.map((ruleValue) => ruleValue.layer)).toEqual(["default", "template"]);
      expect(modules?.ruleValues.map((ruleValue) => ruleValue.source)).toEqual([
        "agentlife.character/character",
        "agentlife.demo/normal-entity",
      ]);
      const identity = companion?.fields.identity;
      expect(identity?.merge).toBe("replace");
      expect(identity?.ruleValues.map((ruleValue) => ruleValue.layer)).toEqual(["template", "override"]);
      // The override is a markdown reference, resolved before the schema check.
      expect(String(identity?.value)).toContain("认得每一棵树的脾气");

      const baseline = result.config?.items.find((item) => item.ref === "agentlife.demo/normal-entity");
      expect(baseline?.fields.name?.ruleValues.map((ruleValue) => ruleValue.layer)).toEqual(["override"]);

      const player = result.config?.items.find((item) => item.ref === "agentlife.demo/player");
      expect(player?.fields.control?.ruleValues.map((ruleValue) => ruleValue.layer)).toEqual(["template", "override"]);
      expect(Reflect.get(player?.values.control as object, "kind")).toBe("user");
    } finally {
      removeDirectory(directory);
    }
  });

  it("exposes a value valueSet as one input whose fields are the declared values", async () => {
    const { result, directory } = await applyDemoPack(createRegistry());
    try {
      const stamina = result.config?.items.find((item) => item.ref === "agentlife.demo/stamina");
      expect(stamina?.values.unit).toBe("points");
      expect(stamina?.values.initial).toBe(70);
      expect(Reflect.get(stamina?.values.policy as object, "range")).toEqual({
        min: 0,
        max: 100,
        boundary: "inclusive",
      });
      // A channel contributes two fields from one item.
      const vision = result.config?.items.find((item) => item.ref === "agentlife.demo/vision");
      expect(vision?.values.available).toBe(true);
      expect(vision?.values.efficiency).toBe(0.8);
      const plans = Object.keys(result.config?.combinePlans ?? {}).sort();
      expect(plans).toEqual([
        "agentlife.body/channels.vision.available",
        "agentlife.body/channels.vision.efficiency",
        "agentlife.body/cognitive-participation",
        "agentlife.body/current-mode",
        "agentlife.body/values.move-cost",
        "agentlife.body/values.move-cost-factor",
        "agentlife.body/values.stamina",
        "agentlife.world/consent",
        "agentlife.world/environment.lamp-state",
        "agentlife.world/environment.light-level",
        "agentlife.world/environment.visibility",
        "agentlife.world/held-by",
        "agentlife.world/located-at",
        "agentlife.world/placed-on",
      ]);
    } finally {
      removeDirectory(directory);
    }
  });

  it("resolves long text through the pack's markdown reference", async () => {
    const { result, directory } = await applyDemoPack(createRegistry());
    try {
      const world = result.config?.items.find((item) => item.ref === "agentlife.demo/valley");
      const description = String(world?.values.description ?? "");
      expect(description.startsWith("# 山谷定居点")).toBe(true);
      expect(description).toContain("白天的光被两侧的山脊切得很碎");
      const square = result.config?.items.find((item) => item.ref === "agentlife.demo/lantern-square");
      expect(String(square?.values.description)).toContain("长明灯");
    } finally {
      removeDirectory(directory);
    }
  });

  it("keeps the current version untouched when an update is rejected", async () => {
    const registry = createRegistry();
    const accepted = await applyDemoPack(registry);
    const rejected = await applyDemoPack(registry, {
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
    });
    try {
      const before = registry.current();
      expect(accepted.result.status).toBe("valid");
      expect(before).toBeDefined();
      expect(rejected.result.status).toBe("rejected");
      expect(registry.current()).toBe(before);
      expect(causeCodes(rejected.result.diagnostics)).toContain("unknown-reference");
    } finally {
      removeDirectory(accepted.directory);
      removeDirectory(rejected.directory);
    }
  });

  it("never publishes a version whose persistence failed before the commit", async () => {
    const durable = new Map<string, unknown>();
    const persistence = {
      saveConfig: (config: { configId: string; document: unknown }) => {
        throw new Error(`injected write failure for ${config.configId.length} bytes`);
      },
      currentConfig: () => {
        const [identity] = [...durable.keys()];
        return identity === undefined ? undefined : { configId: identity, document: durable.get(identity) };
      },
      loadConfig: (identity: string) => durable.get(identity),
    };
    const registry = new CoreRuntime(undefined, persistence);
    for (const system of createSystemSpecs()) registry.addSystem(system);

    const { result, directory } = await applyDemoPack(registry);
    try {
      expect(result.status).toBe("config-unavailable");
      expect(registry.current()).toBeUndefined();
      expect(causeCodes(result.diagnostics)).toEqual(["config-unavailable"]);
      expect(messages(result.diagnostics)).toContain("injected write failure");
    } finally {
      removeDirectory(directory);
    }
  });

  it("adopts a version that was committed even when the acknowledgement was lost", async () => {
    const durable = new Map<string, unknown>();
    const persistence = {
      saveConfig: (config: { configId: string; document: unknown }) => {
        durable.set(config.configId, config.document);
        throw new Error("injected failure after commit");
      },
      currentConfig: () => {
        const [identity] = [...durable.keys()];
        return identity === undefined ? undefined : { configId: identity, document: durable.get(identity) };
      },
      loadConfig: (identity: string) => durable.get(identity),
    };
    const registry = new CoreRuntime(undefined, persistence);
    for (const system of createSystemSpecs()) registry.addSystem(system);

    const { result, directory } = await applyDemoPack(registry);
    try {
      expect(result.status).toBe("valid");
      expect(registry.current()?.configId).toBe(result.config?.configId);
    } finally {
      removeDirectory(directory);
    }
  });

  it("never publishes a version the durable state did not accept", async () => {
    const persistence = {
      saveConfig: () => {
        throw new Error("injected failure after commit");
      },
      currentConfig: () => ({ configId: "0".repeat(64), document: {} }),
      loadConfig: () => undefined,
    };
    const registry = new CoreRuntime(undefined, persistence);
    for (const system of createSystemSpecs()) registry.addSystem(system);

    const { result, directory } = await applyDemoPack(registry);
    try {
      expect(result.status).toBe("config-unavailable");
      expect(registry.current()).toBeUndefined();
    } finally {
      removeDirectory(directory);
    }
  });

  it("rebuilds a stored version from its own document and refuses to substitute another", async () => {
    const durable = new Map<string, unknown>();
    const persistence = {
      saveConfig: (config: { configId: string; document: unknown }) => {
        durable.set(config.configId, config.document);
        return "committed" as const;
      },
      currentConfig: () => {
        const [identity] = [...durable.keys()];
        return identity === undefined ? undefined : { configId: identity, document: durable.get(identity) };
      },
      loadConfig: (identity: string) => durable.get(identity),
    };
    const registry = new CoreRuntime(undefined, persistence);
    for (const system of createSystemSpecs()) registry.addSystem(system);
    const accepted = await applyDemoPack(registry);
    try {
      const identity = accepted.result.config?.configId ?? "";
      const restored = registry.restore(identity);
      expect(restored.status).toBe("valid");
      expect(restored.config?.configId).toBe(identity);
      expect(restored.config?.rules.map((rule) => rule.ref)).toEqual(
        accepted.result.config?.rules.map((rule) => rule.ref),
      );

      const missing = registry.restore("0".repeat(64));
      expect(missing.status).toBe("config-unavailable");
      expect(causeCodes(missing.diagnostics)).toEqual(["config-unavailable"]);
    } finally {
      removeDirectory(accepted.directory);
    }
  });

  it("refuses a foreign item the pack never depended on or that stays private", async () => {
    await withTempDirectory(async (directory) => {
      const dependency = path.join(directory, "library");
      const root = path.join(directory, "host");
      const loader = new ContentPackLoader();
      writePack(dependency, {
        "manifest.yaml": LIBRARY_MANIFEST(),
        "locations/archive.yaml": LIBRARY_LOCATION(false),
      });
      const dependencyPack = packInput(await loader.load(dependency));

      const scenarios: readonly { readonly name: string; readonly dependencies: readonly string[] }[] = [
        { name: "undeclared dependency", dependencies: [] },
        { name: "private item", dependencies: ["agentlife.library"] },
      ];
      for (const scenario of scenarios) {
        writePack(root, {
          "manifest.yaml": HOST_MANIFEST(scenario.dependencies),
          "world/settings.yaml": FIXTURE_WORLD,
          "locations/plaza.yaml": HOST_LOCATION,
        });
        const applied = createRegistry().publish({
          root: packInput(await loader.load(root)),
          dependencies: [dependencyPack],
        });
        expect(applied.status, scenario.name).toBe("rejected");
        expect(causeCodes(applied.diagnostics)).toContain("namespace-not-visible");
        expect(messages(applied.diagnostics)).toContain("agentlife.library");
      }
    });
  });

  it("accepts a published item from a declared dependency", async () => {
    await withTempDirectory(async (directory) => {
      const dependency = path.join(directory, "library");
      const root = path.join(directory, "host");
      const loader = new ContentPackLoader();
      writePack(dependency, {
        "manifest.yaml": LIBRARY_MANIFEST(),
        "locations/archive.yaml": LIBRARY_LOCATION(true),
      });
      writePack(root, {
        "manifest.yaml": HOST_MANIFEST(["agentlife.library"]),
        "world/settings.yaml": FIXTURE_WORLD,
        "locations/plaza.yaml": HOST_LOCATION,
      });
      const applied = createRegistry().publish({
        root: packInput(await loader.load(root)),
        dependencies: [packInput(await loader.load(dependency))],
      });
      expect(applied.status).toBe("valid");
      expect(applied.config?.packs.map((pack) => pack.namespace)).toEqual(["agentlife.host", "agentlife.library"]);
      const plaza = applied.config?.items.find((item) => item.ref === "agentlife.host/plaza");
      expect(plaza?.values.exits).toEqual(["agentlife.library/archive"]);
    });
  });

  it("reports an unloadable dependency instead of ignoring it", async () => {
    await withTempDirectory(async (directory) => {
      const root = path.join(directory, "host");
      writePack(root, {
        "manifest.yaml": HOST_MANIFEST(["agentlife.library"]),
        "world/settings.yaml": FIXTURE_WORLD,
        "locations/plaza.yaml": HOST_LOCATION,
      });
      const applied = await loadPack(createRegistry(), root);
      expect(applied.status).toBe("rejected");
      expect(messages(applied.diagnostics)).toContain("agentlife.library");
    });
  });
});
