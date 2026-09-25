import { expect, test } from 'bun:test';
import { CatalogInventory, changesCatalog, type AttachedDatabase } from '../../src/lib/catalog-inventory';
import type { CatalogData } from '../../src/lib/service';

const db = (name: string, type = 'vgi', id = name): AttachedDatabase => ({ name, type, id });
const catalog = (name: string, doc = name): CatalogData => ({ catalogName: name, catalogComment: doc, catalogTags: { 'vgi.doc_llm': doc }, schemas: [], defaultSchema: null });

function fixture() {
  let databases = [db('alpha'), db('memory', 'duckdb'), db('system', 'duckdb'), db('temp', 'duckdb')];
  let failures = new Set<string>();
  let listError = false;
  const inventory = new CatalogInventory({
    list: async () => { if (listError) throw new Error('Engine unavailable'); return databases; },
    load: async d => { if (failures.has(d.name)) throw new Error('Bad metadata'); return catalog(d.name); },
  });
  return { inventory, setDatabases: (next: AttachedDatabase[]) => { databases = next; }, fail: (names: string[]) => { failures = new Set(names); }, failList: (value: boolean) => { listError = value; } };
}

test('bootstrap is provisional; every user attachment is discovered with its real type', async () => {
  const f = fixture();
  f.inventory.seed(catalog('alpha'), 'https://alpha.example');
  expect(f.inventory.getSnapshot().ready).toBe(false);
  f.setDatabases([db('alpha'), db('beta'), db('warehouse', 'ducklake'), db('local', 'duckdb'), db('memory', 'duckdb'), db('system'), db('temp')]);
  await f.inventory.activate();
  const entries = await f.inventory.current();
  expect(entries.map(c => c.catalogName)).toEqual(['alpha', 'beta', 'local', 'memory', 'warehouse']);
  expect(entries.find(c => c.catalogName === 'warehouse')?.databaseType).toBe('ducklake');
  expect(entries.filter(c => c.primary).map(c => c.catalogName)).toEqual(['alpha']);
  expect(entries.find(c => c.catalogName === 'beta')?.sourceUrl).toBeUndefined();
  expect(entries[0].catalogTags['vgi.doc_llm']).toBe('alpha');
});

test('detaching the primary removes it; reusing its alias does not inherit connection context', async () => {
  const f = fixture();
  f.inventory.seed(catalog('alpha'), 'https://alpha.example');
  await f.inventory.activate();
  f.setDatabases([db('alpha', 'vgi', 'replacement'), db('memory', 'duckdb')]);
  await f.inventory.refresh();
  expect(f.inventory.getSnapshot().catalogs.find(c => c.catalogName === 'alpha')).toMatchObject({ primary: false, sourceUrl: undefined });
  f.setDatabases([db('memory', 'duckdb')]);
  await f.inventory.refresh();
  expect(f.inventory.getSnapshot().catalogs.map(c => c.catalogName)).toEqual(['memory']);
});

test('metadata failure keeps the catalog visible with an error and retry repairs it', async () => {
  const f = fixture();
  f.fail(['alpha']);
  await f.inventory.activate();
  expect(f.inventory.getSnapshot().catalogs.find(c => c.catalogName === 'alpha')?.metadataError).toBe('Bad metadata');
  expect(f.inventory.getSnapshot().catalogs.find(c => c.catalogName === 'memory')?.metadataError).toBeUndefined();
  f.fail([]);
  await f.inventory.refresh();
  expect(f.inventory.getSnapshot().catalogs.find(c => c.catalogName === 'alpha')?.metadataError).toBeUndefined();
  f.failList(true);
  await f.inventory.refresh();
  expect(f.inventory.getSnapshot().catalogs).toHaveLength(2);
  expect(f.inventory.getSnapshot().error).toBe('Engine unavailable');
  await expect(f.inventory.current()).rejects.toThrow('Catalog discovery failed');
  f.failList(false);
  await f.inventory.refresh();
  expect(f.inventory.getSnapshot().error).toBeNull();
});

test('a failed replacement attachment never inherits the old catalog metadata', async () => {
  const f = fixture();
  await f.inventory.activate();
  f.setDatabases([db('alpha', 'vgi', 'new')]);
  f.fail(['alpha']);
  await f.inventory.refresh();
  expect(f.inventory.getSnapshot().catalogs[0].catalogTags).toEqual({});
});

test('mutation during a metadata read discards stale results and coalesces refreshes', async () => {
  let names = [db('old')];
  let release!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  const snapshots: string[][] = [];
  const inventory = new CatalogInventory({
    list: async () => names,
    load: async d => { if (d.name === 'old') await barrier; return catalog(d.name); },
  });
  inventory.subscribe(() => { if (inventory.getSnapshot().ready) snapshots.push(inventory.getSnapshot().catalogs.map(c => c.catalogName)); });
  const first = inventory.activate();
  await Promise.resolve();
  names = [db('new')];
  inventory.invalidate();
  const second = inventory.current();
  release();
  await first;
  expect((await second).map(c => c.catalogName)).toEqual(['new']);
  expect(snapshots.every(names => !names.includes('old'))).toBe(true);
});

test('recognizes changes in comments and batches without reacting to quoted SQL text', () => {
  expect(changesCatalog('/* outer /* nested ; */ still comment */ ATTACH x')).toBe(true);
  expect(changesCatalog('/* outer /* nested */ ; ATTACH x */ SELECT 1')).toBe(false);
  for (const sql of ["attach ':memory:' as other", '-- note\nDETACH other', '/* note */ CREATE TABLE t(i INT)', 'SELECT 1; /* note */ ATTACH x', 'ROLLBACK', 'COMMIT', "COMMENT ON TABLE t IS 'doc'"])
    expect(changesCatalog(sql)).toBe(true);
  for (const sql of ["SELECT 'ATTACH; DROP'", 'SELECT $$; ATTACH x$$', '-- ATTACH x', 'SELECT * FROM duckdb_databases()', 'EXPLAIN CREATE TABLE t(i INT)', 'SET VARIABLE x = 1'])
    expect(changesCatalog(sql)).toBe(false);
});
