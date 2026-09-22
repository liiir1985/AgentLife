import {
  configTypeRef,
  targetRef,
  viewRef,
  type ConfigTypeDeclaration,
  type ExtensionRegistry,
  type OutputTargetDeclaration,
  type ProcessDeclaration,
  type RegisteredExtension,
  type ViewDeclaration,
} from "./extension.js";

/**
 * Read-only index over the declarations of every registered extension.
 *
 * All lookups are by qualified identity, so a rule can never reach a capability
 * by position, by load order or by a coincidentally equal short name.
 */
export interface Capability<T> {
  readonly ref: string;
  readonly extension: RegisteredExtension;
  readonly declaration: T;
}

export class ExtensionCapabilities {
  private readonly configTypes = new Map<string, Capability<ConfigTypeDeclaration>>();
  private readonly views = new Map<string, Capability<ViewDeclaration>>();
  private readonly targets = new Map<string, Capability<OutputTargetDeclaration>>();
  private readonly triggers = new Map<string, Capability<string>>();
  private readonly processes = new Map<string, Capability<ProcessDeclaration>>();

  constructor(private readonly registry: ExtensionRegistry) {
    for (const extension of registry.sorted()) {
      for (const declaration of extension.extension.configTypes) {
        const ref = configTypeRef(extension, declaration.kind);
        this.configTypes.set(ref, { ref, extension, declaration });
      }
      for (const declaration of extension.extension.views) {
        const ref = viewRef(extension, declaration.name);
        this.views.set(ref, { ref, extension, declaration });
      }
      for (const declaration of extension.extension.outputTargets) {
        const ref = targetRef(extension, declaration.name);
        this.targets.set(ref, { ref, extension, declaration });
      }
      for (const name of extension.extension.triggers) {
        const ref = `${extension.extension.namespace}/${name}`;
        this.triggers.set(ref, { ref, extension, declaration: name });
      }
      for (const declaration of extension.extension.processes ?? []) {
        const ref = `${extension.extension.namespace}/${declaration.name}`;
        this.processes.set(ref, { ref, extension, declaration });
      }
    }
  }

  configType(ref: string): Capability<ConfigTypeDeclaration> | undefined {
    return this.configTypes.get(ref);
  }

  trigger(ref: string): Capability<string> | undefined {
    return this.triggers.get(ref);
  }

  process(ref: string): Capability<ProcessDeclaration> | undefined {
    return this.processes.get(ref);
  }

  /** Same decision for a capability already reduced to its owner ref and exposure list. */
  grants(exposedTo: readonly string[], ownerRef: string, reader: string): boolean {
    return ownerRef === reader || exposedTo.includes(reader);
  }

  extension(ref: string): RegisteredExtension | undefined {
    return this.registry.get(ref);
  }

  /** Registered extensions in stable identity order. */
  extensionsSorted(): readonly RegisteredExtension[] {
    return this.registry.sorted();
  }

  all(ref: string): Capability<unknown> | undefined {
    return (
      this.configTypes.get(ref) ??
      this.views.get(ref) ??
      this.targets.get(ref) ??
      this.triggers.get(ref) ??
      this.processes.get(ref)
    );
  }

  /** Unit declared for a view field; `null` for non-numeric fields. */
  viewFieldUnit(capability: Capability<ViewDeclaration>, field: string): string | null {
    return capability.declaration.units?.[field] ?? null;
  }
}
