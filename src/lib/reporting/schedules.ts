import { Field, Schema, Utf8 } from '@query-farm/apache-arrow';
import { serializeBatch, singleRowBatch } from '@query-farm/vgi-rpc/arrow';
import { ReportClient, serviceLocation } from './client';
import type { DataSource, DelegationKey, DelegationRecord, DelegationWrite, ReportResult, Schedule, Trigger } from './contracts.generated';
import type { CatalogData } from '../service';
import { getWorkspace } from '../workspace/store';
import { catalogSecrets, secretsFor } from '../attach/secret-store';
import { registerSecretValues } from '../sentry-scrub';

export const PDF = 'application/pdf', HTML = 'text/html';
export const dateLabel = (value: number | null, zone?: string) => value == null ? '—' : new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short', ...(zone ? { timeZone: zone } : {}) }).format(value);
export const statusLabel = (value: string) => value.replaceAll('_', ' ').replace(/^./, c => c.toUpperCase());
export const sameService = (a: string, b: string) => serviceLocation(a) === serviceLocation(b);
export const delegationId = (key: DelegationKey) => JSON.stringify([key.kind, serviceLocation(key.location), key.catalog_name, key.attachment_id]);
export function requiredDelegations(url: string, sources: readonly DataSource[]): Array<DelegationKey & { alias?: string }> {
  const keys: Array<DelegationKey & { alias?: string }> = [{ kind: 'service', location: serviceLocation(url), catalog_name: '', attachment_id: '' },
    ...sources.filter(s => s.required).map(s => ({ kind: 'catalog' as const, location: serviceLocation(s.location), catalog_name: s.catalog_name, attachment_id: s.attachment_id, alias: s.alias }))];
  return [...new Map(keys.map(key => [delegationId(key), key])).values()];
}

export function newSchedule(report: ReportResult, url: string, pinned = false, htmlBody = true): Schedule {
  return { title: report.envelope?.title ?? 'Report', enabled: false,
    trigger: { kind: 'cron', cron: '0 9 * * 1-5', run_at: null, time_zone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC', start_at: null, end_at: null },
    action: { kind: 'render_report', render_report: { report: { service_url: serviceLocation(url), report_id: report.report_id, revision_id: pinned || !report.published_revision_id ? report.revision_served : null },
      track: pinned || !report.published_revision_id ? 'pinned' : 'published', outputs: htmlBody ? [PDF, HTML] : [PDF] }, run_query: null, data_sources: [], custom_json: null },
    condition_sql: '', parameter_values: [], deliveries: [],
  };
}

export type Frequency = 'weekdays' | 'daily' | 'weekly' | 'once' | 'custom';
export function triggerFields(trigger: Trigger): { frequency: Frequency; time: string; day: string } {
  if (trigger.kind === 'once') return { frequency: 'once', time: '09:00', day: '1' };
  const match = /^(\d{1,2}) (\d{1,2}) \* \* (\*|1-5|[0-6])$/.exec(trigger.cron ?? '');
  if (!match) return { frequency: 'custom', time: '09:00', day: '1' };
  return { frequency: match[3] === '*' ? 'daily' : match[3] === '1-5' ? 'weekdays' : 'weekly', time: `${match[2].padStart(2, '0')}:${match[1].padStart(2, '0')}`, day: match[3].length === 1 && match[3] !== '*' ? match[3] : '1' };
}
export function cronFor(frequency: Exclude<Frequency, 'once' | 'custom'>, time: string, day: string): string {
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time) || !/^[0-6]$/.test(day)) throw new Error('Choose a valid time and weekday.');
  const [h, m] = time.split(':').map(Number);
  return `${m} ${h} * * ${frequency === 'daily' ? '*' : frequency === 'weekdays' ? '1-5' : day}`;
}
export function emailDestinations(text: string) {
  const addresses = [...new Set(text.split(/[,;\n]/).map(s => s.trim()).filter(Boolean))];
  if (!addresses.length) throw new Error('Enter at least one email address.');
  for (const address of addresses) if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(address)) throw new Error(`Check the email address “${address}”.`);
  return addresses.map(address => ({ kind: 'email', address }));
}
export function validateSchedule(schedule: Schedule): void {
  if (!schedule.title.trim()) throw new Error('Give this schedule a name.');
  const action = schedule.action.render_report;
  if (!action || schedule.action.kind !== 'render_report') throw new Error('This page supports report schedules.');
  if (!action.outputs.length) throw new Error('Choose at least one report format.');
  if (action.track === 'pinned' && !action.report.revision_id) throw new Error('Choose a report version.');
  if (schedule.trigger.kind === 'once' && (schedule.trigger.run_at == null || !Number.isFinite(schedule.trigger.run_at) || schedule.trigger.run_at <= Date.now())) throw new Error('Choose a future date and time.');
  if (schedule.trigger.kind === 'cron' && !schedule.trigger.cron?.trim()) throw new Error('Enter a cron expression.');
  try { new Intl.DateTimeFormat(undefined, { timeZone: schedule.trigger.time_zone }); } catch { throw new Error('Choose a valid IANA time zone, such as America/New_York.'); }
  for (const delivery of schedule.deliveries) {
    if (!delivery.destinations.length) throw new Error('Enter at least one email address.');
    if (delivery.inline === 'none' && !delivery.attach.length) throw new Error('Choose at least one attachment, or include report content in the email.');
    if (delivery.inline === 'report' && !action.outputs.includes(HTML)) throw new Error('Report content in email requires HTML output.');
    if (delivery.attach.some(format => !action.outputs.includes(format))) throw new Error('An attachment format is missing from the report outputs.');
  }
}

