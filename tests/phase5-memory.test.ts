import { describe, expect, it, vi } from "vitest";
import {
  OllamaEmbeddingProvider,
  OpenAICompatibleEmbeddingProvider,
  ScriptedEmbeddingProvider,
} from "../src/agent/embedding-provider.js";
import { idleDecision } from "../src/agent/scripted-cognition.js";
import { WorkingMemoryService } from "../src/simulation/memory-service.js";
import { checkSnapshot, decodeSnapshot, encodeSnapshot, snapshotOf } from "../src/simulation/save.js";
import type { CognitionInput, Observation } from "../src/simulation/types.js";
import { dispose, phase4Simulation } from "./helpers/phase4.js";

const FIRST = "agentlife.demo/player";
const SECOND = "agentlife.demo/companion";

function observation(tick: number, id: string, text: string, anchor: string): Observation {
  return {
    observationId: id,
    tick,
    channel: "sight",
    kind: "appearance",
    subject: {
      anchor,
      reference: "o1",
      role: "character",
      held: false,
      level: "detail",
      recognisable: true,
      description: text,
      identity: null,
    },
    eventId: null,
    text,
    salience: 3,
  };
}

describe("subjective memory", () => {
  it("uses the configured existing embedding HTTP service", async () => {
    const request = vi.fn(async (_url: unknown, _init?: RequestInit) =>
      Response.json({
        embeddings: [
          [1, 0],
          [0, 1],
        ],
      }),
    );
    vi.stubGlobal("fetch", request);
    try {
      const vectors = await new OllamaEmbeddingProvider("http://localhost:11434/api/embed", "embeddinggemma").embed([
        "灯",
        "人",
      ]);
      expect(vectors).toEqual([
        [1, 0],
        [0, 1],
      ]);
      expect(JSON.parse(String(request.mock.calls[0]?.[1]?.body))).toEqual({
        model: "embeddinggemma",
        input: ["灯", "人"],
        truncate: false,
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it("reads OpenAI-compatible vectors by their response indexes", async () => {
    const request = vi.fn(async (_url: unknown, _init?: RequestInit) =>
      Response.json({
        data: [
          { index: 1, embedding: [0, 1] },
          { index: 0, embedding: [1, 0] },
        ],
      }),
    );
    vi.stubGlobal("fetch", request);
    try {
      const vectors = await new OpenAICompatibleEmbeddingProvider(
        "http://127.0.0.1:1234/v1/embeddings",
        "text-embedding-embeddinggemma-300m",
      ).embed(["灯", "人"]);
      expect(vectors).toEqual([
        [1, 0],
        [0, 1],
      ]);
      expect(JSON.parse(String(request.mock.calls[0]?.[1]?.body))).toEqual({
        model: "text-embedding-embeddinggemma-300m",
        input: ["灯", "人"],
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it("encodes only admitted experiences, keeps characters separate and forgets expired recent memories", async () => {
    const service = new WorkingMemoryService();
    const embeddings = new ScriptedEmbeddingProvider();
    const source = observation(1, "seen-1", "我看见一位带着灯的人", "person-1");
    let state = service.create([FIRST, SECOND]);
    state = service.admitObservations(state, {
      characterId: FIRST,
      tick: 1,
      capacity: 2,
      observations: [source],
      references: {},
    }).state;
    const vector = (await embeddings.embed([source.text]))[0]!;
    const encoded = service.encode(state, {
      characterId: FIRST,
      tick: 1,
      references: ["o1"],
      text: source.text,
      vector,
      embeddingVersion: "demo-v1",
    });
    state = service.claimProfile(
      encoded.state,
      FIRST,
      { subjectReference: "o1", field: "name", value: "小灯", sourceReferences: ["o1"], confidence: 0.9 },
      encoded.trace.traceId,
    );
    expect(
      service.search(state, {
        characterId: FIRST,
        text: "灯",
        vector: (await embeddings.embed(["灯"]))[0]!,
        embeddingVersion: "demo-v1",
        threshold: 0.1,
        candidateLimit: 5,
        resultLimit: 2,
      }),
    ).toHaveLength(1);
    expect(
      service.search(state, {
        characterId: SECOND,
        text: "灯",
        vector,
        embeddingVersion: "demo-v1",
        threshold: 0,
        candidateLimit: 5,
        resultLimit: 2,
      }),
    ).toHaveLength(0);
    expect(service.recognize(state, FIRST, "person-1", 1, 0.6)?.name).toBe("小灯");
    expect(service.recognize(state, SECOND, "person-1", 1, 0.6)).toBeNull();
    state = service.expire(state, 5, 2, 3);
    expect(state.records[FIRST]?.recent).toHaveLength(0);
    expect(state.records[FIRST]?.archived).toHaveLength(1);
    expect(
      service.search(state, {
        characterId: FIRST,
        text: "灯",
        vector,
        embeddingVersion: "demo-v1",
        threshold: 0,
        candidateLimit: 5,
        resultLimit: 2,
      }),
    ).toHaveLength(0);
    expect(service.recognize(state, FIRST, "person-1", 1, 0.6)).toBeNull();
  });

  it("encodes an AI decision and consolidates at a later stable tick", async () => {
    let encoded = false;
    let encodedText = "";
    const simulation = await phase4Simulation({
      script: {
        fauxMemoryQuery: (input: CognitionInput) => (input.tick >= 7 ? encodedText : null),
        draft: (input: CognitionInput) => {
          if (input.tick >= 7)
            return {
              ...(idleDecision(input) as Record<string, unknown>),
              speech: "我还记得我们见面的地方。",
              idle: null,
              usedMemories: [`${SECOND}/memory-2`],
            };
          const first = input.observations.find((entry) => entry.reference !== null);
          const base = idleDecision(input) as Record<string, unknown>;
          if (encoded || first?.reference === null || first === undefined) return base;
          encoded = true;
          encodedText = `我记得${first.text}`;
          return {
            ...base,
            consumedObservations: [first.reference],
            memoryEncoding: [{ sourceReferences: [first.reference], text: encodedText }],
          };
        },
      },
    });
    try {
      const first = await simulation.runner.runTickToPublication();
      expect(first.status).toBe("completed");
      expect(simulation.runner.state().memory.records[SECOND]?.recent).toHaveLength(1);
      const saved = decodeSnapshot(
        encodeSnapshot(snapshotOf(simulation.runner.state(), "phase5-memory", simulation.config)),
      );
      expect(saved.ok).toBe(true);
      if (saved.ok) {
        expect(checkSnapshot(saved.snapshot, simulation.config).ok).toBe(true);
        expect(saved.snapshot.state.memory.records[SECOND]?.recent).toHaveLength(1);
      }
      for (let tick = 2; tick <= 6; tick += 1) await simulation.runner.runTickToPublication();
      expect(simulation.runner.state().memory.records[SECOND]?.longTerm.length).toBeGreaterThan(0);
      expect(simulation.runner.state().memory.records[SECOND]?.recent).toHaveLength(0);
      const beforeRecall = decodeSnapshot(
        encodeSnapshot(snapshotOf(simulation.runner.state(), "phase5-before-recall", simulation.config)),
      );
      expect(beforeRecall.ok).toBe(true);
      if (!beforeRecall.ok) throw new Error(beforeRecall.reason);
      expect(checkSnapshot(beforeRecall.snapshot, simulation.config).ok).toBe(true);
      expect(checkSnapshot(beforeRecall.snapshot, simulation.config, "a-different-representation").ok).toBe(false);
      expect(() =>
        simulation.runner.load({ ...beforeRecall.snapshot.state, embeddingVersion: "a-different-representation" }),
      ).toThrow(/embedding version/);
      simulation.runner.load(beforeRecall.snapshot.state);
      const recalled = await simulation.runner.runTickToPublication();
      expect(recalled.status).toBe("completed");
      expect(simulation.runner.state().memory.records[SECOND]?.longTerm[0]?.lastUsedTick).toBe(7);
    } finally {
      dispose(simulation);
    }
  });

  it("reconnects a subjective profile only through a newly encoded encounter", async () => {
    const service = new WorkingMemoryService();
    const embeddings = new ScriptedEmbeddingProvider();
    let state = service.create([FIRST]);
    state = service.admitObservations(state, {
      characterId: FIRST,
      tick: 1,
      capacity: 3,
      observations: [observation(1, "first-sighting", "一位熟人", "person-1")],
      references: {},
    }).state;
    const first = service.encode(state, {
      characterId: FIRST,
      tick: 1,
      references: ["o1"],
      text: "一位熟人",
      vector: (await embeddings.embed(["一位熟人"]))[0]!,
      embeddingVersion: "demo-v1",
    });
    state = service.claimProfile(
      first.state,
      FIRST,
      { subjectReference: "o1", field: "name", value: "阿灯", sourceReferences: ["o1"], confidence: 1 },
      first.trace.traceId,
    );
    state = service.confirmUsage(state, {
      characterId: FIRST,
      entryIds: state.records[FIRST]!.entries.map((entry) => entry.entryId),
    }).state;
    state = service.admitObservations(state, {
      characterId: FIRST,
      tick: 2,
      capacity: 3,
      observations: [observation(2, "second-sighting", "我又看见那位熟人", "person-2")],
      references: {},
    }).state;
    const second = service.encode(state, {
      characterId: FIRST,
      tick: 2,
      references: ["o1"],
      text: "我又看见那位熟人",
      vector: (await embeddings.embed(["我又看见那位熟人"]))[0]!,
      embeddingVersion: "demo-v1",
    });
    state = service.reconnectProfile(
      second.state,
      FIRST,
      second.state.records[FIRST]!.profiles[0]!.profileId,
      "o1",
      second.trace.traceId,
    );
    expect(service.recognize(state, FIRST, "person-1", 1, 0.5)).toBeNull();
    expect(service.recognize(state, FIRST, "person-2", 1, 0.5)?.name).toBe("阿灯");
  });

  it("lets the player explicitly keep a personally admitted observation", async () => {
    const simulation = await phase4Simulation();
    try {
      await simulation.runner.runTickToPublication();
      const reference = simulation.runner
        .state()
        .memory.records[FIRST]?.entries.find(
          (entry) => entry.kind === "observation" && entry.reference !== null,
        )?.reference;
      expect(reference).toBeTruthy();
      const beforeTick = simulation.runner.state().tick;
      const result = await simulation.runner.rememberPlayerObservation(
        FIRST,
        reference!,
        "我记得在这里第一次看见这片景象",
      );
      expect(result.ok, result.message).toBe(true);
      expect(simulation.runner.state().tick).toBe(beforeTick);
      expect(simulation.runner.state().memory.records[FIRST]?.recent).toHaveLength(1);
      expect(simulation.runner.state().memory.records[SECOND]?.recent).toHaveLength(0);
    } finally {
      dispose(simulation);
    }
  });

  it("keeps a valid cognitive decision when its optional memory candidate has no consumed source", async () => {
    const simulation = await phase4Simulation({
      script: {
        draft: (input: CognitionInput) => ({
          ...(idleDecision(input) as Record<string, unknown>),
          memoryEncoding: [{ sourceReferences: ["o99"], text: "没有实际来源的记忆" }],
        }),
      },
    });
    try {
      const result = await simulation.runner.runTickToPublication();
      expect(result.status).toBe("completed");
      expect(simulation.runner.state().memory.records[SECOND]?.recent).toHaveLength(0);
    } finally {
      dispose(simulation);
    }
  });
});
