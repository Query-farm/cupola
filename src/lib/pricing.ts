import type { AgentUsage } from "./ai-usage";

/** Claude model pricing: [input $/M tokens, output $/M tokens] */
export const MODEL_PRICING: Record<string, [number, number]> = {
  "claude-haiku-4-5-20251001": [1, 5],
  "claude-sonnet-4-6": [3, 15],
  "claude-opus-4-8": [5, 25],
};

export function estimateCost(
  model: string,
  usage: AgentUsage,
): number {
  const [inRate, outRate] = MODEL_PRICING[model] || [3, 15];
  // Anthropic's five-minute cache writes are 1.25x base input and cache
  // reads are 0.1x. Keep each disjoint usage bucket separate so the estimate
  // matches the Messages API bill instead of treating cache activity as free.
  return (
    usage.inputTokens * inRate
    + usage.cacheWriteTokens * inRate * 1.25
    + usage.cacheReadTokens * inRate * 0.1
    + usage.outputTokens * outRate
  ) / 1_000_000;
}

export function formatCost(cost: number): string {
  return cost < 0.01 ? "<$0.01" : `~$${cost.toFixed(2)}`;
}
