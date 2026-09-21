import { afterEach, describe, expect, test } from "bun:test";

import { runAgentTurn, type AgentCallbacks, type MessageParam, type ContentBlock } from "../../src/lib/ai-agent";

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

function sseStream(events: unknown[]): Response {
  const body = events.map((e) => `event: ${(e as any).type}\ndata: ${JSON.stringify(e)}\n\n`).join("");
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

const SIGNATURE = "EqQBCgIYAhIM1gbcDa9GJwZA2b3hGgxBdjrkzLoky3dl1pk";

/** A turn shaped like a real thinking model's: a thinking block (opened empty,
 *  filled by thinking_delta, closed by signature_delta) ahead of a tool_use. */
function thinkingToolTurn() {
  return sseStream([
    { type: "message_start", message: { usage: { input_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 100 } } },
    { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Check the table first." } },
    { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: SIGNATURE } },
    { type: "content_block_stop", index: 0 },
    { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_1", name: "lookup" } },
    { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: "{}" } },
    { type: "content_block_stop", index: 1 },
    { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 5 } },
  ]);
}

function finalTurn() {
  return sseStream([
    { type: "message_start", message: { usage: { input_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 10 } } },
    { type: "content_block_start", index: 0, content_block: { type: "redacted_thinking", data: "ENCRYPTED_BLOB" } },
    { type: "content_block_stop", index: 0 },
    { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Done." } },
    { type: "content_block_stop", index: 1 },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 3 } },
  ]);
}

function callbacks(over: Partial<AgentCallbacks> = {}): AgentCallbacks {
  return {
    onText: () => {}, onToolCall: () => {}, onToolResult: () => {},
    onDone: () => {}, onError: () => {}, ...over,
  };
}

const TOOLS = [{ name: "lookup", description: "Look up data", input_schema: { type: "object" } }];

describe("extended thinking", () => {
  test("thinking blocks are captured with their signature and echoed back unchanged", async () => {
    const requests: any[] = [];
    const responses = [thinkingToolTurn(), finalTurn()];
    globalThis.fetch = (async (_url: any, init: any) => {
      requests.push(JSON.parse(String(init?.body)));
      return responses.shift()!;
    }) as typeof fetch;

    const messages: MessageParam[] = [{ role: "user", content: "Count the rows" }];
    await runAgentTurn(
      { apiKey: "key" }, "claude-opus-5", messages, "System",
      async () => "ok", callbacks(), undefined, 20, TOOLS, 8_192, false, "high",
    );

    // Captured, not dropped: an assistant turn that loses its thinking block
    // is rejected by the API on every later request in the conversation.
    const assistant = messages.find((m) => m.role === "assistant")!;
    const thinking = (assistant.content as ContentBlock[])[0];
    expect(thinking.type).toBe("thinking");
    expect(thinking.thinking).toBe("Check the table first.");
    expect(thinking.signature).toBe(SIGNATURE);

    // ...and sent back verbatim on the follow-up request.
    const echoed = requests[1].messages.find((m: any) => m.role === "assistant").content[0];
    expect(echoed).toEqual({ type: "thinking", thinking: "Check the table first.", signature: SIGNATURE });
  });

  test("redacted_thinking survives as an opaque block", async () => {
    globalThis.fetch = (async () => finalTurn()) as unknown as typeof fetch;
    const messages: MessageParam[] = [{ role: "user", content: "Hi" }];
    await runAgentTurn(
      { apiKey: "key" }, "claude-opus-5", messages, "System",
      async () => "ok", callbacks(), undefined, 20, TOOLS, 8_192, false, "high",
    );
    const blocks = messages[1].content as ContentBlock[];
    expect(blocks[0]).toEqual({ type: "redacted_thinking", data: "ENCRYPTED_BLOB" });
    expect(blocks[1].type).toBe("text");
  });

  test("a thinking model sends adaptive thinking and the chosen effort", async () => {
    const requests: any[] = [];
    globalThis.fetch = (async (_url: any, init: any) => {
      requests.push(JSON.parse(String(init?.body)));
      return finalTurn();
    }) as typeof fetch;

    await runAgentTurn(
      { apiKey: "key" }, "claude-opus-5", [{ role: "user", content: "Hi" }], "System",
      async () => "ok", callbacks(), undefined, 20, TOOLS, 8_192, false, "xhigh",
    );
    expect(requests[0].thinking).toEqual({ type: "adaptive" });
    expect(requests[0].output_config).toEqual({ effort: "xhigh" });
  });

  test("Haiku sends neither field — both are a 400 there", async () => {
    const requests: any[] = [];
    globalThis.fetch = (async (_url: any, init: any) => {
      requests.push(JSON.parse(String(init?.body)));
      return finalTurn();
    }) as typeof fetch;

    await runAgentTurn(
      { apiKey: "key" }, "claude-haiku-4-5-20251001", [{ role: "user", content: "Hi" }], "System",
      async () => "ok", callbacks(), undefined, 20, TOOLS, 8_192, false, "max",
    );
    expect(requests[0].thinking).toBeUndefined();
    expect(requests[0].output_config).toBeUndefined();
  });

  test("cancelling mid-turn strips the dangling tool_use but keeps the thinking block", async () => {
    globalThis.fetch = (async () => thinkingToolTurn()) as unknown as typeof fetch;
    const abort = new AbortController();
    const messages: MessageParam[] = [{ role: "user", content: "Count the rows" }];

    await expect(runAgentTurn(
      { apiKey: "key" }, "claude-opus-5", messages, "System",
      // Abort while the tool runs: the turn unwinds with a tool_use that will
      // never get a tool_result.
      async () => { abort.abort(); throw new DOMException("Aborted", "AbortError"); },
      callbacks(), abort.signal, 20, TOOLS, 8_192, false, "high",
    )).rejects.toThrow();

    const blocks = messages[1].content as ContentBlock[];
    expect(blocks.some((b) => b.type === "tool_use")).toBe(false);
    // Kept: removing it would trade a recoverable cancel for a signature 400
    // on every later request.
    expect(blocks.some((b) => b.type === "thinking" && b.signature === SIGNATURE)).toBe(true);
  });
});
