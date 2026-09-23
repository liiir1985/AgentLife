import { Agent, type AgentTool } from "@earendil-works/pi-agent-core";
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
  Type,
  type Api,
  type JsonObject,
  type Model,
  type MutableModels,
  type Static,
} from "@earendil-works/pi-ai";
import { Value } from "typebox/value";
import type { SessionTrace } from "../diagnostics/session-trace.js";
import type { SessionCost } from "../diagnostics/session-cost.js";
import type {
  CognitiveDecision,
  CognitionInput,
  CognitionModelResult,
  IdleCommitment,
  IntentionStatus,
  ObservationRole,
} from "../simulation/types.js";

/** One cognition request as the runtime issues it. */
export interface CognitionModelPort {
  request(input: CognitionInput): Promise<CognitionModelResult>;
  /** Aborts the request with this identity; its result then reports "cancelled". */
  cancel(requestId: string): void;
}

export interface PiCognitionAgentOptions {
  readonly provider: string;
  readonly model: string;
  /** Used only when the provider is "faux": the tool arguments the scripted model returns. */
  readonly draft?: (input: CognitionInput) => unknown;
  readonly tokensPerSecond?: number;
  readonly trace?: SessionTrace;
  readonly sessionCost?: SessionCost;
}

/** One refused or discarded model response, kept for the diagnostics panel. */
export interface CognitionDiagnostic {
  readonly requestId: string;
  readonly detail: string;
}

/** Provider name of the deterministic scripted provider used by automatic tests and the demo. */
const FAUX_PROVIDER = "faux";

/** The only tool a cognition model may call; it can neither read the world nor write state. */
const SUBMIT_TOOL_NAME = "submit_cognitive_decision";

/** Long enough that a request stays in flight while a newer one supersedes it or its budget runs out. */
const NARRATIVE_TEXT = "the request narrates without submitting a decision ".repeat(12);

/** One intention change as the model expresses it. */
const IntentionChangeParameters = Type.Object(
  {
    intentionId: Type.Union([Type.String(), Type.Null()]),
    content: Type.String(),
    status: Type.Union([
      Type.Literal("active"),
      Type.Literal("paused"),
      Type.Literal("satisfied"),
      Type.Literal("abandoned"),
    ]),
  },
  { additionalProperties: false },
);

/** One body step as the model expresses it: references stay observer-local until the service maps them. */
const StepParameters = Type.Object(
  {
    action: Type.String(),
    target: Type.Optional(Type.String({ description: "要操作的对象引用名，取自观察行行首（如 o2）" })),
    destination: Type.Optional(Type.String({ description: "要前往的出口或地点引用名，取自观察行行首（如 o2）" })),
    inputs: Type.Optional(Type.Record(Type.String(), Type.String())),
  },
  { additionalProperties: false },
);

/**
 * What an entity with nothing to do right now wants to wait for.
 *
 * Both bounds count from `input.tick`, and the description says so: a model that
 * reads them as absolute tick numbers submits a wait that ends before it starts,
 * and the round is refused.
 */
const IdleParameters = Type.Object(
  {
    kind: Type.Union(
      [Type.Literal("external-event"), Type.Literal("review-condition"), Type.Literal("ongoing-activity")],
      { description: "等待的种类：外部事件、重审条件或持续活动" },
    ),
    detail: Type.String({ description: "这次等待或持续活动在做什么，一句话" }),
    event: Type.Union([Type.String(), Type.Null()], {
      description: "kind 为 external-event 时必填：可被观察到的事件名（如 utterance）",
    }),
    waitTicks: Type.Number({
      description: "从现在起最多等多少 tick（相对值，必须大于 0；不是 tick 号）",
    }),
    reviewInTicks: Type.Number({
      description: "从现在起过多少 tick 重新审视这次等待（相对值，必须大于 0 且不超过 waitTicks）",
    }),
  },
  { additionalProperties: false },
);

/**
 * The model-facing half of a cognitive decision. Every object is closed, so an
 * undeclared field is refused rather than silently carried into the state.
 */
const DecisionParameters = Type.Object(
  {
    attention: Type.Array(
      Type.String({ description: "当前主要关注的对象引用名，取自观察行行首（如 o2）；没有则留空数组" }),
    ),
    understanding: Type.String(),
    questions: Type.Array(Type.String()),
    persistence: Type.String(),
    intentionChanges: Type.Array(IntentionChangeParameters),
    speech: Type.Union([Type.String(), Type.Null()]),
    steps: Type.Array(StepParameters),
    idle: Type.Union([IdleParameters, Type.Null()]),
    consumedObservations: Type.Array(
      Type.String({ description: "本次决定实际用到的观察引用名，取自观察行行首（如 o2）" }),
    ),
    consideredIntentions: Type.Array(Type.String()),
  },
  { additionalProperties: false },
);

