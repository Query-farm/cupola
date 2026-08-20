import { afterEach, describe, expect, test } from "bun:test";

import { runAgentTurn, type AgentCallbacks, type SystemPrompt } from "../../src/lib/ai-agent";
import type { AgentUsage } from "../../src/lib/ai-usage";

const realFetch = globalThis.fetch;
const realWindow = (globalThis as any).window;

function sseStream(events: unknown[]): Response {
  const body = events.map((event) => `event: ${(event as any).type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function toolTurn() {
  return sseStream([
    { type: "message_start", message: { usage: { input_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 1_000 } } },
    { type: "content_block_start", content_block: { type: "tool_use", id: "toolu_1", name: "lookup" } },
    { type: "content_block_delta", delta: { type: "input_json_delta", partial_json: "{}" } },
    { type: "content_block_stop" },
    { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 5 } },
  ]);
}

function finalTurn() {
  return sseStream([
    { type: "message_start", message: { usage: { input_tokens: 20, cache_read_input_tokens: 1_200, cache_creation_input_tokens: 50 } } },
    { type: "content_block_start", content_block: { type: "text", text: "" } },
    { type: "content_block_delta", delta: { type: "text_delta", text: "Done." } },
    { type: "content_block_stop" },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 3 } },
  ]);
}

function callbacks(onDone: (usage?: AgentUsage) => void): AgentCallbacks {
  return {
    onText: () => {},
    onToolCall: () => {},
    onToolResult: () => {},
    onDone,
    onError: () => {},
  };
}

afterEach(() => {
  globalThis.fetch = realFetch;
  if (realWindow === undefined) delete (globalThis as any).window;
  else (globalThis as any).window = realWindow;
});

describe("agent prompt caching and usage", () => {
  test("sends stable explicit breakpoints plus an advancing conversation breakpoint", async () => {
    const requests: any[] = [];
    const responses = [toolTurn(), finalTurn()];
    globalThis.fetch = (async (_url, init) => {
      requests.push(JSON.parse(String(init?.body)));
      return responses.shift()!;
    }) as typeof fetch;

    const system: SystemPrompt = [
      { text: "Stable authoring instructions", cacheControl: true },
      { text: "Current report: {\"title\":\"Example\"}", cacheControl: true },
    ];
    let completed: AgentUsage | undefined;
    await runAgentTurn(
      "key",
      "claude-sonnet-4-6",
      [{ role: "user", content: "Build it" }],
      system,
      async () => "ok",
      callbacks((usage) => { completed = usage; }),
      undefined,
      20,
      [{ name: "lookup", description: "Look up data", input_schema: { type: "object" } }],
      8_192,
      false,
    );

    expect(requests).toHaveLength(2);
    expect(requests[0].cache_control).toEqual({ type: "ephemeral" });
    expect(requests[0].tools[0].cache_control).toEqual({ type: "ephemeral" });
    expect(requests[0].system).toEqual([
      { type: "text", text: "Stable authoring instructions", cache_control: { type: "ephemeral" } },
      { type: "text", text: "Current report: {\"title\":\"Example\"}", cache_control: { type: "ephemeral" } },
    ]);
    expect(requests[1].messages.length).toBeGreaterThan(requests[0].messages.length);
    expect(completed).toEqual({
      inputTokens: 120,
      cacheReadTokens: 1_200,
      cacheWriteTokens: 1_050,
      outputTokens: 8,
      rounds: 2,
    });
  });

  test("returns accumulated usage when the tool-round limit is reached", async () => {
    globalThis.fetch = (async () => toolTurn()) as unknown as typeof fetch;
    let completed: AgentUsage | undefined;
    let error = "";
    const cb = callbacks((usage) => { completed = usage; });
    cb.onError = (message) => { error = message; };

    await runAgentTurn(
      "key",
      "claude-sonnet-4-6",
      [{ role: "user", content: "Build it" }],
      "Stable system",
      async () => "ok",
      cb,
      undefined,
      1,
      [{ name: "lookup", description: "Look up data", input_schema: { type: "object" } }],
      8_192,
      false,
    );

    expect(error).toContain("Too many tool rounds");
    expect(completed).toEqual({
      inputTokens: 100,
      cacheReadTokens: 0,
      cacheWriteTokens: 1_000,
      outputTokens: 5,
      rounds: 1,
    });
  });

  test("can opt into Anthropic cache-miss diagnostics without exposing them by default", async () => {
    (globalThis as any).window = { __cupolaAiCacheDiagnostics: true, __cupolaAiDebug: false };
    const requests: Array<{ headers: HeadersInit | undefined; body: any }> = [];
    const first = sseStream([
      { type: "message_start", message: { id: "msg_first", usage: { input_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 500 }, diagnostics: null } },
      { type: "content_block_start", content_block: { type: "tool_use", id: "toolu_1", name: "lookup" } },
      { type: "content_block_delta", delta: { type: "input_json_delta", partial_json: "{}" } },
      { type: "content_block_stop" },
      { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 1 } },
    ]);
    const second = sseStream([
      { type: "message_start", message: { id: "msg_second", usage: { input_tokens: 5, cache_read_input_tokens: 600, cache_creation_input_tokens: 20 }, diagnostics: { cache_miss_reason: null } } },
      { type: "content_block_start", content_block: { type: "text", text: "" } },
      { type: "content_block_delta", delta: { type: "text_delta", text: "Done." } },
      { type: "content_block_stop" },
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
    ]);
    const responses = [first, second];
    globalThis.fetch = (async (_url, init) => {
      requests.push({ headers: init?.headers, body: JSON.parse(String(init?.body)) });
      return responses.shift()!;
    }) as typeof fetch;
    const diagnostics: unknown[] = [];
    const cb = callbacks(() => {});
    cb.onCacheDiagnostics = (value) => diagnostics.push(value);

    await runAgentTurn(
      "key", "claude-sonnet-4-6", [{ role: "user", content: "Build it" }], "Stable system",
      async () => "ok", cb, undefined, 20,
      [{ name: "lookup", description: "Look up data", input_schema: { type: "object" } }],
      8_192, false,
    );

    expect(String((requests[0].headers as Record<string, string>)["anthropic-beta"])).toContain("cache-diagnosis-2026-04-07");
    expect(requests[0].body.diagnostics).toEqual({ previous_message_id: null });
    expect(requests[1].body.diagnostics).toEqual({ previous_message_id: "msg_first" });
    expect(diagnostics).toHaveLength(2);
    expect((diagnostics[1] as any).messageId).toBe("msg_second");
    expect((diagnostics[1] as any).cacheReadTokens).toBe(600);
  });
});
