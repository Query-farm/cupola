import { useEffect, useState } from 'react';
import { CheckCircle2, KeyRound } from 'lucide-react';
import { Button } from '../ui/button';
import { ReportNotice } from './ReportNotice';
import { ReportClient, reportError } from '../../lib/reporting/client';
import type { DelegationKey, DelegationRecord, GrantPolicy } from '../../lib/reporting/contracts.generated';
import type { CatalogData } from '../../lib/service';
import { authorizeSchedules, getRequiredDelegations, AuthorizationError, dateLabel, delegationId, sameService, sourceAttach } from '../../lib/reporting/schedules';
import { startLoginFlow } from '../../lib/oauth-client';

export function ScheduleAccess({ client, requirements, catalogs, workspaceId, title, busy, onChange, warningSeconds = 86400 }: {
  client: ReportClient; requirements: Array<DelegationKey & { alias?: string }>; catalogs: readonly CatalogData[]; workspaceId?: string; title: string; busy: boolean; onChange: () => void; warningSeconds?: number;
}) {
  const [records, setRecords] = useState<DelegationRecord[]>([]), [error, setError] = useState(''), [signIn, setSignIn] = useState('');
  const [loading, setLoading] = useState(true), [working, setWorking] = useState(false), [days, setDays] = useState('30'), [generation, setGeneration] = useState(0);
  const [duration, setDuration] = useState<'worker' | 'custom'>('worker');
  const [policies, setPolicies] = useState<Record<string, GrantPolicy | null>>({});
  const [policyLoading, setPolicyLoading] = useState(true);
  const locations = [...new Set(requirements.map(key => key.location))].sort();
  const locationsKey = JSON.stringify(locations);
  const allKnown = locations.every(url => policies[url] != null);
  const maximum = Math.min(...Object.values(policies).flatMap(policy => policy?.max_ttl_seconds == null ? [] : [Number(policy.max_ttl_seconds) / 86400]));
  const requested = duration === 'worker' && allKnown ? 'worker' : 'custom';
  useEffect(() => {
    const abort = new AbortController(); setPolicyLoading(true);
    void Promise.all(locations.map(async url => {
      const source = new ReportClient(url);
      const policy = await source.identityInfo('identity.get_grant_policy', abort.signal);
      return [url, policy] as const;
    })).then(entries => {
      if (abort.signal.aborted) return;
      setPolicies(Object.fromEntries(entries));
      const maxDays = Math.min(...entries.flatMap(([, policy]) => policy?.max_ttl_seconds == null ? [] : [Number(policy.max_ttl_seconds) / 86400]));
      setDays(old => String(Math.min(Number(old), maxDays)));
    }).catch(e => { if (!abort.signal.aborted) { setPolicies({}); setError(reportError(e)); } }).finally(() => { if (!abort.signal.aborted) setPolicyLoading(false); });
    return () => abort.abort();
  }, [locationsKey, generation]);
  const [bindings, setBindings] = useState<Record<string, string>>({});
  const choices = (key: DelegationKey) => catalogs.filter(c => c.sourceUrl && sameService(c.sourceUrl, key.location) && (c.serverCatalogName ?? c.catalogName) === key.catalog_name);
  const connection = (key: DelegationKey & { alias?: string }) => bindings[delegationId(key)] ?? choices(key).find(c => c.catalogName === (key.alias ?? key.attachment_id))?.catalogName ?? '';
  useEffect(() => {
    const abort = new AbortController(); setLoading(true);
    void getRequiredDelegations(client, requirements, abort.signal).then(value => { if (!abort.signal.aborted) setRecords(value); })
      .catch(e => { if (!abort.signal.aborted) setError(reportError(e)); }).finally(() => { if (!abort.signal.aborted) setLoading(false); });
    return () => abort.abort();
  }, [client, generation, JSON.stringify(requirements)]);
  async function authorize() {
    setWorking(true); setError(''); setSignIn('');
    try {
      const attachments = new Map<string, ReturnType<typeof sourceAttach>>();
      for (const key of requirements.filter(k => k.kind === 'catalog')) {
        const alias = connection(key);
        if (!alias) throw new Error(`Choose the connected catalog to use for ${key.catalog_name} before authorizing scheduled access.`);
        attachments.set(delegationId(key), sourceAttach({ ...key, alias }, catalogs, workspaceId));
      }
      await authorizeSchedules(client, requirements, title, key => attachments.get(delegationId(key))!, requested === 'worker' ? 'worker' : Number(days)); setGeneration(n => n + 1); onChange();
    }
    catch (e) { setError(reportError(e)); if (e instanceof AuthorizationError) setSignIn(e.service); }
    finally { setWorking(false); }
  }
  const expiring = records.filter(r => requirements.some(key => delegationId(key) === delegationId(r)) && r.expires_at != null && r.expires_at > Date.now() && r.expires_at <= Date.now() + warningSeconds * 1000);
  return <div className="space-y-4">
    {expiring.length > 0 && <ReportNotice kind="permission" title="Scheduled access expires soon">Renew access below before {dateLabel(Math.min(...expiring.map(r => r.expires_at!)))} to keep scheduled reports running.</ReportNotice>}
    <p className="text-sm text-muted-foreground">Authorize this worker to read the report and its data using your worker accounts while you’re away. The worker controls the permissions and maximum lifetime. Renewing access also benefits your other schedules using these connections.</p>
    {loading ? <p role="status" className="text-sm">Checking scheduled access…</p> : <ul className="divide-y rounded-md border">{requirements.map(key => {
      const record = records.find(r => delegationId(r) === delegationId(key));
      const soon = record?.expires_at != null && record.expires_at <= Date.now() + warningSeconds * 1000;
      const active = record && (record.expires_at == null || record.expires_at > Date.now());
      return <li key={delegationId(key)} className="flex items-start gap-3 p-3 text-sm">{active && !soon ? <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-emerald-600" /> : <KeyRound className="mt-0.5 size-4 shrink-0 text-amber-600" />}<div className="min-w-0"><p className="font-medium">{key.kind === 'service' ? 'Report storage' : key.catalog_name}</p><p className="break-all text-xs text-muted-foreground">{new URL(key.location).host}{key.kind === 'catalog' ? ` · ${key.alias ?? key.attachment_id}` : ''}</p><p className="mt-1 text-xs">{active ? record.expires_at == null ? 'Authorized · no expiration' : `Authorized until ${dateLabel(record.expires_at)}` : record ? `Expired ${dateLabel(record.expires_at)}` : 'Authorization required'}</p><p className="mt-1 text-xs text-muted-foreground">{policyLoading ? 'Checking worker access policy…' : policies[key.location] ? policies[key.location]!.max_ttl_seconds == null ? 'Worker permits access without expiration.' : `Worker maximum: ${durationLabel(Number(policies[key.location]!.max_ttl_seconds))}.` : 'Worker does not publish a lifetime limit. It may shorten the requested duration.'}</p>{key.kind === 'catalog' && <label className="mt-2 block text-xs">Connection for {key.alias ?? key.catalog_name}<select className="ml-2 max-w-full rounded border bg-background p-1.5" value={connection(key)} disabled={working || busy} onChange={e => setBindings(old => ({ ...old, [delegationId(key)]: e.target.value }))}><option value="">Choose a connected catalog</option>{choices(key).map(c => <option key={c.catalogName} value={c.catalogName}>{c.catalogName}</option>)}</select></label>}</div></li>;
    })}</ul>}
    <div className="flex flex-wrap items-center gap-3"><label className="text-sm">Requested access <select aria-label="Requested access duration" className="ml-2 rounded border bg-background p-2" value={requested} onChange={e => setDuration(e.target.value as typeof duration)} disabled={busy || working || policyLoading}>{allKnown && <option value="worker">Worker maximum</option>}<option value="custom">Custom duration</option></select></label>{requested === 'custom' && <label className="text-sm">Days <input aria-label="Access duration in days" type="number" min={1 / 86400} max={Number.isFinite(maximum) ? maximum : undefined} step="any" className="ml-2 w-24 rounded border bg-background p-2" value={days} onChange={e => setDays(e.target.value)} disabled={busy || working} /></label>}<Button type="button" variant="outline" disabled={busy || working || loading || policyLoading || requested === 'custom' && (!Number(days) || Number(days) < 0 || Number(days) > maximum)} onClick={() => void authorize()}><KeyRound />{working ? 'Authorizing…' : 'Authorize / renew access'}</Button><Button type="button" variant="ghost" disabled={working || loading} onClick={() => { setError(''); setGeneration(n => n + 1); }}>Refresh access</Button></div>
    {error && <ReportNotice kind="error" title="Scheduled access needs attention" action={signIn ? <Button type="button" variant="outline" onClick={() => { void startLoginFlow(signIn, location.href, { fresh: true }).catch(e => setError(reportError(e))); }}>Sign in again at {new URL(signIn).host}</Button> : undefined}>{error}</ReportNotice>}
  </div>;
}

function durationLabel(seconds: number): string {
  for (const [unit, size] of [["day", 86400], ["hour", 3600], ["minute", 60], ["second", 1]] as const) {
    if (seconds % size === 0) { const count = seconds / size; return `${count} ${unit}${count === 1 ? "" : "s"}`; }
  }
  return `${seconds} seconds`;
}
