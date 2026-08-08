/**
 * Per-model output-token ceilings.
 *
 * `max_tokens` was hardcoded at 4096 for every model and every surface. That is
 * far below what these models allow, and because the agent's requests are
 * streamed (`stream: true`), the usual reason to keep it low — SDK/HTTP
 * timeouts on long non-streaming responses — does not apply here.
 *
 * The cost of the low cap was silent truncation: a response that stops at the
 * limit comes back with `stop_reason: "max_tokens"`, and if it was midway
 * through a `tool_use` block (a large Vega-Lite spec from render_chart is the
 * usual culprit) the tool input is cut off. `parseStreamedToolInput` turns that
 * into a `__parseError` and the agent burns a round recovering.
 *
 * Setting `max_tokens` ABOVE a model's ceiling is a 400, so a user-configured
 * value is clamped per model rather than sent through.
 */

/** Maximum output tokens each offered model accepts. Keep in sync with the
 *  model list in SettingsModal. Haiku is the low one — 64K vs 128K — so a
 *  single shared constant would either waste headroom or 400 on Haiku. */
const MAX_OUTPUT_TOKENS: Record<string, number> = {
  "claude-haiku-4-5-20251001": 64_000,
  "claude-sonnet-4-6": 128_000,
  "claude-opus-4-8": 128_000,
};

/** Ceiling assumed for a model we don't have an entry for (e.g. one a user
 *  typed in, or a new ID added to settings without updating this table).
 *  Deliberately conservative: every current Claude model accepts at least
 *  this, so an unknown model degrades to "smaller than necessary" rather
 *  than to a 400. */
export const CONSERVATIVE_MAX_OUTPUT_TOKENS = 8_192;

/**
 * Default output cap for an agent turn.
 *
 * Chosen as a bound on cost rather than on capability: one turn can run up to
 * `aiMaxToolRounds` (default 20) requests, so the per-request cap multiplies.
 * 16K is ~4x the old limit — comfortably more than any chart spec or answer
 * needs — while keeping a runaway turn's worst case bounded. Users who want
 * more can raise `aiMaxTokens` in Settings; it is clamped per model.
 */
export const DEFAULT_AI_MAX_TOKENS = 16_384;

/** The largest `max_tokens` this model accepts. */
export function modelMaxOutputTokens(model: string): number {
  return MAX_OUTPUT_TOKENS[model] ?? CONSERVATIVE_MAX_OUTPUT_TOKENS;
}

/**
 * Clamp a requested `max_tokens` into what `model` actually accepts.
 *
 * Guards both ends: above the model ceiling the API returns 400, and a zero or
 * negative value (a corrupted setting) would also be rejected.
 */
export function clampMaxTokens(model: string, requested: number | undefined): number {
  const ceiling = modelMaxOutputTokens(model);
  if (!Number.isFinite(requested) || (requested as number) <= 0) {
    return Math.min(DEFAULT_AI_MAX_TOKENS, ceiling);
  }
  return Math.min(Math.floor(requested as number), ceiling);
}
