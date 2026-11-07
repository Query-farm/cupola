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

test('transport progress reports connection and streamed tool size without exposing contents', async () => {
  const responses = [sseStream(textThenToolUse('SELECT 1')), sseStream(endTurn)];
  globalThis.fetch = (async () => responses.shift()!) as unknown as typeof fetch;
  const progress: unknown[] = [];
  await runAgentTurn({ apiKey: 'key' }, 'claude-sonnet-4-6', [{ role: 'user', content: 'hi' }], 'system', async () => 'ok', {
    ...recorder().callbacks, onProgress: event => progress.push(event),
  });
  expect(progress).toContainEqual({ stage: 'connecting' });
  expect(progress).toContainEqual({ stage: 'connected' });
  expect(progress).toContainEqual({ stage: 'tool_input', tool: 'run_sql', characters: '{"sql":"SELECT 1"}'.length });
  expect(JSON.stringify(progress)).not.toContain('SELECT 1');
});

test('a truncated stream never executes its tool or reports success', async () => {
  globalThis.fetch = (async () => sseStream(textThenToolUse('SELECT 1').slice(0, -1))) as unknown as typeof fetch;
  let executed = false;
  const { callbacks, trace } = recorder();
  await expect(runAgentTurn({ apiKey: 'key' }, 'claude-sonnet-4-6', [{ role: 'user', content: 'hi' }], 'system', async () => { executed = true; return 'ok'; }, callbacks)).rejects.toThrow('before the AI response finished');
  expect(executed).toBe(false);
  expect(trace).not.toContain('done');
});

test('provider errors within a successful HTTP stream are surfaced', async () => {
  globalThis.fetch = (async () => sseStream([{ type: 'error', error: { message: 'Overloaded' } }])) as unknown as typeof fetch;
  await expect(runAgentTurn({ apiKey: 'key' }, 'claude-sonnet-4-6', [{ role: 'user', content: 'hi' }], 'system', async () => 'ok', recorder().callbacks)).rejects.toThrow('AI stream error: Overloaded');
});

test('complete tool inputs can be reviewed before EOF and survive a later stream error without executing', async () => {
  const input = { summary: 'Rewrite the report', changes: { source: '# Report\n\n' + 'A long report section.\n'.repeat(10_000) } };
  const raw = JSON.stringify(input);
  const events = [
    { type: 'content_block_start', content_block: { type: 'tool_use', id: 'proposal', name: 'propose_report_edit' } },
    ...Array.from({ length: Math.ceil(raw.length / 1024) }, (_, i) => ({ type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: raw.slice(i * 1024, (i + 1) * 1024) } })),
    { type: 'content_block_stop' },
    { type: 'error', error: { message: 'Timed out' } },
  ];
  globalThis.fetch = (async () => sseStream(events)) as unknown as typeof fetch;
  const reviewed: unknown[] = [];
  let executions = 0;
  await expect(runAgentTurn({ apiKey: 'key' }, 'claude-sonnet-4-6', [{ role: 'user', content: 'Rewrite' }], 'system', async () => { executions++; return 'ok'; }, {
    ...recorder().callbacks,
    onToolInputComplete: (name, value) => { reviewed.push({ name, input: value }); },
  })).rejects.toThrow('Timed out');
  expect(reviewed).toEqual([{ name: 'propose_report_edit', input }]);
  expect(executions).toBe(0);
});

test('a partial JSON input is never offered for review, even when its block stops', async () => {
  const events = textThenToolUse('SELECT 1');
  events.splice(5, 1); // Only the opening JSON fragment remains.
  globalThis.fetch = (async () => sseStream(events.slice(0, -1))) as unknown as typeof fetch;
  const reviewed: unknown[] = [];
  await expect(runAgentTurn({ apiKey: 'key' }, 'claude-sonnet-4-6', [{ role: 'user', content: 'hi' }], 'system', async () => 'ok', {
    ...recorder().callbacks, onToolInputComplete: (_name, input) => { reviewed.push(input); },
  })).rejects.toThrow('before the AI response finished');
  expect(reviewed).toEqual([]);
});

test('review callbacks preserve input identity for normal dispatch and do not execute tools early', async () => {
  const responses = [sseStream(textThenToolUse('SELECT 1')), sseStream(endTurn)];
  globalThis.fetch = (async () => responses.shift()!) as unknown as typeof fetch;
  let reviewed: unknown;
  let executions = 0;
  await runAgentTurn({ apiKey: 'key' }, 'claude-sonnet-4-6', [{ role: 'user', content: 'hi' }], 'system', async (_name, input) => {
    expect(input).toBe(reviewed); executions++; return 'ok';
  }, {
    ...recorder().callbacks, onToolInputComplete: (_name, input) => { expect(executions).toBe(0); reviewed = input; },
  });
  expect(executions).toBe(1);
});

test('stopping a stalled reader cancels it promptly without transport abort support', async () => {
  let connected!: () => void;
  const ready = new Promise<void>(resolve => { connected = resolve; });
  let cancelled = false;
  globalThis.fetch = (async () => new Response(new ReadableStream({ cancel() { cancelled = true; } }))) as unknown as typeof fetch;
  const abort = new AbortController();
  const turn = runAgentTurn({ apiKey: 'key' }, 'claude-sonnet-4-6', [{ role: 'user', content: 'hi' }], 'system', async () => 'ok', {
    ...recorder().callbacks, onProgress: event => { if (event.stage === 'connected') connected(); },
  }, abort.signal);
  await ready;
  abort.abort();
  await expect(turn).rejects.toThrow('Aborted');
  expect(cancelled).toBe(true);
});

test('message_stop finishes a response even if its HTTP stream stays open', async () => {
  let cancelled = false;
  globalThis.fetch = (async () => new Response(new ReadableStream({
    async start(controller) {
      controller.enqueue(new TextEncoder().encode(await sseStream([...endTurn, { type: 'message_stop' }]).text()));
    },
    cancel() { cancelled = true; },
  }))) as unknown as typeof fetch;
  const { callbacks, trace } = recorder();
  await runAgentTurn({ apiKey: 'key' }, 'claude-sonnet-4-6', [{ role: 'user', content: 'hi' }], 'system', async () => 'ok', callbacks);
  expect(trace).toContain('done');
  expect(cancelled).toBe(true);
});

test('an edit cut off by the output limit asks for a smaller targeted proposal', async () => {
  const responses = [sseStream([
    { type: 'content_block_start', content_block: { type: 'tool_use', id: 'proposal', name: 'propose_report_edit' } },
    { type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: '{"summary":"Rewrite","changes":{"source":"' } },
    { type: 'content_block_stop' },
    { type: 'message_delta', delta: { stop_reason: 'max_tokens' }, usage: { output_tokens: 100 } },
  ]), sseStream(endTurn)];
  const requests: any[] = [];
  globalThis.fetch = (async (_url: unknown, init: RequestInit) => { requests.push(JSON.parse(String(init.body))); return responses.shift()!; }) as unknown as typeof fetch;
  let executed = false;
  await runAgentTurn({ apiKey: 'key' }, 'claude-sonnet-4-6', [{ role: 'user', content: 'Rewrite' }], 'system', async () => { executed = true; return 'ok'; }, recorder().callbacks);
  const result = requests[1].messages.at(-1).content[0];
  expect(result.is_error).toBe(true);
  expect(result.content).toContain('output token limit');
  expect(result.content).toContain('sourceEdits');
  expect(executed).toBe(false);
});
