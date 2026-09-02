/**
 * Unit tests for the agent loop's PROGRESS callbacks — the ones the chat
 * surfaces use to keep an indicator on screen.
 *
 * The bug these lock in: a tool_use block's arguments stream for as long as
 * the model takes to write them (a long SQL statement, a Vega spec), but the
 * only signal the panels had was onToolCall, which fires after the whole SSE
 * stream has ended and the dispatch loop reaches the call. Combined with
 * onText clearing the "Thinking" indicator on the first text delta, that left
 * the panel showing nothing at all for the duration. onToolInputStart fires at
 * content_block_start to close that window.
 *
 * Telemetry is disabled via a localStorage stub so the turn runs through
 * runAgentTurnInner rather than a Sentry span tree.
 */
import { test, expect, describe, afterEach, beforeEach } from "bun:test";
import { runAgentTurn, type AgentCallbacks } from "../../src/lib/ai-agent";

const realFetch = globalThis.fetch;
const realLocalStorage = (globalThis as any).localStorage;

/** Encode Anthropic SSE events as the Messages API streams them. */
function sseStream(events: unknown[]): Response {
  const body = events.map((e) => `event: ${(e as any).type}\ndata: ${JSON.stringify(e)}\n\n`).join("");
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function textThenToolUse(sql: string) {
  return [
    { type: "message_start", message: { usage: { input_tokens: 10 } } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Let me check." } },
    { type: "content_block_stop", index: 0 },
    { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_1", name: "run_sql" } },
    // Split across deltas the way a long statement actually arrives.
    { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: `{"sql":"` } },
    { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: `${sql}"}` } },
    { type: "content_block_stop", index: 1 },
    { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 5 } },
  ];
}

const endTurn = [
  { type: "message_start", message: { usage: { input_tokens: 3 } } },
  { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Done." } },
  { type: "content_block_stop", index: 0 },
  { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } },
];

/** Records callbacks in order, as `name:detail` strings. */
function recorder(): { trace: string[]; callbacks: AgentCallbacks } {
  const trace: string[] = [];
  return {
    trace,
    callbacks: {
      onText: (chunk) => trace.push(`text:${chunk}`),
      onToolInputStart: (name) => trace.push(`toolInputStart:${name}`),
      onToolCall: (name) => trace.push(`toolCall:${name}`),
      onToolResult: (name) => trace.push(`toolResult:${name}`),
      onDone: () => trace.push("done"),
      onError: (e) => trace.push(`error:${e}`),
      onRetry: (m) => trace.push(`retry:${m ?? "null"}`),
    },
  };
}

beforeEach(() => {
  // aiTelemetry:false → no Sentry spans around the turn.
  (globalThis as any).localStorage = {
    getItem: (k: string) => (k === "vgi-frontend-settings" ? JSON.stringify({ aiTelemetry: false }) : null),
  };
});

afterEach(() => {
  globalThis.fetch = realFetch;
  (globalThis as any).localStorage = realLocalStorage;
});

describe("agent progress callbacks", () => {
  test("onToolInputStart fires when the tool's input starts streaming, before onToolCall", async () => {
    const responses = [sseStream(textThenToolUse("SELECT 1")), sseStream(endTurn)];
    globalThis.fetch = (async () => responses.shift()!) as unknown as typeof fetch;

    const { trace, callbacks } = recorder();
    await runAgentTurn(
      { apiKey: "key" }, "claude-sonnet-4-6", [{ role: "user", content: "hi" }], "system",
      async () => JSON.stringify({ ok: true }),
      callbacks,
    );

    expect(trace).toEqual([
      "text:Let me check.",
      "toolInputStart:run_sql",
      "toolCall:run_sql",
      "toolResult:run_sql",
      "text:Done.",
      "done",
    ]);
  });

  test("the input-start signal precedes the arguments finishing, not just the call", async () => {
    // Guards the whole point: the callback must arrive with the tool NAME
    // while the input JSON is still incomplete, so a surface can label the
    // wait ("Writing query") without waiting for the arguments.
    let sawStartBeforeStop = false;
    const responses = [sseStream(textThenToolUse("SELECT 1")), sseStream(endTurn)];
    globalThis.fetch = (async () => responses.shift()!) as unknown as typeof fetch;

    const { callbacks } = recorder();
    await runAgentTurn(
      { apiKey: "key" }, "claude-sonnet-4-6", [{ role: "user", content: "hi" }], "system",
      async () => JSON.stringify({ ok: true }),
      {
        ...callbacks,
        onToolInputStart: (name) => { sawStartBeforeStop = name === "run_sql"; },
        onToolCall: (_name, input) => {
          // By the time the call dispatches, the arguments have parsed —
          // which is exactly why onToolCall can't double as a progress signal.
          expect(input.sql).toBe("SELECT 1");
          expect(sawStartBeforeStop).toBe(true);
        },
      },
    );

    expect(sawStartBeforeStop).toBe(true);
  });

  test("a surface that omits onToolInputStart still runs the turn (callback is optional)", async () => {
    const responses = [sseStream(textThenToolUse("SELECT 1")), sseStream(endTurn)];
    globalThis.fetch = (async () => responses.shift()!) as unknown as typeof fetch;

    const { trace, callbacks } = recorder();
    const { onToolInputStart, ...withoutInputStart } = callbacks;
    await runAgentTurn(
      { apiKey: "key" }, "claude-sonnet-4-6", [{ role: "user", content: "hi" }], "system",
      async () => JSON.stringify({ ok: true }),
      withoutInputStart,
    );

    expect(trace).toContain("toolCall:run_sql");
    expect(trace).toContain("done");
  });
});
