import { expect, test } from "bun:test";
import { semanticOutputLabel } from "../../src/lib/reports/semantic-presentation";
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

test("output labels use the model title and unit, falling back to the column name", () => {
  expect(semanticOutputLabel({ name: "temperature", kind: "measure", title: "Average temperature", unit: "Cel" }, "temperature")).toBe("Average temperature (Cel)");
  expect(semanticOutputLabel({ name: "ratio", kind: "measure", unit: "1" }, "ratio")).toBe("ratio");
  expect(semanticOutputLabel(undefined, "net_revenue")).toBe("net revenue");
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