type SubmittedDecision = Static<typeof DecisionParameters>;

/** One request the runtime is currently waiting for. */
interface ActiveRequest {
  readonly requestId: string;
  readonly input: CognitionInput;
  agent: Agent | undefined;
  decision: CognitiveDecision | undefined;
  abortReason: "cancelled" | "timed-out" | undefined;
  /** True once a tool call of this request was refused, so its failure reads as a refusal. */
  refused: boolean;
}

/** The provider collection and model one request streams through. */
interface ModelTarget {
  readonly models: MutableModels;
  readonly model: Model<Api>;
}

/** The scripted provider never resolves; the runtime reports it as an unreadable provider. */
interface UnresolvedModel {
  readonly detail: string;
}

/**
 * The AI cognition runtime of one simulation.
 *
 * It owns at most one model conversation: a new request supersedes the last one,
 * the superseded request reports "cancelled", and only the tool call of the
 * request that is still active may become a decision. The registered surface is
 * exactly one tool, so a model can neither read the world nor write simulated
 * state; every refusal is a value the coordinator retries or records.
 */
export class PiCognitionAgent implements CognitionModelPort {
  /** The only tool this runtime ever registers. */
  readonly toolNames: readonly string[] = Object.freeze([SUBMIT_TOOL_NAME]);

  private builtinCatalog: Promise<MutableModels> | undefined;
  private active: ActiveRequest | undefined;
  private readonly diagnosticLog: CognitionDiagnostic[] = [];

  constructor(private readonly options: PiCognitionAgentOptions) {}

  /** Every refused or discarded response, in the order the runtime observed it. */
  get diagnostics(): readonly CognitionDiagnostic[] {
    return this.diagnosticLog;
  }

  /** Identity of the request still allowed to submit; `null` while nothing is in flight. */
  get activeRequestId(): string | null {
    return this.active?.requestId ?? null;
  }

  cancel(requestId: string): void {
    const request = this.active;
    if (request === undefined || request.requestId !== requestId) return;
    this.abort(request, "cancelled");
  }

  /** Runs one request. The promise settles with a result; a failure is never an exception. */
  async request(input: CognitionInput): Promise<CognitionModelResult> {
    this.supersede();
    try {
      return await this.attempt(input);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return { status: "failed", detail: `the cognition request failed: ${reason}`, decision: null };
    }
  }

  private async attempt(input: CognitionInput): Promise<CognitionModelResult> {
    const target = await this.modelTarget(input);
    if ("detail" in target) return { status: "failed", detail: target.detail, decision: null };

    const request: ActiveRequest = {
      requestId: input.requestId,
      input,
      agent: undefined,
      decision: undefined,
      abortReason: undefined,
      refused: false,
    };
    this.active = request;
    const identity = { entityId: input.characterId, roundId: input.roundId, requestId: input.requestId };

    const tool: AgentTool<typeof DecisionParameters> = {
      name: SUBMIT_TOOL_NAME,
      label: "Submit Cognitive Decision",
      description: "Submit this character's cognition result for the current request",
      parameters: DecisionParameters,
      execute: async (_toolCallId, submitted) => {
        const accepted = this.accept(request, submitted);
        return {
          content: [
            {
              type: "text" as const,
              text: accepted ? "decision accepted" : "decision discarded: this request is no longer the active one",
            },
          ],
          details: { accepted },
        };
      },
    };

    const agent = new Agent({
      initialState: {
        model: target.model,
        systemPrompt: input.systemPrompt,
        tools: [tool],
      },
      streamFn: (model, context, options) => {
        this.options.trace?.record("llm-request", { model: model.id, messages: context.messages }, identity);
        return target.models.streamSimple(model, context, options);
      },
      // Pi's own preflight coerces primitives and only rejects undeclared tools, so
      // the raw tool-call arguments are validated strictly here: a coerced or
      // over-specified call is blocked instead of becoming a decision.
      beforeToolCall: async (context) => {
        const raw: unknown = context.toolCall.arguments;
        if (context.toolCall.name !== SUBMIT_TOOL_NAME) {
          return this.refuse(request, `${context.toolCall.name} is not permitted for a cognition request`);
        }
        if (!Value.Check(DecisionParameters, raw)) {
          return this.refuse(
            request,
            `the submission does not match the required shape: ${JSON.stringify(raw ?? null)}`,
          );
        }
        if (this.active !== request) {
          return this.refuse(request, "the submission arrived after the request had been superseded");
        }
        return undefined;
      },
    });
    request.agent = agent;
    agent.subscribe((event) => {
      if (event.type === "message_end") {
        this.options.trace?.record("llm-message", { message: event.message }, identity);
        if (event.message.role === "assistant" && this.options.sessionCost !== undefined) {
          const charged = this.options.sessionCost.record(target.model, event.message.usage);
          this.options.trace?.record(
            "llm-usage",
            { model: target.model.id, usage: event.message.usage, ...charged },
            identity,
          );
        }
      } else if (event.type === "tool_execution_start")
        this.options.trace?.record(
          "llm-tool-start",
          { toolCallId: event.toolCallId, toolName: event.toolName, args: event.args },
          identity,
        );
      else if (event.type === "tool_execution_end")
        this.options.trace?.record(
          "llm-tool-end",
          { toolCallId: event.toolCallId, toolName: event.toolName, result: event.result, isError: event.isError },
          identity,
        );
    });

    const timer = setTimeout(() => this.abort(request, "timed-out"), Math.max(0, input.timeoutMs));
    let failure: unknown;
    try {
      await agent.prompt(cognitionRequestMessage(input));
    } catch (error) {
      failure = error;
    } finally {
      clearTimeout(timer);
      if (request.agent === agent) request.agent = undefined;
      if (this.active === request) this.active = undefined;
    }

    const status: CognitionModelResult["status"] =
      request.abortReason ?? (request.decision === undefined ? "failed" : "decided");
    this.options.trace?.record(
      "llm-transcript",
      {
        status,
        messages: agent.state.messages,
        failure: failure instanceof Error ? failure.message : failure === undefined ? null : String(failure),
      },
      identity,
    );
    return {
      status,
      detail: resultDetail(request, failure),
      decision: status === "decided" ? (request.decision ?? null) : null,
    };
  }

