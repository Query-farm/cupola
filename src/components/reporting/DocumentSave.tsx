import { appBase } from '../../lib/app-base';
import { listLocalObjects, saveLocalObject, localObjectRecord } from '../../lib/reporting/local-objects';
import { placeLocalReport, localLibrary, localFolderPath } from '../../lib/reporting/local-library';
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { Save, ChevronDown, Check, Circle, AlertCircle, Loader2, LockKeyhole } from 'lucide-react';
import { Popover, PopoverTrigger, PopoverContent } from '../ui/popover';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger, DropdownMenuSeparator } from '../ui/dropdown-menu';
import { DocumentSources } from './DocumentSources';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { ReportStorageTree } from './ReportStorageTree';
import { useReportLocations } from './ReportLocations';
import { ReportClient, reportError, errorCode } from '../../lib/reporting/client';
import { MutationJournal } from '../../lib/reporting/journal';
import { bindDocument, documentBinding, documentIsDirty, documentSaveIntentKey, documentConfigurationKey, DOCUMENT_BINDING_CHANGED, captureSources, captureContext, encodeDocument, portableBody, portableContext, type DocumentKind, type DocumentConfiguration } from '../../lib/reporting/documents';
import type { Notebook } from '../../lib/notebooks/model';
import type { EditorDoc } from '../../lib/editor/editor-store';
import type { CatalogData } from '../../lib/service';

