/**
 * Structured diagnostics and result vocabulary.
 *
 * Validation never collapses to a single "failed" flag: the caller has to know
 * whether to re-evaluate, ask for more rules, repair the content pack or stop a
 * restore, so every failure keeps its stage, code, subject and origin.
 */

/** The seven validation stages of the shared pipeline, in execution order. */
export type ValidationStage =
  "structure" | "reference" | "dependency" | "composition" | "permission" | "domain" | "compatibility";

export type DiagnosticCode =
  | "structure-invalid"
  | "unknown-reference"
  | "reference-type-mismatch"
  | "namespace-not-visible"
  | "cyclic-dependency"
  | "ambiguous-merge"
  | "unit-mismatch"
  | "unused-read"
  | "field-not-overridable"
  | "missing-composition"
  | "composition-not-allowed"
  | "incompatible-output-type"
  | "invalid-value"
  | "multiple-writers"
  | "unauthorized-read"
  | "unauthorized-effect"
  | "unknown-trigger"
  | "domain-rejected"
  | "unsupported-semantics"
  | "identity-conflict"
  | "incompatible-extension"
  | "config-unavailable";

export interface DiagnosticSource {
  /** Content pack namespace the document came from. */
  readonly pack: string;
  /** Root-relative path inside the pack. */
  readonly file: string;
  /** Dotted field path inside the document, when the failure is field-local. */
  readonly path?: string;
}

export interface Diagnostic {
  readonly severity: "error" | "warning";
  readonly stage: ValidationStage;
  readonly code: DiagnosticCode;
  readonly message: string;
  /** Qualified identity of the subject the failure belongs to. */
  readonly subject?: string;
  readonly source?: DiagnosticSource;
}

export function error(stage: ValidationStage, code: DiagnosticCode, message: string): Diagnostic;
export function error(
  stage: ValidationStage,
  code: DiagnosticCode,
  message: string,
  extra: { readonly subject?: string; readonly source?: DiagnosticSource },
): Diagnostic;
export function error(
  stage: ValidationStage,
  code: DiagnosticCode,
  message: string,
  extra?: { readonly subject?: string; readonly source?: DiagnosticSource },
): Diagnostic {
  return { severity: "error", stage, code, message, ...extra };
}

export function warning(stage: ValidationStage, code: DiagnosticCode, message: string): Diagnostic {
  return { severity: "warning", stage, code, message };
}

/** Accumulates diagnostics so a single run reports every failure it can reach. */
export class DiagnosticBag {
  private readonly entries: Diagnostic[] = [];

  add(diagnostic: Diagnostic): void {
    this.entries.push(diagnostic);
  }

  addAll(diagnostics: readonly Diagnostic[]): void {
    this.entries.push(...diagnostics);
  }

  get all(): readonly Diagnostic[] {
    return this.entries;
  }

  get hasErrors(): boolean {
    return this.entries.some((diagnostic) => diagnostic.severity === "error");
  }

  /** Runs a structural parse, converting a thrown failure into a diagnostic. */
  guard<T>(run: () => T, onError: (message: string) => Diagnostic): T | undefined {
    try {
      return run();
    } catch (failure) {
      this.add(onError(failure instanceof Error ? failure.message : String(failure)));
      return undefined;
    }
  }
}

/** Thrown by the stages that cannot continue (parsing, compilation) . */
export class ConfigError extends Error {
  readonly diagnostic: Diagnostic;

  constructor(diagnostic: Diagnostic) {
    super(diagnostic.message);
    this.diagnostic = diagnostic;
  }
}

/**
 * Result semantics of the shared infrastructure. The list is deliberately not
 * collapsed: each status tells the caller a different next action.
 */
export type ResultStatus =
  | "valid"
  | "candidates"
  | "condition-false"
  | "no-match"
  | "input-invalid"
  | "conflict"
  | "state-version-stale"
  | "config-unavailable"
  | "domain-rejected"
  | "inexpressible";

/**
 * Ordering used when several per-target outcomes compete for one status.
 *
 * An incomplete evaluation (missing or invalid input) outranks a partial
 * success: a caller must never mistake candidates computed from an incomplete
 * snapshot for a complete result set. Conflicts and inexpressible values both
 * outrank candidates, because neither may be submitted without arbitration.
 */
export const STATUS_PRECEDENCE: readonly ResultStatus[] = [
  "state-version-stale",
  "config-unavailable",
  "input-invalid",
  "inexpressible",
  "conflict",
  "candidates",
  "condition-false",
  "no-match",
];

export function strongestStatus(statuses: readonly ResultStatus[]): ResultStatus {
  for (const candidate of STATUS_PRECEDENCE) {
    if (statuses.includes(candidate)) return candidate;
  }
  return "no-match";
}
