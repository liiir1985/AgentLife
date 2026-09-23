import { calculateCost, type Api, type Model, type Usage } from "@earendil-works/pi-ai";
import type { ModelCostOverride } from "../config/system-config.js";

export interface ChargedUsage {
  readonly usd: number | null;
  readonly pricing: "configured" | "pi" | "faux" | "unknown";
}

/** Counts every completed model response in this TUI process, including retries. */
export class SessionCost {
  private total = 0;
  private unknownResponses = 0;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly configuredCost?: ModelCostOverride) {}

  get totalUsd(): number | null {
    return this.unknownResponses === 0 ? this.total : null;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  record(model: Model<Api>, usage: Usage): ChargedUsage {
    const tokens = usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
    if (tokens === 0)
      return {
        usd: 0,
        pricing: this.configuredCost !== undefined ? "configured" : model.provider === "faux" ? "faux" : "pi",
      };
    const piPriced =
      model.cost.input > 0 ||
      model.cost.output > 0 ||
      model.cost.cacheRead > 0 ||
      model.cost.cacheWrite > 0 ||
      (model.cost.tiers?.length ?? 0) > 0;
    if (!piPriced && model.provider !== "faux" && this.configuredCost === undefined) {
      this.unknownResponses += 1;
      this.emit();
      return { usd: null, pricing: "unknown" };
    }
    const pricing = this.configuredCost !== undefined ? "configured" : model.provider === "faux" ? "faux" : "pi";
    const priced = this.configuredCost === undefined ? model : { ...model, cost: this.configuredCost };
    const cost = calculateCost(priced, { ...usage, cost: { ...usage.cost } }).total;
    if (!Number.isFinite(cost)) {
      this.unknownResponses += 1;
      this.emit();
      return { usd: null, pricing: "unknown" };
    }
    this.total += cost;
    this.emit();
    return { usd: cost, pricing };
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}

export function formatSessionCost(cost: number | null): string {
  return cost === null ? "费用待配置" : `推理 $${cost.toFixed(6)}`;
}