  /** A newer request replaces the previous one, which then settles as cancelled. */
  private supersede(): void {
    const request = this.active;
    if (request !== undefined) this.abort(request, "cancelled");
  }

  private abort(request: ActiveRequest, reason: "cancelled" | "timed-out"): void {
    if (request.abortReason === undefined) request.abortReason = reason;
    request.agent?.abort();
  }

  /**
   * Records one submission of the request that is still active. A submission that
   * arrives after the request was superseded, or after it already decided, is kept
   * as a diagnostic only.
   */
  private accept(request: ActiveRequest, submitted: SubmittedDecision): boolean {
    if (this.active !== request) {
      this.diagnose(request, "the submission arrived after the request had been superseded");
      return false;
    }
    if (request.decision !== undefined) {
      this.diagnose(request, "the request had already submitted a decision");
      return false;
    }
    request.decision = decisionFromSubmission(request.input, submitted);
    return true;
  }

  private refuse(request: ActiveRequest, detail: string): { block: true; reason: string } {
    request.refused = true;
    this.diagnose(request, detail);
    return { block: true, reason: detail };
  }

  private diagnose(request: ActiveRequest, detail: string): void {
    this.diagnosticLog.push({ requestId: request.requestId, detail });
  }

  private async modelTarget(input: CognitionInput): Promise<ModelTarget | UnresolvedModel> {
    if (this.options.provider === FAUX_PROVIDER) return this.scriptedTarget(input);

    const catalog = await this.catalog();
    const model = catalog.getModel(this.options.provider, this.options.model);
    if (model === undefined) return { detail: this.unresolvedDetail(catalog) };
    return { models: catalog, model };
  }

  /**
   * The scripted provider of automatic tests and the demo. Each request gets its
   * own instance, so two overlapping requests never share one response queue.
   */
  private scriptedTarget(input: CognitionInput): ModelTarget {
    const faux = fauxProvider({
      models: [{ id: this.options.model }],
      ...(this.options.tokensPerSecond === undefined ? {} : { tokensPerSecond: this.options.tokensPerSecond }),
    });
    const drafted: unknown = this.options.draft?.(input);
    faux.setResponses(
      drafted === undefined || drafted === null
        ? [fauxAssistantMessage(fauxText(NARRATIVE_TEXT))]
        : [
            fauxAssistantMessage(fauxToolCall(SUBMIT_TOOL_NAME, drafted as JsonObject), { stopReason: "toolUse" }),
            fauxAssistantMessage(fauxText(NARRATIVE_TEXT)),
          ],
    );
    const models = createModels();
    models.setProvider(faux.provider);
    return { models, model: faux.getModel() };
  }

  private async catalog(): Promise<MutableModels> {
    this.builtinCatalog ??= import("@earendil-works/pi-ai/providers/all").then(({ builtinModels }) => builtinModels());
    return this.builtinCatalog;
  }

  /** Names the exact half of the provider configuration that did not resolve. */
  private unresolvedDetail(catalog: MutableModels): string {
    if (catalog.getProvider(this.options.provider) === undefined) {
      return `unknown cognition provider "${this.options.provider}"`;
    }
    return `cognition provider "${this.options.provider}" has no model "${this.options.model}"`;
  }
}

/** Human-readable role of one observed object, as the authored prompt writes them. */
/** How a line that names no object is rendered: it may be read, never quoted. */
const NO_REFERENCE = "（无引用）";

