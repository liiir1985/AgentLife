import { compileConfiguration, type CompiledRuntimeConfig } from "./compile.js";
import { ExtensionCapabilities } from "./capabilities.js";
import { error, DiagnosticBag, type Diagnostic } from "./diagnostics.js";
import { ExtensionRegistry, type DomainExtension, type RegistrationResult } from "./extension.js";
import { PackSet } from "./packs.js";
import { resolveDefinitions } from "./resolve.js";
import { parseSourcePack, type SourceManifest, type SourcePack } from "./source.js";
import { validateConfiguration } from "./validate.js";
import { evaluate, type EvaluationRequest, type EvaluationResult } from "./evaluate.js";
import type { ContentPackSnapshot } from "../content/content-pack-loader.js";

export interface ContentPackInput {
  /** Root-relative path of every participating file. */
  readonly files: readonly { readonly path: string; readonly document: unknown; readonly text?: string }[];
  readonly manifest: unknown;
  /** Human-readable label used in diagnostics. */
  readonly label: string;
  /** Content identity of the pack, part of the runtime config identity. */
  readonly identity: string;
}

export interface ConfigurationInput {
  readonly root: ContentPackInput;
  readonly dependencies?: readonly ContentPackInput[];
}

export type ApplyStatus = "valid" | "rejected" | "config-unavailable";

export interface ApplyResult {
  readonly status: ApplyStatus;
  readonly diagnostics: readonly Diagnostic[];
  readonly config?: CompiledRuntimeConfig;
}

export interface RestoreResult {
  readonly status: "valid" | "config-unavailable";
  readonly diagnostics: readonly Diagnostic[];
  readonly config?: CompiledRuntimeConfig;
}

/** Port used by the registry to persist a committed runtime config version. */
export interface ConfigPersistence {
  saveRuntimeConfig(config: {
    readonly identity: string;
    readonly namespace: string;
    readonly packVersion: string;
    readonly document: unknown;
  }): "committed" | "duplicate";
  currentRuntimeConfig(): { readonly identity: string; readonly document: unknown } | undefined;
  configDocument(identity: string): unknown | undefined;
}

function manifestLabel(input: ContentPackInput): string {
  const manifest = input.manifest;
  if (typeof manifest === "object" && manifest !== null) {
    const namespace: unknown = Reflect.get(manifest, "namespace") ?? Reflect.get(manifest, "pack");
    if (typeof namespace === "string") return namespace;
  }
  return input.label;
}

