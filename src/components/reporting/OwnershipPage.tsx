import { useEffect, useState } from 'react';
import { Search, UserRound, ArrowRight } from 'lucide-react';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { ReportClient, reportError } from '../../lib/reporting/client';
import { type Ownership, type OwnershipCandidate, type OwnerDiscoveryCapabilities, type ResourceContext, RESOURCE_IDENTITY_PROTOCOL } from '../../lib/reporting/contracts.generated';
import { discoveryLimit } from '../../lib/reporting/discovery';
import { ReportPage } from './ReportPage';
import { ReportNotice } from './ReportNotice';

export function OwnershipPage({ client, resourceKind, resourceId, name, current, blocked, onApply, onBack, onRetry }: {
  client: ReportClient; resourceKind: 'report' | 'folder'; resourceId: string; name: string; current: Ownership;
  onRetry?: () => Promise<void>; blocked: boolean; onApply: (ownership: Ownership) => Promise<void>; onBack: () => void;
}) {
  const [supported, setSupported] = useState<boolean | null>(null), [query, setQuery] = useState('');
  const [capabilities, setCapabilities] = useState<OwnerDiscoveryCapabilities | null>(null);
  const [context, setContext] = useState<ResourceContext | null>(null);
  const [options, setOptions] = useState<OwnershipCandidate[]>([]), [selected, setSelected] = useState<OwnershipCandidate | null>(null);
  const [scheme, setScheme] = useState(''), [identifier, setIdentifier] = useState(''), [parentIdentifier, setParentIdentifier] = useState(''), [parentScheme, setParentScheme] = useState('');
  const [loading, setLoading] = useState(true), [busy, setBusy] = useState(false), [error, setError] = useState(''), [generation, setGeneration] = useState(0);
  useEffect(() => {
    const abort = new AbortController(); setLoading(true); setError(''); setCapabilities(null); setContext(null); setSelected(null); setOptions([]);
    void (async () => {
      let caps: OwnerDiscoveryCapabilities | null;
      if (await client.discover(abort.signal, RESOURCE_IDENTITY_PROTOCOL)) {
        const next = await client.ownershipContext(resourceKind, resourceId, abort.signal);
        caps = (await client.call('resource_identity.get_identity_capabilities', { context: next }, abort.signal)).ownership;
        if (!abort.signal.aborted) setContext(next);
      } else {
        const available = await client.canFindOwners(resourceKind, abort.signal);
        caps = available ? await client.call('get_ownership_capabilities', { resource_kind: resourceKind, resource_id: resourceId }, abort.signal) : null;
      }
      if (!abort.signal.aborted) { setCapabilities(caps); setSupported(Boolean(caps)); setScheme(caps?.identifier_schemes[0] ?? ''); setParentScheme(caps?.identifier_schemes[0] ?? ''); }
    })().catch(e => { if (!abort.signal.aborted) setError(reportError(e)); }).finally(() => { if (!abort.signal.aborted) setLoading(false); });
    return () => abort.abort();
  }, [client, resourceKind, resourceId, generation]);
  useEffect(() => {
    if (!capabilities) return;
    const abort = new AbortController(); setOptions([]); setSelected(null);
    const limit = discoveryLimit(capabilities, query);
    if (limit === null) return;
    setLoading(true);
    const timer = setTimeout(() => void (context
      ? client.call('resource_identity.find_owners', { context, query: query.trim(), limit }, abort.signal)
      : client.call('find_owners', { resource_kind: resourceKind, resource_id: resourceId, query: query.trim(), limit }, abort.signal))
      .then(result => { if (!abort.signal.aborted) setOptions(result); })
      .catch(e => { if (!abort.signal.aborted) setError(reportError(e)); })
      .finally(() => { if (!abort.signal.aborted) setLoading(false); }), 200);
    return () => { clearTimeout(timer); abort.abort(); setLoading(false); };
  }, [client, capabilities, context, query, resourceKind, resourceId]);
  async function checkExact() {
    if (!context || !identifier.trim()) return;
    setBusy(true); setSelected(null); setError('');
    try {
      const check = await client.call('resource_identity.check_ownership', { context, owner: { scheme, value: identifier.trim() }, parent: parentIdentifier.trim() ? { scheme: parentScheme, value: parentIdentifier.trim() } : null });
      if (check.state !== 'allowed' || !check.ownership) throw new Error(check.message || (check.state === 'unknown' ? 'The worker could not verify this owner. Try again.' : 'This owner is not eligible for this item.'));
      setSelected({ ownership: check.ownership, label: check.ownership.owner_ref.display_name || check.ownership.owner_ref.id, description: 'Verified by the worker' });
    } catch (e) { setError(reportError(e)); } finally { setBusy(false); }
  }
  const owner = current.owner_ref;
  const sameIdentity = (a: Ownership['owner_ref'] | null, b: Ownership['owner_ref'] | null) => a?.kind === b?.kind && a?.id === b?.id;
  const unchanged = selected && sameIdentity(selected.ownership.owner_ref, current.owner_ref) && sameIdentity(selected.ownership.parent_owner_ref, current.parent_owner_ref);
  return <ReportPage title="Transfer ownership" description={name} onBack={onBack} backLabel={resourceKind === 'folder' ? 'Back to folder' : 'Back to report'}>
    <p className="text-sm">Choose who will manage this {resourceKind}. Its creator and revision authors stay recorded. Your access may change after the transfer.{resourceKind === 'folder' && ' Reports and subfolders keep their own owners.'}</p>
    <div className="flex items-center gap-3 rounded border p-4"><UserRound className="size-5 text-muted-foreground" /><div><p className="text-xs text-muted-foreground">Current owner</p><p className="font-medium">{owner.display_name || owner.id}</p></div></div>
    {supported === false && <ReportNotice title="Ownership selection unavailable">This worker does not offer owner lookup. Use its administration interface to transfer ownership.</ReportNotice>}
    {supported !== false && <section className="space-y-3" aria-label="Choose a new owner">
      <p className="text-sm text-muted-foreground">{capabilities?.query_hint || 'The worker supplies eligible owners for this item.'}</p>
      {capabilities && <p className="text-xs text-muted-foreground">Supported owner kinds: {capabilities.policy.owner_kinds.join(', ')}. Teams use group ownership. Ownership does not grant execution credentials.</p>}
      {capabilities?.search_supported && <label className="block space-y-1 text-sm font-medium">New owner<Input aria-label="Search owners" placeholder="Search owners…" value={query} disabled={busy} onChange={e => { setQuery(e.target.value); setSelected(null); }} /></label>}
      {loading ? <p role="status">Checking owners…</p> : <fieldset className="space-y-2"><legend className="sr-only">Available owners</legend>{options.map((candidate, index) => <label key={index} className="flex cursor-pointer items-center gap-3 rounded border p-3 has-checked:border-primary has-checked:bg-muted"><input type="radio" name="new-owner" disabled={busy} checked={selected === candidate} onChange={() => setSelected(candidate)} /><span><span className="block font-medium">{candidate.label}</span><span className="block text-sm text-muted-foreground">{candidate.description}</span></span></label>)}</fieldset>}
      {capabilities && discoveryLimit(capabilities, query) === null && capabilities.search_supported && <p className="text-sm">Enter at least {String(capabilities.min_query_length)} characters to search.</p>}
      {capabilities && options.length >= Number(discoveryLimit(capabilities, query) ?? Infinity) && <p className="text-sm">Refine your search to find other owners.</p>}
      {context && capabilities?.identifier_schemes.length ? <fieldset disabled={busy} className="space-y-3 rounded border p-3"><legend className="px-1 text-sm font-medium">Validate an exact owner</legend>
        <label className="block text-sm">Identifier type<select aria-label="Owner identifier type" className="ml-2 rounded border bg-background p-2" value={scheme} onChange={e => { setScheme(e.target.value); setSelected(null); }}>{capabilities.identifier_schemes.map(value => <option key={value}>{value}</option>)}</select></label>
        <label className="block text-sm">Owner identifier<Input value={identifier} onChange={e => { setIdentifier(e.target.value); setSelected(null); }} /></label>
        <label className="block text-sm">Parent identifier type<select className="ml-2 rounded border bg-background p-2" value={parentScheme} onChange={e => { setParentScheme(e.target.value); setSelected(null); }}>{capabilities.identifier_schemes.map(value => <option key={value}>{value}</option>)}</select></label>
        <label className="block text-sm">Parent owner identifier (optional)<Input value={parentIdentifier} onChange={e => { setParentIdentifier(e.target.value); setSelected(null); }} /></label>
        <p className="text-xs text-muted-foreground">Leave the parent blank for the worker’s safe default. The parent is a management owner, independent of folders and group membership.</p>
        <Button variant="outline" disabled={!identifier.trim()} onClick={() => void checkExact()}>Validate owner</Button>
      </fieldset> : null}
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
