import { describe, expect, test } from "bun:test";
import { createEmptyReport } from "../../src/lib/reports/types";
import { validateParameterValue, validateReadOnlySql, validateReport, validateReportParameterValues } from "../../src/lib/reports/validation";

describe("report SQL validation", () => {
  test("accepts read-only queries and trailing semicolons", () => {
    expect(validateReadOnlySql("SELECT * FROM foo;")).toEqual([]);
    expect(validateReadOnlySql("WITH x AS (SELECT 1 AS n) SELECT * FROM x")).toEqual([]);
    expect(validateReadOnlySql("VALUES (1), (2)")).toEqual([]);
  });

  test("rejects writes, control statements, dynamic SQL, and multiple statements", () => {
    expect(validateReadOnlySql("DELETE FROM foo").length).toBeGreaterThan(0);
    expect(validateReadOnlySql("WITH x AS (DELETE FROM foo RETURNING *) SELECT * FROM x").length).toBeGreaterThan(0);
    expect(validateReadOnlySql("SELECT * FROM query('DELETE FROM foo')").length).toBeGreaterThan(0);
    expect(validateReadOnlySql("SELECT 1; DROP TABLE foo").length).toBeGreaterThan(0);
  });

  test("does not classify keywords inside literals or quoted identifiers as writes", () => {
    expect(validateReadOnlySql(`SELECT 'DELETE', "load" FROM foo`)).toEqual([]);
  });
});

