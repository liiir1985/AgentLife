import { Type } from "typebox";
import type { ItemSpec, SystemCheck, MergeStrategy, StateScope } from "./system-spec.js";

/**
 * Value and channel shapes shared by every system that stores declared values.
 *
 * The kernel does not know what a "stamina" or a "vision" is; it knows how a
 * item that declares one contributes fields to a value-set input and output.
 * A system declares ownership of these shapes, may tighten their validation in
 * its own system validator, and may mark the fields it treats as contract
 * values, which the kernel then enforces as single-writer.
 */

/** Policy block whose every part is optional; absent parts constrain nothing. */
const POLICY_SCHEMA = Type.Object(
  {
    unit: Type.Optional(Type.String()),
    rounding: Type.Optional(
      Type.Object(
        {
          mode: Type.Optional(
            Type.Union([
              Type.Literal("none"),
              Type.Literal("half-away-from-zero"),
              Type.Literal("floor"),
              Type.Literal("ceil"),
              Type.Literal("truncate"),
            ]),
          ),
          precision: Type.Optional(Type.Number()),
        },
        { additionalProperties: false },
      ),
    ),
    range: Type.Optional(
      Type.Object(
        {
          min: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
          max: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
          boundary: Type.Optional(Type.Union([Type.Literal("inclusive"), Type.Literal("exclusive")])),
        },
        { additionalProperties: false },
      ),
    ),
    overflow: Type.Optional(Type.Union([Type.Literal("saturate"), Type.Literal("reject")])),
  },
  { additionalProperties: false },
);

const VALUE_HANDLING: {
  readonly overridable: readonly string[];
  readonly merge: Readonly<Record<string, MergeStrategy>>;
} = {
  overridable: ["name", "type", "initial", "unit", "policy", "allowedValues"],
  merge: {
    name: "replace",
    type: "replace",
    initial: "replace",
    unit: "replace",
    policy: "merge",
    allowedValues: "replace",
  },
};

export interface ValueSetOptions {
  /** Config type name, e.g. `value`, `fact` or `channel`. */
  readonly kind: string;
  /** Value-set, input and output name, e.g. `values` or `channels`. */
  readonly valueSet: string;
  /** Members that are core values: exactly one rule may write them. */
  readonly contract: boolean;
  readonly input?: { readonly scope: StateScope; readonly exposedTo: readonly string[] };
  readonly output?: { readonly scope: StateScope; readonly exposedTo: readonly string[] };
  /** Domain invariants for items of this type. */
  readonly validate?: (input: SystemCheck) => void;
}

/**
 * A scalar value item: `id` names the value, `type` fixes its scalar kind,
 * `initial` is its declared starting state, and the optional `unit`, `policy` and
 * `allowedValues` state only the constraints the author actually wants.
 */
export function defineValueContainer(options: ValueSetOptions): ItemSpec {
  return {
    kind: options.kind,
    fields: Type.Object(
      {
        name: Type.Optional(Type.String()),
        type: Type.Union([Type.Literal("number"), Type.Literal("boolean"), Type.Literal("string")]),
        initial: Type.Union([Type.Number(), Type.Boolean(), Type.String()]),
        unit: Type.Optional(Type.String()),
        policy: Type.Optional(POLICY_SCHEMA),
        allowedValues: Type.Optional(Type.Array(Type.String())),
      },
      { additionalProperties: false },
    ),
    overridable: [...VALUE_HANDLING.overridable],
    merge: { ...VALUE_HANDLING.merge },
    valueSet: {
      name: options.valueSet,
      fields: [
        {
          key: "",
          typeField: "type",
          stateField: "initial",
          unitField: "unit",
          policyField: "policy",
          allowedValuesField: "allowedValues",
          contract: options.contract,
        },
      ],
      ...(options.input === undefined ? {} : { input: options.input }),
      ...(options.output === undefined ? {} : { output: options.output }),
    },
    ...(options.validate === undefined ? {} : { validate: options.validate }),
  };
}

/**
 * A sensory channel item. One channel item contributes two fields:
 * `<id>.available` (does the channel currently carry anything) and
 * `<id>.efficiency` (how much of the stimulus survives), so a rule never has to
 * invent a separate value for a channel that is closed or degraded.
 */
export function defineChannelContainer(options: ValueSetOptions): ItemSpec {
  return {
    kind: options.kind,
    fields: Type.Object(
      {
        name: Type.Optional(Type.String()),
        available: Type.Boolean(),
        efficiency: Type.Number(),
        unit: Type.Optional(Type.String()),
        policy: Type.Optional(POLICY_SCHEMA),
      },
      { additionalProperties: false },
    ),
    overridable: ["name", "available", "efficiency", "unit", "policy"],
    merge: { name: "replace", available: "replace", efficiency: "replace", unit: "replace", policy: "merge" },
    valueSet: {
      name: options.valueSet,
      fields: [
        { key: "available", valueType: "boolean", stateField: "available", contract: options.contract },
        {
          key: "efficiency",
          valueType: "number",
          stateField: "efficiency",
          unitField: "unit",
          policyField: "policy",
          contract: options.contract,
        },
      ],
      ...(options.input === undefined ? {} : { input: options.input }),
      ...(options.output === undefined ? {} : { output: options.output }),
    },
    ...(options.validate === undefined ? {} : { validate: options.validate }),
  };
}
