import type { RuntimeConfig } from "../config/config-builder.js";
import type { MergedItem } from "../config/config-merge.js";
import { itemsOf } from "./config-view.js";
import type { CapabilityTier, CharacterRecord, CharacterState, ControlKind, LifecycleStatus } from "./types.js";

/**
 * The character service: the authority over role instances.
 *
 * It owns one stable instance identity per character, the lifecycle status that
 * gates new plans, and the validated associations to the world entity, the body
 * configuration and — for a degraded entity — its behaviour tree and local view.
 * Capability tier, control source and the main flag are protected classification:
 * they are readable through the management view and by no runtime rule.
 */

export class CharacterService {
  constructor(private readonly config: RuntimeConfig) {}

  /** Creates every character instance of the config in stable order. */
  initialize(): CharacterState {
    const characters: Record<string, CharacterRecord> = {};
    for (const item of this.characterItems()) characters[item.ref] = this.recordOf(item);
    return Object.freeze({ version: "characters-1", characters: Object.freeze(characters) });
  }

  /**
   * Roles, in stable order. A character another character composes is a baseline
   * template: it describes what a role is made of and never becomes an instance.
   */
  private characterItems(): readonly MergedItem[] {
    const all = itemsOf(this.config, "agentlife.character/character");
    const composed = new Set(all.flatMap((item) => item.templates));
    return all.filter((item) => !composed.has(item.ref));
  }

  private recordOf(item: MergedItem): CharacterRecord {
    const tier = item.values.tier as CapabilityTier;
    const control = item.values.control;
    const kind =
      typeof control === "object" && control !== null
        ? (Reflect.get(control, "kind") as ControlKind | undefined)
        : undefined;
    return Object.freeze({
      entityId: item.ref,
      tier,
      control: kind ?? "none",
      main: item.values.main === true,
      lifecycle: "running",
      identityVersion: 1,
      homeLocation: String(item.values.homeLocation),
      bodyConfig: typeof item.values.bodyConfig === "string" ? item.values.bodyConfig : null,
      behaviourTree: typeof item.values.behaviourTree === "string" ? item.values.behaviourTree : null,
      localView: typeof item.values.localView === "string" ? item.values.localView : null,
    });
  }

  /** Characters in stable identity order. */
  sorted(state: CharacterState): readonly CharacterRecord[] {
    return Object.values(state.characters).sort((left, right) => (left.entityId < right.entityId ? -1 : 1));
  }

  get(state: CharacterState, entityId: string): CharacterRecord | undefined {
    return state.characters[entityId];
  }

  /** Characters that own a body instance. */
  bodyOwners(state: CharacterState): readonly string[] {
    return this.sorted(state)
      .filter((character) => character.bodyConfig !== null)
      .map((character) => character.entityId);
  }

  /** Degraded entities with a behaviour tree, in stable order. */
  behaviorOwners(state: CharacterState): readonly CharacterRecord[] {
    return this.sorted(state).filter((character) => character.behaviourTree !== null);
  }

  /**
   * Pausing stops new plans and new autonomous decisions only. Established body
   * actions, body processes and every objective world influence keep running.
   */
  pause(state: CharacterState, entityId: string): CharacterState {
    return this.withLifecycle(state, entityId, "paused");
  }

  resume(state: CharacterState, entityId: string): CharacterState {
    return this.withLifecycle(state, entityId, "running");
  }

  acceptsNewPlans(state: CharacterState, entityId: string): boolean {
    return state.characters[entityId]?.lifecycle === "running";
  }

  /** Management and diagnostics only: never a rule or behaviour tree input. */
  managementView(state: CharacterState): readonly {
    readonly entityId: string;
    readonly tier: CapabilityTier;
    readonly control: ControlKind;
    readonly main: boolean;
    readonly lifecycle: LifecycleStatus;
    readonly identityVersion: number;
  }[] {
    return this.sorted(state).map((character) => ({
      entityId: character.entityId,
      tier: character.tier,
      control: character.control,
      main: character.main,
      lifecycle: character.lifecycle,
      identityVersion: character.identityVersion,
    }));
  }

  private withLifecycle(state: CharacterState, entityId: string, lifecycle: LifecycleStatus): CharacterState {
    const character = state.characters[entityId];
    if (character === undefined) return state;
    return {
      version: bump(state.version),
      characters: Object.freeze({ ...state.characters, [entityId]: { ...character, lifecycle } }),
    };
  }
}

function bump(version: string): string {
  const separator = version.lastIndexOf("-");
  return `${version.slice(0, separator)}-${Number(version.slice(separator + 1)) + 1}`;
}
