import { expect, test } from "bun:test";
import {
  semanticBlockDefaults,
  semanticChartSpec,
  semanticOutput,
  formatSemanticValue,
  type SemanticPresentation,
} from "../../src/lib/reports/semantic-presentation";
import { createReportBlock } from "../../src/lib/reports/direct-editor";
import { createReportShowcase } from "../../src/lib/reports/showcase";
import {
  semanticBuilderShapeError,
  renameSemanticOutput,
} from "../../src/lib/reports/semantic-builder";
import { compileSemanticQuery } from "../../src/lib/semantic-compiler";
import { resolveReportSemanticQuery } from "../../src/lib/reports/semantic";
import {
  reportSemanticCatalogs,
  salesRef,
} from "../fixtures/report-semantic-catalogs";

const plan: SemanticPresentation = {
  outputs: [
    {
      name: "day",
      kind: "dimension",
      title: "Observation date",
      data_type: "DATE",
    },
    {
      name: "temperature",
      kind: "measure",
      title: "Average temperature",
      data_type: "DOUBLE",
      unit: "Cel",
      description: "Daily average.",
    },
  ],
  output_units: { temperature: "[degF]" },
};

test("chart and tooltip defaults use effective output metadata without mutating saved specs", () => {
  const spec = {
    layer: [
      {
        mark: "line",
        encoding: {
          x: { field: "day" },
          y: { field: "temperature" },
          tooltip: [{ field: "temperature" }],
        },
      },
    ],
  };
  const original = structuredClone(spec);
  const decorated = semanticChartSpec(spec, plan);
  expect(decorated.layer[0].encoding.x).toEqual({
    field: "day",
    title: "Observation date",
    type: "temporal",
  });
  expect(decorated.layer[0].encoding.y).toEqual({
    field: "temperature",
    title: "Average temperature ([degF])",
    type: "quantitative",
  });
  expect(decorated.layer[0].encoding.tooltip[0]).toEqual(
    decorated.layer[0].encoding.y,
  );
  expect(spec).toEqual(original);
});

test("explicit chart encodings and titles override model defaults, including intentionally hidden titles", () => {
  const spec = {
    mark: "bar",
    encoding: {
      x: { field: "day", type: "ordinal", title: "Week" },
      y: {
        field: "temperature",
        type: "quantitative",
        title: null,
        axis: { format: ".2f" },
      },
    },
  };
  expect(semanticChartSpec(spec, plan)).toEqual(spec);
  expect(semanticChartSpec(spec)).toBe(spec);
  const count = {
    mark: "bar",
    encoding: { y: { field: "temperature", aggregate: "count" } },
  };
  expect(semanticChartSpec(count, plan)).toEqual(count);
  const transformed = {
    ...spec,
    transform: [{ calculate: "datum.temperature / 100", as: "temperature" }],
  };
  expect(semanticChartSpec(transformed, plan)).toBe(transformed);
});

test("KPI and chart creation select semantic measures even when result dimensions come first", () => {
  const report = createReportShowcase();
  const kpi = createReportBlock(
    report,
    "kpi",
    "weather",
    ["day", "temperature"],
    plan,
  );
  expect(kpi.type === "kpi" && kpi.valueColumn).toBe("temperature");
  const chart = createReportBlock(
    report,
    "chart",
    "weather",
    ["temperature", "day"],
    plan,
  );
  expect(chart.type === "chart" && chart.spec.encoding.x.field).toBe("day");
  expect(chart.type === "chart" && chart.spec.encoding.y.field).toBe(
    "temperature",
  );
  expect(semanticBlockDefaults(kpi, plan).title).toBe("Average temperature");
  expect(
    semanticBlockDefaults({ ...kpi, title: "Custom title" }, plan).title,
  ).toBe("Custom title");
  expect(kpi.title).toBeUndefined();
});

