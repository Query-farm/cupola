import { afterEach, describe, expect, test } from "bun:test";

import { runAgentTurn, type AgentCallbacks, type MessageParam, type SystemPrompt } from "../../src/lib/ai-agent";
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

function toolUseTurn(id: string, name: string) {
  return sseStream([
    { type: "message_start", message: { usage: { input_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 100 } } },
    { type: "content_block_start", content_block: { type: "tool_use", id, name } },
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
  test("sends a workspace header only when the credential specifies one", async () => {
    const capturedHeaders: Record<string, string>[] = [];
    globalThis.fetch = (async (_url, init) => {
      capturedHeaders.push(init?.headers as Record<string, string>);
      return finalTurn();
    }) as typeof fetch;

    const run = (workspaceId?: string) => runAgentTurn(
      { apiKey: "key", workspaceId },
      "claude-sonnet-4-6",
      [{ role: "user", content: "Hello" }],
      "Stable system",
      async () => "ok",
      callbacks(() => {}),
      undefined,
      20,
      [],
      8_192,
      false,
    );
    await run();
    await run("  wrkspc_example123  ");

    expect(capturedHeaders[0]["x-api-key"]).toBe("key");
    expect(capturedHeaders[0]["anthropic-workspace-id"]).toBeUndefined();
    expect(capturedHeaders[1]["anthropic-workspace-id"]).toBe("wrkspc_example123");
  });

  test("sends stable explicit breakpoints plus an advancing conversation breakpoint", async () => {
    const requests: any[] = [];
    const responses = [toolTurn(), finalTurn()];
    globalThis.fetch = (async (_url, init) => {
      requests.push(JSON.parse(String(init?.body)));
      return responses.shift()!;
    }) as typeof fetch;

    const system: SystemPrompt = [
      { text: "Stable authoring instructions", cacheControl: true },
      { text: "Stable tool conventions", cacheControl: true },
    ];
    let completed: AgentUsage | undefined;
    await runAgentTurn(
      { apiKey: "key" },
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
      { type: "text", text: "Stable tool conventions", cache_control: { type: "ephemeral" } },
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

  // The regression guard the other tests could not give: they assert that
  // breakpoints are PLACED, which stays true while the bytes behind them churn
  // and every read silently misses. Reads only land where the previous request
  // wrote, so what has to hold is that the earlier request's rendered prompt
  // reappears unchanged as a prefix of the later one. This is the assertion
  // that would have caught the report draft and the per-turn system prompt.
  test("a later turn reuses the earlier turn's rendered prefix byte-for-byte", async () => {
    const requests: any[] = [];
    const responses = [finalTurn(), finalTurn()];
    globalThis.fetch = (async (_url, init) => {
      requests.push(JSON.parse(String(init?.body)));
      return responses.shift()!;
    }) as typeof fetch;

    // cache_control is the one field that legitimately differs between
    // adjacent requests — the breakpoint advances with the conversation and a
    // previously-marked block is still a hit. Strip it before diffing.
    const strip = (value: unknown) =>
      JSON.parse(JSON.stringify(value, (key, inner) => (key === "cache_control" ? undefined : inner)));

    const system: SystemPrompt = [{ text: "Frozen instructions", cacheControl: true }];
    const tools = [{ name: "lookup", description: "Look up data", input_schema: { type: "object" } }];
    const messages: MessageParam[] = [{ role: "user", content: "First question" }];
    const turn = () => runAgentTurn(
      { apiKey: "key" }, "claude-sonnet-4-6", messages, system,
      async () => "ok", callbacks(() => {}), undefined, 20, tools, 8_192, false,
    );

    await turn();
    messages.push({ role: "user", content: "Second question" });
    await turn();

    expect(requests).toHaveLength(2);
    // tools and system render ahead of every message, so a byte moving here
    // re-processes the whole conversation at full price.
    expect(strip(requests[1].tools)).toEqual(strip(requests[0].tools));
    expect(strip(requests[1].system)).toEqual(strip(requests[0].system));
    // ...and the earlier messages must come back unedited, not merely present.
    const before = strip(requests[0].messages);
    const after = strip(requests[1].messages);
    expect(after.slice(0, before.length)).toEqual(before);
    expect(after.length).toBeGreaterThan(before.length);
  });

  // The chart case the generic prefix test can't reach: a render_chart result
  // carries an image, and the agent used to shed it from history two rounds
  // later — converting that tool_result to a string rewrote bytes inside the
  // cached prefix on every chart. It now happens only under context pressure.
  test("a chart's image stays in history, so the next round's prefix is unedited", async () => {
    const requests: any[] = [];
    const responses = [toolUseTurn("toolu_chart", "render_chart"), toolUseTurn("toolu_next", "lookup"), finalTurn()];
    globalThis.fetch = (async (_url, init) => {
      requests.push(JSON.parse(String(init?.body)));
      return responses.shift()!;
    }) as typeof fetch;
    const strip = (value: unknown) =>
      JSON.parse(JSON.stringify(value, (key, inner) => (key === "cache_control" ? undefined : inner)));

    await runAgentTurn(
      { apiKey: "key" }, "claude-opus-5", [{ role: "user", content: "Chart it" }], "System",
      async (name) => name === "render_chart"
        ? [{ type: "text", text: '{"ok":true}' }, { type: "image", source: { type: "base64", media_type: "image/png", data: "PNG" } }]
        : "ok",
      callbacks(() => {}), undefined, 20,
      [{ name: "render_chart", description: "Chart", input_schema: { type: "object" } },
       { name: "lookup", description: "Look up data", input_schema: { type: "object" } }],
      8_192, false,
    );

    expect(requests).toHaveLength(3);
    // requests[2] is the round the old code pruned before sending.
    const before = strip(requests[1].messages);
    const after = strip(requests[2].messages);
    expect(after.slice(0, before.length)).toEqual(before);
    const chartResult = after.find((m: any) => m.content?.[0]?.tool_use_id === "toolu_chart").content[0];
    expect(chartResult.content.some((part: any) => part.type === "image")).toBe(true);
  });

  test("the valve still sheds carried images when the conversation nears the window", async () => {
    const requests: any[] = [];
    const responses = [toolUseTurn("toolu_chart", "render_chart"), toolUseTurn("toolu_next", "lookup"), finalTurn()];
    globalThis.fetch = (async (_url, init) => {
      requests.push(JSON.parse(String(init?.body)));
      return responses.shift()!;
    }) as typeof fetch;

    // An unrecognised model gets the conservative 200k window (threshold
    // 100k); ~110k tokens of earlier context puts it over.
    await runAgentTurn(
      { apiKey: "key" }, "claude-unknown-model",
      [{ role: "user", content: "x".repeat(4 * 110_000) }], "System",
      async (name) => name === "render_chart"
        ? [{ type: "text", text: '{"ok":true}' }, { type: "image", source: { type: "base64", media_type: "image/png", data: "PNG" } }]
        : "ok",
      callbacks(() => {}), undefined, 20,
      [{ name: "render_chart", description: "Chart", input_schema: { type: "object" } },
       { name: "lookup", description: "Look up data", input_schema: { type: "object" } }],
      8_192, false,
    );

    const chartResult = requests[2].messages.find((m: any) => m.content?.[0]?.tool_use_id === "toolu_chart").content[0];
    expect(typeof chartResult.content).toBe("string");
    expect(chartResult.content).toContain("removed from history");
  });

  test("returns accumulated usage when the tool-round limit is reached", async () => {
    globalThis.fetch = (async () => toolTurn()) as unknown as typeof fetch;
    let completed: AgentUsage | undefined;
    let error = "";
    const cb = callbacks((usage) => { completed = usage; });
    cb.onError = (message) => { error = message; };

    await runAgentTurn(
      { apiKey: "key" },
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
      { apiKey: "key" }, "claude-sonnet-4-6", [{ role: "user", content: "Build it" }], "Stable system",
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
