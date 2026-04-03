/** Tags that have dedicated UI rendering and should not appear in the raw TagsTable. */
const DISPLAY_HIDDEN_TAGS = ["example_queries", "description_md", "description_llm"];

/** Tags that should be excluded from AI agent tool outputs (not useful for LLMs). */
const AI_HIDDEN_TAGS = ["description_md", "example_queries"];

/** Filter out tags that have dedicated UI rendering (for TagsTable display). */
export function filterDisplayTags(tags?: Record<string, string> | null): Record<string, string> | null {
  if (!tags) return null;
  const filtered: Record<string, string> = {};
  for (const [k, v] of Object.entries(tags)) {
    if (!DISPLAY_HIDDEN_TAGS.includes(k)) filtered[k] = v;
  }
  return Object.keys(filtered).length > 0 ? filtered : null;
}

/** Filter tags for AI agent tool outputs (keeps description_llm, removes description_md and example_queries). */
export function filterTagsForAI(tags?: Record<string, string> | null): Record<string, string> | undefined {
  if (!tags) return undefined;
  const filtered: Record<string, string> = {};
  for (const [k, v] of Object.entries(tags)) {
    if (!AI_HIDDEN_TAGS.includes(k)) filtered[k] = v;
  }
  return Object.keys(filtered).length > 0 ? filtered : undefined;
}
