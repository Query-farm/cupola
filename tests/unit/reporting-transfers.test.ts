import { expect, test } from 'bun:test';
import { ReportClient } from '../../src/lib/reporting/client';
import { listEvidenceReports, saveEvidenceReport } from '../../src/lib/evidence/reports';
import { createLocalFolder, deleteLocalFolder, renameLocalFolder, localReportEntry, placeLocalReport } from '../../src/lib/reporting/local-library';
import { prepareTransfer, resumeTransfer, transferJobs } from '../../src/lib/reporting/transfers';
import { locationLabel } from '../../src/lib/reporting/locations';
import { info, memoryStorage, record, report } from '../reporting/fixtures';

const context = { scope: 'workspace', workspaceId: 'workspace', serviceUrl: 'https://finance.test' };
const localDestination = { url: null, folderId: null, name: 'On this device' };
const remoteDestination = { url: 'https://reports.test', folderId: null, name: 'Team reports' };

test('local folders reject missing parents, duplicates, and deleting nonempty folders', () => {
  const storage = memoryStorage();
  const folder = createLocalFolder(context.scope, 'Folder', null, storage);
  expect(() => createLocalFolder(context.scope, 'Folder', null, storage)).toThrow('already exists');
  expect(() => createLocalFolder(context.scope, 'Child', 'missing', storage)).toThrow('no longer exists');
  const r = saveEvidenceReport({ ...report(), workspaceId: context.scope }, storage);
  placeLocalReport(context.scope, r.id, folder.id, undefined, storage);
  expect(() => deleteLocalFolder(context.scope, folder.id, storage)).toThrow('Empty this folder');
});

test('lost destination reply keeps the local source and retries one exact create before removing it', async () => {
  const storage = memoryStorage(), calls: any[] = [];
  const source = saveEvidenceReport({ ...report(), workspaceId: context.scope }, storage);
  let destination = record(), lose = true;
  const factory = () => ({ recoveryScope: async () => 'alice', call: async (method: string, input: any) => {
    if (method === 'get_report_service_info') return info;
    if (method === 'create_report') {
      calls.push(input); destination = { ...record(), envelope: input.envelope, body: input.body };
      if (lose) { lose = false; throw new TypeError('reply lost'); } return destination;
    }
    if (method === 'get_report') return destination;
    throw new Error(method);
  } }) as unknown as ReportClient;
  const job = await prepareTransfer({ kind: 'local', report: source }, remoteDestination, true, context, factory, storage);
  try { await resumeTransfer(job, factory, storage); } catch (e) { expect(String(e)).toContain('reply lost'); }
  expect(listEvidenceReports(context.scope, storage)).toHaveLength(1);
  const recovered = transferJobs(context.scope, storage)[0];
  await resumeTransfer(recovered, factory, storage);
  expect(calls).toHaveLength(2); expect(calls[1]).toEqual(calls[0]);
  expect(listEvidenceReports(context.scope, storage)).toHaveLength(0);
  expect(transferJobs(context.scope, storage)).toHaveLength(0);
});

test('cross-worker move uses both accounts and retains the destination on a source conflict', async () => {
  const storage = memoryStorage(), sourceRecord = record(), removals: any[] = [], creates: any[] = [];
  let conflict = true, target = record();
  const factory = (url: string) => ({ recoveryScope: async () => url, call: async (method: string, input: any) => {
    if (method === 'get_report_service_info') return info;
    if (method === 'get_report') return url === 'https://source.test' ? sourceRecord : target;
    if (method === 'create_report') { creates.push(input); target = { ...record(), report_id: 'copy', envelope: input.envelope, body: input.body }; return target; }
    if (method === 'delete_report') { removals.push(input); if (conflict) throw new Error('ABORTED'); return { ok: true }; }
    throw new Error(method);
  } }) as unknown as ReportClient;
  const job = await prepareTransfer({ kind: 'worker', url: 'https://source.test', record: sourceRecord }, remoteDestination, true, context, factory, storage);
  try { await resumeTransfer(job, factory, storage); } catch { /* Copy saved, source not removed. */ }
  expect(transferJobs(context.scope, storage)[0].copied?.id).toBe('copy');
  conflict = false; await resumeTransfer(job, factory, storage);
  expect(creates).toHaveLength(1); expect(removals[0]).toEqual(removals[1]); expect(removals[0].expected_version).toBe(1n);
});

