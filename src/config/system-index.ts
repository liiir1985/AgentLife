import {
  itemTypeRef,
  outputRef,
  inputRef,
  type ItemSpec,
  type SystemCatalog,
  type OutputSpec,
  type ProcessSpec,
  type LoadedSystem,
  type InputSpec,
} from "./system-spec.js";

/**
 * Read-only index over the declarations of every registered system.
 *
 * All lookups are by qualified identity, so a rule can never reach a capability
 * by position, by load order or by a coincidentally equal short name.
 */
export interface SystemEntry<T> {
  readonly ref: string;
  readonly system: LoadedSystem;
  readonly declaration: T;
}

export class SystemIndex {
  private readonly items = new Map<string, SystemEntry<ItemSpec>>();
  private readonly inputs = new Map<string, SystemEntry<InputSpec>>();
  private readonly outputs = new Map<string, SystemEntry<OutputSpec>>();
  private readonly triggers = new Map<string, SystemEntry<string>>();
  private readonly processes = new Map<string, SystemEntry<ProcessSpec>>();
  /** State prefix to the trigger that re-evaluates rules under it, longest first. */
  private readonly propagation = new Map<string, { readonly trigger: string; readonly system: string }>();

  constructor(private readonly registry: SystemCatalog) {
    for (const system of registry.sorted()) {
      for (const declaration of system.spec.items) {
        const ref = itemTypeRef(system, declaration.kind);
        this.items.set(ref, { ref, system, declaration });
      }
      for (const declaration of system.spec.inputs) {
        const ref = inputRef(system, declaration.name);
        this.inputs.set(ref, { ref, system, declaration });
      }
      for (const declaration of system.spec.outputs) {
        const ref = outputRef(system, declaration.name);
        this.outputs.set(ref, { ref, system, declaration });
      }
      for (const name of system.spec.triggers) {
        const ref = `${system.spec.namespace}/${name}`;
        this.triggers.set(ref, { ref, system, declaration: name });
      }
      for (const declaration of system.spec.processes ?? []) {
        const ref = `${system.spec.namespace}/${declaration.name}`;
        this.processes.set(ref, { ref, system, declaration });
      }
      for (const declaration of system.spec.propagation ?? [])
        this.propagation.set(declaration.stateRef, {
          trigger: declaration.trigger,
          system: system.systemId,
        });
    }
  }

  /**
   * Trigger that re-evaluates rules after `stateRef` changed, or `undefined`
   * when the system declares no propagation for that prefix.
   */
  propagationTrigger(stateRef: string): { readonly trigger: string; readonly system: string } | undefined {
    let best: { readonly trigger: string; readonly system: string } | undefined;
    let bestLength = -1;
    for (const [prefix, entry] of this.propagation) {
      if (prefix.length <= bestLength) continue;
      if (stateRef !== prefix && !stateRef.startsWith(`${prefix}.`)) continue;
      best = entry;
      bestLength = prefix.length;
    }
    return best;
  }

  configType(ref: string): SystemEntry<ItemSpec> | undefined {
    return this.items.get(ref);
  }

  trigger(ref: string): SystemEntry<string> | undefined {
    return this.triggers.get(ref);
  }

  process(ref: string): SystemEntry<ProcessSpec> | undefined {
    return this.processes.get(ref);
  }

  /** Same decision for a capability already reduced to its owner ref and exposure list. */
  grants(exposedTo: readonly string[], ownerRef: string, reader: string): boolean {
    return ownerRef === reader || exposedTo.includes(reader);
  }

  system(ref: string): LoadedSystem | undefined {
    return this.registry.get(ref);
  }

  /** Registered systems in stable identity order. */
  systemsSorted(): readonly LoadedSystem[] {
    return this.registry.sorted();
  }

  all(ref: string): SystemEntry<unknown> | undefined {
    return (
      this.items.get(ref) ??
      this.inputs.get(ref) ??
      this.outputs.get(ref) ??
      this.triggers.get(ref) ??
      this.processes.get(ref)
    );
  }

  /** Unit declared for a input field; `null` for non-numeric fields. */
  viewFieldUnit(capability: SystemEntry<InputSpec>, field: string): string | null {
    return capability.declaration.units?.[field] ?? null;
  }
}
