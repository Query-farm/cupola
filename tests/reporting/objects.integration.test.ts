import { afterAll, beforeAll, expect, test } from 'bun:test';
import { startReportingWorker } from './worker';
import { memoryStorage } from './fixtures';
import { prepareTransfer, resumeTransfer } from '../../src/lib/reporting/transfers';
import { listLocalObjects } from '../../src/lib/reporting/local-objects';
import { MutationJournal } from '../../src/lib/reporting/journal';
import { ReportClient } from '../../src/lib/reporting/client';
let a: Awaited<ReturnType<typeof startReportingWorker>>, b: typeof a;
beforeAll(async () => { a = await startReportingWorker('One'); b = await startReportingWorker('Two'); });
afterAll(async () => { await a?.stop(); await b?.stop(); });
const encoded = (kind: 'query' | 'notebook') => ({
  envelope: { title: `Shared ${kind}`, description: 'Shared definition', tags: ['team'], body_format: `cupola.${kind}/1`, data_sources: [], parameters: [] },
  body: new TextEncoder().encode(JSON.stringify(kind === 'query' ? { query: 'SELECT 42', context: {}, vendor: { keep: true } } : { version: 1, cells: [], context: {}, vendor: { keep: true } })),
});
for (const kind of ['notebook', 'query'] as const) test(`${kind}: HTTP history, legacy isolation, worker/device transfer and tab-independent copy`, async () => {
  const client = a.client(), definition = encoded(kind);
  const record = await client.call('create_report', { ...definition, request_id: crypto.randomUUID() });
  expect((record as any).object_kind).toBe(kind);
  expect((await client.call('list_reports', {}, undefined, 'vgi.reports.v1')).some(r => r.report_id === record.report_id)).toBe(false);
  await expect(client.call('get_report', { report_id: record.report_id }, undefined, 'vgi.reports.v1')).rejects.toMatchObject({ errorCode: 'NOT_FOUND' });
  const second = await client.call('commit_revision', { report_id: record.report_id, expected_revision_id: record.head_revision_id, request_id: crypto.randomUUID(), ...definition, envelope: { ...definition.envelope, title: 'Edited' } });
  expect((await client.call('list_revisions', { report_id: record.report_id })).map(r => r.author.id)).toEqual(['alice', 'alice']);
  expect((await client.call('get_report', { report_id: record.report_id, revision_id: record.head_revision_id })).envelope?.title).toBe(`Shared ${kind}`);
  const storage = memoryStorage(), factory = (url: string) => url === a.url ? a.client() : b.client();
  const job = await prepareTransfer({ kind: 'worker', url: a.url, record: second }, { url: null, folderId: null, name: 'Local' }, true, { scope: 'test', serviceUrl: a.url }, factory, storage);
  await resumeTransfer(job, factory, storage);
  const local = listLocalObjects('test', storage)[0];
  expect(local.kind).toBe(kind); expect(local.body).toEqual(definition.body);
  await expect(client.call('get_report', { report_id: record.report_id })).rejects.toMatchObject({ errorCode: 'NOT_FOUND' });
  const upload = await prepareTransfer({ kind: 'document', scope: 'test', document: local }, { url: b.url, folderId: null, name: 'Two' }, false, { scope: 'test', serviceUrl: a.url }, factory, storage);
  const done = await resumeTransfer(upload, factory, storage);
  expect((await b.client().call('get_report', { report_id: done.copied!.id })).body).toEqual(definition.body);
  expect(listLocalObjects('test', storage)).toHaveLength(1);
});
test('new object journal retries its original wire interface after a lost create reply', async () => {
  let drop = true;
  const client = new ReportClient(a.url, { token: async () => 'test-alice', fetch: (async (url, init) => {
    const response = await fetch(url, init);
    if (String(url).endsWith('/create_object') && drop) { drop = false; await response.arrayBuffer(); throw new Error('reply lost'); }
    return response;
  }) as typeof fetch });
  const storage = memoryStorage(), scope = await client.recoveryScope();
  const journal = new MutationJournal(client, scope, 'document', storage);
  await expect(journal.run('create_report', encoded('query'))).rejects.toThrow('reply lost');
  expect(journal.pending!.protocol).toBe('vgi.objects.v1');
  const restored = new MutationJournal(a.client(), scope, 'document', storage);
  const result = await restored.retry();
  expect((await a.client().call('list_revisions', { report_id: result.report_id }))).toHaveLength(1);
});

test('the unified client falls back to a real legacy-only report worker', async () => {
  const old = await startReportingWorker('Legacy', undefined, true);
  try {
    const client = old.client();
    expect(await client.discover()).toBe(true);
    expect(await client.protocolFor('create_report')).toBe('vgi.reports.v1');
    const report = { envelope: { ...encoded('query').envelope, body_format: 'text/markdown' }, body: new TextEncoder().encode('# Legacy report') };
    const created = await client.call('create_report', { ...report, request_id: crypto.randomUUID() });
    expect((await client.call('get_report', { report_id: created.report_id })).body).toEqual(report.body);
  } finally { await old.stop(); }
});