test("units annotate values without scaling percentages or attaching units to nulls", () => {
  const format = (value: unknown) => (value == null ? "—" : String(value));
  expect(formatSemanticValue(68, "%", format)).toBe("68%");
  expect(formatSemanticValue(0.68, "%", format)).toBe("0.68%");
  expect(formatSemanticValue(20, "Cel", format)).toBe("20 °C");
  expect(formatSemanticValue(68, "[degF]", format)).toBe("68 °F");
  expect(formatSemanticValue(42, "EUR", format)).toBe("42 EUR");
  expect(formatSemanticValue(null, "USD", format)).toBe("—");
  expect(formatSemanticValue(2, "1", format)).toBe("2");
  expect(
    semanticOutput(
      { ...plan, output_units: { temperature: null } },
      "temperature",
    )?.unit,
  ).toBeNull();
});

test("alias changes affect output references but leave model members and literals intact", () => {
  const query = {
    measures: [{ ...salesRef, member_id: "revenue" }],
    filters: { member: "revenue", operator: "eq", value: "revenue" },
    derived_measures: [
      {
        name: "ratio",
        expression: {
          op: "coalesce",
          args: [
            { op: "member", member: "revenue" },
            { op: "literal", value: "revenue" },
          ],
        },
      },
    ],
  };
  const updated = renameSemanticOutput(query, "revenue", "total");
  expect(updated.filters).toEqual(query.filters);
  expect(updated.measures).toEqual(query.measures);
  expect(updated.derived_measures[0].expression.args).toEqual([
    { op: "member", member: "total" },
    { op: "literal", value: "revenue" },
  ]);
  expect(query.derived_measures[0].expression.args[0].member).toBe("revenue");
  const sorted = { order: [{ member: "ratio", direction: "desc" }] };
  expect(
    renameSemanticOutput(
      renameSemanticOutput(sorted, "ratio", ""),
      "",
      "new_ratio",
    ).order[0].member,
  ).toBe("new_ratio");
});

test("single-fact post-aggregation filters resolve aliases without exposing them to population filters", () => {
  const query = {
    measures: [{ ...salesRef, member_id: "revenue", alias: "net_sales" }],
    measure_filters: {
      member: "net_sales",
      operator: "gt" as const,
      value: 10,
    },
  };
  const compiled = compileSemanticQuery(reportSemanticCatalogs(), query);
  expect(compiled.ok).toBe(true);
  if (compiled.ok) {
    expect(compiled.plan.sql).toMatch(/HAVING .*SUM\(/);
    expect(compiled.plan.parameters).toEqual([10]);
  }
  const invalid = compileSemanticQuery(reportSemanticCatalogs(), {
    measures: query.measures,
    filters: query.measure_filters,
  });
  expect(invalid.ok).toBe(false);
  if (!invalid.ok)
    expect(invalid.diagnostics[0].code).toBe("unknown_filter_member");
});

test("malformed advanced query structure leaves a repair path; unsupported content is preserved", () => {
  expect(semanticBuilderShapeError({ measures: [null] })).toBe("measures");
  expect(semanticBuilderShapeError({ inputs: [{}] })).toBe("inputs");
  expect(
    semanticBuilderShapeError({ source_bindings: [{ entity: salesRef }] }),
  ).toBe("source_bindings");
  expect(semanticBuilderShapeError({ filters: { and: "bad" } })).toBe(
    "filters",
  );
  expect(
    semanticBuilderShapeError({
      derived_measures: [{ expression: { op: "coalesce", args: {} } }],
    }),
  ).toBe("derived_measures");
  expect(
    semanticBuilderShapeError({
      measures: [],
      derived_measures: [{ expression: { op: "future_op", new_field: true } }],
    }),
  ).toBeNull();
  expect(() =>
    resolveReportSemanticQuery(
      { inputs: [{ rows: [[{ report_number_draft: "-" }]] }] },
      { parameters: [] },
      {},
    ),
  ).toThrow("Complete the number entry");
});
