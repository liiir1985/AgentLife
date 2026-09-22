import { createHash } from "node:crypto";

/**
 * Deterministic serialization used for every identity in the infrastructure.
 *
 * Object keys are sorted, `undefined` members are dropped, and non-finite
 * numbers are refused: two logically equal documents must never produce two
 * different identities, and no identity may depend on insertion order.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

export function canonicalize(value: unknown): unknown {
  if (value === null) return null;
  switch (typeof value) {
    case "boolean":
    case "string":
      return value;
    case "number":
      if (!Number.isFinite(value)) throw new Error(`Cannot canonicalize non-finite number: ${String(value)}`);
      return value;
    case "undefined":
      return undefined;
    case "object":
      break;
    default:
      throw new Error(`Cannot canonicalize value of type ${typeof value}`);
  }
  if (Array.isArray(value)) return value.map((item) => canonicalize(item));
  const source = value as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(source).sort()) {
    const item = canonicalize(source[key]);
    if (item !== undefined) result[key] = item;
  }
  return result;
}

/** SHA-256 over the canonical form of a value; the only identity the kernel uses. */
export function identityOf(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

/** Deep-freezes a compiled artifact so no caller can mutate a live version. */
export function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object") return value;
  Object.freeze(value);
  for (const item of Object.values(value as Record<string, unknown>)) deepFreeze(item);
  if (Array.isArray(value)) for (const item of value) deepFreeze(item);
  return value;
}
