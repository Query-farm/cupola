import { useEffect, useState } from 'react';
import { Search, UserRound, ArrowRight } from 'lucide-react';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { ReportClient, reportError } from '../../lib/reporting/client';
import { OWNERSHIP_PROTOCOL, type Ownership, type OwnershipCandidate, type OwnershipOptions } from '../../lib/reporting/contracts.generated';
import { ReportPage } from './ReportPage';
import { ReportNotice } from './ReportNotice';

export function OwnershipPage({ client, resourceKind, resourceId, name, current, blocked, onApply, onBack, onRetry }: {
  client: ReportClient; resourceKind: 'report' | 'folder'; resourceId: string; name: string; current: Ownership;
  onRetry?: () => Promise<void>; blocked: boolean; onApply: (ownership: Ownership) => Promise<void>; onBack: () => void;
}) {
  const [supported, setSupported] = useState<boolean | null>(null), [query, setQuery] = useState('');
  const [options, setOptions] = useState<OwnershipOptions | null>(null), [selected, setSelected] = useState<OwnershipCandidate | null>(null);
  const [loading, setLoading] = useState(true), [busy, setBusy] = useState(false), [error, setError] = useState(''), [generation, setGeneration] = useState(0);
  useEffect(() => {
    const abort = new AbortController(); setLoading(true); setError(''); setOptions(null); setSelected(null);
    const timer = setTimeout(() => void (async () => {
      const available = await client.discover(abort.signal, OWNERSHIP_PROTOCOL);
      if (abort.signal.aborted) return;
      setSupported(available);
      if (available) {
        const result = await client.call('find_owners', { resource_kind: resourceKind, resource_id: resourceId, query }, abort.signal);
        if (!abort.signal.aborted) setOptions(result);
      }
    })().catch(e => { if (!abort.signal.aborted) setError(reportError(e)); }).finally(() => { if (!abort.signal.aborted) setLoading(false); }), query ? 200 : 0);
    return () => { clearTimeout(timer); abort.abort(); };
  }, [client, resourceKind, resourceId, query, generation]);
  const owner = current.owner_ref;
  const sameIdentity = (a: Ownership['owner_ref'] | null, b: Ownership['owner_ref'] | null) => a?.kind === b?.kind && a?.id === b?.id;
  const unchanged = selected && sameIdentity(selected.ownership.owner_ref, current.owner_ref) && sameIdentity(selected.ownership.parent_owner_ref, current.parent_owner_ref);
  return <ReportPage title="Transfer ownership" description={name} onBack={onBack} backLabel={resourceKind === 'folder' ? 'Back to folder' : 'Back to report'}>
    <p className="text-sm">Choose who will manage this {resourceKind}. Its creator and revision authors stay recorded. Your access may change after the transfer.{resourceKind === 'folder' && ' Reports and subfolders keep their own owners.'}</p>
    <div className="flex items-center gap-3 rounded border p-4"><UserRound className="size-5 text-muted-foreground" /><div><p className="text-xs text-muted-foreground">Current owner</p><p className="font-medium">{owner.display_name || owner.id}</p></div></div>
    {supported === false && <ReportNotice title="Ownership selection unavailable">This worker does not offer owner lookup. Use its administration interface to transfer ownership.</ReportNotice>}
    {supported !== false && <section className="space-y-3" aria-label="Choose a new owner">
      <label className="block space-y-1 text-sm font-medium">New owner<Input aria-label="Search owners" placeholder="Search owners…" value={query} disabled={busy} onChange={e => setQuery(e.target.value)} /></label>
      <p className="text-sm text-muted-foreground">{options?.query_hint || 'The worker supplies eligible owners for this item.'}</p>
      {loading ? <p role="status">Searching owners…</p> : options && <fieldset className="space-y-2"><legend className="sr-only">Available owners</legend>{options.candidates.map((candidate, index) => <label key={index} className="flex cursor-pointer items-center gap-3 rounded border p-3 has-checked:border-primary has-checked:bg-muted"><input type="radio" name="new-owner" disabled={busy} checked={selected === candidate} onChange={() => setSelected(candidate)} /><span><span className="block font-medium">{candidate.label}</span><span className="block text-sm text-muted-foreground">{candidate.description}</span></span></label>)}
        {!options.candidates.length && <p role="status" className="text-sm">No matching owners. {query ? 'Try another name or identifier.' : 'Enter an identifier using the worker’s search instructions.'}</p>}
      </fieldset>}
      {options?.has_more && <p role="status" className="text-sm">More owners are available. Refine your search.</p>}
    </section>}
    {selected && <section aria-label="Review ownership transfer" className="space-y-3 rounded border p-4"><h2 className="font-semibold">Review transfer</h2><p className="flex flex-wrap items-center gap-2">{owner.display_name || owner.id}<ArrowRight className="size-4" />{selected.label}</p>
      {selected.ownership.parent_owner_ref && <p className="text-sm text-muted-foreground">Parent owner: {selected.ownership.parent_owner_ref.display_name || selected.ownership.parent_owner_ref.id}</p>}
      <Button disabled={busy || blocked || Boolean(unchanged)} onClick={async () => { setBusy(true); setError(''); try { await onApply(selected.ownership); } catch (e) { setError(reportError(e)); } finally { setBusy(false); } }}>{busy ? 'Transferring…' : 'Transfer ownership'}</Button>
      {unchanged && <p className="text-sm text-muted-foreground">This is already the current owner.</p>}
    </section>}
    {onRetry && <ReportNotice title="Transfer awaiting confirmation" action={<Button disabled={busy} onClick={async () => { setBusy(true); setError(''); try { await onRetry(); } catch (e) { setError(`${reportError(e)} If your access changed, the transfer may already have completed. Return to the library to check.`); } finally { setBusy(false); } }}>Retry transfer</Button>}>Retry confirms the original request; it does not start another transfer.</ReportNotice>}
    {blocked && !onRetry && <ReportNotice title="Changes are pending">Finish saving or resolve pending changes before transferring ownership.</ReportNotice>}
    {error && <ReportNotice kind="error" title="Could not complete ownership transfer" action={<Button variant="outline" size="sm" disabled={busy} onClick={() => setGeneration(n => n + 1)}><Search />Search again</Button>}>{error}</ReportNotice>}
  </ReportPage>;
}
