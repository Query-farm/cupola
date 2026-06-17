/**
 * Shared "smart insert" logic for dropping/clicking a table reference into a
 * SQL surface (the xterm shell and the CodeMirror editor). Extracted from
 * shell-init.ts so both surfaces behave identically.
 */
import { getColumns, type CatalogData } from "@/lib/service";

/** True when `text` looks like a bare dotted table/identifier reference
 *  (e.g. `cat.schema.table`) rather than an expression the user typed. */
export function isTableRef(text: string): boolean {
  return text.includes(".") && !text.includes(" ") && !text.includes("(");
}

/** Geometry column names for a dotted `cat.schema.table`, searched across the
 *  provided catalogs (primary + memory + attached). Empty if none / not found. */
function geometryColumns(
  dottedName: string,
  catalogs: (CatalogData | null | undefined)[],
): string[] {
  const parts = dottedName.split(".");
  if (parts.length !== 3) return [];
  const [cat, schema, table] = parts;
  for (const catData of catalogs) {
    if (!catData || catData.catalogName !== cat) continue;
    const s = catData.schemas.find((s) => s.info.name === schema);
    const t = s?.tables.find((t) => t.name === table);
    if (!t) continue;
    return getColumns(t).filter((c) => c.duckdbType === "GEOMETRY").map((c) => c.name);
  }
  return [];
}

/**
 * Build `SELECT * [EXCLUDE (geom...)] FROM <dotted> LIMIT 100` (no trailing
 * semicolon — the shell appends one; the editor doesn't need it). Geometry
 * columns are excluded since they have no useful textual representation.
 */
export function buildTableSelect(
  dottedName: string,
  catalogs: (CatalogData | null | undefined)[],
): string {
  const geom = geometryColumns(dottedName, catalogs);
  const exclude = geom.length > 0 ? ` EXCLUDE (${geom.join(", ")})` : "";
  return `SELECT *${exclude} FROM ${dottedName} LIMIT 100`;
}
