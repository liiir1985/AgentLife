/** Text embedding is an external capability, never a source of character knowledge. */
export interface EmbeddingProvider {
  embed(texts: readonly string[]): Promise<readonly (readonly number[])[]>;
}

/** Calls an already running service. Installing or running it is outside AgentLife. */
export class OllamaEmbeddingProvider implements EmbeddingProvider {
  constructor(
    private readonly endpoint: string,
    private readonly model: string,
  ) {}

  async embed(texts: readonly string[]): Promise<readonly (readonly number[])[]> {
    if (texts.length === 0) return [];
    const response = await fetch(this.endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: this.model, input: [...texts], truncate: false }),
    });
    if (!response.ok) throw new Error(`embedding service returned HTTP ${response.status}`);
    const payload: unknown = await response.json();
    const embeddings = typeof payload === "object" && payload !== null ? Reflect.get(payload, "embeddings") : undefined;
    if (!Array.isArray(embeddings) || embeddings.length !== texts.length)
      throw new Error("embedding service returned an unexpected vector count");
    const vectors = embeddings.map((candidate: unknown) => {
      if (
        !Array.isArray(candidate) ||
        candidate.length === 0 ||
        !candidate.every((value) => typeof value === "number" && Number.isFinite(value))
      )
        throw new Error("embedding service returned an invalid vector");
      return candidate as number[];
    });
    if (vectors.some((vector) => vector.length !== vectors[0]?.length))
      throw new Error("embedding service returned incompatible dimensions");
    return vectors;
  }
}

/** Deterministic semantic stand-in for tests and the script-driven demo. */
export class ScriptedEmbeddingProvider implements EmbeddingProvider {
  async embed(texts: readonly string[]): Promise<readonly (readonly number[])[]> {
    return texts.map((text) => {
      const vector = Array.from({ length: 32 }, () => 0);
      for (const word of text.toLocaleLowerCase().match(/[\p{Script=Han}]|[\p{L}\p{N}]+/gu) ?? []) {
        let hash = 2166136261;
        for (const character of word) hash = Math.imul(hash ^ character.codePointAt(0)!, 16777619);
        vector[(hash >>> 0) % vector.length]! += 1;
      }
      const magnitude = Math.hypot(...vector);
      return magnitude === 0 ? vector : vector.map((value) => value / magnitude);
    });
  }
}

export function cosineSimilarity(left: readonly number[], right: readonly number[]): number {
  if (left.length === 0 || left.length !== right.length) return 0;
  let dot = 0,
    leftSize = 0,
    rightSize = 0;
  for (let index = 0; index < left.length; index += 1) {
    dot += left[index]! * right[index]!;
    leftSize += left[index]! ** 2;
    rightSize += right[index]! ** 2;
  }
  return leftSize === 0 || rightSize === 0 ? 0 : dot / Math.sqrt(leftSize * rightSize);
}
