/**
 * Shared "smart insert" logic for dropping/clicking a table reference into a
 * SQL surface (the xterm shell and the CodeMirror editor). Extracted from
 * shell-init.ts so both surfaces behave identically.
 */
import { getColumns, type CatalogData } from "@/lib/service";

const IDENTIFIER = String.raw`(?:"(?:[^"]|"")*"|[\p{L}_][\p{L}\p{N}_$]*)`;
const TABLE_REF = new RegExp(`^${IDENTIFIER}(?:\\s*\\.\\s*${IDENTIFIER})+$`, "u");

/** Decode quoted SQL identifiers, including aliases containing spaces/dots. */
function tableRefParts(text: string): string[] | null {
  if (!TABLE_REF.test(text)) return null;
  return [...text.matchAll(new RegExp(IDENTIFIER, "gu"))].map(([part]) =>
    part.startsWith('"') ? part.slice(1, -1).replaceAll('""', '"') : part,
  );
}

/** True for dotted identifiers, including quoted SQL aliases. */
export function isTableRef(text: string): boolean {
  return tableRefParts(text) !== null;
}

/** Geometry column names for a dotted `cat.schema.table`, searched across the
 *  provided catalogs (primary + memory + attached). Empty if none / not found. */
function geometryColumns(
  dottedName: string,
  catalogs: (CatalogData | null | undefined)[],
): string[] {
  const parts = tableRefParts(dottedName);
  if (!parts || parts.length !== 3) return [];
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
