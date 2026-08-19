import { describe, expect, test } from "bun:test";
import { REPORT_DOCUMENT_SCHEMA, REPORT_TOOLS, upsertAgentBlock, upsertAgentDataset, upsertAgentGroup } from "../../src/lib/reports/agent-tools";
import { createEmptyReport } from "../../src/lib/reports/types";

describe("report agent tools", () => {
  test("requires a structured plan before compositional authoring", () => {
    const plan = REPORT_TOOLS.find((candidate) => candidate.name === "plan_report")!;
    expect(REPORT_TOOLS[0].name).toBe("plan_report");
    expect(plan.input_schema.required).toEqual(["objective", "approach", "datasets", "blocks", "parameters", "acceptanceCriteria"]);
    expect(plan.input_schema.properties.blocks.items.properties.type.enum).toContain("ai_narrative");
    expect(plan.input_schema.properties.acceptanceCriteria.minItems).toBe(1);
  });

  test("bulk schema documents layout as nested x/y/w/h", () => {
    const block = REPORT_DOCUMENT_SCHEMA.properties.blocks.items;
    expect(block.required).toContain("layout");
    expect(block.properties.layout.required).toEqual(["x", "y", "w", "h"]);
    expect(block.properties.col).toBeUndefined();
    expect(block.properties.width).toBeUndefined();
    expect(REPORT_DOCUMENT_SCHEMA.properties.refreshIntervalSeconds.minimum).toBe(5);
  });

  test("compositional block tool keeps raw grid coordinates out of agent input", () => {
    const tool = REPORT_TOOLS.find((candidate) => candidate.name === "upsert_report_block")!;
    const properties = tool.input_schema.properties.block.properties;
    expect(properties.layout).toBeUndefined();
    expect(tool.input_schema.properties.width.enum).toEqual(["quarter", "third", "half", "full"]);
    expect(properties.type.enum).toEqual(expect.arrayContaining(["small_multiples", "bullet", "slopegraph", "range_dot", "ai_narrative"]));
    expect(properties.snapshot).toBeUndefined();
    expect(properties.instruction.description).toContain("focused instructions");
    expect(properties.maxRows.maximum).toBe(100);
    expect(properties.refreshPolicy.enum).toEqual(["manual", "when_data_changes"]);
    expect(properties).toHaveProperty("caption");
    expect(properties).toHaveProperty("source");
    expect(properties).toHaveProperty("groupId");
    expect(properties.appearance.properties.rules.items.required).toEqual(["column", "operator", "value", "tone", "label"]);
    expect(properties.appearance.properties.tone.enum).toEqual(["neutral", "info", "success", "warning", "danger"]);
  });

  test("lets the agent create labeled groups and keeps their blocks together", () => {
    let report = createEmptyReport("Two-city weather");
    report.datasets.push({ id: "weather", name: "Weather", sql: "SELECT 1 AS value" });
    const richmond = upsertAgentGroup(report, { title: "Richmond", description: "Current conditions", tone: "blue" });
    report = richmond.report;
    const norfolk = upsertAgentGroup(report, { title: "Norfolk", tone: "green" });
    report = norfolk.report;

    const richmondKpi = upsertAgentBlock(report, { type: "kpi", title: "Humidity", groupId: richmond.group.id, datasetId: "weather", valueColumn: "value" }, "half", "compact");
    const richmondChart = upsertAgentBlock(richmondKpi.report, { type: "chart", title: "Trend", groupId: richmond.group.id, datasetId: "weather", spec: { mark: "line" } }, "half", "compact");
    const norfolkKpi = upsertAgentBlock(richmondChart.report, { type: "kpi", title: "Humidity", groupId: norfolk.group.id, datasetId: "weather", valueColumn: "value" }, "half", "compact");

    expect(richmondKpi.block.layout).toEqual({ x: 0, y: 0, w: 6, h: 2 });
    expect(richmondChart.block.layout).toEqual({ x: 6, y: 0, w: 6, h: 2 });
    expect(norfolkKpi.block.layout.y).toBeGreaterThanOrEqual(2);
    expect(norfolkKpi.report.groups).toEqual([
      expect.objectContaining({ id: richmond.group.id, title: "Richmond" }),
      expect.objectContaining({ id: norfolk.group.id, title: "Norfolk" }),
    ]);
    expect(norfolkKpi.report.blocks).toHaveLength(3);
    expect(norfolkKpi.report.blocks.filter((block) => block.title === "Humidity").map((block) => block.groupId)).toEqual([
      richmond.group.id,
      norfolk.group.id,
    ]);
    expect(REPORT_TOOLS.find((tool) => tool.name === "upsert_report_group")?.input_schema.properties.group.properties.tone.enum).toContain("blue");
    expect(REPORT_TOOLS.find((tool) => tool.name === "upsert_report_group")?.input_schema.properties.group.properties.titleSize.enum).toEqual(["small", "medium", "large"]);

    const ungrouped = upsertAgentBlock(norfolkKpi.report, {
      id: norfolkKpi.block.id,
      type: "kpi",
      title: "Humidity",
      datasetId: "weather",
      valueColumn: "value",
      groupId: null,
    });
    expect(ungrouped.block.groupId).toBeUndefined();
  });

  test("documents content-only markdown blocks instead of generic Text titles", () => {
    const tool = REPORT_TOOLS.find((candidate) => candidate.name === "upsert_report_block")!;
    const title = tool.input_schema.properties.block.properties.title;
    expect(title.description).toContain("omit it for a content-only card");
    expect(title.description).toContain("never use generic titles");

    const report = createEmptyReport("Weather");
    const created = upsertAgentBlock(report, { type: "markdown", markdown: "Conditions remain comfortable." });
    expect(created.block.title).toBeUndefined();
  });

  test("lets the agent configure or disable automatic refresh", () => {
    const tool = REPORT_TOOLS.find((candidate) => candidate.name === "configure_report")!;
    expect(tool.input_schema.properties.refreshIntervalSeconds.type).toEqual(["number", "null"]);
    expect(tool.input_schema.properties.parameters.items.properties.validation.properties).toHaveProperty("maxSpanDays");
    expect(tool.input_schema.properties.parameters.items.properties.validationDataset.required).toEqual(["datasetId", "validColumn"]);
    expect(tool.input_schema.properties.parameterRules.items.properties.operator.enum).toContain("before_or_equal");
    expect(REPORT_DOCUMENT_SCHEMA.properties.datasets.items.properties.role.enum).toContain("parameter_validation");
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

  test("gives sparklines a compact quarter-width box by default", () => {
    const report = createEmptyReport("Weather");
    report.datasets.push({ id: "weather", name: "Weather", sql: "SELECT 1 AS temperature" });
    const created = upsertAgentBlock(report, { type: "sparkline", title: "Temperature", datasetId: "weather", valueColumn: "temperature" });
    expect(created.block.layout).toEqual({ x: 0, y: 0, w: 3, h: 2 });
    expect(REPORT_DOCUMENT_SCHEMA.properties.blocks.items.properties).toHaveProperty("splitColumn");
    expect(REPORT_DOCUMENT_SCHEMA.properties.blocks.items.properties).toHaveProperty("splitColor");
  });

  test("gives AI narratives a full-width reading box and keeps snapshots managed", () => {
    const report = createEmptyReport("Weather");
    report.datasets.push({ id: "weather", name: "Weather", sql: "SELECT 1 AS temperature" });
    const created = upsertAgentBlock(report, {
      type: "ai_narrative",
      title: "What changed",
      datasetId: "weather",
      instruction: "Summarize material changes.",
      maxRows: 25,
      refreshPolicy: "manual",
    });
    expect(created.block.layout).toEqual({ x: 0, y: 0, w: 12, h: 4 });
    expect(created.block).not.toHaveProperty("snapshot");
    expect(REPORT_DOCUMENT_SCHEMA.properties.blocks.items.properties.snapshot.required).toContain("dataFingerprint");
  });

  test("gives compact comparison devices a half-width default", () => {
    const report = createEmptyReport("Plan");
    report.datasets.push({ id: "plan", name: "Plan", sql: "SELECT 1" });
    const created = upsertAgentBlock(report, {
      type: "bullet",
      title: "Actual versus target",
      datasetId: "plan",
      categoryColumn: "team",
      valueColumn: "actual",
      targetColumn: "target",
    });
    expect(created.block.layout).toEqual({ x: 0, y: 0, w: 6, h: 5 });
  });

  test("reuses dataset IDs when the agent revises by ID or name", () => {
    const report = createEmptyReport("Weather");
    const created = upsertAgentDataset(report, { name: "Conditions", sql: "SELECT 1" });
    const byName = upsertAgentDataset(created.report, { name: "Conditions", sql: "SELECT 2" });
    const byId = upsertAgentDataset(byName.report, { id: created.dataset.id, name: "Conditions", sql: "SELECT 3" });
    expect(byName.dataset.id).toBe(created.dataset.id);
    expect(created.dataset.id).toBe("conditions");
    expect(byId.dataset.id).toBe(created.dataset.id);
    expect(byId.report.datasets).toHaveLength(1);
    expect(byId.dataset.sql).toBe("SELECT 3");
  });
});
