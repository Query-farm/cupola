/** Anthropic reports the three input-token classes as disjoint counters. */
export interface AgentUsage {
  /** Uncached input processed at the model's base input rate. */
  inputTokens: number;
  /** Input served from prompt cache. */
  cacheReadTokens: number;
  /** Input written to the five-minute prompt cache. */
  cacheWriteTokens: number;
  outputTokens: number;
  /** Number of Messages API requests made for this agent turn. */
  rounds: number;
}

export function totalInputTokens(usage: AgentUsage): number {
  return usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
}

export function cacheHitRate(usage: AgentUsage): number {
  const total = totalInputTokens(usage);
  return total === 0 ? 0 : usage.cacheReadTokens / total;
}
