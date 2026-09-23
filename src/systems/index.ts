import type { SystemSpec } from "../config/system-spec.js";
import { createBodySpec } from "./body-spec.js";
import { createCharacterSpec } from "./character-spec.js";
import { createCognitionSpec } from "./cognition-spec.js";
import { createInteractionSpec } from "./interaction-spec.js";
import { createPerceptionSpec } from "./perception-spec.js";
import { createWorldSpec } from "./world-spec.js";

/**
 * The system systems the first stage ships.
 *
 * Each system owns a namespace, so registering them in any order produces the
 * same registry: identity, not load order, decides visibility and ownership.
 */
export function createSystemSpecs(): readonly SystemSpec[] {
  return [
    createWorldSpec(),
    createBodySpec(),
    createCharacterSpec(),
    createInteractionSpec(),
    createPerceptionSpec(),
    createCognitionSpec(),
  ];
}

export {
  createBodySpec,
  createCharacterSpec,
  createCognitionSpec,
  createInteractionSpec,
  createPerceptionSpec,
  createWorldSpec,
};
