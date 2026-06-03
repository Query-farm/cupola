/**
 * Conversation-history hygiene for the AI agent.
 *
 * Pure logic over the message array — no service / catalog / VGI-RPC imports —
 * so it can be unit-tested in isolation (same split rationale as ./ai-fetch and
 * ./query-results). The message types are imported type-only, which is erased at
 * build time and so does NOT pull ai-agent's runtime dependency graph in here.
 *
 * The Anthropic Messages API enforces two structural invariants that a turn
 * interrupted at the wrong moment can violate, wedging the chat with a 400 on
 * EVERY subsequent request:
 *   1. Every `tool_use` block must be answered by a `tool_result` (same id) in
 *      the immediately following message.
 *   2. Messages must alternate user/assistant — no two same-role messages in a
 *      row.
 * `sanitizeConversation` repairs both before each send so a poisoned history
 * (from this build or an older one) heals itself instead of being stuck forever.
 */

import type { MessageParam, ContentBlock, ToolResultBlock } from "./ai-agent";

type AnyBlock = ContentBlock | ToolResultBlock;

/** Normalize a message's content to an array of blocks. A string becomes a
 *  single text block; an empty string becomes no blocks. */
function toBlocks(content: MessageParam["content"]): AnyBlock[] {
  if (typeof content === "string") {
    return content ? [{ type: "text", text: content }] : [];
  }
  return content as AnyBlock[];
}

/**
 * Strip any unmatched `tool_use` blocks from the conversation in place
 * (invariant #1).
 *
 * For each assistant message, any `tool_use` whose id is not answered by the
 * next message's `tool_result` blocks is removed. If that empties the message it
 * is replaced with a placeholder text block, so it stays a valid (non-empty)
 * assistant turn.
 */
export function sanitizeDanglingToolUse(messages: MessageParam[]): void {
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role !== "assistant" || !Array.isArray(msg.content)) continue;
    const blocks = msg.content as ContentBlock[];
    if (!blocks.some((b) => b.type === "tool_use")) continue;

    // Collect the tool_use ids answered by the next message.
    const next = messages[i + 1];
    const answered = new Set<string>();
    if (next && next.role === "user" && Array.isArray(next.content)) {
      for (const b of next.content as ToolResultBlock[]) {
        if (b.type === "tool_result" && b.tool_use_id) answered.add(b.tool_use_id);
      }
    }

    // Keep text blocks and any tool_use that IS answered; drop only the
    // unanswered tool_use blocks.
    const kept = blocks.filter(
      (b) => b.type !== "tool_use" || (b.id != null && answered.has(b.id))
    );
    if (kept.length === blocks.length) continue; // nothing dangling

    // Never leave an empty content array — fall back to a placeholder so the
    // message stays a valid (non-empty) assistant turn.
    msg.content = (kept.length ? kept : [{ type: "text", text: "(stopped)" }]) as ContentBlock[];
  }
}

/**
 * Merge consecutive same-role messages into one (invariant #2), in place.
 *
 * This is the backstop for every path that can leave the history ending on a
 * `user` message (a turn aborted between rounds, or one that exhausted the
 * tool-round budget after pushing tool_results): when the next user message is
 * appended, the two adjacent user messages would otherwise be rejected with
 * "roles must alternate". Merging folds the new question in alongside the prior
 * tool_results — `assistant(tool_use)`, `user([tool_result, …, text])` — which
 * is valid and semantically correct.
 *
 * Content is combined into a single block array (tool_result/text order
 * preserved); string content is promoted to a text block.
 */
export function mergeAdjacentSameRole(messages: MessageParam[]): void {
  for (let i = 1; i < messages.length; i++) {
    const cur = messages[i];
    const prev = messages[i - 1];
    if (cur.role !== prev.role) continue;
    const merged = [...toBlocks(prev.content), ...toBlocks(cur.content)];
    // Guard against an all-empty merge producing an invalid empty content array.
    prev.content = (merged.length ? merged : [{ type: "text", text: "(empty)" }]) as ContentBlock[];
    messages.splice(i, 1);
    i--; // re-check the merged message against the next one (handles 3+ in a row)
  }
}

/**
 * Repair a conversation in place so it satisfies both Anthropic structural
 * invariants. Run before every send.
 */
export function sanitizeConversation(messages: MessageParam[]): void {
  sanitizeDanglingToolUse(messages);
  mergeAdjacentSameRole(messages);
}
