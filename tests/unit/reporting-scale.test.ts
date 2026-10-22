import { expect, test, spyOn } from 'bun:test';
import { ReportClient } from '../../src/lib/reporting/client';
import { discoveryLimit } from '../../src/lib/reporting/discovery';
import { authorizeSchedules, checkEmailRecipients, getRequiredDelegations, newSchedule } from '../../src/lib/reporting/schedules';
import { SchedulePreviewSession } from '../../src/lib/reporting/preview';
import type { DestinationCheck, DiscoveryCapabilities, SchedulePreviewJob } from '../../src/lib/reporting/contracts.generated';
import { record } from '../reporting/fixtures';
import { folderAncestors } from '../../src/lib/reporting/folders';

const caps: DiscoveryCapabilities = { search_supported: true, suggestions_supported: false, enumeration_supported: false, min_query_length: 3n, max_results: 2n, query_hint: '', identifier_schemes: ['group_id'] };
test('search honors optional suggestions, minimum length, and the total worker budget', () => {
  expect(discoveryLimit(caps, '')).toBeNull();
  expect(discoveryLimit(caps, 'ab')).toBeNull();
  expect(discoveryLimit(caps, 'finance')).toBe(2n);
  expect(discoveryLimit({ ...caps, search_supported: false }, 'finance')).toBeNull();
  expect(discoveryLimit({ ...caps, suggestions_supported: true }, '')).toBe(2n);
  expect(discoveryLimit({ ...caps, max_results: 100n }, 'finance')).toBe(20n);
});

test('v1 schedule association verifies the source service and retains the unfiltered window limit', async () => {
  const client = new ReportClient('https://scheduler.test');
  const protocol = spyOn(client, 'protocolFor').mockResolvedValue('vgi.schedules.v1');
  const wire = spyOn(client as any, 'rawCall').mockImplementation(async (method: string, input: any) => {
    if (method === 'schedules.list_schedules') {
      expect(input).toEqual({ report_id: 'shared-id', action_kind: 'render_report', limit: 1n });
      return [{ schedule_id: 'other-source' }];
    }
    expect(method).toBe('schedules.get_schedule');
    return { definition: { action: { render_report: { report: { service_url: 'https://other.test', report_id: 'shared-id' } } } } };
  });
  try { expect(await client.listSchedulesForSource('https://source.test', 'shared-id', undefined, 1n)).toEqual({ records: [], limitReached: true }); }
  finally { wire.mockRestore(); protocol.mockRestore(); }
});

const check = (index: bigint, address = 'a@example.test', state: DestinationCheck['state'] = 'allowed'): DestinationCheck => ({ kind: 'email', address, input_index: index, state, display_name: null, reason_code: null, reason: null });
for (const [name, checks] of [
  ['missing result', [check(0n)]],
  ['duplicate index', [check(0n), check(0n)]],
  ['negative index', [check(-1n), check(1n, 'b@example.test')]],
  ['out-of-range index', [check(0n), check(2n, 'b@example.test')]],
  ['wrong address', [check(0n), check(1n)]],
  ['unknown permission', [check(0n), check(1n, 'b@example.test', 'unknown')]],
  ['denied permission', [check(0n), check(1n, 'b@example.test', 'denied')]],
] as const) test(`recipient validation rejects ${name}`, async () => {
  const client = { call: async (method: string) => method === 'notify.get_notify_info' ? { limits: [{ name: 'max_check_destinations', value: 2n }] } : checks } as unknown as ReportClient;
  await expect(checkEmailRecipients(client, 'a@example.test,b@example.test')).rejects.toThrow();
});
test('recipient checks split at the finite input limit and correlate each batch independently', async () => {
  const batches: string[][] = [];
  const client = { call: async (method: string, input: any) => {
    if (method === 'notify.get_notify_info') return { limits: [{ name: 'max_check_destinations', value: 2n }] };
    expect(method).toBe('notify.check_destinations');
    batches.push(input.destinations.map((d: any) => d.address));
    return input.destinations.map((d: any, i: number) => check(BigInt(i), d.address)).reverse();
  } } as unknown as ReportClient;
  expect(await checkEmailRecipients(client, 'a@example.test,b@example.test,c@example.test')).toHaveLength(3);
  expect(batches).toEqual([['a@example.test', 'b@example.test'], ['c@example.test']]);
});

