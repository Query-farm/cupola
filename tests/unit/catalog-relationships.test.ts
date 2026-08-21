import { describe, expect, test } from "bun:test";
import type { TableInfo } from "vgi/client";
import type { CatalogData, ColumnInfo, ForeignKeyInfo } from "../../src/lib/service";
import {
  buildCatalogRelationshipGraph,
  catalogRelationshipTableId,
  scopeCatalogRelationshipGraph,
} from "../../src/lib/catalog-relationships";

type TestTable = TableInfo & { _columnInfo: ColumnInfo[]; _cols: ColumnInfo[]; _foreignKeys: ForeignKeyInfo[] };

function table(
  schema: string,
  name: string,
  columns: Array<{ name: string; nullable?: boolean }>,
  options: { primaryKey?: number[]; unique?: number[]; foreignKeys?: ForeignKeyInfo[] } = {},
): TestTable {
  const columnInfo: ColumnInfo[] = columns.map((column) => ({
    name: column.name,
    nullable: column.nullable ?? false,
    arrowType: "Int64",
    duckdbType: "BIGINT",
  }));
  return {
    name,
    schema_name: schema,
    comment: null,
    tags: {},
    columns: new Uint8Array(),
    not_null_constraints: [],
    unique_constraints: options.unique ? [options.unique] : [],
    check_constraints: [],
    primary_key_constraints: options.primaryKey ? [options.primaryKey] : [],
    foreign_key_constraints: [],
    supports_insert: false,
    supports_update: false,
    supports_delete: false,
    supports_returning: false,
    supports_column_statistics: false,
    required_filters: [],
    _columnInfo: columnInfo,
    // table-select.test.ts installs a suite-wide service mock under Bun; this
    // parallel alias keeps this fixture valid both with and without it.
    _cols: columnInfo,
    _foreignKeys: options.foreignKeys ?? [],
  };
}

function catalog(tables: TestTable[]): CatalogData {
  return {
    catalogName: "sales",
    catalogComment: null,
    catalogTags: {},
    defaultSchema: "main",
    schemas: [{
      info: { name: "main", comment: null, tags: {}, attach_opaque_data: new Uint8Array() },
      tables,
      views: [],
      functions: [],
      macros: [],
    }],
  };
}

describe("catalog relationship graph", () => {
  test("preserves composite keys, optionality, and one-to-one cardinality", () => {
    const customers = table("main", "customers", [{ name: "tenant_id" }, { name: "id" }], { primaryKey: [0, 1] });
    const profiles = table(
      "main",
      "profiles",
      [{ name: "tenant_id" }, { name: "customer_id", nullable: true }, { name: "display_name" }],
      {
        unique: [0, 1],
        foreignKeys: [{
          columns: ["tenant_id", "customer_id"],
          referencedSchema: "main",
          referencedTable: "customers",
          referencedColumns: ["tenant_id", "id"],
          constraintName: "profiles_customer_fk",
        }],
      },
    );

    const graph = buildCatalogRelationshipGraph(catalog([customers, profiles]));
    expect(graph.relationships).toHaveLength(1);
    expect(graph.relationships[0]).toMatchObject({
      constraintName: "profiles_customer_fk",
      sourceColumns: ["tenant_id", "customer_id"],
      targetColumns: ["tenant_id", "id"],
      optional: true,
      oneToOne: true,
    });
    expect(graph.tables.find((item) => item.name === "profiles")?.foreignKeyColumns).toEqual(["tenant_id", "customer_id"]);
    expect(graph.tables.find((item) => item.name === "customers")?.referencedColumns).toEqual(["tenant_id", "id"]);
  });

  test("creates a labeled external target when referenced metadata is absent", () => {
    const events = table("main", "events", [{ name: "user_id" }], {
      foreignKeys: [{
        columns: ["user_id"],
        referencedCatalog: "identity",
        referencedSchema: "core",
        referencedTable: "users",
        referencedColumns: ["id"],
      }],
    });
    const graph = buildCatalogRelationshipGraph(catalog([events]));
    expect(graph.tables.find((item) => item.name === "users")).toMatchObject({
      catalog: "identity",
      schema: "core",
      external: true,
    });
  });

  test("focuses on an N-hop neighborhood and can omit unrelated tables", () => {
    const accounts = table("main", "accounts", [{ name: "id" }], { primaryKey: [0] });
    const orders = table("main", "orders", [{ name: "id" }, { name: "account_id" }], {
      foreignKeys: [{ columns: ["account_id"], referencedSchema: "main", referencedTable: "accounts", referencedColumns: ["id"] }],
    });
    const lines = table("main", "lines", [{ name: "order_id" }], {
      foreignKeys: [{ columns: ["order_id"], referencedSchema: "main", referencedTable: "orders", referencedColumns: ["id"] }],
    });
    const orphan = table("main", "orphan", [{ name: "id" }]);
    const graph = buildCatalogRelationshipGraph(catalog([accounts, orders, lines, orphan]));
    const focus = catalogRelationshipTableId("sales", "main", "accounts");

    expect(scopeCatalogRelationshipGraph(graph, { focusTableId: focus, depth: 1 }).tables.map((item) => item.name)).toEqual(["accounts", "orders"]);
    expect(scopeCatalogRelationshipGraph(graph, { focusTableId: focus, depth: 2 }).tables.map((item) => item.name)).toEqual(["accounts", "lines", "orders"]);
    expect(scopeCatalogRelationshipGraph(graph, { schema: "main" }).tables.map((item) => item.name)).not.toContain("orphan");
    expect(scopeCatalogRelationshipGraph(graph, { schema: "main", showIsolated: true }).tables.map((item) => item.name)).toContain("orphan");
  });
});
