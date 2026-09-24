import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  FAUX_MODEL_TARGET,
  FAUX_EMBEDDING_TARGET,
  SYSTEM_CONFIG_PATH,
  loadSystemConfig,
  modelTarget,
  parseSystemConfig,
  resolveModel,
  resolveEmbedding,
} from "../src/config/system-config.js";
import { withTempDirectory, writePack } from "./helpers/demo-pack.js";

/**
 * The system-level model configuration.
 *
 * Content never decides which model answers a decision, so the catalog, the
 * fallback and the per-subsystem overrides all come from one file - and every
 * way that file can be wrong has to stop the start with a sentence naming what
 * is wrong, instead of quietly falling back to something nobody chose.
 */

/** A complete configuration carrying the shipped provider catalog. */
function configured(defaultModel: string): string {
  return `models:
  providers:
    - provider: anthropic
      models:
        - claude-haiku-4-5
        - claude-opus-4-5
    - provider: deepseek
      models:
        - deepseek-flash
        - deepseek-v4-pro
  default-model: ${defaultModel}
`;
}

/** The shipped shape: the consumer section is present but commented out. */
const COMMENTED_SECTION = `# cognition:
#   model: anthropic/claude-opus-4-5
`;

describe("system configuration", () => {
  it("reads the provider catalog and no consumer when the section is commented out", () => {
    const config = parseSystemConfig(`${configured("anthropic/claude-haiku-4-5")}${COMMENTED_SECTION}`);
    expect(config.models.providers).toEqual([
      { provider: "anthropic", models: ["claude-haiku-4-5", "claude-opus-4-5"] },
      { provider: "deepseek", models: ["deepseek-flash", "deepseek-v4-pro"] },
    ]);
    expect(config.models.defaultModel).toBe("anthropic/claude-haiku-4-5");
    expect(config.defaultTarget).toEqual({
      reference: "anthropic/claude-haiku-4-5",
      provider: "anthropic",
      model: "claude-haiku-4-5",
    });
    expect(config.consumers).toEqual({});
  });

  it("rejects a top-level field it does not know", () => {
    const document = `${configured("anthropic/claude-haiku-4-5")}cogniton:
  model: anthropic/claude-opus-4-5
`;
    expect(() => parseSystemConfig(document)).toThrow(/未声明的顶层字段 cogniton/);
  });

  it("rejects a document without a model section or without any provider", () => {
    expect(() => parseSystemConfig("providers: []\n")).toThrow(/缺少 models 段/);
    expect(() => parseSystemConfig("models:\n  providers: []\n  default-model: anthropic/claude-haiku-4-5\n")).toThrow(
      /必须是非空数组/,
    );
  });

  it("rejects a provider or a model declared twice", () => {
    const twice = `models:
  providers:
    - provider: anthropic
      models:
        - claude-haiku-4-5
    - provider: anthropic
      models:
        - claude-opus-4-5
  default-model: anthropic/claude-haiku-4-5
`;
    expect(() => parseSystemConfig(twice)).toThrow(/重复声明了 provider "anthropic"/);
    const repeated = `models:
  providers:
    - provider: anthropic
      models:
        - claude-haiku-4-5
        - claude-haiku-4-5
  default-model: anthropic/claude-haiku-4-5
`;
    expect(() => parseSystemConfig(repeated)).toThrow(/系统配置里 anthropic 重复声明了模型 "claude-haiku-4-5"/);
  });

  it("rejects a default model that names no declared provider and one that is not a reference", () => {
    expect(() => parseSystemConfig(configured("bogus/x"))).toThrow(
      /default-model "bogus\/x" 的 provider "bogus" 没有在系统配置里声明/,
    );
    expect(() => parseSystemConfig(configured("faux"))).toThrow(/必须是 provider\/model-name 形式/);
  });

  it("rejects a consumer section without a model and one naming an undeclared model", () => {
    expect(() => parseSystemConfig(`${configured("anthropic/claude-haiku-4-5")}cognition: {}\n`)).toThrow(
      /cognition 段必须声明 model/,
    );
    const document = `${configured("anthropic/claude-haiku-4-5")}cognition:
  model: anthropic/not-a-model
`;
    expect(() => parseSystemConfig(document)).toThrow(
      /cognition\.model "anthropic\/not-a-model" 的 provider "anthropic" 没有声明模型 "not-a-model"/,
    );
  });

  it("gives a subsystem its own model only when it has a section", () => {
    const fallback = parseSystemConfig(configured("anthropic/claude-haiku-4-5"));
    expect(modelTarget(fallback, "cognition")).toEqual(fallback.defaultTarget);
    const overridden = parseSystemConfig(`${configured("anthropic/claude-haiku-4-5")}cognition:
  model: deepseek/deepseek-flash
`);
    expect(modelTarget(overridden, "cognition")).toEqual({
      reference: "deepseek/deepseek-flash",
      provider: "deepseek",
      model: "deepseek-flash",
    });
  });

  it("accepts and validates configured prices for a selected subsystem model", () => {
    const document = `${configured("deepseek/deepseek-flash")}cognition:\n  model: deepseek/deepseek-flash\n  cost:\n    input: 2\n    output: 8\n    cacheRead: 0.04\n    cacheWrite: 0.04\n`;
    expect(modelTarget(parseSystemConfig(document), "cognition").cost).toEqual({
      input: 2,
      output: 8,
      cacheRead: 0.04,
      cacheWrite: 0.04,
    });
    expect(() => parseSystemConfig(document.replace("output: 8", "output: -1"))).toThrow(/cost.output/);
    expect(() => parseSystemConfig(document.replace("cacheWrite: 0.04", "cacheWrite: unknown"))).toThrow(
      /cost.cacheWrite/,
    );
  });

  it("splits a reference at its first slash, so a model name may contain slashes", () => {
    const reference = "fireworks/accounts/fireworks/models/gpt-oss-120b";
    const config = parseSystemConfig(`models:
  providers:
    - provider: fireworks
      models:
        - accounts/fireworks/models/gpt-oss-120b
  default-model: ${reference}
`);
    expect(config.defaultTarget).toEqual({
      reference,
      provider: "fireworks",
      model: "accounts/fireworks/models/gpt-oss-120b",
    });
  });

  it("returns the scripted target in faux mode without reading any file", () => {
    const missing = path.join(SYSTEM_CONFIG_PATH, "absent.yaml");
    expect(resolveModel("cognition", { mode: "faux", path: missing })).toBe(FAUX_MODEL_TARGET);
    expect(resolveEmbedding({ mode: "faux", path: missing })).toBe(FAUX_EMBEDDING_TARGET);
  });

  it("selects embedding from system settings and rejects an undeclared representation", () => {
    const document = `${configured("deepseek/deepseek-flash")}embedding:
  provider: ollama
  model: embeddinggemma
  endpoint: http://localhost:11434/api/embed
  representation-version: embeddinggemma-v1
`;
    expect(parseSystemConfig(document).embedding).toEqual({
      provider: "ollama",
      model: "embeddinggemma",
      endpoint: "http://localhost:11434/api/embed",
      representationVersion: "embeddinggemma-v1",
    });
    expect(() => parseSystemConfig(document.replace("embeddinggemma-v1", ""))).toThrow(
      /embedding.representation-version/,
    );
  });

  it("loads a configuration from a path and reports a path that cannot be read", async () => {
    await withTempDirectory(async (directory) => {
      writePack(directory, { "agentlife.yaml": configured("deepseek/deepseek-flash") });
      expect(loadSystemConfig(path.join(directory, "agentlife.yaml")).defaultTarget.reference).toBe(
        "deepseek/deepseek-flash",
      );
      expect(() => loadSystemConfig(path.join(directory, "absent.yaml"))).toThrow(/读不到系统配置文件/);
    });
  });

  it("resolves the shipped configuration against the models the provider catalog knows", async () => {
    const config = loadSystemConfig();
    expect(resolveModel("cognition").provider).toBe(config.defaultTarget.provider);
    // Imported here rather than at the top: the generated catalog is large and only this
    // case reads it.
    const { builtinModels } = await import("@earendil-works/pi-ai/providers/all");
    const models = builtinModels();
    for (const provider of config.models.providers)
      for (const model of provider.models)
        expect(models.getModel(provider.provider, model), `${provider.provider}/${model}`).toBeDefined();
  });
});
