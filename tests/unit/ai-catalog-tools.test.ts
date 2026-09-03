import { describe, expect, test } from "bun:test";
import {
  executeDescribeFunction,
  executeDescribeTable,
  executeListCatalogs,
  executeListCategories,
  executeListTables,
  REQUIRED_FILTERS_RULE,
} from "../../src/lib/ai-agent";
import type { CatalogData } from "../../src/lib/service";

function catalog(name: string, table: string, category = "reference"): CatalogData {
  return {
    catalogName: name,
    catalogComment: `${name} worker`,
    catalogTags: { "vgi.doc_llm": `${name} documentation`, "vgi.agent_test_tasks": "private" },
    defaultSchema: "main",
    schemas: [{
      info: {
        name: "main",
        comment: "Main schema",
        tags: { "vgi.categories": JSON.stringify([{ name: category, description: "Reference data" }]) },
        attach_opaque_data: new Uint8Array(),
      },
      tables: [{
        name: table,
        schema_name: "main",
        comment: `${table} rows`,
        tags: {
          "vgi.category": category,
          "vgi_required_filters": '[["id"]]',
          "vgi.keywords": '["place","reference"]',
          "vgi.example_queries": JSON.stringify([{ description: "all", sql: `SELECT * FROM ${name}.main.${table}` }]),
          "vgi.executable_examples": JSON.stringify([{ description: "dup", sql: `select * from ${name}.main.${table}` }]),
        },
        columns: new Uint8Array(),
        not_null_constraints: [], unique_constraints: [], check_constraints: [],
        primary_key_constraints: [], foreign_key_constraints: [],
        supports_insert: false, supports_update: false, supports_delete: false,
        supports_returning: false, supports_column_statistics: false, required_filters: [["id"]],
      }],
      views: [], functions: [], macros: [],
    }],
  } as CatalogData;
}

describe("multi-catalog agent discovery", () => {
  test("lists attached catalogs without exposing agent graders", () => {
    const result = JSON.parse(executeListCatalogs([catalog("alpha", "items"), catalog("beta", "places")]));
    expect(result.catalogs.map((item: any) => item.catalog)).toEqual(["alpha", "beta"]);
    expect(JSON.stringify(result)).not.toContain("agent_test_tasks");
  });

  test("requires an explicit catalog when multiple workers are attached", () => {
    const result = JSON.parse(executeListTables([catalog("alpha", "items"), catalog("beta", "places")]));
    expect(result.error).toContain("Catalog is required");
    expect(result.catalogs).toEqual(["alpha", "beta"]);
  });

  test("filters by category and returns fully-qualified identities", () => {
    const result = JSON.parse(executeListTables(
      [catalog("alpha", "items"), catalog("beta", "places")],
      { catalog: "beta", category: "reference" },
    ));
    expect(result.objects[0].qualified_name).toBe("beta.main.places");
    expect(result.objects[0].catalog).toBe("beta");
  });

  test("describes the selected worker and exposes required filters", () => {
    const result = JSON.parse(executeDescribeTable(
      [catalog("alpha", "items"), catalog("beta", "places")],
      "main", "places", "beta",
    ));
    expect(result.qualified_name).toBe("beta.main.places");
    expect(result.required_filters).toEqual([["id"]]);
    // The rule travels with the data, and the raw tag is not sent twice.
    expect(result.required_filters_rule).toBe(REQUIRED_FILTERS_RULE);
    expect(result.tags?.vgi_required_filters).toBeUndefined();
    expect(result.tags?.["vgi.example_queries"]).toBeUndefined();
    // Illustrative + executable examples collapse to one deduplicated list.
    expect(result.examples).toEqual([{ description: "all", sql: "SELECT * FROM beta.main.places" }]);
  });

  test("omits the rule when a table has no required filters", () => {
    const cat = catalog("alpha", "items");
    cat.schemas[0].tables[0].required_filters = [];
    delete (cat.schemas[0].tables[0].tags as any).vgi_required_filters;
    const result = JSON.parse(executeDescribeTable([cat], "main", "items"));
    expect(result.required_filters).toBeNull();
    expect(result.required_filters_rule).toBeUndefined();
  });

  test("listings decode JSON-valued tags", () => {
    const result = JSON.parse(executeListTables([catalog("alpha", "items")]));
    expect(result.objects[0].tags["vgi.keywords"]).toEqual(["place", "reference"]);
    expect(result.objects[0].tags.vgi_required_filters).toEqual([["id"]]);
    expect(result.objects[0].tags["vgi.example_queries"]).toBeUndefined();
  });

  test("describe_function lists examples for macros", () => {
    const cat = catalog("alpha", "items");
    cat.schemas[0].macros = [{
      name: "double_it", macro_type: "SCALAR", parameters: ["x"], parameter_types: null,
      parameter_default_values: null, definition: "x * 2", comment: "Doubles",
      tags: { "vgi.example_queries": JSON.stringify([{ description: "d", sql: "SELECT alpha.main.double_it(2)" }]) },
    }] as any;
    const result = JSON.parse(executeDescribeFunction([cat], { schema: "main", function: "double_it" }));
    expect(result.type).toBe("scalar_macro");
    expect(result.examples).toEqual([{ description: "d", sql: "SELECT alpha.main.double_it(2)" }]);
  });

  test("lists schema category registries per catalog", () => {
    const result = JSON.parse(executeListCategories([catalog("alpha", "items")], { catalog: "alpha" }));
    expect(result.schemas[0].categories[0].name).toBe("reference");
  });
});
