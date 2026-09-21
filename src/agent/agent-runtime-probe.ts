import { randomUUID } from "node:crypto";
import { Agent, type AgentEvent, type AgentTool } from "@earendil-works/pi-agent-core";
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
  Type,
  type FauxProviderHandle,
} from "@earendil-works/pi-ai";
import { Value } from "typebox/value";

/**
 * Identity of a single simulated request. A round may issue several requests, but
 * only the request that is still active may commit a result into simulated state.
 */
export interface AgentRunIdentity {
  readonly timelineId: string;
  readonly roundId: string;
  readonly requestId: string;
}

export type AgentRunStatus = "completed" | "cancelled" | "timed-out" | "failed";

export type AgentRunScript = "submit" | "invalid-submit" | "outside-capability" | "narrative";

export interface AgentRunOptions {
  readonly timelineId: string;
  readonly roundId: string;
  /** Wall-clock budget applied by the AgentLife wrapper, never by simulated state. */
  readonly timeoutMs?: number;
  readonly script?: AgentRunScript;
}

export interface AcceptedSubmission {
  readonly identity: AgentRunIdentity;
  readonly value: string;
}

export interface RejectedSubmission extends AcceptedSubmission {
  readonly reason: "stale-identity" | "invalid-arguments";
}

export interface AgentRunResult {
  readonly identity: AgentRunIdentity;
  readonly status: AgentRunStatus;
  readonly events: readonly AgentEvent[];
  readonly submissions: readonly AcceptedSubmission[];
  readonly rejections: readonly RejectedSubmission[];
}

const SUBMIT_TOOL_NAME = "submit_probe";

/** Stable comparison key for an identity triple. */
function identityKey(identity: AgentRunIdentity): string {
  return `${identity.timelineId}\u0000${identity.roundId}\u0000${identity.requestId}`;
}

const SubmitParameters = Type.Object({ value: Type.String() });

/** Narrative script long enough that streaming stays in flight for cancellation tests. */
const NARRATIVE_TEXT = "the probe narrates a decided outcome ".repeat(12);

/**
 * Thin adapter over the Pi agent that can only reach the deterministic probe tool.
 *
 * No filesystem, shell, database or world-write tool is ever registered, and every
 * submission is gated by the identity of the currently active request.
 */
export class AgentRuntimeProbe {
  readonly toolNames: readonly string[] = Object.freeze([SUBMIT_TOOL_NAME]);

  private readonly models = createModels();
  private readonly provider: FauxProviderHandle;
  private active: AgentRunIdentity | undefined;
  private activeKey: string | undefined;
  private agent: Agent | undefined;
  private abortReason: AgentRunStatus | undefined;
  private readonly accepted: AcceptedSubmission[] = [];
  private readonly rejected: RejectedSubmission[] = [];
  private readonly eventLog: AgentEvent[] = [];
  private readonly listeners: ((event: AgentEvent) => void)[] = [];

  constructor(options: { tokensPerSecond?: number } = {}) {
    this.provider = fauxProvider(
      options.tokensPerSecond === undefined ? {} : { tokensPerSecond: options.tokensPerSecond },
    );
    this.models.setProvider(this.provider.provider);
  }

  /** Every event observed across all runs, in emission order. */
  get events(): readonly AgentEvent[] {
    return this.eventLog;
  }

  /** Subscribe to live agent events. Returns an unsubscribe function. */
  onEvent(listener: (event: AgentEvent) => void): () => void {
    this.listeners.push(listener);
    return () => {
      const index = this.listeners.indexOf(listener);
      if (index >= 0) this.listeners.splice(index, 1);
    };
  }

  get submissions(): readonly AcceptedSubmission[] {
    return this.accepted;
  }

  get rejections(): readonly RejectedSubmission[] {
    return this.rejected;
  }

  get activeIdentity(): AgentRunIdentity | undefined {
    return this.active;
  }

  isActive(identity: AgentRunIdentity): boolean {
    return this.activeKey !== undefined && this.activeKey === identityKey(identity);
  }

  /**
   * Commit a value produced by a request. Only the active identity is accepted;
   * anything else is recorded as a diagnostic rejection.
   */
  submit(identity: AgentRunIdentity, value: string): "accepted" | "stale" {
    const submission: AcceptedSubmission = { identity, value };
    if (this.isActive(identity)) {
      this.accepted.push(submission);
      return "accepted";
    }
    this.rejected.push({ ...submission, reason: "stale-identity" });
    return "stale";
  }

