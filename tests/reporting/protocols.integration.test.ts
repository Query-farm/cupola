import { afterAll, beforeAll, expect, test } from 'bun:test';
import { startReportingWorker } from './worker';
import { ReportClient } from '../../src/lib/reporting/client';
import { checkEmailRecipients, newSchedule } from '../../src/lib/reporting/schedules';
import { SchedulePreviewSession } from '../../src/lib/reporting/preview';
import { record } from './fixtures';

let worker: Awaited<ReturnType<typeof startReportingWorker>>;
beforeAll(async () => { worker = await startReportingWorker('SDK contract fixture', undefined, false, { protocolFixture: true }); });
afterAll(async () => { await worker?.stop(); });

test('new Python summaries cross bounded HTTP continuations with exact int64 and enterprise owners', async () => {
  let responses = 0;
  const client = new ReportClient(worker.url, { token: async () => null, fetch: (async (url: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers); headers.set('VGI-Accept-Max-Response-Bytes', '65536');
    const response = await fetch(url, { ...init, headers });
    if (init?.method === 'POST') responses++;
    return response;
  }) as typeof fetch });
  const info = await client.call('get_report_service_info', {});
  expect(info.ownership.membership_owner_kinds).toEqual(['group', 'organization']);
  responses = 0;
  const rows = await client.call('list_reports', { ownership_scope: 'member', recursive: false, limit: 150n });
  expect(rows).toHaveLength(150);
  expect(rows[149].report_id).toBe('object-149');
  expect(rows[0].version).toBe(9223372036854775806n);
  expect(rows[0].created_by.kind).toBe('user');
  expect(rows[0].ownership.owner_ref.kind).toBe('group');
  expect(rows[0]).not.toHaveProperty('envelope');
  expect(responses).toBeGreaterThan(1);
});

test('resource contexts and generic ownership routing use objects, advertised bounds, and canonical exact IDs', async () => {
  const client = worker.client(null);
  const context = await client.ownershipContext('report', 'object-0');
  const caps = await client.call('resource_identity.get_identity_capabilities', { context });
  expect(caps.ownership?.enumeration_supported).toBe(false);
  expect(await client.call('get_ownership_capabilities', { resource_kind: 'report', resource_id: 'object-0' })).toEqual(caps.ownership!);
  expect((await client.call('find_owners', { resource_kind: 'report', resource_id: 'object-0', query: 'finance', limit: 5n }))[0].ownership.owner_ref.kind).toBe('group');
  const checked = await client.call('resource_identity.check_ownership', { context, owner: { scheme: 'group_id', value: 'tenant/groups/finance' } });
  expect(checked.state).toBe('allowed');
  expect(checked.ownership?.parent_owner_ref?.kind).toBe('organization');
  expect((await client.call('resource_identity.check_ownership', { context, owner: { scheme: 'group_id', value: 'Finance' } })).state).toBe('unknown');
});

test('destination search and exact checks work without enumeration; out-of-order, unknown, partial failure', async () => {
  const client = worker.client(null);
  const checks = await client.call('notify.check_destinations', { destinations: [{ kind: 'email', address: 'a@example.test' }] });
  expect(checks[0].input_index).toBe(0n);
  const rows = await client.call('notify.find_destinations', { kind: 'email', query: 'reader', limit: 3n });
  expect(rows).toHaveLength(3);
  await expect(client.call('notify.list_destinations', { kind: 'email', limit: 1n })).rejects.toMatchObject({ errorCode: 'UNIMPLEMENTED' });
  expect(await checkEmailRecipients(client, 'a@example.test, b@example.test, c@example.test')).toHaveLength(3);
  await expect(checkEmailRecipients(client, 'unknown@example.test')).rejects.toThrow('could not be verified');
  await expect(checkEmailRecipients(client, 'a@example.test, fail@example.test')).rejects.toThrow();
});

test('preview validation, lost-start replay, polling and cancellation cross schedules v2 HTTP', async () => {
  const client = worker.client(null), schedule = newSchedule(record(), worker.url);
  expect(await client.call('schedules.validate_schedule', { schedule })).toEqual({ valid: true, complete: true, issues: [] });
  let drop = true; const starts: Uint8Array[] = [];
  const interrupted = new ReportClient(worker.url, { token: async () => null, fetch: (async (url: RequestInfo | URL, init?: RequestInit) => {
    const response = await fetch(url, init);
    if (String(url).endsWith('/start_test_run')) {
      starts.push(new Uint8Array(init!.body as ArrayBuffer));
      if (drop) { drop = false; await response.arrayBuffer(); throw new TypeError('Lost preview acknowledgement'); }
    }
    return response;
  }) as typeof fetch });
  const session = new SchedulePreviewSession(interrupted, { request_id: crypto.randomUUID(), schedule, as_of: Date.now() });
  await expect(session.run(new AbortController().signal, () => {})).rejects.toThrow('Lost preview');
  expect((await session.run(new AbortController().signal, () => {})).outputs).toEqual([]);
  expect(starts).toHaveLength(2); expect(starts[1]).toEqual(starts[0]);
  expect(session.job?.status).toBe('succeeded');
  const queued = await client.call('schedules.start_test_run', { request_id: crypto.randomUUID(), schedule, as_of: Date.now() });
  expect((await client.call('schedules.cancel_test_run', { job_id: queued.job_id, expected_version: queued.version, request_id: crypto.randomUUID() })).status).toBe('cancelled');
});
