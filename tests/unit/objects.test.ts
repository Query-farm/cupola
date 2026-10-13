import { expect, test } from 'bun:test';
import { decodeNotebook, encodeDocument, openDocumentConnection, assertDocumentSources } from '../../src/lib/reporting/documents';
import { defaultChart } from '../../src/lib/notebooks/model';
import { engine } from '../../src/lib/shell-bridge';
import { record } from '../reporting/fixtures';

test('notebook round trip preserves unknown cell/chart metadata and excludes local execution state', () => {
  const original = { version: 1, context: { vendorContext: 6 }, parameters: [{ id: 'parameter', key: 'limit', vendorPresentation: 7 }], cells: [{ id: 'cell', type: 'sql', title: 'Query', source: 'SELECT 1', collapsed: false, vendorCell: 3, charts: [{ ...defaultChart([]), vendorChart: 4 }] }], vendorBody: 5 };
  const r = { ...record(), envelope: { ...record().envelope!, body_format: 'cupola.notebook/1', data_sources: [], parameters: [{ key: 'limit', label: 'Limit', type: 'number' as const, required: false, default_json: '10', options: [] }] }, body: new TextEncoder().encode(JSON.stringify(original)) };
  const notebook = decodeNotebook(r, 'https://example.test', 'private-workspace', 'local-id'); notebook.values = {};
  const binding = { url: 'https://example.test', record: r, original, context: { default_source_alias: null, default_schema: null } };
  const encoded = encodeDocument('notebook', notebook, [], 'private-workspace', binding);
  const body = JSON.parse(new TextDecoder().decode(encoded.body));
  expect(body.context.vendorContext).toBe(6); expect(body.parameters[0].vendorPresentation).toBe(7);
  expect(body.vendorBody).toBe(5); expect(body.cells[0].vendorCell).toBe(3); expect(body.cells[0].charts[0].vendorChart).toBe(4);
  expect(body.workspaceId).toBeUndefined(); expect(body.values).toBeUndefined(); expect(body.id).toBeUndefined();
});

test('a shared query uses its declared default and refuses another service under the same alias', async () => {
  const before = { statuses: engine.catalogStatuses, status: engine.lifecycleStatus, connection: engine.openConnection, default: engine.defaultCatalog };
  const source = { alias: 'finance', attachment_id: 'original-attachment', location: 'https://source.test/library', catalog_name: 'sales', label: '', required: true };
  const context = { default_source_alias: 'finance', default_schema: 'quarterly' };
  try {
    engine.lifecycleStatus = 'ready'; engine.defaultCatalog = { ...before.default, alias: 'wrong-workspace-default', schema: 'other' };
    engine.catalogStatuses = new Map([['finance', { alias: 'finance', url: 'https://other.test', catalogName: 'sales', state: 'attached' }]]);
    expect(() => assertDocumentSources([source], context)).toThrow('Connect sales');
    engine.catalogStatuses = new Map([['finance', { alias: 'finance', url: source.location, catalogName: 'sales', state: 'attached' }]]);
    const statements: string[] = [];
    engine.openConnection = async () => ({ query: async (sql: string) => { statements.push(sql); return { ok: true }; }, close: async () => {} }) as any;
    await openDocumentConnection({ context, original: {}, record: { ...record(), envelope: { ...record().envelope!, data_sources: [source] } } });
    expect(statements).toEqual(['USE "finance"."quarterly"']);
    statements.length = 0;
    await openDocumentConnection({ context: { default_source_alias: null, default_schema: null }, original: {}, record: { ...record(), envelope: { ...record().envelope!, data_sources: [] } } });
    expect(statements).toEqual(['USE "memory"."main"']);
  } finally { engine.catalogStatuses = before.statuses; engine.lifecycleStatus = before.status; engine.openConnection = before.connection; engine.defaultCatalog = before.default; }
});

test('optional absent sources do not block execution, but an attached alias cannot silently change identity', () => {
  const before = engine.catalogStatuses;
  const source = { alias: 'unused', attachment_id: 'unused', location: 'https://source.test', catalog_name: 'sales', label: '', required: false };
  try {
    engine.catalogStatuses = new Map();
    expect(() => assertDocumentSources([source], { default_source_alias: null, default_schema: null })).not.toThrow();
    expect(() => assertDocumentSources([source], { default_source_alias: 'unused', default_schema: 'main' })).toThrow('Connect sales');
    engine.catalogStatuses.set('unused', { alias: 'unused', url: 'https://different.test', catalogName: 'sales', state: 'attached' });
    expect(() => assertDocumentSources([source], { default_source_alias: null, default_schema: null })).toThrow('Connect sales');
  } finally { engine.catalogStatuses = before; }
});

