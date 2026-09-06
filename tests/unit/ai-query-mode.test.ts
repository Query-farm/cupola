import { describe, expect, test } from "bun:test";
import {
  DEFAULT_AI_QUERY_MODE,
  deniedAIQueryToolResult,
  normalizeAIQueryMode,
  toolsForAIQueryMode,
} from "../../src/lib/ai/query-mode";

const tools = [
  { name: "query_semantic_model" },
  { name: "run_sql" },
  { name: "render_chart" },
  { name: "describe_table" },
];

describe("AI query access policy", () => {
  test("uses unrestricted SQL as the backward-compatible default", () => {
    expect(DEFAULT_AI_QUERY_MODE).toBe("unrestricted-sql");
    expect(normalizeAIQueryMode(undefined)).toBe("unrestricted-sql");
    expect(normalizeAIQueryMode("future-mode")).toBe("unrestricted-sql");
    expect(toolsForAIQueryMode(tools, "unrestricted-sql")).toEqual(tools);
  });

  test("semantic preferred retains both governed and raw query tools", () => {
    expect(toolsForAIQueryMode(tools, "semantic-preferred").map((tool) => tool.name))
      .toEqual(["query_semantic_model", "run_sql", "render_chart", "describe_table"]);
  });

  test("semantic only removes every interactive raw-SQL execution path", () => {
    expect(toolsForAIQueryMode(tools, "semantic-only").map((tool) => tool.name))
      .toEqual(["query_semantic_model", "describe_table"]);
  });

  test("the executor guard rejects a stale raw-SQL tool call", () => {
    expect(JSON.parse(deniedAIQueryToolResult("run_sql", "semantic-only")!)).toEqual({
      ok: false,
      code: "ai_query_mode_tool_denied",
      mode: "semantic-only",
      tool: "run_sql",
      message: "Tool 'run_sql' is unavailable in semantic-only mode. Use query_semantic_model or explain that the requested operation is not represented by the semantic model.",
    });
    expect(deniedAIQueryToolResult("query_semantic_model", "semantic-only")).toBeNull();
  });
});
