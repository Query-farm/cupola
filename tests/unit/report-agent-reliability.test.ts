import { describe, expect, test } from "bun:test";
import { checkpointReportAgentPlan, parseReportAgentPlan, reportAgentRepair, validateReportAgentPlan } from "../../src/lib/reports/agent-reliability";
import { createEmptyReport } from "../../src/lib/reports/types";

describe("report agent reliability", () => {
  test("normalizes and validates an explicit plan", () => {
    const plan = parseReportAgentPlan({
      objective: " Weather briefing ",
      approach: ["Inspect data", "Build and verify"],
      datasets: [{ name: "Conditions", purpose: "Current readings" }],
      parameters: [{ key: "city", type: "text", purpose: "Reader location" }],
      blocks: [{ type: "kpi", title: "Humidity", purpose: "Current humidity", datasetName: "Conditions" }],
      acceptanceCriteria: ["All datasets execute"],
    });
    expect(validateReportAgentPlan(plan)).toEqual([]);
    expect(plan.objective).toBe("Weather briefing");
  });

  test("reports an actionable checkpoint until planned work exists", () => {
    const plan = parseReportAgentPlan({
      objective: "Weather briefing",
      approach: ["Build it"],
      datasets: [{ name: "Conditions", purpose: "Current readings" }],
      parameters: [{ key: "city", type: "text", purpose: "Reader location" }],
      blocks: [{ type: "kpi", title: "Humidity", purpose: "Current humidity" }],
      acceptanceCriteria: ["Report validates"],
    });
    const report = createEmptyReport("Weather");
    const missing = checkpointReportAgentPlan(plan, report);
    expect(missing.complete).toBe(false);
    expect(missing.missing).toEqual({ datasets: ["Conditions"], blocks: ["kpi: Humidity"], parameters: ["city"] });

    report.datasets.push({ id: "conditions", name: "Conditions", sql: "SELECT 40 AS humidity" });
    report.parameters.push({ id: "city", key: "city", label: "City", type: "text", defaultValue: "Glen Allen" });
    report.blocks.push({ id: "humidity", type: "kpi", title: "Humidity", datasetId: "conditions", valueColumn: "humidity", layout: { x: 0, y: 0, w: 3, h: 2 } });
    expect(checkpointReportAgentPlan(plan, report)).toEqual(expect.objectContaining({ complete: true, completed: { datasets: 1, blocks: 1, parameters: 1 } }));
  });

  test("routes missing-table failures through source discovery while preserving the error", () => {
    const message = 'Catalog Error: Table with name prices does not exist! Did you mean "pg_roles"? LINE 7: FROM prices ^';
    const repair = reportAgentRepair("dataset", "dataset price_trend", [message], "upsert_report_dataset");
    expect(repair.errors).toEqual([{ message }]);
    expect(repair.retry).toEqual(expect.objectContaining({
      tool: "upsert_report_dataset",
      target: "dataset price_trend",
      instruction: expect.stringContaining("list_catalogs and list_tables"),
    }));
    expect((repair.retry as { instruction: string }).instruction).toContain("catalog.schema.table");
    expect((repair.retry as { instruction: string }).instruction).toContain("existing dataset id");
  });

  test("unrelated failures retain targeted retry guidance", () => {
    const repair = reportAgentRepair("block", "block trend", ["Invalid encoding"], "upsert_report_block");
    expect((repair.retry as { instruction: string }).instruction).toBe("Correct only block trend, then call upsert_report_block again with the same identifier before continuing.");
  });

  test("returns structured retry guidance", () => {
    expect(reportAgentRepair("dataset", "dataset weather", ["Column city does not exist"], "upsert_report_dataset")).toEqual(expect.objectContaining({
      ok: false,
      code: "report_dataset_failed",
      stage: "dataset",
      target: "dataset weather",
      errors: [{ message: "Column city does not exist" }],
      retry: expect.objectContaining({ tool: "upsert_report_dataset", target: "dataset weather" }),
    }));
  });
});