test('worker to local preserves report metadata and requirements without granting worker permissions', async () => {
  const storage = memoryStorage(), sourceRecord = record({ ...report(), requires: [{ alias: 'finance', url: context.serviceUrl, catalogName: 'yfinance' }] });
  sourceRecord.envelope!.description = 'A description'; sourceRecord.envelope!.tags = ['market'];
  sourceRecord.allowed_actions = ['read'];
  const factory = () => ({ recoveryScope: async () => 'anonymous', call: async () => sourceRecord }) as unknown as ReportClient;
  const job = await prepareTransfer({ kind: 'worker', url: 'https://source.test', record: sourceRecord }, localDestination, false, context, factory, storage);
  await resumeTransfer(job, factory, storage);
  const saved = listEvidenceReports(context.scope, storage)[0];
  expect(saved.requires?.[0].catalogName).toBe('yfinance');
  expect(localReportEntry(context.scope, saved, storage).metadata?.description).toBe('A description');
  expect(localReportEntry(context.scope, saved, storage).metadata?.tags).toEqual(['market']);
  expect(saved.id).not.toBe(sourceRecord.report_id);
});

test('same-worker move preserves identity and uses move_report without creating a revision copy', async () => {
  const storage = memoryStorage(), calls: string[] = [];
  const movable = { ...record(), allowed_actions: ['read', 'move'] };
  const factory = () => ({ recoveryScope: async () => 'alice', call: async (method: string) => {
    calls.push(method); if (method === 'get_report') return movable; if (method === 'get_report_service_info') return { ...info, body_formats: [], limits: [{ name: 'max_body_bytes', value: 1n }] };
    if (method === 'get_folder') return { allowed_actions: ['create_report'] }; return record();
  } }) as unknown as ReportClient;
  const job = await prepareTransfer({ kind: 'worker', url: remoteDestination.url, record: movable }, { ...remoteDestination, folderId: 'folder' }, true, context, factory, storage);
  expect((await resumeTransfer(job, factory, storage)).copied?.id).toBe('report');
  expect(calls).toContain('move_report'); expect(calls).not.toContain('create_report'); expect(calls).not.toContain('delete_report');
  await expect(prepareTransfer({ kind: 'worker', url: remoteDestination.url, record: movable }, localDestination, true, context, factory, storage)).rejects.toThrow('permission to move');
});

test('changed account and full recovery storage prevent transfer dispatch', async () => {
  const storage = memoryStorage(); let account = 'alice', creates = 0;
  const original = saveEvidenceReport({ ...report(), workspaceId: context.scope }, storage);
  const factory = () => ({ recoveryScope: async () => account, call: async (method: string) => { if (method === 'create_report') creates++; return info; } }) as unknown as ReportClient;
  const job = await prepareTransfer({ kind: 'local', report: original }, remoteDestination, true, context, factory, storage);
  account = 'bob';
  try { await resumeTransfer(job, factory, storage); throw new Error('Expected rejection'); } catch (e) { expect(String(e)).toContain('accounts'); }
  expect(creates).toBe(0); expect(listEvidenceReports(context.scope, storage)).toHaveLength(1);
  storage.setItem = () => { throw new Error('quota'); };
  try { await prepareTransfer({ kind: 'local', report: original }, remoteDestination, true, context, factory, storage); throw new Error('Expected rejection'); } catch (e) { expect(String(e)).toContain('quota'); }
  expect(creates).toBe(0);
});

test('duplicate drive names remain distinguishable without using names as identities', () => {
  const locations = [{ url: 'https://one.test', name: 'Reports' }, { url: 'https://two.test/team', name: 'Reports' }];
  expect(locationLabel(locations[0], locations)).toBe('Reports (one.test)');
  expect(locationLabel(locations[1], locations)).toBe('Reports (two.test/team)');
});

test('a historical worker revision can be copied but cannot be moved over the current report', async () => {
  const storage = memoryStorage(), historical = { ...record(), revision_served: 'old' };
  const factory = () => ({ recoveryScope: async () => 'alice', call: async () => historical }) as unknown as ReportClient;
  try { await prepareTransfer({ kind: 'worker', url: 'https://source.test', record: historical }, localDestination, true, context, factory, storage); throw new Error('Expected rejection'); }
  catch (e) { expect(String(e)).toContain('current report'); }
  expect(transferJobs(context.scope, storage)).toHaveLength(0);
});

