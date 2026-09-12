import { describe, expect, test } from "bun:test";
import type { CatalogData, ColumnInfo } from "@/lib/service";
import { compileSemanticQuery } from "@/lib/semantic-compiler";
import {
  fingerprintSemanticPlan,
  prepareSemanticReportDataset,
  resolveReportSemanticQuery,
  semanticParameterReferences,
} from "@/lib/reports/semantic";
import type { ReportDocumentV1, ReportSemanticDataset } from "@/lib/reports/types";

const semanticDataset: ReportSemanticDataset = {
  id: "revenue",
  name: "Revenue",
  kind: "semantic",
  query: {
    measures: [{ catalog_id: "com.example.sales", entity_id: "orders", member_id: "revenue" }],
    filters: {
      and: [
        { member: { catalog_id: "com.example.sales", entity_id: "orders", member_id: "country" }, operator: "eq", value: { report_parameter: "country" } },
        { member: { catalog_id: "com.example.sales", entity_id: "orders", member_id: "ordered_at" }, operator: "gte", value: { report_parameter: "period", part: "start" } },
      ],
    },
  },
};

const report: Pick<ReportDocumentV1, "parameters"> = {
  parameters: [
    { id: "country", key: "country", label: "Country", type: "select", defaultValue: "US" },
    { id: "period", key: "period", label: "Period", type: "date_range", defaultValue: { start: "2026-01-01", end: "2026-01-31" } },
  ],
};

function salesCatalog(alias = "sales_runtime", unit = "USD"): CatalogData {
  const columns = ["order_id", "country", "ordered_at", "amount"].map((name): ColumnInfo => ({
    name,
    arrowType: name === "amount" ? "DOUBLE" : "VARCHAR",
    duckdbType: name === "amount" ? "DOUBLE" : "VARCHAR",
    nullable: false,
  }));
  return {
    catalogName: alias,
    catalogComment: null,
    catalogTags: { "vgi.semantic_catalog": JSON.stringify({ catalog_id: "com.example.sales" }) },
    defaultSchema: "main",
    schemas: [{
      info: { name: "main", comment: null, tags: {} } as any,
      views: [],
      functions: [],
      macros: [],
      tables: [{
        name: "orders",
        schema_name: "main",
        comment: null,
        required_filters: [],
        _columnInfo: columns,
        tags: {
          "vgi.semantic_entity": JSON.stringify({ entity_id: "orders", grain: ["order_id"] }),
          "vgi.semantic_members": JSON.stringify([
            { member_id: "order_id", kind: "identifier", column: "order_id" },
            { member_id: "country", kind: "dimension", column: "country" },
            { member_id: "ordered_at", kind: "time_dimension", column: "ordered_at", timezone: "UTC", granularities: ["day"] },
            { member_id: "amount", kind: "dimension", column: "amount", unit },
            { member_id: "revenue", kind: "measure", aggregation: "sum", member: "amount", additivity: "additive" },
          ]),
        },
      } as any],
    }],
  };
}

describe("semantic report datasets", () => {
  test("resolves scalar and date-range report bindings without changing the saved intent", () => {
    const resolved = resolveReportSemanticQuery(semanticDataset.query, report, {
      country: "DE",
      period: { start: "2026-02-01", end: "2026-02-28" },
    }) as any;
    expect(resolved.filters.and[0].value).toBe("DE");
    expect(resolved.filters.and[1].value).toBe("2026-02-01");
    expect((semanticDataset.query.filters as any).and[0].value).toEqual({ report_parameter: "country" });
    expect(semanticParameterReferences(semanticDataset.query)).toEqual([
      { report_parameter: "country" },
      { report_parameter: "period", part: "start" },
    ]);
  });

  test("compiles through the public compiler and retains parameterized SQL", async () => {
    const catalog = salesCatalog();
    const prepared = await prepareSemanticReportDataset(semanticDataset, report, {
      country: "CA",
      period: { start: "2026-03-01", end: "2026-03-31" },
    }, [catalog]);
    if (!prepared.compilation.ok) throw new Error(JSON.stringify(prepared.compilation.diagnostics));
    const direct = compileSemanticQuery([catalog], prepared.request);
    expect(direct).toEqual(prepared.compilation);
    expect(prepared.compilation.plan.sql).toContain("?");
    expect(prepared.compilation.plan.sql).not.toContain("CA");
    expect(prepared.compilation.plan.parameters).toEqual(["CA", "2026-03-01"]);
    expect(prepared.compilation.plan.output_units).toEqual({ revenue: "USD" });
    expect(prepared.fingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  test("fingerprints semantic contracts independently of attachment aliases and detects real model drift", async () => {
    const first = compileSemanticQuery([salesCatalog("attached_a")], { measures: semanticDataset.query.measures });
    const renamed = compileSemanticQuery([salesCatalog("attached_b")], { measures: semanticDataset.query.measures });
    const changed = compileSemanticQuery([salesCatalog("attached_b", "EUR")], { measures: semanticDataset.query.measures });
    if (!first.ok || !renamed.ok || !changed.ok) throw new Error(JSON.stringify({ first, renamed, changed }));
    const firstFingerprint = await fingerprintSemanticPlan([salesCatalog("attached_a")], first.plan);
    expect(await fingerprintSemanticPlan([salesCatalog("attached_b")], renamed.plan)).toBe(firstFingerprint);
    expect(await fingerprintSemanticPlan([salesCatalog("attached_b", "EUR")], changed.plan)).not.toBe(firstFingerprint);

    const prepared = await prepareSemanticReportDataset(
      { ...semanticDataset, acceptedModelFingerprint: firstFingerprint },
      report,
      { country: "US", period: { start: "2026-01-01", end: "2026-01-31" } },
      [salesCatalog("new_alias", "EUR")],
    );
    expect(prepared.modelChanged).toBe(true);
  });

  test("rejects invalid report parameter references before compilation", () => {
    expect(() => resolveReportSemanticQuery({ parameters: { city: { report_parameter: "missing" } } }, report, {})).toThrow("Unknown report parameter");
    expect(() => resolveReportSemanticQuery({ parameters: { period: { report_parameter: "period" } } }, report, {})).toThrow("requires part");
  });
});
