import { createHash } from "node:crypto";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { parse } from "yaml";

export interface ContentPackFile {
  /** Normalized, root-relative path using `/` separators. */
  readonly path: string;
  readonly bytes: Uint8Array;
  /** Parsed YAML document for structured files, `undefined` for Markdown. */
  readonly document: unknown;
}

export interface ContentPackSnapshot {
  readonly root: string;
  /** SHA-256 over the manifest and every participating file. */
  readonly identity: string;
  readonly manifest: unknown;
  /** Every resolved in-pack reference, normalized and sorted. */
  readonly references: readonly string[];
  readonly files: readonly ContentPackFile[];
}

const MANIFEST = "manifest.yaml";
const SUPPORTED_EXTENSIONS: Record<string, true> = { ".yaml": true, ".yml": true, ".md": true };
const MARKDOWN_LINK = /\]\(([^)\s]+)\)/g;

export class ContentPackError extends Error {}

/**
 * Loads a content pack in a closed world: every participating file must live inside
 * the pack root, the manifest is mandatory, and the returned snapshot is frozen and
 * carries a SHA-256 identity over the exact bytes that were read.
 */
export class ContentPackLoader {
  async load(packRoot: string): Promise<ContentPackSnapshot> {
    const root = await realpath(packRoot).catch(() => {
      throw new ContentPackError(`Content pack root is missing: ${packRoot}`);
    });
    if (!(await lstat(root)).isDirectory()) throw new ContentPackError("Content pack root must be a directory");

    const relativePaths = (await this.walk(root, root)).sort();
    if (!relativePaths.includes(MANIFEST)) throw new ContentPackError(`Content pack requires ${MANIFEST}`);

    const files: ContentPackFile[] = [];
    for (const relativePath of relativePaths) {
      const bytes = Uint8Array.from(await readFile(path.join(root, relativePath)));
      files.push(Object.freeze({ path: relativePath, bytes, document: parseDocument(relativePath, bytes) }));
    }

    const manifest = files.find((file) => file.path === MANIFEST)?.document;
    if (typeof manifest !== "object" || manifest === null || Array.isArray(manifest)) {
      throw new ContentPackError(`${MANIFEST} must contain a mapping`);
    }

    const references = this.resolveReferences(relativePaths, files);
    return Object.freeze({
      root,
      identity: hashFiles(files),
      manifest,
      references: Object.freeze(references),
      files: Object.freeze(files),
    });
  }

  /** Walks the pack, refusing symlinks and directory junctions outright. */
  private async walk(root: string, directory: string): Promise<string[]> {
    const result: string[] = [];
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(root, absolute).split(path.sep).join("/");
      if (entry.isSymbolicLink()) throw new ContentPackError(`Symbolic links are not allowed: ${relative}`);
      if (entry.isDirectory()) {
        result.push(...(await this.walk(root, absolute)));
      } else if (entry.isFile()) {
        if (SUPPORTED_EXTENSIONS[path.extname(entry.name).toLowerCase()] !== true) {
          throw new ContentPackError(`Unsupported content file: ${relative}`);
        }
        result.push(relative);
      }
    }
    return result;
  }

  /** Resolves every reference to a packed file, rejecting escaping or missing targets. */
  private resolveReferences(packed: readonly string[], files: readonly ContentPackFile[]): string[] {
    const inside = new Set(packed);
    const resolved: string[] = [];
    for (const file of files) {
      for (const reference of collectReferences(file)) {
        const normalized = normalizeReference(reference);
        if (!inside.has(normalized))
          throw new ContentPackError(`Missing content file: ${reference} (from ${file.path})`);
        resolved.push(normalized);
      }
    }
    return [...new Set(resolved)].sort();
  }
}

/** Parses YAML documents; Markdown stays raw text under a controlled reference scan. */
function parseDocument(relativePath: string, bytes: Uint8Array): unknown {
  const extension = path.extname(relativePath).toLowerCase();
  return extension === ".md" ? undefined : parse(new TextDecoder().decode(bytes));
}

function collectReferences(file: ContentPackFile): string[] {
  const references: string[] = [];
  if (file.document !== undefined) collectYamlReferences(file.document, references);
  if (path.extname(file.path).toLowerCase() === ".md") {
    const text = new TextDecoder().decode(file.bytes);
    for (const match of text.matchAll(MARKDOWN_LINK)) {
      const target = match[1];
      if (target !== undefined && !target.includes("://")) references.push(target);
    }
  }
  return references;
}

/** Any YAML string ending in a supported extension is treated as a content reference. */
function collectYamlReferences(value: unknown, references: string[]): void {
  if (typeof value === "string") {
    if (SUPPORTED_EXTENSIONS[path.extname(value.trim()).toLowerCase()] === true) references.push(value.trim());
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectYamlReferences(item, references);
    return;
  }
  if (typeof value === "object" && value !== null) {
    for (const item of Object.values(value)) collectYamlReferences(item, references);
  }
}

function normalizeReference(reference: string): string {
  const target = reference.split("#")[0]?.trim() ?? "";
  if (target === "") throw new ContentPackError(`Empty content reference: ${reference}`);
  if (path.isAbsolute(target) || /^[a-zA-Z]:/.test(target)) {
    throw new ContentPackError(`Absolute content reference is not allowed: ${reference}`);
  }
  const segments = target.split(/[\\/]/);
  if (segments.includes("..")) throw new ContentPackError(`Content reference escapes pack root: ${reference}`);
  const normalized = path.posix.normalize(segments.join("/"));
  if (normalized.startsWith("/") || normalized === ".") {
    throw new ContentPackError(`Content reference escapes pack root: ${reference}`);
  }
  return normalized;
}

/**
 * Unambiguous content identity: files are sorted by normalized relative path and each
 * path and payload is prefixed by its byte length, so no segment boundary can be
 * shifted by moving bytes between neighbours or by reordering the traversal.
 */
function hashFiles(files: readonly ContentPackFile[]): string {
  const hash = createHash("sha256");
  const length = Buffer.allocUnsafe(8);
  for (const file of [...files].sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))) {
    const encodedPath = Buffer.from(file.path, "utf8");
    length.writeBigUInt64BE(BigInt(encodedPath.length));
    hash.update(length);
    hash.update(encodedPath);
    length.writeBigUInt64BE(BigInt(file.bytes.byteLength));
    hash.update(length);
    hash.update(file.bytes);
  }
  return `sha256:${hash.digest("hex")}`;
}