const OBSERVATION_ROLE_LABELS: Record<ObservationRole, string> = {
  place: "地点",
  exit: "出口",
  character: "人物",
  item: "物品",
};

const INTENTION_STATUS_LABELS: Record<IntentionStatus, string> = {
  active: "进行中",
  paused: "暂停",
  satisfied: "已满足",
  abandoned: "已放弃",
};

/**
 * The user message of one request: the situation, everything the entity may use
 * - its attention, the observations admitted into Working Memory, its intentions
 * and the actions its body may run - and the bounds that bind the answer.
 */
export function cognitionRequestMessage(input: CognitionInput): string {
  const lines: string[] = [input.situation];
  if (input.attention.length > 0) lines.push(`注意：${input.attention.join("、")}`);
  if (input.observations.length > 0) {
    lines.push(
      [
        "观察（用行首的引用名指代对象）：",
        ...input.observations.map(
          (observation) =>
            `- ${observation.reference ?? NO_REFERENCE}` +
            `${observation.role === null ? "" : `（${OBSERVATION_ROLE_LABELS[observation.role]}）`}` +
            `（第 ${observation.tick} Tick）：${observation.text}`,
        ),
      ].join("\n"),
    );
  }
  if (input.intentions.length > 0) {
    lines.push(
      [
        "意图：",
        ...input.intentions.map(
          (intention) =>
            `- ${intention.intentionId}（${INTENTION_STATUS_LABELS[intention.status]}）：${intention.content}`,
        ),
      ].join("\n"),
    );
  }
  if (input.actions.length > 0) {
    lines.push(
      [
        "可执行动作（steps[].action 填写冒号前的动作名；仅同名动作需要使用完整名称）：",
        ...input.actions.map((action) => `- ${action.action}：${action.name}：${action.description}`),
      ].join("\n"),
    );
  }
  if (input.idle !== null) {
    lines.push(
      `当前空闲承诺：${input.idle.detail}（${input.idle.kind}，` +
        `${input.idle.reviewTick - input.tick} tick 后重审，最晚再等 ${input.idle.untilTick - input.tick} tick）`,
    );
  }
  lines.push(
    `边界：最多 ${input.maxSteps} 个动作步骤；一次空闲等待不得超过 ${input.idleWaitLimitTicks} tick。` +
      `空闲承诺的 waitTicks 与 reviewInTicks 都从现在算起，是相对 tick 数，不是 tick 号。`,
  );
  if (input.rejection !== null) {
    lines.push(`第 ${input.attempt} 次尝试：上一次提交被拒绝——${input.rejection}`);
  }
  return lines.join("\n\n");
}

/** Adds the identity the runtime, not the model, owns, and reads relative idle ticks as absolute ones. */
function decisionFromSubmission(input: CognitionInput, submitted: SubmittedDecision): CognitiveDecision {
  return {
    characterId: input.characterId,
    requestId: input.requestId,
    attention: [...submitted.attention],
    understanding: submitted.understanding,
    questions: [...submitted.questions],
    persistence: submitted.persistence,
    intentionChanges: submitted.intentionChanges.map((change) => ({
      intentionId: change.intentionId,
      content: change.content,
      status: change.status,
    })),
    speech: submitted.speech,
    steps: submitted.steps.map((step) => ({
      action: step.action,
      ...(step.target === undefined ? {} : { target: step.target }),
      ...(step.destination === undefined ? {} : { destination: step.destination }),
      ...(step.inputs === undefined ? {} : { inputs: { ...step.inputs } }),
    })),
    idle: idleFromSubmission(input, submitted.idle),
    consumedObservations: [...submitted.consumedObservations],
    consideredIntentions: [...submitted.consideredIntentions],
  };
}

function idleFromSubmission(input: CognitionInput, idle: SubmittedDecision["idle"]): IdleCommitment | null {
  if (idle === null) return null;
  return {
    kind: idle.kind,
    detail: idle.detail,
    event: idle.event,
    reviewTick: input.tick + idle.reviewInTicks,
    untilTick: input.tick + idle.waitTicks,
  };
}

/** A readable reason for every outcome that is not a decision. */
function resultDetail(request: ActiveRequest, failure: unknown): string {
  if (request.abortReason === "cancelled") return "the request was cancelled before a decision was accepted";
  if (request.abortReason === "timed-out") {
    return `the model did not submit a decision within ${request.input.timeoutMs} ms`;
  }
  if (request.decision !== undefined) return "the model submitted a cognitive decision";
  if (failure !== undefined) {
    return `the model request failed: ${failure instanceof Error ? failure.message : String(failure)}`;
  }
  return request.refused
    ? "the model submitted no decision: its tool call was refused"
    : "the model submitted no decision before the conversation ended";
}
