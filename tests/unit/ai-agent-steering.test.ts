import { afterEach, describe, expect, test } from "bun:test";

import { runAgentTurn, type AgentCallbacks, type MessageParam } from "../../src/lib/ai-agent";
import { prepareAiAttachment, queuedMessageContent, userMessageContent } from '../../src/lib/ai/attachments';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

function sseStream(events: unknown[]): Response {
  const body = events.map((e) => `event: ${(e as any).type}\ndata: ${JSON.stringify(e)}\n\n`).join("");
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function toolTurn(id: string) {
  return sseStream([
    { type: "message_start", message: { usage: { input_tokens: 10 } } },
    { type: "content_block_start", index: 0, content_block: { type: "tool_use", id, name: "lookup" } },
    { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{}" } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 5 } },
  ]);
}

function finalTurn() {
  return sseStream([
    { type: "message_start", message: { usage: { input_tokens: 5 } } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Done." } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 3 } },
  ]);
}

function callbacks(over: Partial<AgentCallbacks> = {}): AgentCallbacks {
  return { onText: () => {}, onToolCall: () => {}, onToolResult: () => {}, onDone: () => {}, onError: () => {}, ...over };
}

const TOOLS = [{ name: "lookup", description: "Look up data", input_schema: { type: "object" } }];

function serve(responses: Response[]) {
  const requests: any[] = [];
  globalThis.fetch = (async (_url: any, init: any) => {
    requests.push(JSON.parse(String(init?.body)));
    return responses.shift()!;
  }) as typeof fetch;
  return requests;
}

describe("messages sent while the agent works", () => {
  test('attachments reach the initial request and queued tool-round follow-up', async () => {
    const initial = await prepareAiAttachment(new File(['a,b\n1,2'], 'initial.csv'));
    const followup = await prepareAiAttachment(new File(['Reference text'], 'followup.txt'));
    const requests = serve([toolTurn('toolu_1'), finalTurn()]);
    let pending = true;
    await runAgentTurn(
      { apiKey: 'key' }, 'claude-sonnet-5', [{ role: 'user', content: userMessageContent('Analyze this', [initial]) }], 'System', async () => 'ok',
      callbacks({ takeUserMessages: () => { if (!pending) return null; pending = false; return queuedMessageContent([{ text: 'Use this too', attachments: [followup] }]); } }),
      undefined, 20, TOOLS, 8_192, false,
    );
    expect(requests[0].messages[0].content).toContainEqual(initial.block);
    expect(requests[1].messages.at(-1).content[0].type).toBe('tool_result');
    expect(requests[1].messages.at(-1).content).toContainEqual(followup.block);
    expect(requests[1].messages[0].content).toEqual(requests[0].messages[0].content);
  });
  test("ride after the next round's tool results, without ending the turn", async () => {
    const requests = serve([toolTurn("toolu_1"), toolTurn("toolu_2"), finalTurn()]);
    const pending = ["Also add a chart"];
    let polls = 0;
    const messages: MessageParam[] = [{ role: "user", content: "Build the report" }];
    await runAgentTurn(
      { apiKey: "key" }, "claude-sonnet-5", messages, "System", async () => "ok",
      callbacks({ takeUserMessages: () => { polls++; return pending.shift() ?? null; } }),
      undefined, 20, TOOLS, 8_192, false, "high",
    );

    expect(requests).toHaveLength(3);
    expect(requests[1].messages.at(-1).content).toEqual([
      { type: "tool_result", tool_use_id: "toolu_1", content: "ok" },
      { type: "text", text: "Also add a chart" },
    ]);
    // Taken once: the following round carries only its tool result.
    expect(requests[2].messages.at(-1).content).toEqual([{ type: "tool_result", tool_use_id: "toolu_2", content: "ok" }]);
    // Append-only: the earlier request's messages are a prefix of the later one's.
    expect(requests[2].messages.slice(0, requests[1].messages.length).map((m: any) => m.content))
      .toEqual(requests[1].messages.map((m: any) => m.content));
    // Polled after each tool round, never at the end of the turn.
    expect(polls).toBe(2);
  });

  test("are not taken on the last round, when no request follows", async () => {
    serve([toolTurn("toolu_1")]);
    let polls = 0;
    const messages: MessageParam[] = [{ role: "user", content: "Build the report" }];
    await runAgentTurn(
      { apiKey: "key" }, "claude-sonnet-5", messages, "System", async () => "ok",
      callbacks({ takeUserMessages: () => { polls++; return "late"; } }),
      undefined, 1, TOOLS, 8_192, false, "high",
    );
    expect(polls).toBe(0);
  });
});
