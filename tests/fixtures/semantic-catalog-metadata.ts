import { Field, Map_, Struct, Utf8, tableFromIPC, tableToIPC, vectorFromArray } from '@query-farm/apache-arrow';
import { engine } from '../../src/lib/shell-bridge';
import { catalogInventory } from '../../src/lib/catalog-store';
import { normalizeTags } from '../../src/lib/tags';
import type { CatalogData } from '../../src/lib/service';

/** Native fixture tables carry synthetic VGI semantic tags. Supply those tags
 * at the metadata-query boundary so tests exercise the session inventory too. */
export async function installSemanticCatalogMetadata(catalogs: CatalogData[]) {
  const query = engine.query!;
  const mapType = new Map_<Utf8, Utf8>(new Field('entries', new Struct<{ key: Utf8; value: Utf8 }>([
    new Field('key', new Utf8(), false), new Field('value', new Utf8()),
  ]), false), false);
  engine.query = async (sql, options) => {
    const result = await query(sql, options);
    if (!result.ok || !result.arrowBuffers?.length || !/duckdb_(?:databases|schemas|tables)\(\)/.test(sql)) return result;
    const table = tableFromIPC(result.arrowBuffers[0]);
    if (!table.getChild('tags')) return result;
    const tags = Array.from({ length: table.numRows }, (_, index) => {
      const row = table.get(index)!;
      const catalog = catalogs.find(c => c.catalogName === row.database_name);
      const schema = catalog?.schemas.find(s => s.info.name === row.schema_name);
      const override = sql.includes('duckdb_databases()') ? catalog?.catalogTags
        : sql.includes('duckdb_schemas()') ? schema?.info.tags
        : schema?.tables.find(t => t.name === row.table_name)?.tags;
      return new Map(Object.entries(override ?? normalizeTags(row.tags)));
    });
    const annotated = table.setChild('tags', vectorFromArray(tags, mapType));
    return { ...result, arrowBuffers: [tableToIPC(annotated).slice().buffer as ArrayBuffer] };
  };
  catalogInventory.invalidate();
  await catalogInventory.refresh();
}
