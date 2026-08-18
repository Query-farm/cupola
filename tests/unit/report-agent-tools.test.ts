import { describe, expect, test } from "bun:test";
import { REPORT_DOCUMENT_SCHEMA, REPORT_TOOLS, upsertAgentBlock, upsertAgentDataset } from "../../src/lib/reports/agent-tools";
import { createEmptyReport } from "../../src/lib/reports/types";

describe("report agent tools", () => {
  test("bulk schema documents layout as nested x/y/w/h", () => {
    const block = REPORT_DOCUMENT_SCHEMA.properties.blocks.items;
    expect(block.required).toContain("layout");
    expect(block.properties.layout.required).toEqual(["x", "y", "w", "h"]);
    expect(block.properties.col).toBeUndefined();
    expect(block.properties.width).toBeUndefined();
  });

  test("compositional block tool keeps raw grid coordinates out of agent input", () => {
    const tool = REPORT_TOOLS.find((candidate) => candidate.name === "upsert_report_block")!;
    const properties = tool.input_schema.properties.block.properties;
    expect(properties.layout).toBeUndefined();
    expect(tool.input_schema.properties.width.enum).toEqual(["quarter", "third", "half", "full"]);
  });

  test("places semantic half-width blocks side by side and preserves layout on revision", () => {
    let report = createEmptyReport("Weather");
    report.datasets.push({ id: "weather", name: "Weather", sql: "SELECT 1 AS value" });
    const first = upsertAgentBlock(report, { type: "chart", title: "Temperature", datasetId: "weather", spec: { mark: "line" } }, "half", "medium");
    report = first.report;
    const second = upsertAgentBlock(report, { type: "chart", title: "Air quality", datasetId: "weather", spec: { mark: "bar" } }, "half", "medium");
    expect(first.block.layout).toEqual({ x: 0, y: 0, w: 6, h: 5 });
    expect(second.block.layout).toEqual({ x: 6, y: 0, w: 6, h: 5 });

    const revised = upsertAgentBlock(second.report, { id: first.block.id, type: "chart", title: "Daily temperature", datasetId: "weather", spec: { mark: "area" } });
    expect(revised.block.id).toBe(first.block.id);
    expect(revised.block.layout).toEqual(first.block.layout);
    expect(revised.report.blocks).toHaveLength(2);
  });

  test("reuses dataset IDs when the agent revises by ID or name", () => {
    const report = createEmptyReport("Weather");
    const created = upsertAgentDataset(report, { name: "Conditions", sql: "SELECT 1" });
    const byName = upsertAgentDataset(created.report, { name: "Conditions", sql: "SELECT 2" });
    const byId = upsertAgentDataset(byName.report, { id: created.dataset.id, name: "Conditions", sql: "SELECT 3" });
    expect(byName.dataset.id).toBe(created.dataset.id);
    expect(byId.dataset.id).toBe(created.dataset.id);
    expect(byId.report.datasets).toHaveLength(1);
    expect(byId.dataset.sql).toBe("SELECT 3");
  });
});
