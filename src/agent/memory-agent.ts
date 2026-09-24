import { Agent, type AgentTool } from "@earendil-works/pi-agent-core";
import { Type, type Api, type Model, type MutableModels } from "@earendil-works/pi-ai";
import { Value } from "typebox/value";
import type { MemoryTrace } from "../simulation/types.js";

export interface ConsolidationResult {
  readonly sourceIds: readonly string[];
  readonly text: string;
}

/** The agent receives only an already authorized, bounded candidate set. */
export interface MemoryAgentPort {
  rerank(query: string, candidates: readonly MemoryTrace[]): Promise<readonly string[]>;
  consolidate(characterId: string, candidates: readonly MemoryTrace[]): Promise<readonly ConsolidationResult[]>;
}

/** A predictable port for script-driven demonstrations and ordinary tests. */
export class ScriptedMemoryAgent implements MemoryAgentPort {
  async rerank(_query: string, candidates: readonly MemoryTrace[]): Promise<readonly string[]> {
    return candidates.map((candidate) => candidate.traceId);
  }

  async consolidate(_characterId: string, candidates: readonly MemoryTrace[]): Promise<readonly ConsolidationResult[]> {
    return candidates.length === 0
      ? []
      : [
          {
            sourceIds: candidates.map((candidate) => candidate.traceId),
            text: candidates.map((candidate) => candidate.text).join("；"),
          },
        ];
  }
}

const RerankParameters = Type.Object({ traceIds: Type.Array(Type.String()) }, { additionalProperties: false });
const ConsolidateParameters = Type.Object(
  {
    results: Type.Array(
      Type.Object({ sourceIds: Type.Array(Type.String()), text: Type.String() }, { additionalProperties: false }),
    ),
  },
  { additionalProperties: false },
);

/** Separate Pi agent for organizing existing memories; it has no state write tool. */
export class PiMemoryAgent implements MemoryAgentPort {
  private catalogPromise: Promise<MutableModels> | undefined;

  constructor(
    private readonly provider: string,
    private readonly modelId: string,
  ) {}

  async rerank(query: string, candidates: readonly MemoryTrace[]): Promise<readonly string[]> {
    if (candidates.length === 0) return [];
    const response = await this.ask(
      "Sort only the supplied personal memories by relevance. Submit only their traceIds.",
      JSON.stringify({
        query,
        candidates: candidates.map(({ traceId, text, formedTick }) => ({ traceId, text, formedTick })),
      }),
      "submit_memory_ranking",
      RerankParameters,
    );
    if (!Value.Check(RerankParameters, response)) throw new Error("memory agent returned no valid ranking");
    const allowed = new Set(candidates.map((candidate) => candidate.traceId));
    if (response.traceIds.some((id) => !allowed.has(id)))
      throw new Error("memory agent ranked a memory outside its candidates");
    return [...new Set(response.traceIds)];
  }

  async consolidate(characterId: string, candidates: readonly MemoryTrace[]): Promise<readonly ConsolidationResult[]> {
    if (candidates.length === 0) return [];
    const response = await this.ask(
      "Summarize only the supplied subjective memories. Preserve uncertainty and cite sourceIds. Submit bounded long-term results.",
      JSON.stringify({
        characterId,
        candidates: candidates.map(({ traceId, text, formedTick }) => ({ traceId, text, formedTick })),
      }),
      "submit_memory_consolidation",
      ConsolidateParameters,
    );
    if (!Value.Check(ConsolidateParameters, response)) throw new Error("memory agent returned no valid consolidation");
    if (response.results.length > candidates.length)
      throw new Error("memory agent returned more results than candidates");
    const allowed = new Set(candidates.map((candidate) => candidate.traceId));
    for (const result of response.results)
      if (result.sourceIds.length === 0 || result.sourceIds.some((id) => !allowed.has(id)) || result.text.trim() === "")
        throw new Error("memory agent consolidation has an invalid source");
    return response.results;
  }

  private async ask<T extends typeof RerankParameters | typeof ConsolidateParameters>(
    systemPrompt: string,
    message: string,
    toolName: string,
    parameters: T,
  ): Promise<unknown> {
    this.catalogPromise ??= import("@earendil-works/pi-ai/providers/all").then(({ builtinModels }) => builtinModels());
    const models = await this.catalogPromise;
    const model = models.getModel(this.provider, this.modelId) as Model<Api> | undefined;
    if (model === undefined) throw new Error(`memory model ${this.provider}/${this.modelId} is unavailable`);
    let answer: unknown;
    const tool: AgentTool<T> = {
      name: toolName,
      label: "Submit Memory Result",
      description: systemPrompt,
      parameters,
      execute: async (_toolCallId, submitted) => {
        answer = submitted;
        return { content: [{ type: "text" as const, text: "result accepted" }], details: { accepted: true } };
      },
    };
    const agent = new Agent({
      initialState: { model, systemPrompt, tools: [tool] },
      streamFn: (selected, context, options) => models.streamSimple(selected, context, options),
      beforeToolCall: async (context) => {
        if (context.toolCall.name !== toolName || !Value.Check(parameters, context.toolCall.arguments))
          return { block: true as const, reason: "memory agent submitted an invalid tool call" };
        return undefined;
      },
    });
    const timer = setTimeout(() => agent.abort(), 60_000);
    try {
      await agent.prompt(message);
    } finally {
      clearTimeout(timer);
    }
    return answer;
  }
}
