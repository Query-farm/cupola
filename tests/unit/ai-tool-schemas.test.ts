import { afterEach, describe, expect, test } from "bun:test";
import { CHART_TOOL, TOOLS, runAgentTurn, type Tool } from "../../src/lib/ai-agent";
import { REPORT_TOOLS } from "../../src/lib/reports/agent-tools";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("Anthropic tool schema compatibility", () => {
  test.each<{ surface: string; tools: Tool[] }>([
    { surface: "editor and terminal", tools: TOOLS },
    { surface: "Ask AI chat", tools: [...TOOLS, CHART_TOOL] },
    { surface: "report authoring", tools: REPORT_TOOLS },
  ])("$surface sends object schemas without top-level combinators", async ({ tools }) => {
    const requests: Array<{ tools: Tool[] }> = [];
    globalThis.fetch = (async (_url, init) => {
      requests.push(JSON.parse(String(init?.body)));
      const events = [
        { type: "message_start", message: { usage: { input_tokens: 1 } } },
        { type: "content_block_start", content_block: { type: "text", text: "" } },
        { type: "content_block_delta", delta: { type: "text_delta", text: "Done." } },
        { type: "content_block_stop" },
        { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
      ];
      return new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), {
        headers: { "content-type": "text/event-stream" },
      });
    }) as typeof fetch;

    const errors: string[] = [];
    let completed = false;
    await runAgentTurn(
      { apiKey: "test-key" },
      "claude-sonnet-4-6",
      [{ role: "user", content: "Hello" }],
      "System instructions",
      async () => "ok",
      {
        onText: () => {},
        onToolCall: () => {},
        onToolResult: () => {},
        onDone: () => { completed = true; },
        onError: (error) => { errors.push(error); },
      },
      undefined, 20, tools, 8_192, false,
    );

    expect(errors).toEqual([]);
    expect(completed).toBe(true);
    expect(requests).toHaveLength(1);
    expect(requests[0].tools.map((tool) => tool.name)).toEqual(tools.map((tool) => tool.name));
    expect(requests[0].tools.map((tool) => tool.name)).toContain("query_semantic_model");
    for (const tool of requests[0].tools) {
      expect(tool.input_schema.type).toBe("object");
      for (const keyword of ["oneOf", "allOf", "anyOf"]) {
        expect({ tool: tool.name, keyword, present: keyword in tool.input_schema })
          .toEqual({ tool: tool.name, keyword, present: false });
      }
    }
  });
});
