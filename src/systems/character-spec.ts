import { Type } from "typebox";
import { error } from "../config/diagnostics.js";
import type { SystemItem, SystemSpec } from "../config/system-spec.js";

/**
 * Character system system.
 *
 * Registers the character config type and the creation-time invariants the
 * character system owns: capability tier, control source, subsystem modules and
 * the main-entity flag must agree with each other before a config can load.
 *
 * `identity` is free text: the kernel hashes it into the configuration identity
 * but never interprets it, and the character system only requires that an
 * initial version exists. Structuring a life story, a personality or a set of
 * preferences is a cognition concern, not a configuration-schema concern.
 *
 * The scheduling input it exposes is management information and is granted to no
 * other system, so no runtime rule can read tier or control routing.
 */

const CONTROL_SCHEMA = Type.Object(
  {
    kind: Type.Union([
      Type.Literal("none"),
      Type.Literal("behaviour-tree"),
      Type.Literal("cognition"),
      Type.Literal("user"),
    ]),
  },
  { additionalProperties: false },
);

const CHARACTER_SCHEMA = Type.Object(
  {
    name: Type.String(),
    identity: Type.String(),
    tier: Type.Union([Type.Literal("dynamic"), Type.Literal("degraded"), Type.Literal("normal")]),
    main: Type.Boolean(),
    control: CONTROL_SCHEMA,
    modules: Type.Array(
      Type.Union([
        Type.Literal("perception"),
        Type.Literal("cognition"),
        Type.Literal("memory"),
        Type.Literal("behaviour-tree"),
      ]),
    ),
    homeLocation: Type.String(),
  },
  { additionalProperties: false },
);

const SCHEDULE_VIEW = Type.Object(
  {
    tier: Type.String(),
    main: Type.Boolean(),
    hasCognition: Type.Boolean(),
    hasBehaviourTree: Type.Boolean(),
  },
  { additionalProperties: false },
);

/** Subjective modules only a normal entity may carry. */
const SUBJECTIVE_MODULES: readonly string[] = ["perception", "cognition", "memory"];

function reportInvariant(
  report: (diagnostic: ReturnType<typeof error>) => void,
  subject: string,
  message: string,
): void {
  report(error("system", "system-rejected", message, { subject }));
}

function checkTier(item: SystemItem, report: (diagnostic: ReturnType<typeof error>) => void): void {
  const tier = item.values.tier;
  const control = item.values.control;
  const modules = Array.isArray(item.values.modules)
    ? item.values.modules.filter((module): module is string => typeof module === "string")
    : [];
  const main = item.values.main === true;
  const kind = typeof control === "object" && control !== null ? Reflect.get(control, "kind") : undefined;

  if (tier === "dynamic" && kind !== "none")
    reportInvariant(
      report,
      item.ref,
      `${item.ref} is a dynamic entity and must not declare an autonomous decision entry`,
    );
  if (tier === "degraded" && kind !== "behaviour-tree")
    reportInvariant(report, item.ref, `${item.ref} is a degraded entity and must use a behaviour tree`);
  if (tier === "normal" && kind !== "cognition" && kind !== "user")
    reportInvariant(report, item.ref, `${item.ref} is a normal entity and must use a cognition or user decision entry`);
  if (tier !== "normal" && main)
    reportInvariant(report, item.ref, `${item.ref} is not a normal entity and cannot be a main entity`);
  if (tier === "degraded")
    for (const module of modules)
      if (SUBJECTIVE_MODULES.includes(module))
        reportInvariant(report, item.ref, `${item.ref} is a degraded entity and must not reference ${module}`);
  if (tier === "dynamic" && modules.length > 0)
    reportInvariant(report, item.ref, `${item.ref} is a dynamic entity and must not declare subsystem modules`);
  if (tier === "normal" && modules.includes("behaviour-tree"))
    reportInvariant(
      report,
      item.ref,
      `${item.ref} is a normal entity and must not run a behaviour tree next to full cognition`,
    );
  if (kind === "cognition" && !modules.includes("cognition"))
    reportInvariant(report, item.ref, `${item.ref} uses a cognition entry without a cognition module`);
  if (kind === "user" && modules.includes("cognition") && !modules.includes("memory"))
    reportInvariant(report, item.ref, `${item.ref} keeps cognition state without subjective memory`);
}

function checkIdentity(item: SystemItem, report: (diagnostic: ReturnType<typeof error>) => void): void {
  const identity = item.values.identity;
  if (typeof identity !== "string" || identity.trim() === "")
    reportInvariant(report, item.ref, `${item.ref}.identity must carry an initial version`);
}

export function createCharacterSpec(): SystemSpec {
  return {
    name: "system",
    namespace: "agentlife.character",
    version: "1.0.0",
    kernel: ">=1.0.0 <2.0.0",
    requires: [],
    items: [
      {
        kind: "character",
        fields: CHARACTER_SCHEMA,
        defaults: { main: false, modules: [] },
        references: { homeLocation: ["agentlife.world/location"] },
        overridable: ["name", "identity", "tier", "main", "control", "modules", "homeLocation"],
        merge: {
          name: "replace",
          identity: "replace",
          tier: "replace",
          main: "replace",
          control: "replace",
          modules: "append",
          homeLocation: "replace",
        },
        validate: ({ items, report }) => {
          for (const item of items) {
            checkTier(item, report);
            checkIdentity(item, report);
          }
        },
      },
    ],
    inputs: [
      {
        name: "schedule",
        fields: SCHEDULE_VIEW,
        // Scheduling classification is management information; the kernel grants
        // it to no runtime rule system.
        exposedTo: [],
      },
    ],
    triggers: ["identity-changed", "lifecycle-changed"],
    outputs: [],
    validate: ({ items, report }) => {
      const mainEntities = items.filter((item) => item.values.main === true);
      for (const item of mainEntities)
        if (item.values.tier !== "normal")
          reportInvariant(report, item.ref, `${item.ref} is marked main without a normal capability tier`);
    },
  };
}
