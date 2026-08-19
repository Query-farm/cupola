import { describe, expect, test } from "bun:test";
import { buildShareReportUrl, REPORT_MODE_PARAM } from "../../src/lib/reports/share";
import { createEmptyReport } from "../../src/lib/reports/types";

describe("report share mode", () => {
  test("marks published reader links without changing ordinary draft links", async () => {
    const report = createEmptyReport("Shared report");
    const reader = new URL(await buildShareReportUrl(report, { baseUrl: "https://cupola.example/latest/", mode: "reader" }));
    const draft = new URL(await buildShareReportUrl(report, { baseUrl: "https://cupola.example/latest/" }));
    expect(new URLSearchParams(reader.hash.slice(1)).get(REPORT_MODE_PARAM)).toBe("reader");
    expect(new URLSearchParams(draft.hash.slice(1)).has(REPORT_MODE_PARAM)).toBe(false);
  });
});
