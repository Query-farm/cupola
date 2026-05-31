/**
 * Parse the streamed `input_json_delta` text of a tool_use block.
 *
 * The Anthropic streaming API sends an EMPTY input string for a tool invoked
 * with no arguments — e.g. `list_tables`, whose schema has no properties. The
 * naive `JSON.parse("")` throws, and the old handler turned that into a bogus
 * `{ __parseError: "" }` input. That had two bad effects:
 *   1. the tool dispatcher returned an "invalid JSON" error instead of running
 *      the tool, and
 *   2. the malformed input was written into conversation history, so the model
 *      saw itself "passing" a `__parseError` argument to list_tables and kept
 *      retrying — the stuck "Looking up tables…" loop.
 *
 * Treating empty (or whitespace-only) input as `{}` fixes both. A genuinely
 * malformed non-empty payload still yields the `__parseError` sentinel so the
 * dispatcher can return a self-correctable error (better than a silent `{}`
 * that would run a tool with undefined arguments).
 *
 * Pure + dependency-free so it stays unit-testable in isolation.
 */
export interface ParsedToolInput {
  /** The parsed arguments object (or the __parseError sentinel on failure). */
  input: any;
  /** True when the payload was non-empty but failed to parse. */
  parseError: boolean;
}

export function parseStreamedToolInput(raw: string): ParsedToolInput {
  // No-argument tool calls stream "" (or nothing) — that's a valid empty call.
  if (raw.trim() === "") return { input: {}, parseError: false };
  try {
    return { input: JSON.parse(raw), parseError: false };
  } catch {
    return { input: { __parseError: raw }, parseError: true };
  }
}
