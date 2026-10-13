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
