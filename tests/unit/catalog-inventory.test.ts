import { expect, test } from 'bun:test';
import { CatalogInventory, changesCatalog, type AttachedDatabase, type CatalogConnection } from '../../src/lib/catalog-inventory';
import type { CatalogData } from '../../src/lib/service';

const db = (name: string, type = 'vgi', id = name): AttachedDatabase => ({ name, type, id });
const catalog = (name: string, doc = name): CatalogData => ({ catalogName: name, catalogComment: doc, catalogTags: { 'vgi.doc_llm': doc }, schemas: [], defaultSchema: null });

const conn = (sourceUrl: string, catalogName: string, databaseType = 'vgi', extra: Partial<CatalogConnection> = {}): CatalogConnection => ({ sourceUrl, catalogName, databaseType, ...extra });
/** The single-catalog case: one connection, which is the default. */
function seedOne(inventory: CatalogInventory, seed: CatalogData, url: string, type = 'vgi') {
  inventory.setConnections(new Map([[seed.catalogName, conn(url, seed.catalogName, type)]]), seed.catalogName, [seed]);
}

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
  seedOne(f.inventory, catalog('alpha'), 'https://alpha.example');
  expect(f.inventory.getSnapshot().ready).toBe(false);
  f.setDatabases([db('alpha'), db('beta'), db('warehouse', 'ducklake'), db('local', 'duckdb'), db('memory', 'duckdb'), db('system'), db('temp')]);
  await f.inventory.activate();
  const entries = await f.inventory.current();
  expect(entries.map(c => c.catalogName)).toEqual(['alpha', 'beta', 'local', 'memory', 'warehouse']);
  expect(entries.find(c => c.catalogName === 'warehouse')?.databaseType).toBe('ducklake');
  expect(entries.filter(c => c.isDefault).map(c => c.catalogName)).toEqual(['alpha']);
  expect(entries.find(c => c.catalogName === 'beta')?.sourceUrl).toBeUndefined();
  expect(entries[0].catalogTags['vgi.doc_llm']).toBe('alpha');
});

