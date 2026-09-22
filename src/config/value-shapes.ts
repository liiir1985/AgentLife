import { Type } from "typebox";
import type { ConfigTypeDeclaration, DomainValidationInput, MergeStrategy } from "./extension.js";

/**
 * Value and channel shapes shared by every domain that stores declared values.
 *
 * The kernel does not know what a "stamina" or a "vision" is; it knows how a
 * definition that declares one contributes members to a family view and target.
 * A domain declares ownership of these shapes, may tighten their validation in
 * its own domain validator, and may mark the members it treats as contract
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

export interface ValueFamilyOptions {
  /** Config type name, e.g. `value`, `fact` or `channel`. */
  readonly kind: string;
  /** Family, view and target name, e.g. `values` or `channels`. */
  readonly family: string;
  /** Members that are core values: exactly one rule may write them. */
  readonly contract: boolean;
  readonly view?: { readonly exposedTo: readonly string[] };
  readonly target?: { readonly exposedTo: readonly string[] };
  /** Domain invariants for definitions of this type. */
  readonly validate?: (input: DomainValidationInput) => void;
}

/**
 * A scalar value definition: `id` names the value, `type` fixes its scalar kind,
 * `initial` is its declared starting state, and the optional `unit`, `policy` and
 * `allowedValues` state only the constraints the author actually wants.
 */
export function defineValueContainer(options: ValueFamilyOptions): ConfigTypeDeclaration {
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
    family: {
      name: options.family,
      members: [
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
      ...(options.view === undefined ? {} : { view: options.view }),
      ...(options.target === undefined ? {} : { target: options.target }),
    },
    ...(options.validate === undefined ? {} : { validate: options.validate }),
  };
}

/**
 * A sensory channel definition. One channel definition contributes two members:
 * `<id>.available` (does the channel currently carry anything) and
 * `<id>.efficiency` (how much of the stimulus survives), so a rule never has to
 * invent a separate value for a channel that is closed or degraded.
 */
export function defineChannelContainer(options: ValueFamilyOptions): ConfigTypeDeclaration {
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
    family: {
      name: options.family,
      members: [
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
      ...(options.view === undefined ? {} : { view: options.view }),
      ...(options.target === undefined ? {} : { target: options.target }),
    },
    ...(options.validate === undefined ? {} : { validate: options.validate }),
  };
}
