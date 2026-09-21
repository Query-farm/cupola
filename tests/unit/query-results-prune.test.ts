/**
 * Unit tests for pruneCarriedToolImages — chart-image context pruning.
 *
 * Chart PNGs are sent back to the model only so it can evaluate/revise the
 * chart it just drew; carrying them forward bloats context (~1.5k tokens each)
 * and can blow the input limit. These tests lock in: only the final message
 * keeps its image, the text part survives, and non-chart history is untouched.
 */
import { test, expect, describe } from "bun:test";
import { estimateConversationTokens, pruneCarriedToolImages, shouldPruneCarriedImages } from "../../src/lib/query-results";

const img = (data = "BASE64") => ({
  type: "image" as const,
  source: { type: "base64" as const, media_type: "image/png" as const, data },
});
const imageToolResult = (id: string, text: string) => ({
  role: "user" as const,
  content: [{ type: "tool_result", tool_use_id: id, content: [{ type: "text", text }, img()] }],
});

describe("pruneCarriedToolImages", () => {
  test("strips images from all but the final message, keeping the text part", () => {
    const messages: any[] = [
      { role: "user", content: "draw two charts" },
      { role: "assistant", content: [{ type: "tool_use", id: "a", name: "render_chart", input: {} }] },
      imageToolResult("a", '{"ok":true,"row_count":5}'),
      { role: "assistant", content: [{ type: "tool_use", id: "b", name: "render_chart", input: {} }] },
      imageToolResult("b", '{"ok":true,"row_count":9}'),
    ];
    pruneCarriedToolImages(messages);

    // Earlier chart (index 2): image gone, text kept.
    const stale = messages[2].content[0].content;
    expect(typeof stale).toBe("string");
    expect(stale).toContain('"row_count":5');
    expect(stale).toContain("removed from history");

    // Final chart (index 4): image preserved for the upcoming evaluation.
    const fresh = messages[4].content[0].content;
    expect(Array.isArray(fresh)).toBe(true);
    expect(fresh.some((p: any) => p.type === "image")).toBe(true);
  });

  test("leaves a conversation with no images untouched", () => {
    const messages: any[] = [
      { role: "user", content: "hi" },
      { role: "assistant", content: [{ type: "text", text: "hello" }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "x", content: "plain text result" }] },
    ];
    const snapshot = JSON.stringify(messages);
    pruneCarriedToolImages(messages);
    expect(JSON.stringify(messages)).toBe(snapshot);
  });

  test("when the only image is in the final message, nothing is stripped", () => {
    const messages: any[] = [
      { role: "user", content: "chart it" },
      imageToolResult("a", '{"ok":true}'),
    ];
    pruneCarriedToolImages(messages);
    expect(Array.isArray(messages[1].content[0].content)).toBe(true);
  });

  test("drops the image even when the tool_result has no text part", () => {
    const messages: any[] = [
      { role: "user", content: [{ type: "tool_result", tool_use_id: "a", content: [img()] }] },
      { role: "user", content: "next" },
    ];
    pruneCarriedToolImages(messages);
    expect(messages[0].content[0].content).toBe("[chart image removed from history to save context]");
  });
});

describe("shouldPruneCarriedImages", () => {
  test("prices an image as an image, not by the length of its base64", () => {
    // A real feedback PNG is tens of KB of base64. Counted as text that would
    // be ~25k tokens; the model bills it at a few hundred to ~1.6k.
    const bigPayload = "A".repeat(100_000);
    const tokens = estimateConversationTokens([imageToolResult("a", "ok")].map((m) => ({
      ...m,
      content: [{ ...m.content[0], content: [{ type: "text", text: "ok" }, img(bigPayload)] }],
    })));
    expect(tokens).toBeLessThan(2_000);
  });

  test("counts text, tool inputs and thinking at roughly four characters a token", () => {
    const tokens = estimateConversationTokens([
      { content: "x".repeat(400) },
      { content: [{ type: "tool_use", id: "t", name: "run_sql", input: { sql: "y".repeat(400) } }] },
      { content: [{ type: "thinking", thinking: "z".repeat(400), signature: "sig" }] },
    ]);
    expect(tokens).toBeGreaterThan(290);
    expect(tokens).toBeLessThan(320);
  });

  test("an ordinary chart conversation is nowhere near the threshold on a 1M model", () => {
    const messages: any[] = [{ role: "user", content: "chart it" }];
    for (let i = 0; i < 40; i++) messages.push(imageToolResult(`c${i}`, '{"ok":true}'));
    expect(shouldPruneCarriedImages(messages, 1_000_000)).toBe(false);
  });

  test("fires once the conversation passes half the window", () => {
    const messages = [{ content: "x".repeat(4 * 60_000) }]; // ~60k tokens
    expect(shouldPruneCarriedImages(messages, 200_000)).toBe(false); // threshold 100k
    expect(shouldPruneCarriedImages(messages, 100_000)).toBe(true);  // threshold 50k
  });
});
