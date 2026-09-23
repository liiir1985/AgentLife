import { fileURLToPath } from "node:url";
import { hashId } from "../config/canonical.js";
import { ContentPackLoader } from "../content/content-pack-loader.js";
import { CoreRuntime, packInput, type PublishResult } from "../config/core-runtime.js";
import type { RuntimeConfig } from "../config/config-builder.js";
import { createSystemSpecs } from "../systems/index.js";
import type { SimulationState } from "./types.js";

/**
 * The demo content pack and the canonical digest of a state it produced.
 *
 * Publication is what every entry point and every integration test starts from,
 * and the digest is how a resumed timeline is compared with the one it was saved
 * from: it is independent of run identity, so two timelines that did the same
 * thing hash the same even though each minted its own ids.
 */

export const DEMO_PACK_PATH = fileURLToPath(new URL("../../content/demo", import.meta.url));

/** Publishes the demo pack, failing loudly with the diagnostics that refused it. */
export async function publishDemoConfig(): Promise<{ readonly core: CoreRuntime; readonly config: RuntimeConfig }> {
  const core = new CoreRuntime();
  for (const system of createSystemSpecs()) {
    const registration = core.addSystem(system);
    if (registration.status !== "registered")
      throw new Error(`System ${system.namespace} did not load: ${JSON.stringify(registration.diagnostics, null, 2)}`);
  }
  const snapshot = await new ContentPackLoader().load(DEMO_PACK_PATH);
  const applied: PublishResult = core.publish({ root: packInput(snapshot) });
  if (applied.status !== "valid" || applied.config === undefined)
    throw new Error(`Demo pack did not apply: ${JSON.stringify(applied.diagnostics, null, 2)}`);
  return { core, config: applied.config };
}

/**
 * An event identity without the timeline that minted it.
 *
 * Every loaded timeline is a new timeline by design and stamps its own prefix, while
 * the events it names are the same events. A canonical view therefore compares which
 * tick an identity points at, not which timeline wrote the string around it.
 */
function canonicalEventId(eventId: string): string {
  const tick = /\/(\d+)\//.exec(eventId);
  return tick === null ? eventId : eventId.slice(tick.index);
}

/** A canonical view of what the simulation produced, independent of run identity. */
function semanticView(state: SimulationState): unknown {
  return {
    tick: state.tick,
    runMode: state.runMode,
    world: {
      entities: state.world.entities,
      environment: state.world.environment,
      processes: state.world.processes,
      events: state.world.events.map((event) => ({
        tick: event.tick,
        kind: event.kind,
        actor: event.actor,
        subject: event.subject,
        stateRef: event.stateRef,
        from: event.from,
        to: event.to,
      })),
    },
    characters: state.characters.characters,
    body: state.body.bodies,
    actions: state.actions.map((action) => ({
      entityId: action.entityId,
      action: action.action,
      status: action.status,
      stageIndex: action.stageIndex,
      stepIndex: action.stepIndex,
      target: action.target,
      destination: action.destination,
      outcome: action.outcome,
      waitingWorld: action.worldRequest !== null,
    })),
    perception: Object.fromEntries(
      Object.entries(state.perception.observers).map(([observer, value]) => [
        observer,
        {
          subjects: value.subjects,
          pending: value.pending.map((observation) => ({
            ...observation,
            eventId: observation.eventId === null ? null : canonicalEventId(observation.eventId),
          })),
          references: value.references,
          referencesUsed: value.referencesUsed,
          suppressedUntil: value.suppressedUntil,
          // A set of events already turned into observations: order carries nothing.
          processedEvents: value.processedEvents.map((eventId) => canonicalEventId(eventId)).sort(),
          materialVersion: value.materialVersion,
          attentionVersion: value.attentionVersion,
        },
      ]),
    ),
    memory: state.memory,
    cognition: state.cognition,
    behaviours: state.behaviours,
    barrier: state.barrier,
    failure: state.failure,
  };
}

export function digestOf(state: SimulationState): string {
  return hashId(semanticView(state)).slice(0, 16);
}