  /** Abort the active run. The abort reason never touches simulated state. */
  cancel(): void {
    if (this.active !== undefined && this.abortReason === undefined) this.abortReason = "cancelled";
    this.agent?.abort();
  }

  async run(options: AgentRunOptions): Promise<AgentRunResult> {
    if (this.active !== undefined) this.cancel();
    const identity: AgentRunIdentity = {
      timelineId: options.timelineId,
      roundId: options.roundId,
      requestId: randomUUID(),
    };
    const key = identityKey(identity);
    this.active = identity;
    this.activeKey = key;
    this.abortReason = undefined;
    const events: AgentEvent[] = [];

    const tool: AgentTool<typeof SubmitParameters> = {
      name: SUBMIT_TOOL_NAME,
      label: "Submit Probe",
      description: "Submit a deterministic probe value for the active request",
      parameters: SubmitParameters,
      execute: async (_toolCallId, params) => {
        const outcome = this.submit(identity, params.value);
        const text: string = outcome === "accepted" ? `accepted:${params.value}` : `rejected:${params.value}`;
        return { content: [{ type: "text" as const, text }], details: { outcome } };
      },
    };

    switch (options.script ?? "submit") {
      case "submit":
        this.provider.setResponses([
          fauxAssistantMessage(fauxToolCall(SUBMIT_TOOL_NAME, { value: "ok" }), { stopReason: "toolUse" }),
          fauxAssistantMessage(fauxText("probe complete")),
        ]);
        break;
      case "invalid-submit":
        this.provider.setResponses([
          fauxAssistantMessage(fauxToolCall(SUBMIT_TOOL_NAME, { value: 42 }), { stopReason: "toolUse" }),
          fauxAssistantMessage(fauxText("probe recovered")),
        ]);
        break;
      case "outside-capability":
        this.provider.setResponses([
          fauxAssistantMessage(fauxToolCall("read_world_file", { path: "world.json" }), { stopReason: "toolUse" }),
          fauxAssistantMessage(fauxText("probe recovered")),
        ]);
        break;
      case "narrative":
        this.provider.setResponses([fauxAssistantMessage(fauxText(NARRATIVE_TEXT))]);
        break;
    }

    const agent = new Agent({
      initialState: {
        model: this.provider.getModel(),
        systemPrompt: "Deterministic probe agent. Use only the submit_probe tool.",
        tools: [tool],
      },
      streamFn: this.models.streamSimple.bind(this.models),
      // Pi's preflight validation coerces primitives (42 becomes "42" for a string
      // parameter) and only rejects undeclared tools, so the raw tool-call arguments
      // are checked strictly here: a mis-typed or unexpected call is blocked before
      // it can reach simulated state.
      beforeToolCall: async (context) => {
        const raw: unknown = context.toolCall.arguments;
        if (context.toolCall.name === SUBMIT_TOOL_NAME && Value.Check(SubmitParameters, raw)) return undefined;
        this.rejected.push({
          identity,
          value: JSON.stringify(raw ?? null),
          reason: "invalid-arguments",
        });
        return { block: true, reason: `${context.toolCall.name} is not permitted for this request` };
      },
    });
    this.agent = agent;
    agent.subscribe((event) => {
      events.push(event);
      this.eventLog.push(event);
      for (const listener of [...this.listeners]) listener(event);
    });

    const timer =
      options.timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            if (this.abortReason === undefined) this.abortReason = "timed-out";
            agent.abort();
          }, options.timeoutMs);

    let failure: unknown;
    try {
      await agent.prompt("run probe");
    } catch (error) {
      failure = error;
    } finally {
      clearTimeout(timer);
      if (this.agent === agent) this.agent = undefined;
    }

    const status: AgentRunStatus = this.abortReason ?? (failure === undefined ? "completed" : "failed");
    if (this.activeKey === key) {
      this.active = undefined;
      this.activeKey = undefined;
    }
    const mine = (candidate: AcceptedSubmission): boolean => identityKey(candidate.identity) === key;
    return {
      identity,
      status,
      events,
      submissions: this.accepted.filter(mine),
      rejections: this.rejected.filter(mine),
    };
  }
}
