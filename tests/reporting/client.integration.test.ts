import { afterAll, beforeAll, expect, test } from 'bun:test';
import { startReportingWorker } from './worker';
import { nativeOnlyParameters, report } from './fixtures';
import { decodeReport, encodeReport } from '../../src/lib/reporting/body';
import { ReportClient, reportError } from '../../src/lib/reporting/client';
import { MutationJournal } from '../../src/lib/reporting/journal';
import { memoryStorage } from './fixtures';

let worker: Awaited<ReturnType<typeof startReportingWorker>>;
beforeAll(async () => { worker = await startReportingWorker(); });
afterAll(async () => { await worker?.stop(); });
test('worker accepts Cupola-only controls and exact public parameter defaults together', async () => {
  const document = { ...report('Parameter interoperability'), parameters: [...nativeOnlyParameters,
    { id: 'public', key: 'public', label: 'Public choice', type: 'select' as const, required: false, defaultValue: 0, options: { kind: 'static' as const, values: [{ label: 'Zero', value: 0 }, { label: 'One', value: 1 }] } },
  ] };
  const c = worker.client();
  const encoded = encodeReport(document, { description: '', tags: [] });
  expect(encoded.envelope.parameters.map(p => p.key)).toEqual(['public']);
  const created = await c.call('create_report', { request_id: crypto.randomUUID(), envelope: encoded.envelope, body: encoded.body });
  expect(decodeReport(created, worker.url).parameters).toEqual(document.parameters);
  await c.call('delete_report', { request_id: crypto.randomUUID(), report_id: created.report_id, expected_version: created.version });
});
test('all seventeen protocol methods cross real Python HTTP with permission and CAS enforcement', async () => {
  const c = worker.client(), reader = worker.client(null);
  expect(await c.discover()).toBe(true);
  expect((await c.call('get_report_service_info', {})).body_formats).toContain('cupola.evidence/1');
  const folder = await c.call('create_folder', { request_id: 'folder', name: 'Finance' });
  const renamed = await c.call('update_folder', { request_id: 'rename', folder_id: folder.folder_id, expected_version: folder.version, name: 'Markets', parent_folder_id: null });
  expect((await c.call('get_folder', { folder_id: folder.folder_id })).name).toBe('Markets');
  expect((await c.call('list_folders', {}))[0].version).toBe(2n);
  const { envelope, body } = encodeReport(report(), { description: 'Market report', tags: ['finance'] });
  const first = await c.call('create_report', { request_id: 'create', envelope, body, folder_id: folder.folder_id });
  expect(decodeReport(await c.call('get_report', { report_id: first.report_id }), worker.url).source).toBe(report().source);
  expect((await c.call('list_reports', { folder_id: folder.folder_id }))[0].version).toBe(1n);
  const next = await c.call('commit_revision', { request_id: 'edit', report_id: first.report_id, expected_revision_id: first.head_revision_id, envelope: { ...envelope, title: 'Updated' }, body });
  await expect(c.call('commit_revision', { request_id: 'stale', report_id: first.report_id, expected_revision_id: first.head_revision_id, envelope, body })).rejects.toMatchObject({ errorCode: 'ABORTED' });
  await c.call('publish', { request_id: 'publish', report_id: first.report_id, revision_id: next.head_revision_id, expected_published_revision_id: null });
  expect(await reader.call('list_reports', {})).toEqual([]); // Publication does not bypass private folders.
  let current = await c.call('get_report', { report_id: first.report_id });
  await c.call('move_report', { request_id: 'move', report_id: first.report_id, expected_version: current.version, folder_id: null });
  expect((await reader.call('get_report', { report_id: first.report_id })).envelope!.title).toBe('Updated');
  await expect(reader.call('delete_report', { request_id: 'forbidden', report_id: first.report_id, expected_version: 4n })).rejects.toMatchObject({ errorCode: 'PERMISSION_DENIED' });
  current = await c.call('get_report', { report_id: first.report_id });
  await c.call('redact_revision', { request_id: 'redact', report_id: first.report_id, revision_id: first.head_revision_id, expected_version: current.version, reason: 'Outdated content' });
  expect((await c.call('list_revisions', { report_id: first.report_id }))[1].redaction_reason).toBe('Outdated content');
  const owner = { owner_ref: { kind: 'principal', id: 'bob', display_name: '' }, parent_owner_ref: null };
  current = await c.call('get_report', { report_id: first.report_id });
  await c.call('set_ownership', { request_id: 'transfer', report_id: first.report_id, expected_version: current.version, ownership: owner });
  await c.call('set_folder_ownership', { request_id: 'folder-owner', folder_id: folder.folder_id, expected_version: renamed.version, ownership: owner });
  const bob = worker.client('test-bob');
  const bobFolder = await bob.call('get_folder', { folder_id: folder.folder_id });
  await bob.call('delete_folder', { request_id: 'delete-folder', folder_id: folder.folder_id, expected_version: bobFolder.version });
  const bobReport = await bob.call('get_report', { report_id: first.report_id });
  expect(bobReport.created_by.id).toBe('alice');
  await bob.call('delete_report', { request_id: 'delete-report', report_id: first.report_id, expected_version: bobReport.version });
  expect(await bob.call('list_reports', {})).toEqual([]);
});

