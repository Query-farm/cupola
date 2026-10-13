import { listLocalObjects, saveLocalObject, localObjectRecord } from '../../lib/reporting/local-objects';
import { placeLocalReport } from '../../lib/reporting/local-library';
import { useEffect, useState } from 'react';
import { Save, FolderOpen } from 'lucide-react';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { ReportStorageTree } from './ReportStorageTree';
import { useReportLocations } from './ReportLocations';
import { ReportClient, reportError } from '../../lib/reporting/client';
import { MutationJournal } from '../../lib/reporting/journal';
import { bindDocument, documentBinding, documentLink, decodeNotebook, encodeDocument, portableBody, portableContext, type DocumentKind } from '../../lib/reporting/documents';
import type { Notebook } from '../../lib/notebooks/model';
import type { EditorDoc } from '../../lib/editor/editor-store';
import type { CatalogData } from '../../lib/service';

/** Shared durable save workflow for the Notebook and Query editors. */
export function DocumentSave({ kind, doc, scope, catalogs, workspaceId, libraryScope = scope, onTitleSaved, disabled }: {
  kind: DocumentKind; doc: Notebook | EditorDoc; scope: string; catalogs: readonly CatalogData[]; workspaceId?: string; libraryScope?: string; onTitleSaved?: (title: string) => void; disabled?: boolean;
}) {
  const { locations, refresh } = useReportLocations();
  const [binding, setBinding] = useState(() => documentBinding(scope, kind, doc.id));
  const [choosing, setChoosing] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [target, setTarget] = useState(binding?.url ?? 'local'), [folder, setFolder] = useState<string | null>(binding?.record.folder_id ?? null);
  const [name, setName] = useState('title' in doc ? doc.title : doc.name);
  const intentKey = `cupola.objects.save-intent:${JSON.stringify([scope, kind, doc.id])}`;
  const [pending, setPending] = useState<MutationJournal | null>(null);
  useEffect(() => { setBinding(documentBinding(scope, kind, doc.id)); setChoosing(false); setError(''); setNotice(''); setPending(null);
    try {
      const raw = localStorage.getItem(intentKey);
      if (raw) { const intent = JSON.parse(raw); const journal = new MutationJournal(new ReportClient(intent.url), intent.auth, intent.id); if (journal.pending) setPending(journal); else localStorage.removeItem(intentKey); }
    } catch (e) { setError(reportError(e)); }
  }, [scope, kind, doc.id]);
  useEffect(() => {
    if (!binding || binding.localScope) return;
    let dirty = true;
    try {
      if (kind === 'query') dirty = (doc as EditorDoc).sql !== binding.original.query || (doc as EditorDoc).name !== binding.record.envelope?.title;
      else { const original = decodeNotebook(binding.record, '', undefined, doc.id), current = doc as Notebook;
        dirty = current.title !== original.title || JSON.stringify(current.cells) !== JSON.stringify(original.cells) || JSON.stringify(current.parameters ?? []) !== JSON.stringify(original.parameters ?? []);
      }
    } catch { /* Invalid drafts must not permit moving the old saved definition. */ }
    window.dispatchEvent(new CustomEvent('cupola:document-edit-state', { detail: { url: binding.url, id: binding.record.report_id, dirty: dirty || Boolean(pending?.pending) || busy, record: binding.record } }));
  }, [doc, binding, pending, busy]);
  const supported = locations.filter(l => l.info?.body_formats.includes(`cupola.${kind}/1`));
  async function save(copy = false, retry = false) {
    setBusy(true); setError('');
    try {
      const intent = retry ? JSON.parse(localStorage.getItem(intentKey) ?? 'null') : null;
      const url = intent?.url ?? (copy ? target : binding?.url ?? target);
      if (url === 'local') {
        const encoded = encodeDocument(kind, doc, catalogs, workspaceId, binding);
        if (copy) encoded.envelope.title = name.trim() || `${encoded.envelope.title} (copy)`;
        const localScope = binding?.localScope ?? libraryScope;
        if (!copy && binding?.localScope) {
          const current = listLocalObjects(localScope).find(d => d.id === binding.record.report_id);
          if (!current || String(current.updatedAt) !== binding.record.head_revision_id) throw new Error('This document changed in another editor. Save a copy to keep your draft.');
        }
        const object = { id: !copy && binding?.localScope ? binding.record.report_id : crypto.randomUUID(), kind, ...encoded, updatedAt: Date.now() };
        placeLocalReport(localScope, object.id, folder); saveLocalObject(localScope, object);
        const result = localObjectRecord(object), body = portableBody(result);
        const next = { url: 'local', localScope, record: result, original: body, context: portableContext(body) };
        if (!copy || !binding) { bindDocument(scope, kind, doc.id, next); setBinding(next); onTitleSaved?.(result.envelope!.title); } setChoosing(false); setNotice('Saved on this device'); refresh(); return;
      }
      if (!url) throw new Error('Choose a writable worker library. Your local draft is already kept on this device.');
      const client = new ReportClient(url), auth = intent?.auth ?? await client.recoveryScope();
      const id = `document:${kind}:${scope}:${doc.id}`;
      const journal = pending ?? new MutationJournal(client, auth, id);
      setPending(journal);
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
        const encoded = encodeDocument(kind, doc, catalogs, workspaceId, binding);
        if (copy) encoded.envelope.title = name.trim() || `${encoded.envelope.title} (copy)`;
        result = binding && !copy && !binding.readOnly && binding.record.allowed_actions.includes('edit')
          ? await journal.run('commit_revision', { report_id: binding.record.report_id, expected_revision_id: binding.record.head_revision_id, ...encoded, message: `Saved ${kind}` })
          : await journal.run('create_report', { ...encoded, folder_id: folder, message: `Saved ${kind}` });
      }
      const body = portableBody(result);
      const next = { url, record: result, original: body, context: portableContext(body) };
      if (!(intent?.copy ?? copy) || !binding) { bindDocument(scope, kind, doc.id, next); setBinding(next); onTitleSaved?.(result.envelope!.title); } localStorage.removeItem(intentKey); setPending(null); setChoosing(false); setNotice('Saved to library'); refresh();
    } catch (e) { setError(reportError(e)); } finally { setBusy(false); }
  }
  const editable = binding && !binding.readOnly && binding.record.allowed_actions.includes('edit');
  return <div className="border-b bg-muted/20 px-3 py-2 text-sm" aria-label={`Save ${kind}`}>
    <div className="flex flex-wrap items-center gap-2">
      <Button size="sm" variant="outline" disabled={disabled || busy || Boolean(pending?.pending)} onClick={() => editable ? void save() : (setName('title' in doc ? doc.title : doc.name), setChoosing(true))}><Save />{editable ? binding.localScope ? 'Save on this device' : 'Save to library' : 'Save to library…'}</Button>
      {binding && <><Button size="sm" variant="ghost" disabled={busy || Boolean(pending?.pending)} onClick={() => { setTarget(binding.url); setName(`${'title' in doc ? doc.title : doc.name} (copy)`); setChoosing(true); }}>Save a copy…</Button>{!binding.localScope && <Button size="sm" variant="ghost" onClick={() => void documentLink(binding).then(url => { location.href = url; }).catch(e => setError(reportError(e)))}><FolderOpen />Details & history</Button>}</>}
      <span className="text-muted-foreground" role="status">{busy ? 'Saving…' : notice || (binding ? `${binding.localScope ? 'On this device' : locations.find(l => l.url === binding.url)?.name ?? 'Library'} · Version ${binding.record.revision_number}` : 'Local draft')}</span>
    </div>
    {error && <p role="alert" className="mt-2 text-destructive">{error} Your draft is kept on this device.</p>}
    {pending?.pending && <Button size="sm" disabled={busy} onClick={() => void save(false, true)}>Retry pending save</Button>}
    {choosing && <section className="mt-3 max-w-xl space-y-3 rounded-lg border bg-card p-4" aria-label="Save destination">
      <label className="block space-y-1">Name<Input value={name} onChange={e => setName(e.target.value)} /></label>
      <ReportStorageTree objectKind={kind} locations={supported} scope={libraryScope} location={target} folderId={folder} picker disabled={busy} onSelect={(url, id) => { setTarget(url); setFolder(id); }} />
      {!supported.length && <p>You can save on this device. No connected worker accepts this document type.</p>}
      <div className="flex gap-2"><Button disabled={busy || !target} onClick={() => void save(true)}>Save here</Button><Button variant="ghost" disabled={busy} onClick={() => setChoosing(false)}>Cancel</Button></div>
    </section>}
  </div>;
}