test('detaching the default removes it; reusing its alias does not inherit connection context', async () => {
  const f = fixture();
  seedOne(f.inventory, catalog('alpha'), 'https://alpha.example');
  await f.inventory.activate();
  f.setDatabases([db('alpha', 'vgi', 'replacement'), db('memory', 'duckdb')]);
  await f.inventory.refresh();
  expect(f.inventory.getSnapshot().catalogs.find(c => c.catalogName === 'alpha')).toMatchObject({ isDefault: false, sourceUrl: undefined });
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

test('a Grainlift service seeds its alias and becomes the default once attached as grainlift', async () => {
  const f = fixture();
  seedOne(f.inventory, catalog('d1'), 'grainlift+https://gw.example', 'grainlift');
  f.setDatabases([db('d1', 'grainlift'), db('memory', 'duckdb')]);
  await f.inventory.activate();
  const [first] = await f.inventory.current();
  expect(first.catalogName).toBe('d1');
  expect(first.isDefault).toBe(true);
  expect(first.databaseType).toBe('grainlift');
  expect(first.sourceUrl).toBe('grainlift+https://gw.example');
});

test('several connections: each keeps its own context, ordered default first then workspace order', async () => {
  const f = fixture();
  const connections = new Map([
    ['sales', conn('https://a.example', 'sales', 'vgi', { attachOptions: { region: 'eu' }, secretOptionNames: ['api_key'], defaultSchema: 'main' })],
    ['sales_2', conn('https://b.example', 'sales')],
    ['zeta', conn('https://z.example', 'zeta')],
  ]);
  f.inventory.setConnections(connections, 'sales_2', [catalog('sales'), catalog('sales_2')]);
  expect(f.inventory.getSnapshot().catalogs.map(c => c.catalogName)).toEqual(['sales_2', 'sales']);
  f.setDatabases([db('aaa', 'duckdb'), db('zeta'), db('sales'), db('sales_2'), db('memory', 'duckdb')]);
  await f.inventory.activate();
  const entries = await f.inventory.current();
  expect(entries.map(c => c.catalogName)).toEqual(['sales_2', 'sales', 'zeta', 'aaa', 'memory']);
  expect(entries.find(c => c.catalogName === 'sales')).toMatchObject({ sourceUrl: 'https://a.example', serverCatalogName: 'sales', attachOptions: { region: 'eu' }, secretOptionNames: ['api_key'], isDefault: false });
  expect(entries.find(c => c.catalogName === 'sales_2')).toMatchObject({ sourceUrl: 'https://b.example', serverCatalogName: 'sales', isDefault: true });
  expect(entries.find(c => c.catalogName === 'aaa')?.sourceUrl).toBeUndefined();
  f.inventory.setDefault('sales');
  expect(f.inventory.getSnapshot().catalogs.map(c => c.catalogName)).toEqual(['sales', 'sales_2', 'zeta', 'aaa', 'memory']);
});

test('a configured catalog attached later (Retry) binds; a manual re-attach of a bound alias does not', async () => {
  const f = fixture();
  f.inventory.setConnections(new Map([['a', conn('https://a', 'a')], ['b', conn('https://b', 'b')]]), 'a');
  f.setDatabases([db('a'), db('memory', 'duckdb')]);
  await f.inventory.activate();
  f.setDatabases([db('a'), db('b', 'vgi', 'b-1'), db('memory', 'duckdb')]);
  await f.inventory.refresh();
  expect(f.inventory.getSnapshot().catalogs.find(c => c.catalogName === 'b')?.sourceUrl).toBe('https://b');
  f.setDatabases([db('a'), db('b', 'vgi', 'b-2'), db('memory', 'duckdb')]);
  await f.inventory.refresh();
  expect(f.inventory.getSnapshot().catalogs.find(c => c.catalogName === 'b')?.sourceUrl).toBeUndefined();
  f.inventory.rebind('b');
  await f.inventory.refresh();
  expect(f.inventory.getSnapshot().catalogs.find(c => c.catalogName === 'b')?.sourceUrl).toBe('https://b');
});

test('an attachment of the wrong type under a configured alias gets no context', async () => {
  const f = fixture();
  f.inventory.setConnections(new Map([['a', conn('https://a', 'a')]]), 'a');
  f.setDatabases([db('a', 'duckdb')]);
  await f.inventory.activate();
  expect(f.inventory.getSnapshot().catalogs[0]).toMatchObject({ sourceUrl: undefined, isDefault: false });
});

test('session-temporary DDL is not a catalog change', () => {
  for (const sql of [
    'CREATE TEMP VIEW v AS SELECT 1',
    'create or replace temporary table t AS SELECT 1',
    '/* x */ CREATE OR REPLACE TEMP VIEW temp.main."p_1" AS SELECT 1',
    'DROP VIEW IF EXISTS temp.main."p_1"',
    'DROP TABLE "temp".main.t',
    'CREATE TEMP MACRO m(x) AS x',
  ]) expect(changesCatalog(sql)).toBe(false);
  for (const sql of [
    'CREATE TABLE memory.main.t AS SELECT 1',
    'CREATE OR REPLACE VIEW v AS SELECT 1',
    'DROP TABLE t',
    'DROP TABLE templates.t',
    'CREATE TEMP VIEW v AS SELECT 1; CREATE TABLE t(i INT)',
  ]) expect(changesCatalog(sql)).toBe(true);
});

test('a metadata error returned by the loader keeps the last good metadata', async () => {
  let broken = false;
  const loaded = (name: string): CatalogData => ({ ...catalog(name), schemas: [{ info: { name: 'main' } as any, tables: [], views: [], functions: [] } as any] });
  const inventory = new CatalogInventory({
    list: async () => [db('alpha')],
    // The real loader (fetchAttachedCatalog) never throws: it returns what it
    // could read plus metadataError.
    load: async d => broken ? { ...catalog(d.name), schemas: [], metadataError: 'IO Error' } : loaded(d.name),
  });
  await inventory.activate();
  broken = true;
  await inventory.refresh();
  const [alpha] = inventory.getSnapshot().catalogs;
  expect(alpha.metadataError).toBe('IO Error');
  expect(alpha.schemas.map(s => s.info.name)).toEqual(['main']);
});

test('a refresh that finds nothing new publishes no new catalogs', async () => {
  const f = fixture();
  await f.inventory.activate();
  const before = f.inventory.getSnapshot();
  await f.inventory.refresh();
  const after = f.inventory.getSnapshot();
  expect(after.catalogs).toBe(before.catalogs);
  expect(after.revision).toBe(before.revision);
  f.setDatabases([db('alpha'), db('beta'), db('memory', 'duckdb')]);
  await f.inventory.refresh();
  const changed = f.inventory.getSnapshot();
  expect(changed.catalogs).not.toBe(before.catalogs);
  // Catalogs that did not change keep their objects.
  expect(changed.catalogs.find(c => c.catalogName === 'alpha')).toBe(before.catalogs.find(c => c.catalogName === 'alpha')!);
});

test('a failed listing is retried by the next current()', async () => {
  const f = fixture();
  await f.inventory.activate();
  f.failList(true);
  await f.inventory.refresh();
  expect(f.inventory.getSnapshot().error).toBe('Engine unavailable');
  f.failList(false);
  // No refresh() or invalidate(): a discovery tool's lookup recovers on its own.
  expect((await f.inventory.current()).map(c => c.catalogName)).toContain('alpha');
  expect(f.inventory.getSnapshot().error).toBeNull();
});

test('a refresh asked for while one is in flight runs another pass', async () => {
  let names = [db('old')];
  let release!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  const inventory = new CatalogInventory({
    list: async () => names,
    load: async d => { if (d.name === 'old') await barrier; return catalog(d.name); },
  });
  const first = inventory.activate();
  await Promise.resolve();
  // Changed outside any observed query (a server-side change): only Retry knows.
  names = [db('new')];
  const retry = inventory.refresh();
  release();
  await Promise.all([first, retry]);
  expect(inventory.getSnapshot().catalogs.map(c => c.catalogName)).toEqual(['new']);
});
