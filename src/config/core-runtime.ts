import { buildConfig, type RuntimeConfig } from "./config-builder.js";
import { SystemIndex } from "./system-index.js";
import { error, IssueList, type ConfigIssue } from "./diagnostics.js";
import { SystemCatalog, type SystemSpec, type LoadResult } from "./system-spec.js";
import { PackSet } from "./packs.js";
import { mergeItems } from "./config-merge.js";
import { parsePack, type PackManifest, type ParsedPack } from "./source.js";
import { checkConfig } from "./config-checker.js";
import { runRules, type RuleRequest, type RuleResult } from "./rule-engine.js";
import type { ContentPackSnapshot } from "../content/content-pack-loader.js";

export interface PackInput {
  /** Root-relative path of every participating file. */
  readonly files: readonly { readonly path: string; readonly document: unknown; readonly text?: string }[];
  readonly manifest: unknown;
  /** Human-readable label used in diagnostics. */
  readonly label: string;
  /** Content identity of the pack, part of the runtime config id. */
  readonly contentId: string;
}

export interface ConfigInput {
  readonly root: PackInput;
  readonly dependencies?: readonly PackInput[];
}

export type PublishStatus = "valid" | "rejected" | "config-unavailable";

export interface PublishResult {
  readonly status: PublishStatus;
  readonly diagnostics: readonly ConfigIssue[];
  readonly config?: RuntimeConfig;
}

export interface RestoreResult {
  readonly status: "valid" | "config-unavailable";
  readonly diagnostics: readonly ConfigIssue[];
  readonly config?: RuntimeConfig;
}

/** Port used by the registry to persist a committed runtime config version. */
export interface ConfigStore {
  saveConfig(config: {
    readonly configId: string;
    readonly namespace: string;
    readonly packVersion: string;
    readonly document: unknown;
  }): "committed" | "duplicate";
  currentConfig(): { readonly configId: string; readonly document: unknown } | undefined;
  loadConfig(configId: string): unknown | undefined;
}

function manifestLabel(input: PackInput): string {
  const manifest = input.manifest;
  if (typeof manifest === "object" && manifest !== null) {
    const namespace: unknown = Reflect.get(manifest, "namespace") ?? Reflect.get(manifest, "pack");
    if (typeof namespace === "string") return namespace;
  }
  return input.label;
}

function toParsedPack(input: PackInput, bag: IssueList): ParsedPack | undefined {
  const label = manifestLabel(input);
  const pack = parsePack(
    input.manifest,
    input.files,
    (relativePath, message) => {
      bag.add(
        error("structure", "structure-invalid", message, {
          subject: label,
          source: { pack: label, file: relativePath },
        }),
      );
    },
    input.contentId,
    (target) => input.files.find((file) => file.path === target)?.text,
  );
  return pack;
}

/**
 * The configuration registry: parse, resolve, validate, compile and publish one
 * runtime config version.
 *
 * A failed update returns diagnostics and leaves the current version completely
 * untouched. A successful update commits the new version to the store and only
 * then becomes observable, so no caller can observe a partial update.
 */
export function packInput(snapshot: ContentPackSnapshot): PackInput {
  return {
    label: snapshot.root,
    contentId: snapshot.identity,
    manifest: snapshot.manifest,
    files: snapshot.files.map((file) => ({
      path: file.path,
      document: file.document,
      ...(file.document === undefined ? { text: new TextDecoder().decode(file.bytes) } : {}),
    })),
  };
}

export class CoreRuntime {
  private readonly systems: SystemCatalog;
  private cachedIndex: SystemIndex | undefined;
  private currentConfig: RuntimeConfig | undefined;

  constructor(
    systems: SystemCatalog = new SystemCatalog(),
    private readonly store?: ConfigStore,
  ) {
    this.systems = systems;
  }

  addSystem(system: SystemSpec): LoadResult {
    const result = this.systems.add(system);
    if (result.status === "registered") this.cachedIndex = undefined;
    return result;
  }

  systemIndex(): SystemIndex {
    this.cachedIndex ??= new SystemIndex(this.systems);
    return this.cachedIndex;
  }

  systemCatalog(): SystemCatalog {
    return this.systems;
  }

  /** The single runtime config version visible to evaluation. */
  current(): RuntimeConfig | undefined {
    return this.currentConfig;
  }

  publish(input: ConfigInput): PublishResult {
    const bag = new IssueList();
    const root = toParsedPack(input.root, bag);
    const dependencies: ParsedPack[] = [];
    for (const dependency of input.dependencies ?? []) {
      const parsed = toParsedPack(dependency, bag);
      if (parsed !== undefined) dependencies.push(parsed);
    }
    if (root === undefined || bag.hasErrors) return { status: "rejected", diagnostics: bag.all };
    const built = this.buildPacks(root, dependencies, bag);
    if (built === undefined) return { status: "rejected", diagnostics: bag.all };

    const namespace = root.manifest.namespace;
    const packVersion = root.manifest.version;
    if (this.store !== undefined) {
      try {
        this.store.saveConfig({
          configId: built.configId,
          namespace,
          packVersion,
          document: built.sourceData,
        });
      } catch (failure) {
        // A hard failure after the commit means the version is durable but the
        // acknowledgement was lost; the durable state decides, never the caller.
        const durable = this.store.currentConfig();
        if (durable?.configId !== built.configId) {
          bag.add(
            error(
              "compatibility",
              "config-unavailable",
              `Runtime config ${built.configId} could not be persisted: ${
                failure instanceof Error ? failure.message : String(failure)
              }`,
            ),
          );
          return { status: "config-unavailable", diagnostics: bag.all };
        }
      }
    }
    this.currentConfig = built;
    return { status: "valid", diagnostics: bag.all, config: built };
  }

