import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { generateReportNarrative, prepareNarrativeInput, REPORT_NARRATIVE_MAX_ROWS } from "../../src/lib/reports/narrative";
import type { ReportAiNarrativeBlock } from "../../src/lib/reports/types";

function block(overrides: Partial<ReportAiNarrativeBlock> = {}): ReportAiNarrativeBlock {
  return {
    id: "narrative",
    type: "ai_narrative",
    datasetId: "weather",
    instruction: "Summarize conditions for $city.",
    layout: { x: 0, y: 0, w: 12, h: 4 },
    ...overrides,
  };
}

const report = { parameters: [{ id: "city", key: "city", label: "City", type: "text" as const, defaultValue: "Glen Allen" }] };
const realFetch = globalThis.fetch;
const realLocalStorage = (globalThis as any).localStorage;

beforeEach(() => {
  (globalThis as any).localStorage = {
    getItem: (key: string) => key === "vgi-frontend-settings" ? JSON.stringify({ aiTelemetry: false }) : null,
  };
});

afterEach(() => {
  globalThis.fetch = realFetch;
  (globalThis as any).localStorage = realLocalStorage;
});

describe("AI report narrative input", () => {
  test("selects requested columns and interpolates applied parameters", () => {
    const prepared = prepareNarrativeInput(
      block({ columns: ["temperature", "humidity"] }),
      [{ city: "Glen Allen", temperature: 82, humidity: 68, ignored: "x" }],
      report,
      { city: "Norfolk" },
      "model-a",
    );
    expect(prepared.instruction).toBe("Summarize conditions for Norfolk.");
    expect(prepared.rows).toEqual([{ temperature: 82, humidity: 68 }]);
    expect(prepared.dataJson).not.toContain("ignored");
  });

  test("caps rows and fingerprints data, instructions, and model", () => {
    const rows = Array.from({ length: 150 }, (_, index) => ({ value: index }));
    const first = prepareNarrativeInput(block({ maxRows: 500 }), rows, report, {}, "model-a");
    const changed = prepareNarrativeInput(block({ maxRows: 500 }), [{ value: 999 }, ...rows], report, {}, "model-a");
    const otherModel = prepareNarrativeInput(block({ maxRows: 500 }), rows, report, {}, "model-b");
    expect(first.rows).toHaveLength(REPORT_NARRATIVE_MAX_ROWS);
    expect(first.truncated).toBe(true);
    expect(changed.fingerprint).not.toBe(first.fingerprint);
    expect(otherModel.fingerprint).not.toBe(first.fingerprint);
  });

  test("coerces bigint values into JSON-safe data", () => {
    const prepared = prepareNarrativeInput(block(), [{ value: 9_007_199_254_740_993n }], report, {}, "model-a");
    expect(() => JSON.parse(prepared.dataJson)).not.toThrow();
  });

  test("generates a persisted snapshot through a text-only request with no tools", async () => {
    let requestBody: any;
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      requestBody = JSON.parse(String(init?.body));
      const events = [
        { type: "message_start", message: { usage: { input_tokens: 20 } } },
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Humidity is elevated." } },
        { type: "content_block_stop", index: 0 },
        { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5 } },
      ];
      const body = events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
      return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
    }) as typeof fetch;

    const snapshot = await generateReportNarrative(
      "test-key",
      "claude-sonnet-4-6",
      block({ columns: ["humidity"] }),
      [{ humidity: 68 }],
      { ...report, title: "Weather" },
      { city: "Glen Allen" },
    );

    expect(requestBody.tools).toBeUndefined();
    expect(requestBody.messages[0].content).toContain('"humidity":68');
    expect(snapshot).toEqual(expect.objectContaining({
      markdown: "Humidity is elevated.",
      model: "claude-sonnet-4-6",
      rowCount: 1,
    }));
    expect(snapshot.dataFingerprint).toHaveLength(8);
  });
});