test('a dropped HTTP reply after admission replays the exact create without duplicates', async () => {
  let drop = true;
  const intercepted = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const response = await fetch(input, init);
    if (String(input).includes('/create_report') && drop) { drop = false; await response.arrayBuffer(); throw new TypeError('Response lost after admission'); }
    return response;
  }) as typeof fetch;
  const c = new ReportClient(worker.url, { token: async () => 'test-alice', fetch: intercepted });
  const journal = new MutationJournal(c, await c.recoveryScope(), 'interrupted', memoryStorage());
  const { envelope, body } = encodeReport(report('Interrupted'), { description: '', tags: [] });
  await expect(journal.run('create_report', { envelope, body })).rejects.toThrow('Response lost');
  const result = await journal.retry();
  expect((await c.call('list_reports', { query: 'Interrupted' })).map(r => r.report_id)).toEqual([result.report_id]);
});

test('folder streams consume every continuation page without losing int64 metadata', async () => {
  const c = worker.client();
  const parent = await c.call('create_folder', { request_id: crypto.randomUUID(), name: 'Paged library' });
  const ids = new Set<string>();
  for (let i = 0; i < 130; i++) {
    const folder = await c.call('create_folder', { request_id: crypto.randomUUID(), name: `Folder ${i}`, parent_folder_id: parent.folder_id });
    ids.add(folder.folder_id);
  }
  const folders = await c.call('list_folders', { parent_folder_id: parent.folder_id, recursive: false });
  expect(new Set(folders.map(folder => folder.folder_id))).toEqual(ids);
  expect(folders.every(folder => folder.version === 1n)).toBe(true);
});


test('HTTP owner lookup resolves worker identities and duplicate folder errors remain actionable', async () => {
  const c = worker.client();
  expect(await c.discover(undefined, 'vgi.reports.ownership.v1')).toBe(true);
  const { envelope, body } = encodeReport(report('Owner lookup'), { description: 'Searchable forecast', tags: ['budget'] });
  const created = await c.call('create_report', { request_id: crypto.randomUUID(), envelope, body });
  const options = await c.call('find_owners', { resource_kind: 'report', resource_id: created.report_id, query: 'bob@example.test' });
  expect(options.candidates).toHaveLength(1);
  expect(options.candidates[0].ownership.owner_ref.id).toBe('bob');
  expect((await c.call('list_reports', { query: 'FORECAST', tags: ['budget'] })).some(r => r.report_id === created.report_id)).toBe(true);
  await c.call('create_folder', { request_id: crypto.randomUUID(), name: 'Unique HTTP folder' });
  const journal = new MutationJournal(c, await c.recoveryScope(), 'duplicate-folder', memoryStorage());
  try { await journal.run('create_folder', { name: 'Unique HTTP folder' }); throw new Error('Expected duplicate failure'); }
  catch (error: any) { expect(error.errorCode).toBe('ALREADY_EXISTS'); expect(reportError(error)).toContain('already exists'); }
  expect(journal.pending).toBeNull();
  expect((await journal.run('create_folder', { name: 'Corrected HTTP folder' })).name).toBe('Corrected HTTP folder');
});
