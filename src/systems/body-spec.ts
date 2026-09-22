import { Type } from "typebox";
import type { SystemSpec } from "../config/system-spec.js";
import { defineChannelContainer, defineValueContainer } from "../config/value-shapes.js";

/**
 * Body system system.
 *
 * The body system owns two kinds of declared value and one contract value:
 *
 * - `value` items (stamina, load, ...) are content values: several rules
 *   may write them as long as they agree on one combine method, because the
 *   body runtime is the only authority that can judge the resulting state.
 * - `channel` items (vision, ...) are contract values: each channel
 *   contributes `<id>.available` and `<id>.efficiency`, and exactly one rule per
 *   field writes it, so perception can rely on a single, unambiguous producer.
 * - `cognitive-participation` is the contract value the cognition system inputs
 *   before it may run at all; the body system owns its vocabulary.
 *
 * Organs, systemIndex, resources, modes and body processes are deliberately not
 * part of this vocabulary yet: they arrive with the body runtime that can define
 * and verify them.
 */

const PARTICIPATION_VOCABULARY: readonly string[] = ["allowed", "restricted", "forbidden"];

const PARTICIPATION_VIEW = Type.Object({ permission: Type.String() }, { additionalProperties: false });

/** Readers allowed to see body values and channels; owners are always allowed. */
const BODY_READERS: readonly string[] = ["agentlife.character"];

export function createBodySpec(): SystemSpec {
  return {
    name: "system",
    namespace: "agentlife.body",
    version: "1.0.0",
    kernel: ">=1.0.0 <2.0.0",
    requires: [],
    items: [
      defineValueContainer({
        kind: "value",
        valueSet: "values",
        contract: false,
        input: { exposedTo: BODY_READERS },
        output: { exposedTo: [] },
      }),
      defineChannelContainer({
        kind: "channel",
        valueSet: "channels",
        contract: true,
        input: { exposedTo: BODY_READERS },
        output: { exposedTo: [] },
      }),
    ],
    inputs: [
      {
        name: "cognitive-participation",
        fields: PARTICIPATION_VIEW,
        exposedTo: BODY_READERS,
      },
    ],
    triggers: ["tick-elapsed", "value-changed", "external-influence"],
    outputs: [
      {
        name: "cognitive-participation",
        valueType: "string",
        allowedValues: PARTICIPATION_VOCABULARY,
        exposedTo: [],
      },
    ],
  };
}