test('saved query sessions retain connection state across revisions and reset only for execution context changes', async () => {
  const { DocumentQuerySession } = await import('../../src/lib/reporting/documents');
  const before = { statuses: engine.catalogStatuses, status: engine.lifecycleStatus, connection: engine.openConnection };
  let opens = 0, closes = 0;
  const statements: string[] = [];
  try {
    engine.lifecycleStatus = 'ready'; engine.catalogStatuses = new Map();
    engine.openConnection = async () => { opens++; return { query: async (sql: string) => { statements.push(sql); return { ok: true }; }, close: async () => { closes++; } } as any; };
    const binding = { url: 'https://example.test', record: { ...record(), envelope: { ...record().envelope!, data_sources: [] } }, original: { setup_sql: 'CREATE TEMP TABLE setup AS SELECT 1' }, context: { default_source_alias: null, default_schema: null } };
    const session = new DocumentQuerySession();
    await session.query(binding, 'CREATE TEMP TABLE work AS SELECT 2');
    await session.query({ ...binding, record: { ...binding.record, revision_number: 2n } }, 'SELECT * FROM work');
    expect(opens).toBe(1); expect(closes).toBe(0);
    expect(statements).toEqual(['USE "memory"."main"', 'CREATE TEMP TABLE setup AS SELECT 1', 'CREATE TEMP TABLE work AS SELECT 2', 'SELECT * FROM work']);
    await session.query({ ...binding, original: { setup_sql: 'SELECT 3' } }, 'SELECT 4');
    expect(opens).toBe(2); expect(closes).toBe(1);
    await session.close(); expect(closes).toBe(2);
    await expect(session.query(binding, 'SELECT 5')).rejects.toThrow('closed');
  } finally { engine.catalogStatuses = before.statuses; engine.lifecycleStatus = before.status; engine.openConnection = before.connection; }
});

test('acknowledged query content becomes dirty again on further edits or a source change', async () => {
  const { documentIsDirty } = await import('../../src/lib/reporting/documents');
  const binding = { url: 'https://example.test', record: { ...record(), envelope: { ...record().envelope!, title: 'Sales' } }, original: { query: 'SELECT 1' }, context: { default_source_alias: null, default_schema: null } };
  const doc = { id: 'query', name: 'Sales', sql: 'SELECT 1', createdAt: 0, updatedAt: 0 };
  expect(documentIsDirty('query', doc, binding)).toBe(false);
  expect(documentIsDirty('query', { ...doc, sql: 'SELECT 2' }, binding)).toBe(true);
  expect(documentIsDirty('query', doc, { ...binding, configurationDraft: { sources: [], context: { default_source_alias: 'sales', default_schema: 'main' } } })).toBe(true);
});

test('closing during a source reset cannot open or leak another connection', async () => {
  const { DocumentQuerySession } = await import('../../src/lib/reporting/documents');
  const before = { statuses: engine.catalogStatuses, status: engine.lifecycleStatus, connection: engine.openConnection };
  let opens = 0, finishClose!: () => void;
  try {
    engine.lifecycleStatus = 'ready'; engine.catalogStatuses = new Map();
    engine.openConnection = async () => { opens++; return { query: async () => ({ ok: true }), close: () => new Promise<void>(resolve => { finishClose = resolve; }) } as any; };
    const binding = { url: 'https://example.test', record: { ...record(), envelope: { ...record().envelope!, data_sources: [] } }, original: {}, context: { default_source_alias: null, default_schema: null } };
    const session = new DocumentQuerySession();
    await session.query(binding, 'SELECT 1');
    const resetting = session.query({ ...binding, original: { setup_sql: 'SELECT 2' } }, 'SELECT 3');
    await Promise.resolve();
    await session.close(); finishClose();
    await expect(resetting).rejects.toThrow('closed');
    expect(opens).toBe(1);
  } finally { engine.catalogStatuses = before.statuses; engine.lifecycleStatus = before.status; engine.openConnection = before.connection; }
});
