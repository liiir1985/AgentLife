import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

/**
 * The system-level model configuration.
 *
 * Which provider and which model the runtime talks to is not content: a content
 * pack declares what a character may decide and never who it thinks with. The
 * provider catalog, the model each provider offers, the model a subsystem falls
 * back to, and per-subsystem overrides all live in one file at the repository
 * root, and every reference is written `provider/model-name`.
 *
 * Secrets never enter this file: pi-ai resolves keys and base URLs from the
 * environment. The scripted provider is not a configuration entry either -
 * `resolveModel` with `mode: "faux"` returns it without reading the file, so
 * automatic runs need neither credentials nor configuration.
 */

/** One provider and the models this configuration allows it to be asked for. */
export interface ModelProviderEntry {
  readonly provider: string;
  readonly models: readonly string[];
}

/** The model catalog as declared: the providers, and the fallback reference. */
export interface ModelsSection {
  readonly providers: readonly ModelProviderEntry[];
  readonly defaultModel: string;
}

/** Explicit USD per million tokens for the chosen model. */
export interface ModelCostOverride {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
}

/** One resolved `provider/model-name`: the reference as written plus its two parts. */
export interface ModelTarget {
  readonly reference: string;
  readonly provider: string;
  readonly model: string;
  readonly cost?: ModelCostOverride;
}

export interface SystemConfig {
  /** The catalog as declared, kept for validation and display. */
  readonly models: ModelsSection;
  /** The parsed `models.default-model`. */
  readonly defaultTarget: ModelTarget;
  /** Parsed subsystem sections, keyed by subsystem name. */
  readonly consumers: Readonly<Record<string, ModelTarget>>;
  readonly embedding?: EmbeddingTarget;
}

/** System-owned representation service; content packs cannot select it. */
export interface EmbeddingTarget {
  readonly provider: "ollama" | "faux";
  readonly model: string;
  readonly endpoint: string;
  readonly representationVersion: string;
}

export const FAUX_EMBEDDING_TARGET: EmbeddingTarget = Object.freeze({
  provider: "faux",
  model: "scripted-embedding",
  endpoint: "",
  representationVersion: "scripted-embedding-v1",
});

/** Automatic mode does not read the configuration: every subsystem uses the scripted model. */
export type ModelMode = "configured" | "faux";

/** The scripted model's target; `faux` is introduced by this mode and lives in no configuration file. */
export const FAUX_MODEL_TARGET: ModelTarget = Object.freeze({
  reference: "faux/faux-cognition",
  provider: "faux",
  model: "faux-cognition",
});

/** Subsystems that may choose a model; a new consumer is one entry here plus its section. */
export const MODEL_CONSUMERS: readonly string[] = ["cognition"];

/** The system configuration at the repository root; resolved like `content/demo`, so cwd never matters. */
export const SYSTEM_CONFIG_PATH: string = fileURLToPath(new URL("../../config/agentlife.yaml", import.meta.url));

/** A provider name is a lowercase machine name: no spaces, no punctuation beyond `-`. */
const PROVIDER_NAME = /^[a-z0-9][a-z0-9-]*$/;

/** A model name carries no whitespace; everything else, slashes included, is the provider's business. */
const MODEL_NAME = /^\S+$/;

