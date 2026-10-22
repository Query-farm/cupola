import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
let act: typeof import('@testing-library/react').act;
let cleanup: typeof import('@testing-library/react').cleanup, fireEvent: typeof import('@testing-library/react').fireEvent, render: typeof import('@testing-library/react').render, waitFor: typeof import('@testing-library/react').waitFor;
let OwnershipPage: typeof import('../../src/components/reporting/OwnershipPage').OwnershipPage;
let ScheduleForm: typeof import('../../src/components/reporting/ScheduleForm').ScheduleForm;
let ScheduleRunDetails: typeof import('../../src/components/reporting/ScheduleRunDetails').ScheduleRunDetails;
import { ReportClient } from '../../src/lib/reporting/client';
import type { OwnerDiscoveryCapabilities, SchedulerInfo, ScheduleRun } from '../../src/lib/reporting/contracts.generated';
import { info, record } from './fixtures';

beforeAll(async () => {
  GlobalRegistrator.register();
  ({ act, cleanup, fireEvent, render, waitFor } = await import('@testing-library/react/pure'));
  ({ OwnershipPage } = await import('../../src/components/reporting/OwnershipPage'));
  ({ ScheduleForm } = await import('../../src/components/reporting/ScheduleForm'));
  ({ ScheduleRunDetails } = await import('../../src/components/reporting/ScheduleRunDetails'));
});
afterEach(async () => { await act(async () => { cleanup(); }); sessionStorage.clear(); await new Promise(resolve => setTimeout(resolve, 0)); });
afterAll(() => GlobalRegistrator.unregister());

const ownerCaps: OwnerDiscoveryCapabilities = { policy: info.ownership, search_supported: false, suggestions_supported: false, enumeration_supported: false, min_query_length: 3n, max_results: 2n, identifier_schemes: ['group_id'], query_hint: 'Enter a canonical group identifier.' };
const group = { owner_ref: { kind: 'group', id: 'tenant/groups/finance', display_name: 'Finance' }, parent_owner_ref: { kind: 'organization', id: 'tenant/org', display_name: 'Company' } };
const context = { protocol: 'vgi.objects.v1', resource_kind: 'object', operation: 'transfer_ownership', resource_id: 'report', parent_folder_id: null };

test('exact group ownership remains usable when all directory discovery is disabled', async () => {
  const calls: Array<[string, any]> = [], transfers: unknown[] = [];
  const client = { discover: async () => true, ownershipContext: async () => context, call: async (method: string, input: any) => {
    calls.push([method, input]);
    if (method === 'resource_identity.get_identity_capabilities') return { ownership: ownerCaps, execution: null };
    if (method === 'resource_identity.check_ownership') return { state: 'allowed', ownership: group, message: null, reason_code: null };
    throw new Error(`Unexpected directory enumeration: ${method}`);
  } } as unknown as ReportClient;
  const ui = render(<OwnershipPage client={client} resourceKind="report" resourceId="report" name="Report" current={record().ownership} blocked={false} onApply={async value => { transfers.push(value); }} onBack={() => {}} />);
  const owner = await ui.findByLabelText('Owner identifier');
  expect(ui.queryByLabelText('Search owners')).toBeNull();
  fireEvent.change(owner, { target: { value: 'tenant/groups/finance' } });
  fireEvent.click(ui.getByRole('button', { name: 'Validate owner' }));
  await ui.findByRole('heading', { name: 'Review transfer' });
  expect(calls.at(-1)).toEqual(['resource_identity.check_ownership', { context, owner: { scheme: 'group_id', value: 'tenant/groups/finance' }, parent: null }]);
  fireEvent.click(ui.getByRole('button', { name: 'Transfer ownership' }));
  await waitFor(() => expect(transfers).toEqual([group]));
});

test('unknown exact ownership and edits to a validated identifier cannot enable a transfer', async () => {
  let allowed = true;
  const client = { discover: async () => true, ownershipContext: async () => context, call: async (method: string) => method === 'resource_identity.get_identity_capabilities' ? { ownership: ownerCaps, execution: null } : { state: allowed ? 'allowed' : 'unknown', ownership: allowed ? group : null, message: 'Directory unavailable' } } as unknown as ReportClient;
  const ui = render(<OwnershipPage client={client} resourceKind="report" resourceId="report" name="Report" current={record().ownership} blocked={false} onApply={async () => { throw new Error('Must not transfer'); }} onBack={() => {}} />);
  const owner = await ui.findByLabelText('Owner identifier');
  fireEvent.change(owner, { target: { value: 'tenant/groups/finance' } }); fireEvent.click(ui.getByRole('button', { name: 'Validate owner' }));
  await ui.findByRole('heading', { name: 'Review transfer' });
  allowed = false; fireEvent.change(owner, { target: { value: 'another' } });
  expect(ui.queryByRole('button', { name: 'Transfer ownership' })).toBeNull();
  fireEvent.click(ui.getByRole('button', { name: 'Validate owner' }));
  await ui.findByText('Directory unavailable');
  expect(ui.queryByRole('button', { name: 'Transfer ownership' })).toBeNull();
});

