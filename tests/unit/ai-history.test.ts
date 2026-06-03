/**
 * Unit tests for conversation-history hygiene (src/lib/ai-history.ts).
 *
 * Locks in the fix for the "tool_use ids were found without tool_result blocks"
 * 400 (and the sibling "roles must alternate" 400) that permanently wedged the
 * AI chat. An interrupted turn could leave the history either with an assistant
 * tool_use that had no matching tool_result, or ending on a user/tool_result
 * message that — once the next question was appended — produced two consecutive
 * user messages. Every later request replayed the poisoned history. The
 * sanitizers heal both shapes.
 *
 * ai-history.ts is pure so it imports without the VGI/RPC graph.
 */
import { test, expect, describe } from "bun:test";
import {
  sanitizeDanglingToolUse,
  mergeAdjacentSameRole,
  sanitizeConversation,
} from "../../src/lib/ai-history";
import type { MessageParam } from "../../src/lib/ai-agent";

describe("sanitizeDanglingToolUse", () => {
  test("leaves a properly-matched tool_use/tool_result pair untouched", () => {
    const messages: MessageParam[] = [
      { role: "user", content: "hi" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "looking" },
          { type: "tool_use", id: "t1", name: "list_tables", input: {} },
        ],
      },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] },
      { role: "assistant", content: [{ type: "text", text: "done" }] },
    ];
    const snapshot = JSON.stringify(messages);
    sanitizeDanglingToolUse(messages);
    expect(JSON.stringify(messages)).toBe(snapshot);
  });

  test("strips a trailing dangling tool_use, keeping the assistant's text", () => {
    const messages: MessageParam[] = [
      { role: "user", content: "hi" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "let me check" },
          { type: "tool_use", id: "t1", name: "run_sql", input: { sql: "SELECT 1" } },
        ],
      },
    ];
    sanitizeDanglingToolUse(messages);
    expect(messages[1].content).toEqual([{ type: "text", text: "let me check" }]);
  });

  test("dangling tool_use with no text becomes a placeholder (preserves alternation)", () => {
    const messages: MessageParam[] = [
      { role: "user", content: "hi" },
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "run_sql", input: {} }] },
      { role: "user", content: "follow up" },
    ];
    sanitizeDanglingToolUse(messages);
    expect(messages[1].content).toEqual([{ type: "text", text: "(stopped)" }]);
    expect(messages[1].role).toBe("assistant");
  });

  test("the next message being a plain user string (not tool_result) counts as unanswered", () => {
    const messages: MessageParam[] = [
      {
        role: "assistant",
        content: [
          { type: "text", text: "a" },
          { type: "tool_use", id: "t1", name: "run_sql", input: {} },
        ],
      },
      { role: "user", content: "totally unrelated text" },
    ];
    sanitizeDanglingToolUse(messages);
    expect(messages[0].content).toEqual([{ type: "text", text: "a" }]);
  });

  test("keeps answered tool_use blocks and strips only the unanswered ones in the same message", () => {
    const messages: MessageParam[] = [
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "t1", name: "run_sql", input: {} },
          { type: "tool_use", id: "t2", name: "run_sql", input: {} },
        ],
      },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] },
    ];
    sanitizeDanglingToolUse(messages);
    expect(messages[0].content).toEqual([
      { type: "tool_use", id: "t1", name: "run_sql", input: {} },
    ]);
  });

  test("no-op on a conversation with no tool_use blocks", () => {
    const messages: MessageParam[] = [
      { role: "user", content: "hi" },
      { role: "assistant", content: [{ type: "text", text: "hello" }] },
    ];
    const snapshot = JSON.stringify(messages);
    sanitizeDanglingToolUse(messages);
    expect(JSON.stringify(messages)).toBe(snapshot);
  });
});

describe("mergeAdjacentSameRole", () => {
  test("merges two consecutive user messages (tool_result array + new text)", () => {
    const messages: MessageParam[] = [
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "run_sql", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] },
      { role: "user", content: "next question" },
    ];
    mergeAdjacentSameRole(messages);
    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe("assistant");
    expect(messages[1].role).toBe("user");
    expect(messages[1].content).toEqual([
      { type: "tool_result", tool_use_id: "t1", content: "ok" },
      { type: "text", text: "next question" },
    ]);
  });

  test("merges three-in-a-row into one", () => {
    const messages: MessageParam[] = [
      { role: "assistant", content: [{ type: "text", text: "x" }] },
      { role: "user", content: "a" },
      { role: "user", content: "b" },
      { role: "user", content: "c" },
    ];
    mergeAdjacentSameRole(messages);
    expect(messages).toHaveLength(2);
    expect(messages[1].content).toEqual([
      { type: "text", text: "a" },
      { type: "text", text: "b" },
      { type: "text", text: "c" },
    ]);
  });

  test("leaves a properly alternating conversation untouched", () => {
    const messages: MessageParam[] = [
      { role: "user", content: "a" },
      { role: "assistant", content: [{ type: "text", text: "b" }] },
      { role: "user", content: "c" },
    ];
    const snapshot = JSON.stringify(messages);
    mergeAdjacentSameRole(messages);
    expect(JSON.stringify(messages)).toBe(snapshot);
  });
});

describe("sanitizeConversation — end-to-end poisoning scenarios", () => {
  // Reproduces the abort-between-rounds shape: a completed round leaves
  // assistant(tool_use) + user(tool_result), the turn is cancelled, then the
  // user asks again — appending a second user message.
  test("abort-between-rounds then a new question yields a valid alternating history", () => {
    const messages: MessageParam[] = [
      { role: "user", content: "q1" },
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "run_sql", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "42" }] },
      { role: "user", content: "q2" }, // appended by handleSend before the next turn
    ];
    sanitizeConversation(messages);
    // Roles strictly alternate.
    for (let i = 1; i < messages.length; i++) {
      expect(messages[i].role).not.toBe(messages[i - 1].role);
    }
    // Final shape: q1, assistant(tool_use t1), user([tool_result t1, "q2"]).
    expect(messages).toHaveLength(3);
    expect(messages[2].content).toEqual([
      { type: "tool_result", tool_use_id: "t1", content: "42" },
      { type: "text", text: "q2" },
    ]);
  });

  // Reproduces a legacy poisoned history: a dangling tool_use directly
  // followed by a new user question (the original 400).
  test("dangling tool_use directly followed by a new question heals to a valid history", () => {
    const messages: MessageParam[] = [
      { role: "user", content: "q1" },
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "run_sql", input: {} }] },
      { role: "user", content: "q2" },
    ];
    sanitizeConversation(messages);
    for (let i = 1; i < messages.length; i++) {
      expect(messages[i].role).not.toBe(messages[i - 1].role);
    }
    // tool_use stripped → assistant("(stopped)"); roles already alternate so
    // no merge needed.
    expect(messages).toHaveLength(3);
    expect(messages[1].content).toEqual([{ type: "text", text: "(stopped)" }]);
    expect(messages[2].content).toBe("q2");
  });
});
