/** Claude model pricing: [input $/M tokens, output $/M tokens] */
export const MODEL_PRICING: Record<string, [number, number]> = {
  "claude-haiku-4-5-20251001": [1, 5],
  "claude-sonnet-4-20250514": [3, 15],
  "claude-opus-4-20250514": [15, 75],
};

export function estimateCost(
  model: string,
  inputTokens: number,
  outputTokens: number,
): number {
  const [inRate, outRate] = MODEL_PRICING[model] || [3, 15];
  return (inputTokens * inRate + outputTokens * outRate) / 1_000_000;
}

export function formatCost(cost: number): string {
  return cost < 0.01 ? "<$0.01" : `~$${cost.toFixed(2)}`;
}
