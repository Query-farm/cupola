/**
 * A table or view as the sidebar hover card and the editor's Inspector show
 * it: its columns, keys and description, looked up from the session catalogs.
 */
import { getColumns, type CatalogData, type ColumnInfo } from "./service";
import type { TableInfo, ViewInfo } from "./vgi-catalog-types";
import { getTag, TAG_DOC_MD, TAG_TITLE } from "./tags";

export interface Relation {
  kind: "table" | "view";
  catalog: string;
  schema: string;
  name: string;
  /** Empty for a VGI view, whose columns are only known to the engine. */
  columns: ColumnInfo[];
  primaryKey: Set<string>;
  description: string;
  docMd?: string;
  source: TableInfo | ViewInfo;
}

export function findRelation(
  catalogs: readonly CatalogData[],
  sel: { type: string; catalog?: string; schema?: string; name: string } | null | undefined,
): Relation | null {
  if (!sel?.catalog || !sel.schema || (sel.type !== "table" && sel.type !== "view")) return null;
  const schema = catalogs.find((c) => c.catalogName === sel.catalog)?.schemas.find((s) => s.info.name === sel.schema);
  if (!schema) return null;
  if (sel.type === "table") {
    const table = schema.tables.find((t) => t.name === sel.name);
    if (!table) return null;
    const columns = getColumns(table);
    const primaryKey = new Set(
      table.primary_key_constraints?.flatMap((pk) => pk.map((i) => columns[i]?.name).filter((n): n is string => !!n)) ?? [],
    );
    return {
      kind: "table", catalog: sel.catalog, schema: sel.schema, name: table.name, columns, primaryKey,
      description: (table.comment || getTag(table.tags, TAG_TITLE) || "").trim(),
      docMd: getTag(table.tags, TAG_DOC_MD) || undefined,
      source: table,
    };
  }
  const view = schema.views.find((v) => v.name === sel.name);
  if (!view) return null;
  const override = (view as ViewInfo & { _columnInfo?: ColumnInfo[] })._columnInfo;
  return {
    kind: "view", catalog: sel.catalog, schema: sel.schema, name: view.name,
    columns: Array.isArray(override) ? override : [],
    primaryKey: new Set(),
    description: (view.comment || getTag(view.tags, TAG_TITLE) || "").trim(),
    docMd: getTag(view.tags, TAG_DOC_MD) || undefined,
    source: view,
  };
}
