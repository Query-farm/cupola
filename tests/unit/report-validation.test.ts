import { describe, expect, test } from "bun:test";
import { createEmptyReport } from "../../src/lib/reports/types";
import { validateReadOnlySql, validateReport } from "../../src/lib/reports/validation";

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

  test("validates block group references while accepting legacy reports without groups", () => {
    const report = createEmptyReport("Grouped weather");
    report.groups = [{ id: "glen-allen", title: "Glen Allen", tone: "green" }];
    report.blocks.push({ id: "conditions", type: "markdown", groupId: "glen-allen", markdown: "Conditions", layout: { x: 0, y: 0, w: 12, h: 2 } });
    expect(validateReport(report)).toEqual([]);

    report.blocks[0].groupId = "missing-city";
    expect(validateReport(report).join(" ")).toContain("group is missing");

    delete report.groups;
    delete report.blocks[0].groupId;
    expect(validateReport(report)).toEqual([]);
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
