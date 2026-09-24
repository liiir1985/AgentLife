import { PiCognitionAgent } from "../../src/agent/cognition-agent.js";
import { idleDecision, type ScriptedDraft } from "../../src/agent/scripted-cognition.js";
import { FAUX_MODEL_TARGET } from "../../src/config/system-config.js";
import type { SessionTrace } from "../../src/diagnostics/session-trace.js";
import type { SessionCost } from "../../src/diagnostics/session-cost.js";
import type { CognitionInput } from "../../src/simulation/types.js";

/**
 * Test-side cognition.
 *
 * The scripted model goes through the real Pi adapter rather than around it, so a
 * test exercises the same submission, validation and refusal path the runtime uses.
 * Ticks are driven with `SimulationRunner.runTickToPublication`, which resolves a
 * barrier with that same port.
 */

export interface CognitionScript {
  readonly tokensPerSecond?: number;
  readonly draft?: ScriptedDraft;
  readonly fauxMemoryQuery?: (input: CognitionInput) => string | null;
  readonly trace?: SessionTrace;
  readonly sessionCost?: SessionCost;
}

/** A faux cognition model whose submissions are scripted by the test. */
export function scriptedModel(script: CognitionScript = {}): PiCognitionAgent {
  return new PiCognitionAgent({
    provider: FAUX_MODEL_TARGET.provider,
    model: FAUX_MODEL_TARGET.model,
    tokensPerSecond: script.tokensPerSecond ?? 100_000,
    draft: script.draft ?? idleDecision,
    ...(script.fauxMemoryQuery === undefined ? {} : { fauxMemoryQuery: script.fauxMemoryQuery }),
    ...(script.trace === undefined ? {} : { trace: script.trace }),
    ...(script.sessionCost === undefined ? {} : { sessionCost: script.sessionCost }),
  });
}