/** Attach with the exact options of the matching connection. Never silently use defaults for a missing connection. */
export function sourceAttach(source: DelegationKey & { alias?: string }, catalogs: readonly CatalogData[], workspaceId?: string) {
  const workspace = workspaceId ? getWorkspace(workspaceId) : null;
  const connected = catalogs.find(c => c.sourceUrl && sameService(c.sourceUrl, source.location) && (c.serverCatalogName ?? c.catalogName) === source.catalog_name &&
    (c.catalogName === (source.alias ?? source.attachment_id) || workspace?.catalogs.some(w => w.id === source.attachment_id && w.alias === c.catalogName)));
  const saved = workspace?.catalogs.find(c => (c.id === source.attachment_id || c.alias === (source.alias ?? source.attachment_id)) && sameService(c.url, source.location) && c.catalogName === source.catalog_name);
  if (!connected || (workspace && !saved)) throw new Error(`Connect the original ${source.catalog_name} data source in this workspace before authorizing it.`);
  if (saved?.rawOptions) throw new Error(`Reconnect ${source.catalog_name} to finish importing its connection options first.`);
  const secrets = saved && workspaceId ? catalogSecrets({ workspaceId, catalogId: saved.id, url: saved.url, catalogName: saved.catalogName }) : secretsFor(source.location, source.catalog_name);
  const options = { ...(connected.attachOptions ?? {}), ...(saved?.options ?? {}), ...(saved?.target ? { target: saved.target } : {}), ...secrets };
  for (const name of connected.secretOptionNames ?? []) if (!(name in options)) throw new Error(`Reconnect ${source.catalog_name}: its saved ${name} option is unavailable.`);
  const names = Object.keys(options);
  // ATTACH options in Cupola are DuckDB text, the same scalar strings passed by its catalog connection.
  const batch = names.length ? serializeBatch(singleRowBatch(new Schema(names.map(name => new Field(name, new Utf8(), false))), options)) : null;
  return { options: batch, data_version_spec: saved?.dataVersionSpec ?? '', implementation_version: '' };
}

export class AuthorizationError extends Error {
  constructor(readonly service: string, message: string, options?: ErrorOptions) { super(message, options); }
}
/** Opaque credentials live only in this call. Metadata is the only return value or persisted state. */
export async function authorizeSchedules(scheduler: ReportClient, keys: DelegationKey[], title: string,
  attach: (key: DelegationKey) => ReturnType<typeof sourceAttach>, days: number,
  makeClient: (url: string) => ReportClient = url => new ReportClient(url)): Promise<DelegationRecord[]> {
  const scope = await scheduler.recoveryScope();
  const existing = await scheduler.call('delegations.list_delegations', {});
  const ttl = BigInt(days * 86400), writes: DelegationWrite[] = [];
  for (const key of keys) {
    try {
      const options = key.kind === 'catalog' ? attach(key) : null;
      const client = makeClient(key.location);
      const grant = await client.call('identity.issue_grant', { purpose: `Cupola scheduled report: ${title}`, scopes: [], ttl_seconds: ttl });
      registerSecretValues([grant.token]);
      const ticket = options ? await client.call('tickets.seal_attach', { request: { catalog_name: key.catalog_name, ...options, ttl_seconds: ttl } }) : null;
      if (ticket) registerSecretValues([ticket.ticket]);
      const expires = Math.min(grant.expires_at, ticket?.expires_at ?? Infinity);
      writes.push({ expected_version: existing.find(item => delegationId(item) === delegationId(key))?.version ?? 0n,
        delegation: { ...key, grant: grant.token, ticket: ticket?.ticket ?? '', expires_at: Number.isFinite(expires) ? expires * 1000 : null } });
    } catch (error) {
      // Upstream error payloads can echo inputs; never persist or display them with credentials.
      throw new AuthorizationError(key.location, `Could not authorize ${key.catalog_name || 'report access'} at ${new URL(key.location).host}. Check your connection and sign in again if the worker requires a recent login.`, { cause: error });
    }
  }
  if (scope !== await scheduler.recoveryScope()) throw new Error('Your scheduling account changed. Authorize again with the intended account.');
  // A credential write is deliberately excluded from MutationJournal/localStorage.
  try { return (await scheduler.call('delegations.put_delegations', { request_id: crypto.randomUUID(), delegations: writes })).delegations; }
  catch { throw new Error('Access could not be confirmed. Refresh its status before authorizing again; an earlier credential update may have completed.'); }
}

/** Artifact URLs are worker-issued capabilities; never attach browser credentials to them. */
export function artifactUrl(value: string): string | null {
  try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : null; } catch { return null; }
}
