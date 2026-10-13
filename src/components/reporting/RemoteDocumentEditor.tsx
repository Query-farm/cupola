import { useEffect, useRef, useState } from 'react';
import { NotebookWorkspace } from '../notebooks/NotebookPanel';
import { SqlEditorView } from '../editor/SqlEditorView';
import { bindDocument, DOCUMENT_BINDING_CHANGED, documentBinding, documentIsDirty, encodeDocument, documentSaveIntentKey, resetDocumentDraft, documentDraftScope, decodeNotebook, portableBody, portableContext } from '../../lib/reporting/documents';
import { documentKind } from '../../lib/reporting/object-adapter';
import { listNotebooks, saveNotebook, type Notebook } from '../../lib/notebooks/model';
import { loadEditorState, readEditorState, saveEditorState } from '../../lib/editor/editor-store';
import { ReportClient, reportError } from '../../lib/reporting/client';
import { MutationJournal } from '../../lib/reporting/journal';
import { saveLocalObject } from '../../lib/reporting/local-objects';
import { Button } from '../ui/button';
import type { ReportResult } from '../../lib/reporting/contracts.generated';
import type { ReportingWorkspaceProps } from './ReportingWorkspace';

/** The ordinary editors retain a local recovery draft for a shared document. */
export function RemoteDocumentEditor({ record, libraryUrl, pinned, onLeave, localScope, authScope, recoveryOnly, ...props }: ReportingWorkspaceProps & {
  record: ReportResult; localScope?: string; authScope?: string; recoveryOnly?: boolean; libraryUrl: string; pinned: boolean; onLeave: () => void;
}) {
  const [comparing, setComparing] = useState(false);
  const [recoveryError, setRecoveryError] = useState('');
  const beforeLeave = useRef<(() => boolean) | null>(null);
  const [loaded] = useState(() => {
    try {
      const kind = documentKind(record);
      if (kind !== 'query' && kind !== 'notebook') throw new Error('This document needs another editor.');
      const scope = documentDraftScope(localScope ?? libraryUrl, record.report_id, pinned ? record.revision_served : null, authScope);
      const body = portableBody(record), existing = documentBinding(scope, kind, record.report_id);
      let notebook: Notebook | undefined;
      const draft = existing ? kind === 'notebook' ? listNotebooks(scope).documents.find(d => d.id === record.report_id) : readEditorState(scope)?.docs.find(d => d.id === record.report_id) : undefined;
      const intent = JSON.parse(localStorage.getItem(documentSaveIntentKey(scope, kind, record.report_id)) ?? 'null');
      const pending = intent && Boolean(new MutationJournal(new ReportClient(intent.url), intent.auth, intent.id).pending);
      const changed = Boolean(existing && existing.record.revision_served !== record.revision_served);
      const dirty = Boolean(existing && draft && documentIsDirty(kind, draft, existing));
      const conflict = changed && (dirty || pending);
      // A clean browser recovery draft must never hide a newer worker revision.
      const adopt = !existing || (!recoveryOnly && !conflict && (changed || !draft));
      if (existing && recoveryOnly) bindDocument(scope, kind, record.report_id, { ...existing, record: { ...existing.record, allowed_actions: [] }, readOnly: true });
      if (adopt) {
        // Persist the draft before binding; partial local-storage writes cannot lose worker data.
        if (kind === 'notebook') {
          notebook = decodeNotebook(record, props.serviceUrl, scope, record.report_id); saveNotebook(notebook);
        } else {
          if (record.envelope?.body_format !== 'cupola.query/1' || typeof body.query !== 'string') throw new Error('Unsupported query format.');
          saveEditorState({ version: 1, activeId: record.report_id, docs: [{ id: record.report_id, name: record.envelope.title, sql: body.query, createdAt: Date.now(), updatedAt: Date.now() }] }, scope);
        }
        if (kind === 'query' && readEditorState(scope)?.docs.find(d => d.id === record.report_id)?.sql !== body.query) throw new Error('The browser could not preserve this query draft. Free storage and reopen it.');
        bindDocument(scope, kind, record.report_id, { localScope, url: libraryUrl, record, original: body, context: portableContext(body), readOnly: pinned || !record.allowed_actions.includes('edit') });
      } else {
        // Permissions come from the current response, even when retaining local edits.
        bindDocument(scope, kind, record.report_id, { ...existing!, record: { ...existing!.record, version: record.version, folder_id: record.folder_id, ownership: record.ownership, published_revision_id: record.published_revision_id, allowed_actions: record.allowed_actions }, readOnly: recoveryOnly || pinned || !record.allowed_actions.includes('edit') });
        if (kind === 'notebook') notebook = draft as Notebook;
        else loadEditorState(scope);
      }
      if (kind === 'notebook' && !notebook) throw new Error('The local notebook draft is unavailable. Export recovery data or open another revision.');
      return { kind, scope, notebook, conflict, pending, draft, error: '' };
    } catch (e) { return { error: reportError(e), kind: '', scope: '' }; }
  });
  const [comparisonDraft, setComparisonDraft] = useState(loaded.draft);
  const [base, setBase] = useState(() => loaded.scope ? documentBinding(loaded.scope, loaded.kind as 'query' | 'notebook', record.report_id) : null);
  useEffect(() => {
    if (!loaded.scope) return;
    const changed = () => setBase(documentBinding(loaded.scope, loaded.kind as 'query' | 'notebook', record.report_id));
    const edited = (event: Event) => { const detail = (event as CustomEvent).detail; if (detail.id === record.report_id && detail.url === libraryUrl) setComparisonDraft(detail.doc); };
    window.addEventListener(DOCUMENT_BINDING_CHANGED, changed); window.addEventListener('cupola:document-edit-state', edited);
    return () => { window.removeEventListener(DOCUMENT_BINDING_CHANGED, changed); window.removeEventListener('cupola:document-edit-state', edited); };
  }, [loaded.scope, record.report_id, libraryUrl]);
  const conflict = !recoveryOnly && base && base.record.revision_served !== record.revision_served;
  const intentRaw = loaded.scope ? localStorage.getItem(documentSaveIntentKey(loaded.scope, loaded.kind as 'query' | 'notebook', record.report_id)) : null;
  const savedIntent = intentRaw ? JSON.parse(intentRaw) : null;
  const intent = savedIntent && Boolean(new MutationJournal(new ReportClient(savedIntent.url), savedIntent.auth, savedIntent.id).pending);
  if (loaded.error) return <p role="alert" className="p-5 text-destructive">{loaded.error}</p>;
  const catalog = props.catalogs[0];
  return <div className="flex h-full min-h-0 flex-col">
    {conflict && <section aria-label="Newer version available" className="shrink-0 space-y-2 border-b bg-amber-50 p-3 text-sm dark:bg-amber-950/20">
      <p className="font-medium">A newer version is available</p><p>Your unsaved draft is kept on this device. Compare it with version {String(record.revision_number)} before choosing which to keep.</p>
      <div className="flex flex-wrap gap-2"><Button size="sm" variant="outline" onClick={() => setComparing(!comparing)}>{comparing ? 'Hide comparison' : 'Compare versions'}</Button><Button size="sm" variant="outline" disabled={Boolean(intent)} onClick={() => {
        if (!confirm('Load the latest saved version? Your edited draft will be saved as a recovered copy in Library → Local.')) return;
        try {
          if (!comparisonDraft || !base) throw new Error('The recovery draft is unavailable. Keep this editor open and save a copy first.');
          const kind = loaded.kind as 'query' | 'notebook', encoded = encodeDocument(kind, comparisonDraft, props.catalogs, props.workspaceId, base);
          encoded.envelope.title += ' (recovered draft)';
          saveLocalObject(props.workspaceId ?? props.serviceUrl, { id: crypto.randomUUID(), kind, ...encoded, updatedAt: Date.now() });
          resetDocumentDraft(localScope ?? libraryUrl, record.report_id, kind, authScope); location.reload();
        } catch (error) { setRecoveryError(reportError(error)); }
      }}>Load latest version</Button><Button size="sm" variant="outline" disabled={Boolean(intent)} onClick={() => window.dispatchEvent(new CustomEvent('cupola:document-save-copy', { detail: { scope: loaded.scope, id: record.report_id } }))}>Save draft as a copy</Button></div>
      {recoveryError && <p role="alert" className="text-destructive">{recoveryError}</p>}
      {intent && <p>A save is awaiting confirmation. Open Save status and retry it before replacing this draft.</p>}
      {comparing && <div className="grid max-h-72 gap-3 overflow-auto sm:grid-cols-2"><section><h3 className="font-medium">Your draft</h3><pre className="whitespace-pre-wrap break-words rounded border bg-background p-2 text-xs">{loaded.kind === 'query' ? (comparisonDraft as any)?.sql : JSON.stringify((comparisonDraft as Notebook)?.cells, null, 2)}</pre></section><section><h3 className="font-medium">Latest saved version</h3><pre className="whitespace-pre-wrap break-words rounded border bg-background p-2 text-xs">{loaded.kind === 'query' ? portableBody(record).query : JSON.stringify(portableBody(record).cells, null, 2)}</pre></section></div>}
    </section>}
    <div className="min-h-0 flex-1">{loaded.notebook ? <NotebookWorkspace managed={!localScope} initial={loaded.notebook} beforeLeave={beforeLeave} catalogs={props.catalogs} libraryScope={props.workspaceId ?? props.serviceUrl} onClose={onLeave} onInsertionHandled={() => {}} /> : catalog ? <SqlEditorView managed={!localScope} serviceUrl={props.serviceUrl} workspaceId={loaded.scope} libraryScope={props.workspaceId ?? props.serviceUrl} catalogData={catalog} attachedCatalogs={[...props.catalogs]} /> : <p className="p-5">Connect a catalog to open the query editor. The saved query remains available in this library.</p>}</div>
  </div>;
}
