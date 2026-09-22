import type { DomainExtension } from "../config/extension.js";
import { createBodyExtension } from "./body-extension.js";
import { createCharacterExtension } from "./character-extension.js";
import { createWorldExtension } from "./world-extension.js";

/**
 * The domain extensions the first stage ships.
 *
 * Each extension owns a namespace, so registering them in any order produces the
 * same registry: identity, not load order, decides visibility and ownership.
 */
export function createDomainExtensions(): readonly DomainExtension[] {
  return [createWorldExtension(), createBodyExtension(), createCharacterExtension()];
}

export { createBodyExtension, createCharacterExtension, createWorldExtension };
