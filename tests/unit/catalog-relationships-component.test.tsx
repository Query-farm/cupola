import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, fireEvent, render, within } from "@testing-library/react";
import { CatalogRelationships } from "../../src/components/content/CatalogRelationships";
import { ui } from "../../src/lib/shell-bridge";
import type { CatalogData, ColumnInfo, ForeignKeyInfo } from "../../src/lib/service";

beforeAll(() => GlobalRegistrator.register());
afterEach(() => { cleanup(); ui.openInEditor = null; });
afterAll(() => GlobalRegistrator.unregister());

function testCatalog(): CatalogData {
  const columns = (names: string[]): ColumnInfo[] => names.map((name) => ({ name, nullable: false, arrowType: "Int64", duckdbType: "BIGINT" }));
  const table = (name: string, names: string[], foreignKeys: ForeignKeyInfo[] = []): any => {
    const info = columns(names);
    return {
      name, schema_name: "main", comment: null, tags: {}, columns: new Uint8Array(),
      not_null_constraints: [], unique_constraints: [], check_constraints: [],
      primary_key_constraints: name === "customers" ? [[0]] : [], foreign_key_constraints: [],
      supports_insert: false, supports_update: false, supports_delete: false,
      supports_returning: false, supports_column_statistics: false, required_filters: [],
      _columnInfo: info, _cols: info, _foreignKeys: foreignKeys,
    };
  };
  return {
    catalogName: "sales", catalogComment: null, catalogTags: {}, defaultSchema: "main",
    schemas: [{
      info: { name: "main", comment: null, tags: {}, attach_opaque_data: new Uint8Array() },
      tables: [
        table("customers", ["id", "name"]),
        table("orders", ["id", "customer_id"], [{ columns: ["customer_id"], referencedSchema: "main", referencedTable: "customers", referencedColumns: ["id"], constraintName: "orders_customer_fk" }]),
        table("audit_log", ["id", "event", "actor", "created_at", "payload", "source"]),
      ],
      views: [], functions: [], macros: [],
    }],
  };
}

describe("catalog relationship explorer", () => {
  test("renders declared column relationships and navigates to a table", () => {
    const onNavigate = mock(() => {});
    const view = render(<CatalogRelationships catalog={testCatalog()} onNavigate={onNavigate} />);
    expect(view.getByText("1 declared foreign keys across 2 tables")).toBeTruthy();
    expect(view.getByTestId("relationship-node-main-orders")).toBeTruthy();
    expect(within(view.getByTestId("relationship-node-main-orders")).getByText("1 of 2")).toBeTruthy();
    expect(view.getByRole("button", { name: /orders\.customer_id references customers\.id/i })).toBeTruthy();

    fireEvent.click(view.getByRole("button", { name: "Open main.orders" }));
    expect(onNavigate).toHaveBeenCalledWith({ type: "table", name: "orders", schema: "main", catalog: "sales" });
  });

  test("labels the four-column fallback as a preview", () => {
    const view = render(<CatalogRelationships catalog={testCatalog()} onNavigate={() => {}} />);
    fireEvent.click(view.getByRole("button", { name: "Unrelated" }));
    const audit = view.getByTestId("relationship-node-main-audit_log");
    const indicator = within(audit).getByText("Preview 4 of 6");
    expect(indicator.title).toContain("first 4 of 6 columns");
  });

  test("creates a quoted JOIN query from the selected relationship", () => {
    const openInEditor = mock((_sql: string, _options?: { autoRun?: boolean }) => {});
    ui.openInEditor = openInEditor;
    const view = render(<CatalogRelationships catalog={testCatalog()} onNavigate={() => {}} />);
    fireEvent.click(view.getByRole("button", { name: /orders\.customer_id references customers\.id/i }));
    fireEvent.click(view.getByRole("button", { name: "Create JOIN query" }));
    expect(openInEditor).toHaveBeenCalledTimes(1);
    expect(openInEditor.mock.calls[0][0]).toContain('FROM "sales"."main"."orders" AS source');
    expect(openInEditor.mock.calls[0][0]).toContain('source."customer_id" = target."id"');
  });
});
