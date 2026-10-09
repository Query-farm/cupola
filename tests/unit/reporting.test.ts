import { describe, expect, test } from 'bun:test';
import { decodeRecord, encodeRecord, ReportClient, serviceLocation } from '../../src/lib/reporting/client';
import { decodeReport, encodeReport } from '../../src/lib/reporting/body';
import { MutationJournal, parseJournal, serializeJournal } from '../../src/lib/reporting/journal';
import { SaveController, recoveryDrafts } from '../../src/lib/reporting/save-controller';
import { info, memoryStorage, record, report } from '../reporting/fixtures';

const settle = async (controller: SaveController) => { for (let i = 0; i < 100 && ['draft', 'saving'].includes(controller.state.status); i++) await new Promise(resolve => setTimeout(resolve, 1)); };
describe('reporting wire and documents', () => {
  test('nested Arrow records preserve binary64 defaults, nulls, Unicode and exact int64 versions', () => {
    const r = record(); r.version = 9223372036854775806n; r.envelope!.title = '市場 📊';
    expect(decodeRecord(encodeRecord('ReportResult', r))).toEqual(r);
  });
  test('preserves native controls and excludes local identities, selected values and credentials', () => {
    const r = report(); r.workspaceId = 'private-workspace'; r.values = { city: 'Private view' };
    r.parameters = [{ id: 'city', key: 'city', label: 'City', type: 'select', required: false, defaultValue: null, options: { kind: 'query', sql: 'select city from places' } }];
    r.requires = [{ alias: 'finance', url: 'https://example.test', catalogName: 'yfinance' }];
    const encoded = encodeReport(r, { description: 'Shared', tags: ['finance'] });
    expect(encoded.envelope.parameters).toEqual([]); expect(encoded.localControls).toEqual(['City']);
    const bytes = new TextDecoder().decode(encoded.body);
    expect(bytes).not.toContain('private-workspace'); expect(bytes).not.toContain('Private view');
    const decoded = decodeReport({ ...record(r), ...encoded }, r.serviceUrl, 'reader-workspace');
    expect(decoded.parameters).toEqual(r.parameters); expect(decoded.requires).toEqual(r.requires);
    expect(decoded.workspaceId).toBe('reader-workspace'); expect(decoded.values).toEqual({});
    expect(() => serviceLocation('https://user:secret@example.test')).toThrow();
    expect(() => serviceLocation('https://example.test?token=secret')).toThrow();
  });
  test('refuses malformed, unknown and redacted documents instead of silently overwriting them', () => {
    const r = record();
    expect(() => decodeReport({ ...r, redacted: true, body: null }, 'https://example.test')).toThrow('redacted');
    expect(() => decodeReport({ ...r, body: new TextEncoder().encode('{') }, 'https://example.test')).toThrow('JSON');
    expect(() => decodeReport({ ...r, envelope: { ...r.envelope!, body_format: 'something/new' } }, 'https://example.test')).toThrow('cannot edit');
  });
  test('editing or rebinding retains attachment identity, labels and optionality', () => {
    const r = report(); r.requires = [{ alias: 'new_alias', url: 'https://example.test', catalogName: 'finance' }];
    const source = { alias: 'old_alias', attachment_id: 'durable-attachment', location: 'https://example.test', catalog_name: 'finance', label: 'Finance source', required: false };
    const encoded = encodeReport(r, { description: '', tags: [], dataSources: [source] });
    expect(encoded.envelope.data_sources).toEqual([{ ...source, alias: 'new_alias' }]);
  });
});
describe('durable reporting mutations', () => {
  test('journals bytes and int64 losslessly before dispatch, retries an ambiguous result with the same request ID', async () => {
    const storage = memoryStorage(), calls: any[] = [];
    const client = { recoveryScope: async () => 'scope', call: async (_m: string, input: any) => { calls.push(input); expect(storage.length).toBe(1); if (calls.length === 1) throw new TypeError('response lost'); return record(); } } as unknown as ReportClient;
    const journal = new MutationJournal(client, 'scope', 'test', storage);
    try { await journal.run('commit_revision', { report_id: 'r', expected_revision_id: 'head', envelope: record().envelope!, body: new Uint8Array([0, 255]) }); } catch { /* Ambiguous. */ }
    expect(journal.pending).not.toBeNull();
    await new MutationJournal(client, 'scope', 'test', storage).retry();
    expect(calls[1]).toEqual(calls[0]); expect(storage.length).toBe(0);
    expect(parseJournal(serializeJournal({ version: 9223372036854775807n }))).toEqual({ version: 9223372036854775807n });
  });
  test('does not dispatch when recovery storage is full, credentials change, or replay expires', async () => {
    let calls = 0;
    const client = { recoveryScope: async () => 'different', call: async () => { calls++; return record(); } } as unknown as ReportClient;
    const storage = memoryStorage(), journal = new MutationJournal(client, 'scope', 'test', storage);
    await expect(journal.run('delete_report', { report_id: 'r', expected_version: 2n })).rejects.toThrow('account changed');
    const pending = journal.pending!; pending.createdAt = 0; storage.setItem(journal.key, serializeJournal(pending));
    await expect(journal.retry()).rejects.toThrow('replay window');
    await journal.discard(); storage.setItem = () => { throw new Error('quota'); };
    await expect(journal.run('delete_report', { report_id: 'r', expected_version: 2n })).rejects.toThrow('quota');
    expect(calls).toBe(0);
  });
  test('recovery retries the original edit before saving newer typing; reader values create no revision', async () => {
    const storage = memoryStorage(), calls: any[] = []; let fail = true;
    const client = { recoveryScope: async () => 'scope', call: async (_m: string, input: any) => { calls.push(input); if (fail) throw new TypeError('lost reply'); return { ...record(), head_revision_id: `head-${calls.length}`, revision_served: `head-${calls.length}`, envelope: input.envelope, body: input.body }; } } as unknown as ReportClient;
    const controller = new SaveController(client, 'scope', record(), report(), info, undefined, storage);
    controller.capture({ ...report(), values: { p: 'view' } }); expect(controller.dirty).toBe(false); expect(recoveryDrafts('scope', storage)).toHaveLength(0);
    controller.stage(report('First')); await settle(controller);
    expect(controller.state.status).toBe('error'); controller.capture(report('Later')); controller.stage(report('Later')); controller.dispose();
    fail = false;
    const recovered = recoveryDrafts('scope', storage)[0];
    const resumed = new SaveController(client, 'scope', record(), report(), info, recovered, storage);
    await resumed.retry();
    expect(calls[1]).toEqual(calls[0]); expect(calls.at(-1).envelope.title).toBe('Later');
    expect(resumed.state.status).toBe('saved'); expect(recoveryDrafts('scope', storage)).toHaveLength(0);
  });
  test('conflicts preserve the draft and do not advance the precondition or retry automatically', async () => {
    const storage = memoryStorage(); let calls = 0;
    const client = { recoveryScope: async () => 'scope', call: async () => { calls++; throw { errorCode: 'ABORTED' }; } } as unknown as ReportClient;
    const controller = new SaveController(client, 'scope', record(), report(), info, undefined, storage);
    controller.stage(report('Mine')); await settle(controller);
    controller.stage(report('More edits')); await new Promise(resolve => setTimeout(resolve, 5));
    expect(calls).toBe(1); expect(controller.state.status).toBe('conflict'); expect(controller.current.report.title).toBe('More edits');
    expect(controller.journal.pending).toBeNull(); expect(recoveryDrafts('scope', storage)[0].value.base.head_revision_id).toBe('head');
    controller.updateRecord({ ...record(), head_revision_id: 'someone-elses-head' });
    expect(controller.state.record.head_revision_id).toBe('head');
  });
});