/** Shared durable save workflow for the Notebook and Query editors. */
export interface DocumentSaveHandle { save: () => void }
export const DocumentSave = forwardRef<DocumentSaveHandle, {
  kind: DocumentKind; doc: Notebook | EditorDoc; scope: string; catalogs: readonly CatalogData[]; workspaceId?: string; libraryScope?: string; onTitleSaved?: (title: string) => void; disabled?: boolean; onSourcesChange?: () => void;
}>(function DocumentSave({ kind, doc, scope, catalogs, workspaceId, libraryScope = scope, onTitleSaved, disabled, onSourcesChange }, ref) {
  const { locations, refresh } = useReportLocations();
  const [binding, setBinding] = useState(() => documentBinding(scope, kind, doc.id));
  const [sourcesOpen, setSourcesOpen] = useState(false);
  const [statusOpen, setStatusOpen] = useState(false);
  const [folderPath, setFolderPath] = useState('');
  const [choosing, setChoosing] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [target, setTarget] = useState(binding?.url ?? 'local'), [folder, setFolder] = useState<string | null>(binding?.record.folder_id ?? null);
  const [name, setName] = useState('title' in doc ? doc.title : doc.name);
  const intentKey = documentSaveIntentKey(scope, kind, doc.id);
  const latest = useRef(doc); latest.current = doc;
  const configurationKey = documentConfigurationKey(scope, kind, doc.id);
  const [configuration, setConfiguration] = useState<DocumentConfiguration | undefined>(() => { try { return JSON.parse(localStorage.getItem(configurationKey) ?? 'null') ?? undefined; } catch { return undefined; } });
  const dirty = binding ? documentIsDirty(kind, doc, binding) || Boolean(configuration) : true;
  const editable = binding && !binding.readOnly && binding.record.allowed_actions.includes('edit');
  const destination = binding?.localScope ? 'On this device' : locations.find(l => l.url === binding?.url)?.name ?? 'Library';
  useEffect(() => {
    if (!binding?.record.folder_id) { setFolderPath(''); return; }
    if (binding.localScope) { setFolderPath(localFolderPath(binding.record.folder_id, localLibrary(binding.localScope).folders)); return; }
    const abort = new AbortController();
    void new ReportClient(binding.url).call('list_folders', {}, abort.signal).then(folders => {
      const names: string[] = [], visited = new Set<string>(); let id = binding.record.folder_id;
      while (id && !visited.has(id)) { visited.add(id); const folder = folders.find(f => f.folder_id === id); if (!folder) break; names.unshift(folder.name); id = folder.parent_folder_id; }
      if (!abort.signal.aborted) setFolderPath(names.join(' / '));
    }).catch(() => { if (!abort.signal.aborted) setFolderPath('Folder'); });
    return () => abort.abort();
  }, [binding?.url, binding?.localScope, binding?.record.folder_id]);
  const [pending, setPending] = useState<MutationJournal | null>(null);
  useEffect(() => { setBinding(documentBinding(scope, kind, doc.id)); setChoosing(false); setError(''); setNotice(''); setPending(null);
    try {
      const raw = localStorage.getItem(intentKey);
      if (raw) { const intent = JSON.parse(raw); const journal = new MutationJournal(new ReportClient(intent.url), intent.auth, intent.id); if (journal.pending) setPending(journal); else localStorage.removeItem(intentKey); }
    } catch (e) { setError(reportError(e)); }
  }, [scope, kind, doc.id]);
  useEffect(() => {
    const changed = () => {
      setBinding(documentBinding(scope, kind, doc.id));
      setConfiguration(JSON.parse(localStorage.getItem(configurationKey) ?? 'null') ?? undefined);
    };
    const copy = (event: Event) => { const detail = (event as CustomEvent).detail; if (detail.scope === scope && detail.id === doc.id) chooseCopy(); };
    window.addEventListener(DOCUMENT_BINDING_CHANGED, changed); window.addEventListener('cupola:document-save-copy', copy);
    return () => { window.removeEventListener(DOCUMENT_BINDING_CHANGED, changed); window.removeEventListener('cupola:document-save-copy', copy); };
  }, [scope, kind, doc.id, binding]);
  useEffect(() => {
    if (!binding) return;
    window.dispatchEvent(new CustomEvent('cupola:document-edit-state', { detail: { url: binding.url, id: binding.record.report_id, dirty: dirty || Boolean(pending?.pending) || busy, record: binding.record, doc } }));
  }, [doc, dirty, binding, pending, busy]);
  function chooseCopy() {
    setTarget(binding?.url ?? 'local'); setFolder(binding?.record.folder_id ?? null);
    setName(`${'title' in doc ? doc.title : doc.name}${binding ? ' (copy)' : ''}`); setError(''); setChoosing(true);
  }
  function requestSave() {
    if (disabled || busy || pending?.pending) return;
    if (choosing) { if (target && name.trim()) void save(true); return; }
    if (editable) { if (dirty) void save(); } else chooseCopy();
  }
  useImperativeHandle(ref, () => ({ save: requestSave }));
  async function openPage(page: 'details' | 'history' | 'share' | 'ownership') {
    if (!binding) return;
    try {
      // Management stays in this workspace; portable sharing links are for recipients.
      const url = new URL(location.href);
      url.pathname = `${appBase.replace(/\/$/, '')}/reports`;
      for (const key of ['evidence_report', 'evidence_new', 'report_revision', 'report_folder', 'notebook', 'report_scheduler', 'report_schedule', 'report_run']) url.searchParams.delete(key);
      url.searchParams.set('report_service', binding.url); url.searchParams.set('report_id', binding.record.report_id); url.searchParams.set('report_view', page);
      if (binding.pinnedRevision) url.searchParams.set('report_revision', binding.pinnedRevision);
      location.href = url.href;
    }
    catch (e) { setError(reportError(e)); }
  }
  const supported = locations.filter(l => l.info?.body_formats.includes(`cupola.${kind}/1`));
  async function save(copy = false, retry = false) {
    setBusy(true); setError(''); setNotice('');
    const submittedTitle = 'title' in doc ? doc.title : doc.name;
    const acknowledgeTitle = (title: string) => { if (('title' in latest.current ? latest.current.title : latest.current.name) === submittedTitle) onTitleSaved?.(title); };
    const encodingBinding = configuration ? { ...(binding ?? { url: '', record: {} as any, original: {}, context: configuration.context }), configurationDraft: configuration } : binding;
    let activeJournal: MutationJournal | undefined;
    try {
      const intent = retry ? JSON.parse(localStorage.getItem(intentKey) ?? 'null') : null;
      const url = intent?.url ?? (copy ? target : binding?.url ?? target);
      if (url === 'local') {
        const encoded = encodeDocument(kind, doc, catalogs, workspaceId, encodingBinding);
        if (copy) encoded.envelope.title = name.trim() || `${encoded.envelope.title} (copy)`;
        const localScope = binding?.localScope ?? libraryScope;
        if (!copy && binding?.localScope) {
          const current = listLocalObjects(localScope).find(d => d.id === binding.record.report_id);
          if (!current || String(current.updatedAt) !== binding.record.head_revision_id) throw new Error('This document changed in another editor. Save a copy to keep your draft.');
        }
        const object = { id: !copy && binding?.localScope ? binding.record.report_id : crypto.randomUUID(), kind, ...encoded, updatedAt: Date.now() };
        placeLocalReport(localScope, object.id, folder); saveLocalObject(localScope, object);
        const result = { ...localObjectRecord(object), folder_id: folder }, body = portableBody(result);
        const next = { url: 'local', localScope, record: result, original: body, context: portableContext(body) };
        if (!copy || !binding) { bindDocument(scope, kind, doc.id, next); setBinding(next); acknowledgeTitle(result.envelope!.title); setConfiguration(undefined); localStorage.removeItem(configurationKey); } setChoosing(false); setNotice(copy && binding ? `Copy saved as “${result.envelope!.title}” on this device.` : ''); refresh(); return;
      }
      if (!url) throw new Error('Choose a writable worker library. Your local draft is already kept on this device.');
      const client = new ReportClient(url), auth = intent?.auth ?? await client.recoveryScope();
      const id = `document:${kind}:${scope}:${doc.id}`;
      const journal = retry && pending?.pending ? pending : new MutationJournal(client, auth, id);
      activeJournal = journal; setPending(journal);
      if (binding && !copy && !retry && !editable) throw new Error('This document is read-only. Save a copy in a writable location.');
      if (journal.pending && !retry) throw new Error('A save is awaiting confirmation. Retry it before starting another save.');
      let result;
      if (retry) result = await journal.retry();
      else {
        if (!binding || copy || binding.readOnly) {
          const info = await client.call('get_report_service_info', {});
          const destination: any = folder ? await client.call('get_folder', { folder_id: folder }) : info;
          const actions = folder ? destination.allowed_actions : info.root_allowed_actions;
          if (!info.writable || !actions.includes('create_report') || destination.creatable_kinds && !destination.creatable_kinds.includes(kind)) throw new Error(`This folder does not allow creating ${kind}s with your current access.`);
        }
        localStorage.setItem(intentKey, JSON.stringify({ url, auth, id, copy }));
        const encoded = encodeDocument(kind, doc, catalogs, workspaceId, encodingBinding);
        if (copy) encoded.envelope.title = name.trim() || `${encoded.envelope.title} (copy)`;
        result = binding && !copy && !binding.readOnly && binding.record.allowed_actions.includes('edit')
          ? await journal.run('commit_revision', { report_id: binding.record.report_id, expected_revision_id: binding.record.head_revision_id, ...encoded, message: `Saved ${kind}` })
          : await journal.run('create_report', { ...encoded, folder_id: folder, message: `Saved ${kind}` });
      }
      const body = portableBody(result);
      const next = { url, authScope: auth, record: result, original: body, context: portableContext(body) };
      if (!(intent?.copy ?? copy) || !binding) { bindDocument(scope, kind, doc.id, next); setBinding(next); acknowledgeTitle(result.envelope!.title); setConfiguration(undefined); localStorage.removeItem(configurationKey); } localStorage.removeItem(intentKey); setPending(null); setChoosing(false); setNotice((intent?.copy ?? copy) && binding ? `Copy saved as “${result.envelope!.title}”.` : ''); refresh();
    } catch (e) {
      if (activeJournal && !activeJournal.pending) { localStorage.removeItem(intentKey); setPending(null); }
      setError(reportError(e)); setStatusOpen(true);
      if (errorCode(e) === 'ABORTED' && binding && !binding.localScope) {
        try { const record = await new ReportClient(binding.url).call('get_report', { report_id: binding.record.report_id }); window.dispatchEvent(new CustomEvent('cupola:document-newer-version', { detail: { url: binding.url, record } })); } catch { /* The original error remains actionable. */ }
      }
    } finally { setBusy(false); }
  }
  const state = busy ? 'Saving…' : pending?.pending ? 'Save unconfirmed' : error ? 'Save failed' : binding && !editable ? 'Read-only' : !binding ? 'Local draft' : dirty ? 'Changes to save' : 'Saved';
  const StatusIcon = busy ? Loader2 : error || pending?.pending ? AlertCircle : binding && !editable ? LockKeyhole : binding && !dirty ? Check : Circle;
  return <div className="flex min-w-0 items-center gap-2" aria-label={`Save ${kind}`}>
    <Popover open={choosing} onOpenChange={open => { if (!busy) setChoosing(open); }}>
      <div className="inline-flex shrink-0 items-center rounded-lg border bg-background">
        <PopoverTrigger render={<Button size="sm" variant="ghost" className="h-7 rounded-r-none" disabled={disabled || busy || Boolean(pending?.pending)} />} onClick={event => { event.preventDefault(); requestSave(); }}><Save />Save</PopoverTrigger>
        <DropdownMenu><DropdownMenuTrigger render={<Button size="icon-sm" variant="ghost" className="h-7 w-6 rounded-l-none border-l" aria-label="Save options" disabled={busy} />}><ChevronDown /></DropdownMenuTrigger><DropdownMenuContent align="start">
          <DropdownMenuItem disabled={disabled || busy || Boolean(pending?.pending)} onClick={chooseCopy}>{binding ? 'Save a copy…' : 'Save as…'}</DropdownMenuItem>
          <DropdownMenuItem disabled={disabled || Boolean(pending?.pending)} onClick={() => setSourcesOpen(true)}>Data sources…</DropdownMenuItem>
          {binding && !binding.localScope && <><DropdownMenuSeparator /><DropdownMenuItem onClick={() => void openPage('details')}>Details</DropdownMenuItem><DropdownMenuItem onClick={() => void openPage('history')}>Version history</DropdownMenuItem><DropdownMenuItem onClick={() => void openPage('share')}>Share</DropdownMenuItem>{binding.record.allowed_actions.includes('transfer_ownership') && <DropdownMenuItem disabled={dirty || Boolean(pending?.pending)} onClick={() => void openPage('ownership')}>Transfer ownership…</DropdownMenuItem>}</>}
        </DropdownMenuContent></DropdownMenu>
      </div>
      <PopoverContent align="start" className="w-[min(28rem,calc(100vw-2rem))] max-h-[min(36rem,80dvh)] overflow-auto p-4">
        <section aria-label="Save destination"><form className="space-y-3 text-sm" onSubmit={event => { event.preventDefault(); if (!busy && !pending?.pending && target && name.trim()) void save(true); }}>
          <h2 className="font-semibold">{binding ? 'Save a copy' : 'Save to library'}</h2>
          <label className="block space-y-1">Name<Input value={name} onChange={e => setName(e.target.value)} disabled={busy} autoFocus /></label>
          <ReportStorageTree objectKind={kind} locations={supported} scope={libraryScope} location={target} folderId={folder} picker disabled={busy} onSelect={(url, id) => { setTarget(url); setFolder(id); }} />
          {!supported.length && <p className="text-muted-foreground">You can save on this device. No connected worker accepts this document type.</p>}
          {error && <p role="alert" className="text-destructive">{error}</p>}
          <div className="flex gap-2"><Button disabled={busy || !target || !name.trim() || Boolean(pending?.pending)} type="submit">Save here</Button><Button type="button" variant="ghost" disabled={busy} onClick={() => setChoosing(false)}>Cancel</Button></div>
        </form></section>
      </PopoverContent>
    </Popover>
    <Popover open={statusOpen} onOpenChange={setStatusOpen}><PopoverTrigger render={<button type="button" className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground hover:text-foreground" aria-label="Save status" />}><StatusIcon aria-hidden className={`size-3.5 shrink-0 ${busy ? 'animate-spin' : ''}`} /><span role="status" className="max-w-32 truncate">{state}</span></PopoverTrigger><PopoverContent align="start" className="w-72 space-y-2 p-3 text-sm">
      <p className="font-medium">{state}{binding ? ` · ${destination}${folderPath ? ` / ${folderPath}` : ''}` : ''}</p>
      <p className="text-muted-foreground">{binding ? `Version ${binding.record.revision_number}. ` : ''}Edits are kept as a recovery draft on this device. Save updates the library document.</p>
      {error && <p role="alert" className="text-destructive">{error}</p>}
      {pending?.pending && <Button size="sm" disabled={busy} onClick={() => void save(false, true)}>Retry pending save</Button>}
      {error && !pending?.pending && <Button size="sm" disabled={busy} onClick={requestSave}>Try again</Button>}
    </PopoverContent></Popover>
    {binding && <span className="hidden max-w-40 truncate text-xs text-muted-foreground xl:inline" title={`${destination}${folderPath ? ` / ${folderPath}` : ''}`}>{destination}{folderPath && ` / ${folderPath}`}</span>}
    {notice && <div role="status" className="fixed bottom-5 right-5 z-50 flex max-w-[calc(100vw-2.5rem)] items-center gap-3 rounded-lg border bg-popover p-3 text-sm shadow-lg"><Check aria-hidden className="size-4 shrink-0" /><span>{notice}</span><Button size="sm" variant="ghost" onClick={() => setNotice('')}>Dismiss</Button></div>}
    {sourcesOpen && <DocumentSources configuration={configuration ?? binding?.configurationDraft ?? { sources: binding?.record.envelope?.data_sources ?? captureSources(catalogs, workspaceId), context: binding?.context ?? captureContext() }} catalogs={catalogs} workspaceId={workspaceId} onClose={() => setSourcesOpen(false)} onApply={value => {
      localStorage.setItem(configurationKey, JSON.stringify(value)); setConfiguration(value);
      if (binding) { const next = { ...binding, configurationDraft: value }; bindDocument(scope, kind, doc.id, next); setBinding(next); }
      setSourcesOpen(false); onSourcesChange?.();
    }} />}
  </div>;
});