function isMapping(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The text a malformed value is reported with; anything but a string is reported as empty. */
function textOf(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function costOf(value: unknown, label: string, fail: (message: string) => never): ModelCostOverride {
  if (!isMapping(value)) return fail(`${label}.cost 必须是映射`);
  const names = ["input", "output", "cacheRead", "cacheWrite"] as const;
  for (const key of Object.keys(value))
    if (!names.includes(key as (typeof names)[number])) return fail(`${label}.cost 有未声明的字段 ${key}`);
  for (const name of names)
    if (typeof value[name] !== "number" || !Number.isFinite(value[name]) || value[name] < 0)
      return fail(`${label}.cost.${name} 必须是非负有限数字`);
  return {
    input: value.input as number,
    output: value.output as number,
    cacheRead: value.cacheRead as number,
    cacheWrite: value.cacheWrite as number,
  };
}

/**
 * The target one reference names, or one sentence saying why it names none.
 *
 * The split is at the first `/`, because a model name may itself contain one
 * (`fireworks/accounts/fireworks/models/gpt-oss-120b`).
 */
function resolve(entries: readonly ModelProviderEntry[], reference: string): ModelTarget | string {
  const slash = reference.indexOf("/");
  if (slash <= 0 || slash === reference.length - 1) return "必须是 provider/model-name 形式";
  const provider = reference.slice(0, slash);
  const model = reference.slice(slash + 1);
  const entry = entries.find((candidate) => candidate.provider === provider);
  if (entry === undefined) return `的 provider "${provider}" 没有在系统配置里声明`;
  if (!entry.models.includes(model)) return `的 provider "${provider}" 没有声明模型 "${model}"`;
  return { reference, provider, model };
}

/**
 * Parses one system configuration document.
 *
 * Every failure throws: a configuration that cannot be understood stops the
 * start, it is never quietly replaced by a default nobody chose. `subject` names
 * the document in the message.
 */
export function parseSystemConfig(document: string, subject: string = SYSTEM_CONFIG_PATH): SystemConfig {
  const fail = (message: string): never => {
    throw new Error(`${subject} ${message}`);
  };

  let parsed: unknown;
  try {
    parsed = parse(document);
  } catch (cause) {
    return fail(`不是合法的 YAML：${cause instanceof Error ? cause.message : String(cause)}`);
  }
  if (!isMapping(parsed) || parsed.models === undefined) return fail("系统配置文件缺少 models 段");
  for (const key of Object.keys(parsed))
    if (key !== "models" && key !== "embedding" && !MODEL_CONSUMERS.includes(key))
      return fail(`系统配置文件有未声明的顶层字段 ${key}`);

  const models = parsed.models;
  if (!isMapping(models)) return fail("系统配置文件缺少 models 段");
  for (const key of Object.keys(models))
    if (key !== "providers" && key !== "default-model") return fail(`系统配置的 models 段有未声明的字段 ${key}`);

  const declared = models.providers;
  if (!Array.isArray(declared) || declared.length === 0) return fail("系统配置的 models.providers 必须是非空数组");

  const providers: ModelProviderEntry[] = [];
  for (const raw of declared) {
    if (!isMapping(raw)) return fail(`系统配置的 provider "${textOf(raw)}" 不是合法的 provider 名`);
    for (const key of Object.keys(raw))
      if (key !== "provider" && key !== "models") return fail(`系统配置的 provider "${key}" 不是合法的 provider 名`);
    const provider = textOf(raw.provider);
    if (!PROVIDER_NAME.test(provider)) return fail(`系统配置的 provider "${provider}" 不是合法的 provider 名`);
    if (providers.some((entry) => entry.provider === provider))
      return fail(`系统配置重复声明了 provider "${provider}"`);
    const rawModels: unknown = raw.models;
    const candidates = Array.isArray(rawModels) ? rawModels : [rawModels];
    const names: string[] = [];
    for (const candidate of candidates) {
      const model = textOf(candidate);
      if (!MODEL_NAME.test(model)) return fail(`系统配置里 ${provider} 的模型 "${model}" 不是合法的模型名`);
      if (names.includes(model)) return fail(`系统配置里 ${provider} 重复声明了模型 "${model}"`);
      names.push(model);
    }
    if (names.length === 0) return fail(`系统配置里 ${provider} 的模型 "" 不是合法的模型名`);
    providers.push({ provider, models: names });
  }

  /** The resolved target of `label`, or a failure naming the reference that was rejected. */
  const target = (reference: string, label: string): ModelTarget => {
    const resolved = resolve(providers, reference);
    return typeof resolved === "string" ? fail(`${label} ${resolved}`) : resolved;
  };

  const fallback = textOf(models["default-model"]);
  const defaultTarget = target(fallback, `系统配置的 models.default-model "${fallback}"`);

  const consumers: Record<string, ModelTarget> = {};
  for (const consumer of MODEL_CONSUMERS) {
    const section = parsed[consumer];
    if (section === undefined) continue;
    if (!isMapping(section)) return fail(`系统配置的 ${consumer} 段必须是映射`);
    for (const key of Object.keys(section))
      if (key !== "model" && key !== "cost") return fail(`系统配置的 ${consumer} 段有未声明的字段 ${key}`);
    const reference = textOf(section.model);
    if (reference === "") return fail(`系统配置的 ${consumer} 段必须声明 model`);
    const selected = target(reference, `系统配置的 ${consumer}.model "${reference}"`);
    consumers[consumer] =
      section.cost === undefined
        ? selected
        : { ...selected, cost: costOf(section.cost, `系统配置的 ${consumer}`, fail) };
  }

  let embedding: EmbeddingTarget | undefined;
  if (parsed.embedding !== undefined) {
    const section = parsed.embedding;
    if (!isMapping(section)) return fail("系统配置的 embedding 段必须是映射");
    for (const key of Object.keys(section))
      if (!["provider", "model", "endpoint", "representation-version"].includes(key))
        return fail(`系统配置的 embedding 段有未声明的字段 ${key}`);
    const provider = textOf(section.provider);
    const model = textOf(section.model);
    const endpoint = textOf(section.endpoint);
    const representationVersion = textOf(section["representation-version"]);
    if (provider !== "ollama") return fail("系统配置的 embedding.provider 必须是 ollama");
    if (!MODEL_NAME.test(model)) return fail("系统配置的 embedding.model 必须是非空模型名");
    if (!/^https?:\/\//.test(endpoint)) return fail("系统配置的 embedding.endpoint 必须是 HTTP 地址");
    if (representationVersion.trim() === "") return fail("系统配置的 embedding.representation-version 不能为空");
    embedding = { provider, model, endpoint, representationVersion };
  }
  return {
    models: { providers, defaultModel: fallback },
    defaultTarget,
    consumers,
    ...(embedding === undefined ? {} : { embedding }),
  };
}

/** Reads and parses the system configuration at `path`, which must exist. */
export function loadSystemConfig(path: string = SYSTEM_CONFIG_PATH): SystemConfig {
  let document: string;
  try {
    document = readFileSync(path, "utf8");
  } catch (cause) {
    throw new Error(`读不到系统配置文件 ${path}：${cause instanceof Error ? cause.message : String(cause)}`);
  }
  return parseSystemConfig(document, path);
}

/** The model one subsystem uses: its own section when it has one, the default otherwise. */
export function modelTarget(config: SystemConfig, consumer: string): ModelTarget {
  return config.consumers[consumer] ?? config.defaultTarget;
}

/**
 * The model an entry point starts a subsystem with.
 *
 * `mode: "faux"` returns the scripted target and reads nothing, so an automatic
 * run works without credentials and without a configuration file.
 */
export function resolveModel(
  consumer: string,
  options: { readonly mode?: ModelMode; readonly path?: string } = {},
): ModelTarget {
  if (options.mode === "faux") return FAUX_MODEL_TARGET;
  return modelTarget(loadSystemConfig(options.path ?? SYSTEM_CONFIG_PATH), consumer);
}

/** Selects the separately owned embedding service or the deterministic faux provider. */
export function resolveEmbedding(options: { readonly mode?: ModelMode; readonly path?: string } = {}): EmbeddingTarget {
  if (options.mode === "faux") return FAUX_EMBEDDING_TARGET;
  const target = loadSystemConfig(options.path ?? SYSTEM_CONFIG_PATH).embedding;
  if (target === undefined) throw new Error("系统配置文件缺少 embedding 段");
  return target;
}
