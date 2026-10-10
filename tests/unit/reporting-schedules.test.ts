import { expect, test } from 'bun:test';
import { tableFromIPC } from '@query-farm/apache-arrow';
import { artifactUrl, authorizeSchedules, cronFor, delegationId, emailDestinations, newSchedule, requiredDelegations, sourceAttach, triggerFields, validateSchedule } from '../../src/lib/reporting/schedules';
import { MutationJournal } from '../../src/lib/reporting/journal';
import { decodeRecord, encodeRecord, ReportClient } from '../../src/lib/reporting/client';
import type { CatalogData } from '../../src/lib/service';
import { memoryStorage, record } from '../reporting/fixtures';

test('schedule defaults pin unpublished reports, remain paused, and retain timezone-aware triggers on the wire', () => {
  const draft = newSchedule(record(), 'https://reports.test/');
  expect(draft.enabled).toBe(false); expect(draft.action.render_report!.track).toBe('pinned');
  expect(draft.action.render_report!.report.revision_id).toBe('head');
  expect(decodeRecord(encodeRecord('Schedule', draft))).toEqual(draft);
  const published = newSchedule({ ...record(), published_revision_id: 'published' }, 'https://reports.test');
  expect(published.action.render_report!.track).toBe('published'); expect(published.action.render_report!.report.revision_id).toBeNull();
  expect(newSchedule({ ...record(), published_revision_id: 'published' }, 'https://reports.test', true).action.render_report!.track).toBe('pinned');
  draft.trigger = { ...draft.trigger, kind: 'once', cron: null, run_at: Date.parse('2030-05-10T14:30:00Z') };
  expect(decodeRecord(encodeRecord('Schedule', draft)).trigger.run_at).toBe(draft.trigger.run_at);
});

test('presets keep custom cron expressions distinct and preserve midnight and Sunday', () => {
  expect(cronFor('weekly', '00:05', '0')).toBe('5 0 * * 0');
  expect(cronFor('weekdays', '17:30', '2')).toBe('30 17 * * 1-5');
  const trigger = newSchedule(record(), 'https://reports.test').trigger;
  expect(triggerFields({ ...trigger, cron: '5 0 * * 0' })).toEqual({ frequency: 'weekly', time: '00:05', day: '0' });
  expect(triggerFields({ ...trigger, cron: '*/15 * * * *' }).frequency).toBe('custom');
  expect(() => cronFor('daily', '25:00', '1')).toThrow();
});

test('recipient parsing rejects header injection and validates nonempty delivery/output choices', () => {
  expect(emailDestinations(' a@example.test; a@example.test\nb@example.test ')).toEqual([{ kind: 'email', address: 'a@example.test' }, { kind: 'email', address: 'b@example.test' }]);
  expect(() => emailDestinations('reader@example.test\rBcc:someone@example.test')).toThrow();
  expect(() => emailDestinations('')).toThrow();
  const draft = newSchedule(record(), 'https://reports.test');
  draft.trigger.time_zone = 'not/a-zone'; expect(() => validateSchedule(draft)).toThrow('time zone');
  draft.trigger.time_zone = 'UTC'; draft.action.render_report!.outputs = []; expect(() => validateSchedule(draft)).toThrow('format');
});

test('delegation matching canonicalizes default ports without mixing attachments', () => {
  const source = { alias: 'one', attachment_id: 'a', location: 'https://source.test:443/', catalog_name: 'finance', required: true, label: '' };
  const keys = requiredDelegations('https://reports.test', [source, source, { ...source, alias: 'two', attachment_id: 'b' }, { ...source, attachment_id: 'optional', required: false }]);
  expect(keys).toHaveLength(3);
  expect(delegationId(source as any)).toBe(delegationId({ ...source, location: 'https://source.test' } as any));
  expect(delegationId(keys[1])).not.toBe(delegationId(keys[2]));
});

test('attach sealing uses the report alias and exact options; a missing original connection is an error', () => {
  const source = { kind: 'catalog' as const, location: 'https://source.test', catalog_name: 'finance', attachment_id: 'opaque-worker-id', alias: 'finance_eu' };
  const catalogs = [{ catalogName: 'finance_eu', serverCatalogName: 'finance', sourceUrl: source.location, attachOptions: { region: 'EU', years: '3' } }, { catalogName: 'finance_us', serverCatalogName: 'finance', sourceUrl: source.location, attachOptions: { region: 'US', years: '3' } }].map(c => ({ ...c, catalogComment: null, catalogTags: {}, defaultSchema: null, schemas: [] })) satisfies CatalogData[];
  const attach = sourceAttach(source, catalogs);
  expect(tableFromIPC(attach.options!).get(0)?.toJSON()).toEqual({ region: 'EU', years: '3' });
  expect(() => sourceAttach({ ...source, alias: 'missing' }, catalogs)).toThrow('Connect the original');
});

test('opaque credential writes cannot enter the persistent mutation journal', async () => {
  const storage = memoryStorage(), client = { call: () => { throw new Error('must not dispatch'); } } as unknown as ReportClient;
  const journal = new MutationJournal(client, 'scope', 'credentials', storage);
  await expect(journal.run('delegations.put_delegations', { delegations: [] })).rejects.toThrow('Credentials cannot');
  expect(storage.length).toBe(0);
});

test('authorization failure does not leak a minted credential or partially install a grant set', async () => {
  const keys = requiredDelegations('https://reports.test', [{ alias: 'finance', attachment_id: 'finance', location: 'https://source.test', catalog_name: 'finance', label: '', required: true }]);
  let writes = 0;
  const scheduler = { recoveryScope: async () => 'same', call: async (method: string) => { if (method === 'delegations.list_delegations') return []; writes++; throw new Error('must not write'); } } as unknown as ReportClient;
  const source = { call: async (method: string) => { if (method === 'identity.issue_grant') return { token: 'opaque-secret-token', expires_at: Date.now() / 1000 + 3600 }; throw new Error('upstream echoed opaque-secret-token'); } } as unknown as ReportClient;
  try { await authorizeSchedules(scheduler, keys, 'Report', () => ({ options: null, data_version_spec: '', implementation_version: '' }), 7, () => source); throw new Error('Expected failure'); }
  catch (error) { expect((error as Error).message).not.toContain('opaque-secret-token'); expect((error as Error).message).toContain('source.test'); }
  expect(writes).toBe(0);
});

test('artifact links reject active schemes and credentials', () => {
  expect(artifactUrl('javascript:alert(1)')).toBeNull(); expect(artifactUrl('https://token:secret@example.test/file')).toBeNull();
  expect(artifactUrl('https://reports.test/file?signature=abc')).toBe('https://reports.test/file?signature=abc');
});
