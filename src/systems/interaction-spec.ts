import { Type } from "typebox";
import { error } from "../config/diagnostics.js";
import type { SystemSpec } from "../config/system-spec.js";

const FILTER_SCHEMA = Type.Object(
  {
    attribute: Type.String(),
    equals: Type.Union([Type.String(), Type.Number(), Type.Boolean()]),
  },
  { additionalProperties: false },
);

const ENTITY_ARGUMENT_SCHEMA = Type.Object(
  {
    name: Type.String(),
    kind: Type.Literal("entity"),
    binding: Type.Union([Type.Literal("target"), Type.Literal("destination")]),
    candidates: Type.Union([
      Type.Literal("current-exits"),
      Type.Literal("visible-items"),
      Type.Literal("held-items"),
      Type.Literal("visible-entities"),
    ]),
    filters: Type.Optional(Type.Array(FILTER_SCHEMA)),
    prompt: Type.String(),
  },
  { additionalProperties: false },
);

const TEXT_ARGUMENT_SCHEMA = Type.Object(
  {
    name: Type.String(),
    kind: Type.Literal("text"),
    field: Type.String(),
    prompt: Type.String(),
    minLength: Type.Optional(Type.Integer({ minimum: 0 })),
    maxLength: Type.Integer({ minimum: 1 }),
  },
  { additionalProperties: false },
);

const COMMAND_SCHEMA = Type.Object(
  {
    name: Type.String(),
    description: Type.String(),
    order: Type.Integer(),
    aliases: Type.Array(Type.String()),
    action: Type.String(),
    conflict: Type.Union([Type.Literal("parallel"), Type.Literal("queue"), Type.Literal("replace")]),
    arguments: Type.Array(Type.Union([ENTITY_ARGUMENT_SCHEMA, TEXT_ARGUMENT_SCHEMA])),
  },
  { additionalProperties: false },
);

const MANAGEMENT_COMMANDS = new Set(["step", "run", "pause", "save", "load", "status", "monitor", "help"]);

function commandProblems(
  items: readonly { readonly ref: string; readonly values: Readonly<Record<string, unknown>> }[],
  lookup: (ref: string) => { readonly type: string } | undefined,
  report: (subject: string, message: string) => void,
): void {
  const words = new Map<string, string>();
  for (const item of items) {
    const action = item.values.action;
    if (typeof action === "string" && lookup(action)?.type !== "agentlife.body/action")
      report(item.ref, `${item.ref} names unknown body action ${action}`);
    const labels = [item.values.name, ...(Array.isArray(item.values.aliases) ? item.values.aliases : [])];
    for (const label of labels) {
      if (typeof label !== "string") continue;
      const normalized = label.trim().toLocaleLowerCase("en-US");
      if (normalized.length === 0) report(item.ref, `${item.ref} declares an empty command word`);
      if (normalized.startsWith("/") || MANAGEMENT_COMMANDS.has(normalized.replace(/^\//, "")))
        report(item.ref, `${item.ref} uses reserved management command ${label}`);
      const owner = words.get(normalized);
      if (owner !== undefined && owner !== item.ref)
        report(item.ref, `${item.ref} and ${owner} both declare command word ${label}`);
      words.set(normalized, item.ref);
    }
    const bindings = new Set<string>();
    const textFields = new Set<string>();
    const args = Array.isArray(item.values.arguments) ? item.values.arguments : [];
    for (const argument of args) {
      if (typeof argument !== "object" || argument === null) continue;
      const kind = Reflect.get(argument, "kind");
      if (kind === "entity") {
        const binding = String(Reflect.get(argument, "binding"));
        if (bindings.has(binding)) report(item.ref, `${item.ref} binds ${binding} more than once`);
        bindings.add(binding);
        const filters = Reflect.get(argument, "filters");
        if (Array.isArray(filters))
          for (const filter of filters) {
            if (typeof filter !== "object" || filter === null) continue;
            const attribute = Reflect.get(filter, "attribute");
            if (typeof attribute === "string" && lookup(attribute)?.type !== "agentlife.world/attribute")
              report(item.ref, `${item.ref} names unknown world attribute ${attribute}`);
          }
      } else if (kind === "text") {
        const field = String(Reflect.get(argument, "field"));
        if (textFields.has(field)) report(item.ref, `${item.ref} declares text field ${field} more than once`);
        textFields.add(field);
        const min = Reflect.get(argument, "minLength");
        const max = Reflect.get(argument, "maxLength");
        if (typeof min === "number" && typeof max === "number" && min > max)
          report(item.ref, `${item.ref} declares minLength greater than maxLength for ${field}`);
      }
    }
  }
}

export function createInteractionSpec(): SystemSpec {
  return {
    name: "interaction",
    namespace: "agentlife.interaction",
    version: "1.1.0",
    kernel: ">=1.0.0 <2.0.0",
    requires: ["agentlife.body", "agentlife.world"],
    items: [
      {
        kind: "action-command",
        fields: COMMAND_SCHEMA,
        references: { action: ["agentlife.body/action"] },
        overridable: ["name", "description", "order", "aliases", "action", "conflict", "arguments"],
        merge: {
          name: "replace",
          description: "replace",
          order: "replace",
          aliases: "replace",
          action: "replace",
          conflict: "replace",
          arguments: "replace",
        },
      },
    ],
    inputs: [],
    triggers: [],
    outputs: [],
    processes: [],
    propagation: [],
    validate: ({ items, lookup, report }) =>
      commandProblems(items, lookup, (subject, message) =>
        report(error("system", "system-rejected", message, { subject })),
      ),
  };
}
