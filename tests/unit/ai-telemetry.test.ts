import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";

import {
  ATTR,
  isAbortError,
  isAiTelemetryEnabled,
  mapUsageAttributes,
  serializeInputMessages,
  serializeOutputMessages,
  serializeToolDefinitions,
  serializeToolResult,
} from "../../src/lib/ai-telemetry";
import type { ContentBlock, MessageParam, ToolResultBlock } from "../../src/lib/ai-agent";

describe("mapUsageAttributes", () => {
  test("input_tokens includes cache counts; cached/cache_write are subsets", () => {
    const attrs = mapUsageAttributes({
      inputTokens: 100,
      cacheReadTokens: 900,
      cacheWriteTokens: 50,
      outputTokens: 20,
    });
    expect(attrs[ATTR.USAGE_INPUT]).toBe(1050);
    expect(attrs[ATTR.USAGE_INPUT_CACHED]).toBe(900);
    expect(attrs[ATTR.USAGE_INPUT_CACHE_WRITE]).toBe(50);
    expect(attrs[ATTR.USAGE_OUTPUT]).toBe(20);
    expect(attrs[ATTR.USAGE_TOTAL]).toBe(1070);
  });

  test("no caching", () => {
    const attrs = mapUsageAttributes({
      inputTokens: 10,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 5,
    });
    expect(attrs[ATTR.USAGE_INPUT]).toBe(10);
    expect(attrs[ATTR.USAGE_INPUT_CACHED]).toBe(0);
    expect(attrs[ATTR.USAGE_TOTAL]).toBe(15);
  });

  test("all zero", () => {
    const attrs = mapUsageAttributes({
      inputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 0,
    });
    expect(attrs[ATTR.USAGE_TOTAL]).toBe(0);
  });
});

describe("serializeInputMessages", () => {
  test("string content becomes a text part", () => {
    const messages: MessageParam[] = [{ role: "user", content: "show me the tables" }];
    expect(JSON.parse(serializeInputMessages(messages))).toEqual([
      { role: "user", parts: [{ type: "text", content: "show me the tables" }] },
    ]);
  });

  test("assistant text + tool_use becomes text + tool_call parts", () => {
    const messages: MessageParam[] = [
      {
        role: "assistant",
        content: [
          { type: "text", text: "Let me check." },
          { type: "tool_use", id: "tu_1", name: "run_sql", input: { sql: "SELECT 1" } },
        ] as ContentBlock[],
      },
    ];
    const [msg] = JSON.parse(serializeInputMessages(messages));
    expect(msg.role).toBe("assistant");
    expect(msg.parts).toEqual([
      { type: "text", content: "Let me check." },
      { type: "tool_call", id: "tu_1", name: "run_sql", arguments: { sql: "SELECT 1" } },
    ]);
  });

  test("all-tool_result message gets role tool", () => {
    const messages: MessageParam[] = [
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "tu_1", content: "1 row" },
        ] as ToolResultBlock[],
      },
    ];
    const [msg] = JSON.parse(serializeInputMessages(messages));
    expect(msg.role).toBe("tool");
    expect(msg.parts).toEqual([{ type: "tool_result", id: "tu_1", content: "1 row" }]);
  });

  test("image tool_result parts are elided, not inlined", () => {
    const base64 = "A".repeat(40_000);
    const messages: MessageParam[] = [
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "tu_2",
            content: [
              { type: "text", text: "Chart rendered." },
              { type: "image", source: { type: "base64", media_type: "image/png", data: base64 } },
            ],
          },
        ] as ToolResultBlock[],
      },
    ];
    const serialized = serializeInputMessages(messages);
    expect(serialized).not.toContain("AAAA");
    expect(serialized).toContain("Chart rendered.");
    expect(serialized).toContain("[image image/png, 30000 bytes elided]");
  });

  test("oversized single text part is truncated", () => {
    const messages: MessageParam[] = [{ role: "user", content: "x".repeat(30_000) }];
    const [msg] = JSON.parse(serializeInputMessages(messages));
    expect(msg.parts[0].content.length).toBeLessThan(21_000);
    expect(msg.parts[0].content).toContain("[truncated 10000 chars]");
  });

  test("oldest messages are elided when the total exceeds the budget", () => {
    const messages: MessageParam[] = Array.from({ length: 30 }, (_, i) => ({
      role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
      content: `${i}:${"y".repeat(15_000)}`,
    }));
    const parsed = JSON.parse(serializeInputMessages(messages));
    expect(serializeInputMessages(messages).length).toBeLessThanOrEqual(210_000);
    expect(parsed[0].role).toBe("system");
    expect(parsed[0].parts[0].content).toMatch(/\[\d+ earlier messages elided\]/);
    // The most recent message always survives.
    expect(parsed[parsed.length - 1].parts[0].content.startsWith("29:")).toBe(true);
  });
});

