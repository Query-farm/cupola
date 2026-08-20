import { describe, expect, test } from "bun:test";

import { cacheHitRate, totalInputTokens, type AgentUsage } from "../../src/lib/ai-usage";
import { estimateCost } from "../../src/lib/pricing";

const usage: AgentUsage = {
  inputTokens: 1_000,
  cacheReadTokens: 4_000,
  cacheWriteTokens: 2_000,
  outputTokens: 500,
  rounds: 3,
};

describe("cache-aware AI usage", () => {
  test("totals disjoint Anthropic input buckets", () => {
    expect(totalInputTokens(usage)).toBe(7_000);
    expect(cacheHitRate(usage)).toBeCloseTo(4 / 7);
  });

  test("prices uncached input, five-minute writes, reads, and output separately", () => {
    // Sonnet 4.6: input $3/M, write $3.75/M, read $0.30/M, output $15/M.
    expect(estimateCost("claude-sonnet-4-6", usage)).toBeCloseTo(0.0192);
  });
});