const keys = [{ kind: 'service' as const, location: 'https://source.test', catalog_name: '', attachment_id: '' }];
test('delegation reads are exact and only NOT_FOUND means missing', async () => {
  const calls: string[] = [];
  const client = { call: async (method: string, input: any) => { calls.push(method); expect(input.key).toEqual(keys[0]); throw { errorCode: 'NOT_FOUND' }; } } as unknown as ReportClient;
  expect(await getRequiredDelegations(client, keys)).toEqual([]);
  expect(calls).toEqual(['delegations.get_delegation']);
  client.call = (async () => { throw { errorCode: 'UNAVAILABLE' }; }) as any;
  await expect(getRequiredDelegations(client, keys)).rejects.toMatchObject({ errorCode: 'UNAVAILABLE' });
});
test('oversized credential writes fail before any grant is minted', async () => {
  const calls: string[] = [];
  const client = { recoveryScope: async () => 'scope', call: async (method: string) => { calls.push(method); return { limits: [{ name: 'max_delegation_writes', value: 1n }] }; } } as unknown as ReportClient;
  await expect(authorizeSchedules(client, [...keys, { ...keys[0], location: 'https://other.test' }], 'Title', () => { throw new Error('must not mint'); }, 1)).rejects.toThrow('atomically');
  expect(calls).toEqual(['delegations.get_delegation_limits']);
});

test('folder paths do not enumerate directories or require access to hidden ancestors', async () => {
  const calls: unknown[] = [];
  const client = { call: async (method: string, input: any) => {
    expect(method).toBe('get_folder'); calls.push(input);
    if (input.folder_id === 'child') return { folder_id: 'child', parent_folder_id: 'hidden', name: 'Finance' };
    throw { errorCode: 'PERMISSION_DENIED' };
  } } as unknown as ReportClient;
  expect((await folderAncestors(client, 'child')).map(f => f.folder_id)).toEqual(['child']);
  expect(calls).toEqual([{ folder_id: 'child' }, { folder_id: 'hidden' }]);
  await expect(folderAncestors(client, 'hidden')).rejects.toMatchObject({ errorCode: 'PERMISSION_DENIED' });
});

const job = (): SchedulePreviewJob => ({ job_id: 'preview', version: 1n, status: 'queued', created_at: Date.now(), finished_at: null, poll_after_seconds: 0n, expires_at: Date.now() + 60_000, error: null, allowed_actions: ['cancel'], result: null });
const request = () => ({ request_id: crypto.randomUUID(), schedule: newSchedule(record(), 'https://reports.test'), as_of: Date.now() });
test('preview resumes the existing job after polling failure and never repeats its start', async () => {
  const calls: string[] = []; let fail = true;
  const client = { recoveryScope: async () => 'scope', call: async (method: string) => {
    calls.push(method);
    if (method === 'schedules.start_test_run') return job();
    if (fail) { fail = false; throw new Error('connection lost'); }
    return { ...job(), status: 'succeeded', result: { evaluated_at: Date.now(), parameter_values: [], outputs: [], messages: [], condition_evaluated: false, condition_value: null } };
  } } as unknown as ReportClient;
  const preview = new SchedulePreviewSession(client, request());
  await expect(preview.run(new AbortController().signal, () => {})).rejects.toThrow('connection lost');
  expect((await preview.run(new AbortController().signal, () => {})).outputs).toEqual([]);
  expect(calls.filter(m => m === 'schedules.start_test_run')).toHaveLength(1);
});
test('cancel uses the exact request after a lost response; changed credentials cannot resume it', async () => {
  const calls: unknown[] = []; let scope = 'alice';
  const client = { recoveryScope: async () => scope, call: async (_method: string, input: unknown) => { calls.push(input); if (calls.length === 1) throw new Error('lost cancellation'); return { ...job(), status: 'cancelled' }; } } as unknown as ReportClient;
  const preview = new SchedulePreviewSession(client, request()); preview.job = job();
  await expect(preview.cancel()).rejects.toThrow('lost cancellation');
  scope = 'bob'; await expect(preview.cancel()).rejects.toThrow('account changed');
  expect(calls).toHaveLength(1);
  scope = 'alice'; await preview.cancel(); expect(calls[1]).toEqual(calls[0]);
});
test('cancellation conflict refreshes the version and requires an explicit retry', async () => {
  const calls: any[] = [];
  const client = { recoveryScope: async () => 'scope', call: async (method: string, input: any) => {
    calls.push([method, input]);
    if (calls.length === 1) throw { errorCode: 'ABORTED' };
    return { ...job(), version: 2n, status: method === 'schedules.get_test_run' ? 'running' : 'cancelled' };
  } } as unknown as ReportClient;
  const preview = new SchedulePreviewSession(client, request()); preview.job = job();
  await expect(preview.cancel()).rejects.toMatchObject({ errorCode: 'ABORTED' });
  expect(calls).toHaveLength(2); await preview.cancel();
  expect(calls[2][1].expected_version).toBe(2n);
  expect(calls[2][1].request_id).not.toBe(calls[0][1].request_id);
});
