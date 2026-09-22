/**
 * Stable identity for every configurable artifact.
 *
 * A qualified name is `<namespace>/<name>`; namespaces are dotted lowercase
 * segments, names are lowercase kebab tokens. A reference may pin an explicit
 * version with `@<major>.<minor>.<patch>`. Nothing in the kernel resolves an
 * identity from load order, file position or a display name, so every lookup is
 * reproducible from the identity alone.
 */
export const KERNEL_NAMESPACE = "agentlife.kernel";
export const KERNEL_VERSION = "1.0.0";

const NAMESPACE_PATTERN = /^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*)*$/;
const NAME_PATTERN = /^[a-z][a-z0-9-]*$/;
const VERSION_PATTERN = /^\d+\.\d+\.\d+$/;
const RANGE_PATTERN = /^(?:>=|<=|>|<|=)?\d+\.\d+\.\d+$/;

export interface QualifiedName {
  readonly namespace: string;
  readonly name: string;
}

export interface QualifiedReference extends QualifiedName {
  /** Explicit version pin; absent means "any version of this identity". */
  readonly version?: string;
}

export function isNamespace(value: string): boolean {
  return NAMESPACE_PATTERN.test(value);
}

export function isName(value: string): boolean {
  return NAME_PATTERN.test(value);
}

export function isVersion(value: string): boolean {
  return VERSION_PATTERN.test(value);
}

/** Canonical text form: `<namespace>/<name>` plus `@<version>` when pinned. */
export function formatQualifiedName(reference: QualifiedReference): string {
  const base = `${reference.namespace}/${reference.name}`;
  return reference.version === undefined ? base : `${base}@${reference.version}`;
}

/**
 * Parses `<namespace>/<name>[@<version>]`. Structural failures throw, because a
 * malformed identity in a source document can never be repaired by the caller.
 */
export function parseQualifiedName(text: string, kind = "reference"): QualifiedReference {
  const separator = text.indexOf("@");
  const base = separator === -1 ? text : text.slice(0, separator);
  const version = separator === -1 ? undefined : text.slice(separator + 1);
  const slash = base.indexOf("/");
  if (slash <= 0 || slash === base.length - 1) throw new Error(`Invalid ${kind}: ${text}`);
  const namespace = base.slice(0, slash);
  const name = base.slice(slash + 1);
  if (!isNamespace(namespace) || !isName(name)) throw new Error(`Invalid ${kind}: ${text}`);
  if (version !== undefined && !isVersion(version)) throw new Error(`Invalid ${kind} version: ${text}`);
  return version === undefined ? { namespace, name } : { namespace, name, version };
}

export function sameName(left: QualifiedName, right: QualifiedName): boolean {
  return left.namespace === right.namespace && left.name === right.name;
}

/** Total order over identities, used as the final tie-break for stable ordering. */
export function compareNames(left: QualifiedName, right: QualifiedName): number {
  if (left.namespace !== right.namespace) return left.namespace < right.namespace ? -1 : 1;
  if (left.name === right.name) return 0;
  return left.name < right.name ? -1 : 1;
}

const VERSION_PARTS = /^\d+\.\d+\.\d+$/;

/** Compares two `major.minor.patch` versions numerically. */
export function compareVersions(left: string, right: string): number {
  const leftParts = left.split(".").map(Number);
  const rightParts = right.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    const a = leftParts[index] ?? 0;
    const b = rightParts[index] ?? 0;
    if (a !== b) return a < b ? -1 : 1;
  }
  return 0;
}

/**
 * Evaluates a space-separated version constraint list such as `>=1.0.0 <2.0.0`.
 * Every clause must hold; an empty constraint means "any version".
 */
export function satisfiesVersion(version: string, constraint: string): boolean {
  if (!VERSION_PARTS.test(version)) return false;
  const clauses = constraint
    .trim()
    .split(/\s+/)
    .filter((clause) => clause !== "");
  if (clauses.length === 0) return true;
  return clauses.every((clause) => {
    const match = /^(>=|<=|>|<|=)?(\d+\.\d+\.\d+)$/.exec(clause);
    if (match === null) return false;
    const operator = match[1] ?? "=";
    const target = match[2] ?? "";
    const order = compareVersions(version, target);
    switch (operator) {
      case ">=":
        return order >= 0;
      case "<=":
        return order <= 0;
      case ">":
        return order > 0;
      case "<":
        return order < 0;
      default:
        return order === 0;
    }
  });
}

export function isVersionConstraint(value: string): boolean {
  const clauses = value
    .trim()
    .split(/\s+/)
    .filter((clause) => clause !== "");
  return clauses.length > 0 && clauses.every((clause) => RANGE_PATTERN.test(clause));
}
