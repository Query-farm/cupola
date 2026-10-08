/**
 * Where to take the reader after a DDL statement from the shell or the AI chat.
 *
 * This compares the inventory before and after the statement rather than
 * parsing its SQL. Parsing assumed every target was in `memory` and broke on
 * quoted names: `CREATE TABLE mydb.main.t` opened memory → schema `mydb` →
 * table `main`, and a TEMP table opened a memory table that did not exist. The
 * inventory already knows which catalog an unqualified name landed in (after
 * any `USE`), and TEMP objects are not in it.
 *
 * Pure apart from the types, so it unit-tests without the RPC graph.
 */

import type { CatalogData } from "./service";
import type { Selection } from "./tree";

interface Entry { selection: Selection; signature: string }

function objects(catalogs: readonly CatalogData[]): Map<string, Entry> {
  const out = new Map<string, Entry>();
  for (const catalog of catalogs) {
    for (const schema of catalog.schemas) {
      const schemaName = schema.info.name;
      for (const [type, list] of [["table", schema.tables], ["view", schema.views]] as const) {
        for (const object of list) {
          out.set(`${catalog.catalogName}\u0000${schemaName}\u0000${object.name}`, {
            selection: { type, name: object.name, schema: schemaName, catalog: catalog.catalogName },
            signature: JSON.stringify(object, (_k, v) => typeof v === "bigint" ? `${v}n` : v),
          });
        }
      }
    }
  }
  return out;
}

function schemas(catalogs: readonly CatalogData[]): Map<string, Selection> {
  const out = new Map<string, Selection>();
  for (const catalog of catalogs) {
    for (const schema of catalog.schemas) {
      const name = schema.info.name;
      out.set(`${catalog.catalogName}\u0000${name}`, { type: "schema", name, schema: name, catalog: catalog.catalogName });
    }
  }
  return out;
}

/** The page that shows what a DDL statement did, or null when it changed
 *  nothing the sidebar lists. In order: a new table or view, one that was
 *  replaced, the schema (or else catalog) a dropped one was in, a new schema. */
export function selectionAfterDdl(before: readonly CatalogData[], after: readonly CatalogData[]): Selection | null {
  const was = objects(before);
  const now = objects(after);
  for (const [key, entry] of now) if (!was.has(key)) return entry.selection;
  for (const [key, entry] of now) if (was.get(key)!.signature !== entry.signature) return entry.selection;

  const schemasNow = schemas(after);
  const catalogsNow = new Set(after.map(c => c.catalogName));
  const parent = (catalog: string, schema: string): Selection | null =>
    schemasNow.get(`${catalog}\u0000${schema}`)
      ?? (catalogsNow.has(catalog) ? { type: "catalog", name: catalog, catalog } : null);
  for (const [key, entry] of was) {
    if (!now.has(key)) return parent(entry.selection.catalog!, entry.selection.schema!);
  }
  const schemasBefore = schemas(before);
  for (const [key, selection] of schemasBefore) {
    if (!schemasNow.has(key) && catalogsNow.has(selection.catalog!)) return { type: "catalog", name: selection.catalog!, catalog: selection.catalog };
  }
  for (const [key, selection] of schemasNow) if (!schemasBefore.has(key)) return selection;
  return null;
}
