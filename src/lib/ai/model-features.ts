/**
 * Per-model request features for the AI agent.
 *
 * Two fields on the Messages request are model-gated, and getting either wrong
 * is a 400 rather than a degradation — so, like `modelMaxOutputTokens`, this
 * table is keyed by exact model ID and an unknown model falls back to the
 * combination every Claude model accepts (send neither).
 *
 * `thinking` is the sharper edge, because its DEFAULT differs by model rather
 * than being absent everywhere: omitting it means "no thinking" on Sonnet 4.6
 * and Haiku 4.5, but Opus 5 and Sonnet 5 run adaptive thinking when it is
 * omitted. Cupola sent no `thinking` at all until these models were offered,
 * so adding them silently turned thinking on — and the SSE parser dropped the
 * resulting `thinking` blocks, which the API requires to be echoed back
 * unchanged. Sending the field explicitly makes the behaviour the same whether
 * or not a given model would have defaulted to it.
 *
 * `output_config.effort` is narrower: it is a 400 on Haiku 4.5 and Sonnet 4.5,
 * so it ships only with adaptive thinking.
 */

/** Thinking depth / token spend. Ordered cheapest to most thorough. */
export type AIEffort = "low" | "medium" | "high" | "xhigh" | "max";

export const AI_EFFORT_LEVELS: readonly AIEffort[] = ["low", "medium", "high", "xhigh", "max"];

/** Matches the API's own default, so pinning it explicitly is a no-op for the
 *  prompt cache while keeping the value stable if that default ever moves. */
export const DEFAULT_AI_EFFORT: AIEffort = "high";

/** Models that take `thinking: {type: "adaptive"}` and `output_config.effort`.
 *  Keep in sync with the model list in SettingsModal. */
const ADAPTIVE_THINKING_MODELS = new Set([
  "claude-opus-5",
  "claude-sonnet-5",
]);

export function supportsAdaptiveThinking(model: string): boolean {
  return ADAPTIVE_THINKING_MODELS.has(model);
}

/** Effort is only offered where thinking is — the dropdown hides otherwise. */
export function supportsEffort(model: string): boolean {
  return supportsAdaptiveThinking(model);
}

/** Coerce a persisted or user-supplied value into a valid level. */
export function normalizeEffort(value: unknown): AIEffort {
  return AI_EFFORT_LEVELS.includes(value as AIEffort) ? (value as AIEffort) : DEFAULT_AI_EFFORT;
}

/**
 * The thinking-related request fields for `model`, or an empty object when it
 * supports neither. Spread into the request body.
 *
 * `display` is deliberately left at its default (`"omitted"` on these models):
 * the blocks still arrive — and still must be echoed back — but carry no text,
 * so nothing extra streams to a UI that has no place to show it. Thinking is
 * billed identically either way, so this costs nothing but the summary.
 */
export function thinkingRequestFields(model: string, effort: AIEffort): Record<string, unknown> {
  if (!supportsAdaptiveThinking(model)) return {};
  return {
    thinking: { type: "adaptive" },
    output_config: { effort: normalizeEffort(effort) },
  };
}