test('owner search is bounded and starts only at the advertised minimum length', async () => {
  const queries: unknown[] = [];
  const client = { discover: async () => true, ownershipContext: async () => context, call: async (method: string, input: any) => {
    if (method === 'resource_identity.get_identity_capabilities') return { ownership: { ...ownerCaps, search_supported: true }, execution: null };
    queries.push(input); return [{ label: 'Finance', description: 'Team', ownership: group }];
  } } as unknown as ReportClient;
  const ui = render(<OwnershipPage client={client} resourceKind="report" resourceId="report" name="Report" current={record().ownership} blocked={false} onApply={async () => {}} onBack={() => {}} />);
  const search = await ui.findByLabelText('Search owners');
  fireEvent.change(search, { target: { value: 'ab' } });
  await new Promise(resolve => setTimeout(resolve, 250)); expect(queries).toEqual([]);
  fireEvent.change(search, { target: { value: 'finance' } });
  await ui.findByText('Team'); expect(queries).toEqual([{ context, query: 'finance', limit: 2n }]);
});

const scheduler: SchedulerInfo = { ...info, action_kinds: ['render_report'], output_formats: ['application/pdf'], relative_tokens: [], tzdb_version: 'test', retry_policy: { max_attempts: 1n, max_elapsed_seconds: 60n, initial_backoff_seconds: 1n, max_backoff_seconds: 5n }, alert_events: [] };
test('schedule form blocks incomplete validation and then polls an admitted preview', async () => {
  let complete = false, starts = 0, saves = 0;
  const client = { url: 'https://reports.test', recoveryScope: async () => 'scope', call: async (method: string) => {
    if (method === 'list_revisions') return [];
    if (method === 'get_report') return record();
    if (method === 'schedules.preview_trigger') return { fire_times: [], warnings: [] };
    if (method === 'schedules.validate_schedule') return { valid: complete, complete, issues: [{ field: 'execution', message: 'Unable to complete validation' }] };
    const base = { job_id: 'preview', version: 1n, created_at: Date.now(), finished_at: null, poll_after_seconds: 0n, expires_at: Date.now() + 60_000, allowed_actions: ['cancel'], error: null };
    if (method === 'schedules.start_test_run') { starts++; return { ...base, status: 'queued', result: null }; }
    if (method === 'schedules.get_test_run') return { ...base, status: 'succeeded', result: { evaluated_at: Date.now(), outputs: [], messages: [], condition_evaluated: false } };
    throw new Error(`Unexpected method: ${method}`);
  } } as unknown as ReportClient;
  const ui = render(<ScheduleForm draftKey="protocol-test" report={record()} reportClient={client} client={client} scheduler={scheduler} notify={null} pinned={false} busy={false} access={null} onSources={() => {}} onSave={async () => { saves++; }} onReload={() => {}} />);
  const preview = ui.getByRole('button', { name: 'Preview without sending' });
  await waitFor(() => expect((preview as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(preview); await ui.findByText('execution: Unable to complete validation');
  expect(starts).toBe(0); expect(saves).toBe(0);
  complete = true; fireEvent.click(preview);
  await ui.findByRole('heading', { name: 'Preview result' });
  expect(starts).toBe(1); expect(saves).toBe(0);
});

test('run details read bounded child streams and fetch attempts only on expansion', async () => {
  const calls: Array<[string, any]> = [];
  const attempt = { attempt: 500n, started_at: Date.now(), finished_at: Date.now(), effect_outcome: 'committed', error: null };
  const client = { call: async (method: string, input: any) => {
    calls.push([method, input]);
    if (method === 'schedules.list_run_steps') return [{ step_index: 0n, kind: 'render', status: 'succeeded', effect_outcome: 'committed', attempt_count: 500n, last_attempt: attempt }];
    if (method === 'schedules.list_step_attempts') return [attempt];
    return [];
  } } as unknown as ReportClient;
  const run = { run_id: 'run', version: 1n, status: 'succeeded', trigger_kind: 'manual', scheduled_for: Date.now(), started_at: Date.now(), finished_at: Date.now(), revision_id: 'revision', execution_principal: record().created_by, outputs: [], recovery: { state: 'none', failed_step_index: null, allowed_actions: [] }, allowed_actions: [] } as unknown as ScheduleRun;
  const ui = render(<ScheduleRunDetails client={client} run={run} busy={false} onAction={() => {}} onRenew={() => {}} onResolve={() => {}} />);
  await ui.findByText(/500 attempts/);
  expect(calls).toHaveLength(3);
  expect(calls.every(([, input]) => input.limit === 100n && input.run_id === 'run')).toBe(true);
  const details = ui.getByText('Attempt history').closest('details')!;
  details.open = true; fireEvent(details, new Event('toggle'));
  await waitFor(() => expect(details.textContent).toContain('Committed'));
  expect(calls.at(-1)).toEqual(['schedules.list_step_attempts', { run_id: 'run', step_index: 0n, limit: 100n }]);
});