describe("report document validation", () => {
  test("validates type constraints, option membership, and cross-parameter rules", () => {
    const report = createEmptyReport("Validated filters");
    report.parameters.push(
      { id: "minimum", key: "minimum", label: "Minimum", type: "number", defaultValue: 10, required: true, validation: { min: 0, max: 100, step: 5 } },
      { id: "maximum", key: "maximum", label: "Maximum", type: "number", defaultValue: 50, validation: { min: 0, max: 100 } },
      { id: "city", key: "city", label: "City", type: "select", defaultValue: "RIC", options: { kind: "static", values: [{ label: "Richmond", value: "RIC" }] } },
    );
    report.parameterRules = [{ id: "ordered", leftKey: "minimum", operator: "less_than_or_equal", rightKey: "maximum", message: "Minimum must not exceed maximum." }];
    expect(validateReport(report)).toEqual([]);
    expect(validateReportParameterValues(report, { minimum: 15, maximum: 10, city: "ORF" }, { city: report.parameters[2].options!.kind === "static" ? report.parameters[2].options!.values : [] }).map((issue) => issue.message)).toEqual([
      "City contains a value that is not currently available.",
      "Minimum must not exceed maximum.",
    ]);
    expect(validateParameterValue(report.parameters[0], 12)).toContain("increments of 5");
  });

  test("validates date ranges and dynamic parameter references", () => {
    const report = createEmptyReport("Forecast");
    report.parameters.push({ id: "period", key: "period", label: "Period", type: "date_range", defaultValue: { start: "2026-08-01", end: "2026-08-07" }, validation: { requireBoth: true, maxSpanDays: 31 } });
    report.blocks.push({ id: "intro", type: "markdown", title: "$period_start to $period_end", markdown: "Budget: $$100", layout: { x: 0, y: 0, w: 12, h: 2 } });
    expect(validateReport(report)).toEqual([]);
    expect(validateParameterValue(report.parameters[0], { start: "2026-08-10", end: "2026-08-01" })).toContain("must not be after");
    report.blocks[0].title = "$unknown";
    expect(validateReport(report).join(" ")).toContain("unknown parameter $unknown");
  });

  test("requires validation datasets to use the dedicated role", () => {
    const report = createEmptyReport("Inventory");
    report.parameters.push({ id: "sku", key: "sku", label: "SKU", type: "text", defaultValue: "A1", validationDataset: { datasetId: "validate_sku", validColumn: "valid", messageColumn: "message" } });
    report.datasets.push({ id: "validate_sku", name: "Validate SKU", role: "data", sql: "SELECT true AS valid" });
    expect(validateReport(report).join(" ")).toContain("role parameter_validation");
    report.datasets[0].role = "parameter_validation";
    expect(validateReport(report)).toEqual([]);
  });

  test("validates the persisted automatic refresh cadence", () => {
    const report = createEmptyReport("Live report");
    report.refreshIntervalSeconds = 30;
    expect(validateReport(report)).toEqual([]);
    report.refreshIntervalSeconds = 1;
    expect(validateReport(report).join(" ")).toContain("refreshIntervalSeconds");
  });

  test("validates references, layout, chart safety, and multi-select placement", () => {
    const report = createEmptyReport("Sales");
    report.parameters.push({ id: "parameter", key: "regions", label: "Regions", type: "multi_select", defaultValue: [] });
    report.datasets.push({ id: "dataset", name: "Sales", sql: "SELECT * FROM sales WHERE region = $regions" });
    report.blocks.push({ id: "block", type: "chart", datasetId: "dataset", spec: { mark: "bar", data: { url: "https://example.com" } }, layout: { x: 10, y: 0, w: 4, h: 4 } });
    const errors = validateReport(report).join(" ");
    expect(errors).toContain("multi-select");
    expect(errors).toContain("invalid layout");
    expect(errors).toContain("not allowed");
  });

  test("reports a precise path for a missing nested layout instead of throwing", () => {
    const report = createEmptyReport("Broken layout") as any;
    report.blocks.push({
      id: "chart",
      type: "chart",
      datasetId: "dataset",
      spec: { mark: "bar" },
      col: 0,
      width: 12,
    });
    expect(() => validateReport(report)).not.toThrow();
    expect(validateReport(report)).toContain("report.blocks[0].layout is required and must be {x, y, w, h}.");
  });

  test("allows an omitted markdown title but rejects malformed titles", () => {
    const report = createEmptyReport("Narrative");
    report.blocks.push({ id: "context", type: "markdown", markdown: "No separate title needed.", layout: { x: 0, y: 0, w: 12, h: 2 } });
    expect(validateReport(report)).toEqual([]);

    (report.blocks[0] as any).title = 42;
    expect(validateReport(report)).toContain("report.blocks[0].title must be a string.");
  });

  test("validates optional sparkline split configuration", () => {
    const report = createEmptyReport("Forecast trend") as any;
    report.datasets.push({ id: "weather", name: "Weather", sql: "SELECT 1 AS humidity, false AS is_forecast" });
    report.blocks.push({
      id: "humidity",
      type: "sparkline",
      datasetId: "weather",
      valueColumn: "humidity",
      splitColumn: "is_forecast",
      splitLabel: "Now",
      splitColor: "#7c3aed",
      layout: { x: 0, y: 0, w: 3, h: 2 },
    });
    expect(validateReport(report)).toEqual([]);

    delete report.blocks[0].splitColumn;
    expect(validateReport(report).join(" ")).toContain("splitColumn is required");
  });

  test("validates bounded AI narrative instructions, refresh policy, and snapshots", () => {
    const report = createEmptyReport("Narrative");
    report.datasets.push({ id: "weather", name: "Weather", sql: "SELECT 68 AS humidity" });
    report.blocks.push({
      id: "summary",
      type: "ai_narrative",
      datasetId: "weather",
      instruction: "Explain the current conditions.",
      columns: ["humidity"],
      maxRows: 25,
      refreshPolicy: "when_data_changes",
      snapshot: { markdown: "Humidity is 68%.", generatedAt: Date.now(), dataFingerprint: "abc123", model: "test-model", rowCount: 1 },
      layout: { x: 0, y: 0, w: 12, h: 4 },
    });
    expect(validateReport(report)).toEqual([]);

    (report.blocks[0] as any).maxRows = 101;
    (report.blocks[0] as any).refreshPolicy = "always";
    (report.blocks[0] as any).snapshot.rowCount = -1;
    const errors = validateReport(report).join(" ");
    expect(errors).toContain("maxRows");
    expect(errors).toContain("refreshPolicy");
    expect(errors).toContain("snapshot.rowCount");
  });

  test("validates block group references while accepting legacy reports without groups", () => {
    const report = createEmptyReport("Grouped weather");
    report.groups = [{ id: "glen-allen", title: "Glen Allen", tone: "green", titleSize: "large" }];
    report.blocks.push({ id: "conditions", type: "markdown", groupId: "glen-allen", markdown: "Conditions", layout: { x: 0, y: 0, w: 12, h: 2 } });
    expect(validateReport(report)).toEqual([]);

    report.blocks[0].groupId = "missing-city";
    expect(validateReport(report).join(" ")).toContain("group is missing");

    delete report.groups;
    delete report.blocks[0].groupId;
    expect(validateReport(report)).toEqual([]);
  });

  test("rejects unsupported group title sizes", () => {
    const report = createEmptyReport("Grouped weather") as any;
    report.groups = [{ id: "glen-allen", title: "Glen Allen", titleSize: "giant" }];
    expect(validateReport(report).join(" ")).toContain("report.groups[0].titleSize is unsupported");
  });

  test("rejects dataset IDs that collide as DuckDB relation names", () => {
    const report = createEmptyReport("Relations");
    report.datasets.push(
      { id: "Weather_Base", name: "First", sql: "SELECT 1" },
      { id: "weather_base", name: "Second", sql: "SELECT 2" },
    );
    expect(validateReport(report).join(" ")).toContain("conflict as SQL relation names");
  });

  test("validates safe conditional block appearance rules", () => {
    const report = createEmptyReport("Humidity alerts");
    report.datasets.push({ id: "weather", name: "Weather", sql: "SELECT 68 AS humidity" });
    report.blocks.push({
      id: "humidity",
      type: "kpi",
      datasetId: "weather",
      valueColumn: "humidity",
      appearance: {
        tone: "success",
        label: "In range",
        rules: [{ column: "humidity", operator: "greater_than", value: 65, tone: "warning", emphasis: "prominent", label: "Above preferred range" }],
      },
      layout: { x: 0, y: 0, w: 3, h: 2 },
    });
    expect(validateReport(report)).toEqual([]);

    report.blocks[0].appearance!.rules![0] = { ...report.blocks[0].appearance!.rules![0], operator: "between", value2: undefined };
    expect(validateReport(report).join(" ")).toContain("value2 must be a finite number");

    report.blocks[0] = { id: "note", type: "markdown", markdown: "Alert", appearance: { rules: [{ column: "humidity", operator: "equal", value: 68, tone: "danger", label: "Alert" }] }, layout: { x: 0, y: 0, w: 3, h: 2 } };
    expect(validateReport(report).join(" ")).toContain("conditional appearance requires a dataset-backed block");
  });

  test("rejects malformed map fields without throwing", () => {
    const report = createEmptyReport("Broken map") as any;
    report.datasets.push({ id: "dataset", name: "Places", sql: "SELECT 1" });
    report.blocks.push({ id: "map", type: "map", datasetId: "dataset", geometryColumn: 42, layout: { x: 0, y: 0, w: 12, h: 5 } });
    expect(() => validateReport(report)).not.toThrow();
    expect(validateReport(report).join(" ")).toContain("report.blocks[0].geometryColumn must be a string");
  });

  test("rejects cycles between SQL-driven parameter choices", () => {
    const report = createEmptyReport("Filters");
    report.parameters.push(
      { id: "pa", key: "a", label: "A", type: "select", defaultValue: null, options: { kind: "dataset", datasetId: "da", valueColumn: "value" } },
      { id: "pb", key: "b", label: "B", type: "select", defaultValue: null, options: { kind: "dataset", datasetId: "db", valueColumn: "value" } },
    );
    report.datasets.push(
      { id: "da", name: "A options", role: "parameter_options", sql: "SELECT value FROM a_options WHERE b = $b" },
      { id: "db", name: "B options", role: "parameter_options", sql: "SELECT value FROM b_options WHERE a = $a" },
    );
    expect(validateReport(report).join(" ")).toContain("dependency cycle");
  });

  test("validates declarative map configuration", () => {
    const report = createEmptyReport("Locations");
    report.datasets.push({ id: "locations", name: "Locations", sql: "SELECT * FROM locations" });
    report.blocks.push({
      id: "map",
      type: "map",
      datasetId: "locations",
      latitudeColumn: "latitude",
      longitudeColumn: "longitude",
      basemap: "none",
      style: { radius: 8, fillOpacity: 0.4 },
      layout: { x: 0, y: 0, w: 12, h: 6 },
    });
    expect(validateReport(report)).toEqual([]);

    report.blocks[0] = {
      id: "map",
      type: "map",
      datasetId: "locations",
      latitudeColumn: "latitude",
      style: { radius: 100, opacity: 2 },
      layout: { x: 0, y: 0, w: 12, h: 6 },
    };
    const errors = validateReport(report).join(" ");
    expect(errors).toContain("latitudeColumn and longitudeColumn");
    expect(errors).toContain("opacity");
    expect(errors).toContain("radius");
  });
});