test('changing the source during a local-to-worker transfer preserves both reports', async () => {
  const storage = memoryStorage(), original = saveEvidenceReport({ ...report(), workspaceId: context.scope }, storage);
  let destination = record();
  const factory = () => ({ recoveryScope: async () => 'alice', call: async (method: string, input: any) => {
    if (method === 'get_report_service_info') return info;
    if (method === 'create_report') {
      destination = { ...record(), envelope: input.envelope, body: input.body };
      saveEvidenceReport({ ...original, title: 'New edits' }, storage); return destination;
    }
    return destination;
  } }) as unknown as ReportClient;
  const job = await prepareTransfer({ kind: 'local', report: original }, remoteDestination, true, context, factory, storage);
  try { await resumeTransfer(job, factory, storage); throw new Error('Expected conflict'); }
  catch (e) { expect(String(e)).toContain('original changed'); }
  expect(listEvidenceReports(context.scope, storage)[0].title).toBe('New edits');
  expect(transferJobs(context.scope, storage)[0].copied).toBeDefined();
});

test('moving a local report between folders does not require an HTTP-compatible data source', async () => {
  const storage = memoryStorage();
  const original = saveEvidenceReport({ ...report(), workspaceId: context.scope, requires: [{ alias: 'data', url: 'iroh://endpoint', catalogName: 'catalog' }] }, storage);
  const folder = createLocalFolder(context.scope, 'Drafts', null, storage);
  const factory = () => { throw new Error('Must not contact a worker'); };
  const job = await prepareTransfer({ kind: 'local', report: original }, { ...localDestination, folderId: folder.id }, true, context, factory, storage);
  await resumeTransfer(job, factory, storage);
  expect(listEvidenceReports(context.scope, storage)).toHaveLength(1);
  expect(localReportEntry(context.scope, original, storage).folderId).toBe(folder.id);
});


test('copy naming is frozen for retries and never renames the source or a move', async () => {
  const storage = memoryStorage(), original = saveEvidenceReport({ ...report('Revenue'), workspaceId: context.scope }, storage);
  const job = await prepareTransfer({ kind: 'local', report: original }, localDestination, false, context, undefined, storage);
  expect(job.envelope.title).toBe('Revenue (copy)');
  await resumeTransfer(job, undefined, storage);
  expect(listEvidenceReports(context.scope, storage).map(r => r.title).sort()).toEqual(['Revenue', 'Revenue (copy)']);
  const folder = createLocalFolder(context.scope, 'Folder', null, storage);
  const move = await prepareTransfer({ kind: 'local', report: original }, { ...localDestination, folderId: folder.id }, true, { ...context, copyName: 'Ignored name' }, undefined, storage);
  expect(move.envelope.title).toBe('Revenue');
  await resumeTransfer(move, undefined, storage);
  expect(listEvidenceReports(context.scope, storage).find(r => r.id === original.id)?.title).toBe('Revenue');
});

test('worker copy keeps an edited name across a lost reply and preserves the source envelope', async () => {
  const storage = memoryStorage(), original = record(report('Revenue')), creates: any[] = []; let lose = true;
  const factory = () => ({ recoveryScope: async () => 'alice', call: async (method: string, input: any) => {
    if (method === 'get_report') return original;
    if (method === 'get_report_service_info') return info;
    if (method === 'create_report') { creates.push(input); if (lose) { lose = false; throw new Error('lost'); } return { ...original, report_id: 'copy' }; }
    throw new Error(method);
  } }) as unknown as ReportClient;
  const job = await prepareTransfer({ kind: 'worker', url: 'https://source.test', record: original }, remoteDestination, false, { ...context, copyName: 'Revenue for review' }, factory, storage);
  await expect(resumeTransfer(job, factory, storage)).rejects.toThrow('lost');
  await resumeTransfer(transferJobs(context.scope, storage)[0], factory, storage);
  expect(creates[1]).toEqual(creates[0]); expect(creates[1].envelope.title).toBe('Revenue for review');
  expect(original.envelope!.title).toBe('Revenue');
});

test('local folder rename preserves descendants and rejects normalized sibling collisions', () => {
  const storage = memoryStorage(), a = createLocalFolder(context.scope, 'Café', null, storage), b = createLocalFolder(context.scope, 'Second', null, storage);
  const child = createLocalFolder(context.scope, 'Child', b.id, storage);
  expect(() => renameLocalFolder(context.scope, b.id, 'Cafe\u0301', storage)).toThrow('already exists');
  renameLocalFolder(context.scope, b.id, 'Renamed', storage);
  expect(child.parentId).toBe(b.id); expect(a.id).not.toBe(b.id);
});
