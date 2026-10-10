import { useEffect, useState } from 'react';
import { CheckCircle2, KeyRound } from 'lucide-react';
import { Button } from '../ui/button';
import { ReportNotice } from './ReportNotice';
import { ReportClient, reportError } from '../../lib/reporting/client';
import type { DelegationKey, DelegationRecord } from '../../lib/reporting/contracts.generated';
import type { CatalogData } from '../../lib/service';
import { authorizeSchedules, AuthorizationError, dateLabel, delegationId, sameService, sourceAttach } from '../../lib/reporting/schedules';
import { startLoginFlow } from '../../lib/oauth-client';

export function ScheduleAccess({ client, requirements, catalogs, workspaceId, title, busy, onChange }: {
  client: ReportClient; requirements: Array<DelegationKey & { alias?: string }>; catalogs: readonly CatalogData[]; workspaceId?: string; title: string; busy: boolean; onChange: () => void;
}) {
  const [records, setRecords] = useState<DelegationRecord[]>([]), [error, setError] = useState(''), [signIn, setSignIn] = useState('');
  const [loading, setLoading] = useState(true), [working, setWorking] = useState(false), [days, setDays] = useState('30'), [generation, setGeneration] = useState(0);
  const [bindings, setBindings] = useState<Record<string, string>>({});
  const choices = (key: DelegationKey) => catalogs.filter(c => c.sourceUrl && sameService(c.sourceUrl, key.location) && (c.serverCatalogName ?? c.catalogName) === key.catalog_name);
  const connection = (key: DelegationKey & { alias?: string }) => bindings[delegationId(key)] ?? choices(key).find(c => c.catalogName === (key.alias ?? key.attachment_id))?.catalogName ?? '';
  useEffect(() => {
    const abort = new AbortController(); setLoading(true);
    void client.call('delegations.list_delegations', {}, abort.signal).then(value => { if (!abort.signal.aborted) setRecords(value); })
      .catch(e => { if (!abort.signal.aborted) setError(reportError(e)); }).finally(() => { if (!abort.signal.aborted) setLoading(false); });
    return () => abort.abort();
  }, [client, generation]);
  async function authorize() {
    setWorking(true); setError(''); setSignIn('');
    try {
      const attachments = new Map<string, ReturnType<typeof sourceAttach>>();
      for (const key of requirements.filter(k => k.kind === 'catalog')) {
        const alias = connection(key);
        if (!alias) throw new Error(`Choose the connected catalog to use for ${key.catalog_name} before authorizing scheduled access.`);
        attachments.set(delegationId(key), sourceAttach({ ...key, alias }, catalogs, workspaceId));
      }
      await authorizeSchedules(client, requirements, title, key => attachments.get(delegationId(key))!, Number(days)); setGeneration(n => n + 1); onChange();
    }
    catch (e) { setError(reportError(e)); if (e instanceof AuthorizationError) setSignIn(e.service); }
    finally { setWorking(false); }
  }
  return <div className="space-y-4">
    <p className="text-sm text-muted-foreground">Authorize this worker to read the report and its data using your worker accounts while you’re away. The worker controls the permissions and maximum lifetime. Renewing access also benefits your other schedules using these connections.</p>
    {loading ? <p role="status" className="text-sm">Checking scheduled access…</p> : <ul className="divide-y rounded-md border">{requirements.map(key => {
      const record = records.find(r => delegationId(r) === delegationId(key));
      const active = record && (record.expires_at == null || record.expires_at > Date.now());
      return <li key={delegationId(key)} className="flex items-start gap-3 p-3 text-sm">{active ? <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-emerald-600" /> : <KeyRound className="mt-0.5 size-4 shrink-0 text-amber-600" />}<div className="min-w-0"><p className="font-medium">{key.kind === 'service' ? 'Report storage' : key.catalog_name}</p><p className="break-all text-xs text-muted-foreground">{new URL(key.location).host}{key.kind === 'catalog' ? ` · ${key.alias ?? key.attachment_id}` : ''}</p><p className="mt-1 text-xs">{active ? record.expires_at == null ? 'Authorized · no expiry declared' : `Authorized until ${dateLabel(record.expires_at)}` : record ? `Expired ${dateLabel(record.expires_at)}` : 'Authorization required'}</p>{key.kind === 'catalog' && <label className="mt-2 block text-xs">Connection for {key.alias ?? key.catalog_name}<select className="ml-2 max-w-full rounded border bg-background p-1.5" value={connection(key)} disabled={working || busy} onChange={e => setBindings(old => ({ ...old, [delegationId(key)]: e.target.value }))}><option value="">Choose a connected catalog</option>{choices(key).map(c => <option key={c.catalogName} value={c.catalogName}>{c.catalogName}</option>)}</select></label>}</div></li>;
    })}</ul>}
    <div className="flex flex-wrap items-center gap-3"><label className="text-sm">Requested access <select aria-label="Requested access duration" className="ml-2 rounded border bg-background p-2" value={days} onChange={e => setDays(e.target.value)} disabled={busy || working}><option value="7">7 days</option><option value="30">30 days</option><option value="90">90 days</option></select></label><Button type="button" variant="outline" disabled={busy || working || loading} onClick={() => void authorize()}><KeyRound />{working ? 'Authorizing…' : 'Authorize / renew access'}</Button><Button type="button" variant="ghost" disabled={working || loading} onClick={() => { setError(''); setGeneration(n => n + 1); }}>Refresh access</Button></div>
    {error && <ReportNotice kind="error" title="Scheduled access needs attention" action={signIn ? <Button type="button" variant="outline" onClick={() => { void startLoginFlow(signIn, location.href, { fresh: true }).catch(e => setError(reportError(e))); }}>Sign in again at {new URL(signIn).host}</Button> : undefined}>{error}</ReportNotice>}
  </div>;
}
