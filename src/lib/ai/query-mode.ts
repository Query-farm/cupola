export const AI_QUERY_MODES = [
  "unrestricted-sql",
  "semantic-preferred",
  "semantic-only",
] as const;

export type AIQueryMode = (typeof AI_QUERY_MODES)[number];

/** Existing installations retain the pre-policy behavior unless the user
 * explicitly chooses a more restrictive mode. */
export const DEFAULT_AI_QUERY_MODE: AIQueryMode = "unrestricted-sql";

const RAW_SQL_TOOLS = new Set(["run_sql", "render_chart"]);

export function normalizeAIQueryMode(value: unknown): AIQueryMode {
  return typeof value === "string" && (AI_QUERY_MODES as readonly string[]).includes(value)
    ? value as AIQueryMode
    : DEFAULT_AI_QUERY_MODE;
}
export function isAIQueryToolAllowed(name: string, mode: AIQueryMode): boolean {
  return mode !== "semantic-only" || !RAW_SQL_TOOLS.has(name);
}

export function toolsForAIQueryMode<T extends { name: string }>(tools: readonly T[], mode: AIQueryMode): T[] {
  return tools.filter((tool) => isAIQueryToolAllowed(tool.name, mode));
}

/** A dispatcher guard for stale conversations or malformed model output. Tool
 * filtering is the primary boundary, but execution must enforce it too. */
export function deniedAIQueryToolResult(name: string, mode: AIQueryMode): string | null {
  if (isAIQueryToolAllowed(name, mode)) return null;
  return JSON.stringify({
    ok: false,
    code: "ai_query_mode_tool_denied",
    mode,
    tool: name,
    message: `Tool '${name}' is unavailable in semantic-only mode. Use query_semantic_model or explain that the requested operation is not represented by the semantic model.`,
  });
}

export function aiQueryModePrompt(mode: AIQueryMode): string {
  if (mode === "semantic-only") {
    return [
      "### Query access mode: semantic only",
      "You may query data only through query_semantic_model. Raw SQL execution and SQL-backed chart queries are unavailable.",
      "Never invent SQL or silently bypass a semantic diagnostic. If the requested operation is not represented by the model, explain that limitation and the relevant diagnostic or missing semantic concept.",
    ].join("\n");
  }
  if (mode === "semantic-preferred") {
    return [
      "### Query access mode: semantic preferred",
      "Use query_semantic_model first whenever the requested concepts are represented by semantic tags.",
      "Use run_sql only for a genuinely unmodeled operation or after a semantic diagnostic establishes that the governed compiler cannot express the request. Never silently retry a failed semantic request as SQL.",
    ].join("\n");
  }
  return [
    "### Query access mode: unrestricted SQL",
    "Both query_semantic_model and run_sql are available. Choose the tool that best fits the request; use semantic definitions when their governed measures and dimensions are useful.",
  ].join("\n");
}
