import { Type } from "typebox";
import type { DomainExtension } from "../config/extension.js";
import { defineChannelContainer, defineValueContainer } from "../config/value-shapes.js";

/**
 * Body domain extension.
 *
 * The body domain owns two kinds of declared value and one contract value:
 *
 * - `value` definitions (stamina, load, ...) are content values: several rules
 *   may write them as long as they agree on one composition method, because the
 *   body runtime is the only authority that can judge the resulting state.
 * - `channel` definitions (vision, ...) are contract values: each channel
 *   contributes `<id>.available` and `<id>.efficiency`, and exactly one rule per
 *   member writes it, so perception can rely on a single, unambiguous producer.
 * - `cognitive-participation` is the contract value the cognition system reads
 *   before it may run at all; the body domain owns its vocabulary.
 *
 * Organs, capabilities, resources, modes and body processes are deliberately not
 * part of this vocabulary yet: they arrive with the body runtime that can define
 * and verify them.
 */

const PARTICIPATION_VOCABULARY: readonly string[] = ["allowed", "restricted", "forbidden"];

const PARTICIPATION_VIEW = Type.Object({ permission: Type.String() }, { additionalProperties: false });

/** Readers allowed to see body values and channels; owners are always allowed. */
const BODY_READERS: readonly string[] = ["agentlife.character/extension"];

export function createBodyExtension(): DomainExtension {
  return {
    name: "extension",
    namespace: "agentlife.body",
    version: "1.0.0",
    kernel: ">=1.0.0 <2.0.0",
    requires: [],
    configTypes: [
      defineValueContainer({
        kind: "value",
        family: "values",
        contract: false,
        view: { exposedTo: BODY_READERS },
        target: { exposedTo: [] },
      }),
      defineChannelContainer({
        kind: "channel",
        family: "channels",
        contract: true,
        view: { exposedTo: BODY_READERS },
        target: { exposedTo: [] },
      }),
    ],
    views: [
      {
        name: "cognitive-participation",
        fields: PARTICIPATION_VIEW,
        exposedTo: BODY_READERS,
      },
    ],
    triggers: ["tick-elapsed", "value-changed", "external-influence"],
    outputTargets: [
      {
        name: "cognitive-participation",
        valueType: "string",
        allowedValues: PARTICIPATION_VOCABULARY,
        exposedTo: [],
      },
    ],
  };
}