  /**
   * Rebuilds a stored runtime config version and checks that it still compiles
   * to the same configId. A restore never silently substitutes another version.
   */
  restore(configId: string): RestoreResult {
    const document = this.store?.loadConfig(configId);
    if (document === undefined)
      return {
        status: "config-unavailable",
        diagnostics: [
          error(
            "compatibility",
            "config-unavailable",
            `Runtime config version ${configId} is not available for restore`,
          ),
        ],
      };
    const parsed = readStoredDocument(document);
    if (parsed === undefined)
      return {
        status: "config-unavailable",
        diagnostics: [
          error("compatibility", "config-unavailable", `Stored runtime config ${configId} is not readable`),
        ],
      };
    const bag = new IssueList();
    const built = this.buildPacks(parsed.root, parsed.dependencies, bag);
    if (built === undefined) return { status: "config-unavailable", diagnostics: bag.all };
    if (built.configId !== configId) {
      return {
        status: "config-unavailable",
        diagnostics: [
          error(
            "compatibility",
            "config-unavailable",
            `Restored content compiles to ${built.configId}, but the saved state refers to ${configId}`,
          ),
        ],
      };
    }
    return { status: "valid", diagnostics: bag.all, config: built };
  }

  /** Evaluates against the current runtime config version. */
  runRules(request: RuleRequest): RuleResult {
    if (this.currentConfig === undefined)
      return {
        status: "config-unavailable",
        configId: "",
        stateChanges: [],
        processChanges: [],
        trace: {
          runId: request.runId,
          trigger: request.trigger,
          configId: "",
          stateVersion: request.input.stateVersion,
          simTime: request.input.simTime,
          shared: {
            entityId: null,
            selectedRules: [],
            skippedRules: [],
            rules: [],
            combines: [],
            stateChanges: [],
            processChanges: [],
          },
          entities: [...new Set(request.entityIds)].sort().map((entityId) => ({
            entityId,
            selectedRules: [],
            skippedRules: [],
            rules: [],
            combines: [],
            stateChanges: [],
            processChanges: [],
          })),
          stateChanges: [],
          processChanges: [],
        },
      };
    return runRules(this.currentConfig, request);
  }

  private buildPacks(root: ParsedPack, dependencies: readonly ParsedPack[], bag: IssueList): RuntimeConfig | undefined {
    bag.addAll(this.systems.finalize());
    const packs = PackSet.build(root, dependencies, bag);
    if (bag.hasErrors) return undefined;
    const items = mergeItems(packs, this.systems, bag);
    if (bag.hasErrors) return undefined;
    const validated = checkConfig(packs, this.systemIndex(), items, bag);
    if (validated === undefined) return undefined;
    return buildConfig(validated);
  }
}

/** Reads back the already-parsed manifest of a stored runtime config document. */
function readStoredManifest(value: unknown): PackManifest | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const namespace: unknown = Reflect.get(value, "namespace");
  const version: unknown = Reflect.get(value, "version");
  const kernel: unknown = Reflect.get(value, "kernel");
  const dependencies: unknown = Reflect.get(value, "dependencies");
  const systems: unknown = Reflect.get(value, "systems");
  const sections: unknown = Reflect.get(value, "sections");
  if (typeof namespace !== "string" || typeof version !== "string" || typeof kernel !== "string") return undefined;
  if (!Array.isArray(dependencies) || dependencies.some((item) => typeof item !== "string")) return undefined;
  if (!Array.isArray(systems) || systems.some((item) => typeof item !== "string")) return undefined;
  if (typeof sections !== "object" || sections === null) return undefined;
  const parsedSections: Record<string, string> = {};
  for (const [directory, typeRef] of Object.entries(sections)) {
    if (typeof typeRef !== "string") return undefined;
    parsedSections[directory] = typeRef;
  }
  return {
    namespace,
    version,
    kernel,
    dependencies: dependencies as readonly string[],
    systems: systems as readonly string[],
    sections: parsedSections,
  };
}

interface StoredDocument {
  readonly root: ParsedPack;
  readonly dependencies: readonly ParsedPack[];
}

function readStoredDocument(document: unknown): StoredDocument | undefined {
  if (typeof document !== "object" || document === null) return undefined;
  const packs: unknown = Reflect.get(document, "packs");
  if (!Array.isArray(packs) || packs.length === 0) return undefined;
  const parsed = packs.map((entry) => {
    if (typeof entry !== "object" || entry === null) return undefined;
    const manifest: unknown = Reflect.get(entry, "manifest");
    const items: unknown = Reflect.get(entry, "items");
    const rules: unknown = Reflect.get(entry, "rules");
    const formulas: unknown = Reflect.get(entry, "formulas");
    if (!Array.isArray(items) || !Array.isArray(rules) || !Array.isArray(formulas)) return undefined;
    const contentId: unknown = Reflect.get(entry, "contentId");
    const storedManifest = readStoredManifest(manifest);
    if (storedManifest === undefined) return undefined;
    return {
      manifest: storedManifest,
      contentId: typeof contentId === "string" ? contentId : "",
      items: items as ParsedPack["items"],
      rules: rules as ParsedPack["rules"],
      formulas: formulas as ParsedPack["formulas"],
    } satisfies ParsedPack;
  });
  if (parsed.some((entry) => entry === undefined)) return undefined;
  const stored = parsed as readonly ParsedPack[];
  const rootIndex = packs.findIndex((entry) => Reflect.get(entry as object, "root") === true);
  const root = stored[rootIndex === -1 ? 0 : rootIndex];
  if (root === undefined) return undefined;
  return { root, dependencies: stored.filter((pack) => pack !== root) };
}