function toSourcePack(input: ContentPackInput, bag: DiagnosticBag): SourcePack | undefined {
  const label = manifestLabel(input);
  const pack = parseSourcePack(
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
    input.identity,
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
export function contentPackInput(snapshot: ContentPackSnapshot): ContentPackInput {
  return {
    label: snapshot.root,
    identity: snapshot.identity,
    manifest: snapshot.manifest,
    files: snapshot.files.map((file) => ({
      path: file.path,
      document: file.document,
      ...(file.document === undefined ? { text: new TextDecoder().decode(file.bytes) } : {}),
    })),
  };
}

export class ConfigurationRegistry {
  private readonly extensions: ExtensionRegistry;
  private cachedCapabilities: ExtensionCapabilities | undefined;
  private currentConfig: CompiledRuntimeConfig | undefined;

  constructor(
    extensions: ExtensionRegistry = new ExtensionRegistry(),
    private readonly persistence?: ConfigPersistence,
  ) {
    this.extensions = extensions;
  }

  registerExtension(extension: DomainExtension): RegistrationResult {
    const result = this.extensions.register(extension);
    if (result.status === "registered") this.cachedCapabilities = undefined;
    return result;
  }

  capabilities(): ExtensionCapabilities {
    this.cachedCapabilities ??= new ExtensionCapabilities(this.extensions);
    return this.cachedCapabilities;
  }

  extensionRegistry(): ExtensionRegistry {
    return this.extensions;
  }

  /** The single runtime config version visible to evaluation. */
  current(): CompiledRuntimeConfig | undefined {
    return this.currentConfig;
  }

  apply(input: ConfigurationInput): ApplyResult {
    const bag = new DiagnosticBag();
    const root = toSourcePack(input.root, bag);
    const dependencies: SourcePack[] = [];
    for (const dependency of input.dependencies ?? []) {
      const parsed = toSourcePack(dependency, bag);
      if (parsed !== undefined) dependencies.push(parsed);
    }
    if (root === undefined || bag.hasErrors) return { status: "rejected", diagnostics: bag.all };
    const built = this.buildFromPacks(root, dependencies, bag);
    if (built === undefined) return { status: "rejected", diagnostics: bag.all };

    const namespace = root.manifest.namespace;
    const packVersion = root.manifest.version;
    if (this.persistence !== undefined) {
      try {
        this.persistence.saveRuntimeConfig({
          identity: built.identity,
          namespace,
          packVersion,
          document: built.sourceDocument,
        });
      } catch (failure) {
        // A hard failure after the commit means the version is durable but the
        // acknowledgement was lost; the durable state decides, never the caller.
        const durable = this.persistence.currentRuntimeConfig();
        if (durable?.identity !== built.identity) {
          bag.add(
            error(
              "compatibility",
              "config-unavailable",
              `Runtime config ${built.identity} could not be persisted: ${
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
   * to the same identity. A restore never silently substitutes another version.
   */
  restore(identity: string): RestoreResult {
    const document = this.persistence?.configDocument(identity);
    if (document === undefined)
      return {
        status: "config-unavailable",
        diagnostics: [
          error(
            "compatibility",
            "config-unavailable",
            `Runtime config version ${identity} is not available for restore`,
          ),
        ],
      };
    const parsed = readStoredDocument(document);
    if (parsed === undefined)
      return {
        status: "config-unavailable",
        diagnostics: [
          error("compatibility", "config-unavailable", `Stored runtime config ${identity} is not readable`),
        ],
      };
    const bag = new DiagnosticBag();
    const built = this.buildFromPacks(parsed.root, parsed.dependencies, bag);
    if (built === undefined) return { status: "config-unavailable", diagnostics: bag.all };
    if (built.identity !== identity) {
      return {
        status: "config-unavailable",
        diagnostics: [
          error(
            "compatibility",
            "config-unavailable",
            `Restored content compiles to ${built.identity}, but the saved state refers to ${identity}`,
          ),
        ],
      };
    }
    return { status: "valid", diagnostics: bag.all, config: built };
  }

  /** Evaluates against the current runtime config version. */
  evaluate(request: EvaluationRequest): EvaluationResult {
    if (this.currentConfig === undefined)
      return {
        status: "config-unavailable",
        configIdentity: "",
        trace: {
          requestId: request.requestId,
          trigger: request.trigger,
          configIdentity: "",
          stateVersion: request.snapshot.stateVersion,
          simulationTime: request.snapshot.simulationTime,
          indexed: [],
          notIndexed: [],
          rules: [],
          compositions: [],
          candidates: [],
          processOperations: [],
        },
      };
    return evaluate(this.currentConfig, request);
  }

  private buildFromPacks(
    root: SourcePack,
    dependencies: readonly SourcePack[],
    bag: DiagnosticBag,
  ): CompiledRuntimeConfig | undefined {
    bag.addAll(this.extensions.finalize());
    const packs = PackSet.build(root, dependencies, bag);
    if (bag.hasErrors) return undefined;
    const definitions = resolveDefinitions(packs, this.extensions, bag);
    if (bag.hasErrors) return undefined;
    const validated = validateConfiguration(packs, this.capabilities(), definitions, bag);
    if (validated === undefined) return undefined;
    return compileConfiguration(validated);
  }
}

/** Reads back the already-parsed manifest of a stored runtime config document. */
function readStoredManifest(value: unknown): SourceManifest | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const namespace: unknown = Reflect.get(value, "namespace");
  const version: unknown = Reflect.get(value, "version");
  const kernel: unknown = Reflect.get(value, "kernel");
  const dependencies: unknown = Reflect.get(value, "dependencies");
  const extensions: unknown = Reflect.get(value, "extensions");
  const sections: unknown = Reflect.get(value, "sections");
  if (typeof namespace !== "string" || typeof version !== "string" || typeof kernel !== "string") return undefined;
  if (!Array.isArray(dependencies) || dependencies.some((item) => typeof item !== "string")) return undefined;
  if (!Array.isArray(extensions) || extensions.some((item) => typeof item !== "string")) return undefined;
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
    extensions: extensions as readonly string[],
    sections: parsedSections,
  };
}

interface StoredDocument {
  readonly root: SourcePack;
  readonly dependencies: readonly SourcePack[];
}

function readStoredDocument(document: unknown): StoredDocument | undefined {
  if (typeof document !== "object" || document === null) return undefined;
  const packs: unknown = Reflect.get(document, "packs");
  if (!Array.isArray(packs) || packs.length === 0) return undefined;
  const parsed = packs.map((entry) => {
    if (typeof entry !== "object" || entry === null) return undefined;
    const manifest: unknown = Reflect.get(entry, "manifest");
    const definitions: unknown = Reflect.get(entry, "definitions");
    const rules: unknown = Reflect.get(entry, "rules");
    const derivations: unknown = Reflect.get(entry, "derivations");
    if (!Array.isArray(definitions) || !Array.isArray(rules) || !Array.isArray(derivations)) return undefined;
    const contentIdentity: unknown = Reflect.get(entry, "identity");
    const storedManifest = readStoredManifest(manifest);
    if (storedManifest === undefined) return undefined;
    return {
      manifest: storedManifest,
      identity: typeof contentIdentity === "string" ? contentIdentity : "",
      definitions: definitions as SourcePack["definitions"],
      rules: rules as SourcePack["rules"],
      derivations: derivations as SourcePack["derivations"],
    } satisfies SourcePack;
  });
  if (parsed.some((entry) => entry === undefined)) return undefined;
  const stored = parsed as readonly SourcePack[];
  const rootIndex = packs.findIndex((entry) => Reflect.get(entry as object, "root") === true);
  const root = stored[rootIndex === -1 ? 0 : rootIndex];
  if (root === undefined) return undefined;
  return { root, dependencies: stored.filter((pack) => pack !== root) };
}