describe("serializeOutputMessages", () => {
  test("text-only response", () => {
    const out = JSON.parse(serializeOutputMessages([{ type: "text", text: "There are 5 tables." }], "end_turn"));
    expect(out).toEqual([
      {
        role: "assistant",
        parts: [{ type: "text", content: "There are 5 tables." }],
        finish_reason: "end_turn",
      },
    ]);
  });

  test("text + tool_use response", () => {
    const content: ContentBlock[] = [
      { type: "text", text: "Querying…" },
      { type: "tool_use", id: "tu_9", name: "list_tables", input: {} },
    ];
    const [msg] = JSON.parse(serializeOutputMessages(content, "tool_use"));
    expect(msg.finish_reason).toBe("tool_use");
    expect(msg.parts[1]).toEqual({ type: "tool_call", id: "tu_9", name: "list_tables", arguments: {} });
  });
});

describe("serializeToolDefinitions", () => {
  test("maps name/description/input_schema", () => {
    const defs = JSON.parse(
      serializeToolDefinitions([
        { name: "run_sql", description: "Run a query", input_schema: { type: "object" } },
      ])
    );
    expect(defs).toEqual([
      { type: "function", name: "run_sql", description: "Run a query", parameters: { type: "object" } },
    ]);
  });
});

describe("serializeToolResult", () => {
  test("string passes through", () => {
    expect(serializeToolResult("3 rows")).toBe("3 rows");
  });

  test("array form joins text parts and elides images", () => {
    const result = serializeToolResult([
      { type: "text", text: "Chart ready." },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "Zm9vYmFy" } },
    ]);
    expect(result).toBe("Chart ready.\n[image image/png, 6 bytes elided]");
  });

  test("oversized string is capped", () => {
    const result = serializeToolResult("z".repeat(25_000));
    expect(result.length).toBeLessThan(21_000);
    expect(result).toContain("[truncated 5000 chars]");
  });
});

describe("isAbortError", () => {
  test("AbortError DOMException", () => {
    expect(isAbortError(new DOMException("Aborted", "AbortError"))).toBe(true);
  });
  test("fetchWithRetry Cancelled.", () => {
    expect(isAbortError(new Error("Cancelled."))).toBe(true);
  });
  test("ordinary errors are not aborts", () => {
    expect(isAbortError(new Error("boom"))).toBe(false);
    expect(isAbortError(null)).toBe(false);
    expect(isAbortError("Cancelled.")).toBe(false);
  });
});

describe("isAiTelemetryEnabled", () => {
  // bun:test has no localStorage; install a minimal in-memory stand-in.
  const store = new Map<string, string>();
  beforeAll(() => {
    (globalThis as any).localStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, String(v)),
      removeItem: (k: string) => void store.delete(k),
    };
  });
  afterAll(() => {
    delete (globalThis as any).localStorage;
  });
  afterEach(() => {
    store.clear();
  });

  test("defaults to true with no stored settings", () => {
    expect(isAiTelemetryEnabled()).toBe(true);
  });

  test("false when aiTelemetry is disabled", () => {
    localStorage.setItem("vgi-frontend-settings", JSON.stringify({ aiTelemetry: false }));
    expect(isAiTelemetryEnabled()).toBe(false);
  });

  test("true when aiTelemetry is enabled or absent", () => {
    localStorage.setItem("vgi-frontend-settings", JSON.stringify({ aiTelemetry: true }));
    expect(isAiTelemetryEnabled()).toBe(true);
    localStorage.setItem("vgi-frontend-settings", JSON.stringify({ shellFontSize: 13 }));
    expect(isAiTelemetryEnabled()).toBe(true);
  });

  test("true on corrupt settings JSON", () => {
    localStorage.setItem("vgi-frontend-settings", "{not json");
    expect(isAiTelemetryEnabled()).toBe(true);
  });
});
