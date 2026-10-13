import { useEffect, useRef, useState, type RefObject } from 'react';
import type { NotebookInsertion } from '../../lib/notebooks/navigation';
import { NotebookWorkspace } from '../notebooks/NotebookPanel';
import { bindDocument, DOCUMENT_BINDING_CHANGED, documentBinding, documentIsDirty, encodeDocument, documentSaveIntentKey, resetDocumentBinding, documentDraftScope, decodeNotebook, portableBody, portableContext } from '../../lib/reporting/documents';
import { documentKind } from '../../lib/reporting/object-adapter';
import { listNotebooks, saveNotebook, type Notebook } from '../../lib/notebooks/model';
import { ReportClient, reportError } from '../../lib/reporting/client';
import { MutationJournal } from '../../lib/reporting/journal';
import { saveLocalObject } from '../../lib/reporting/local-objects';
import { Button } from '../ui/button';
import type { ReportResult } from '../../lib/reporting/contracts.generated';
import type { ReportingWorkspaceProps } from './ReportingWorkspace';

/** The ordinary editors retain a local recovery draft for a shared document. */
export function LibraryNotebookEditor({ record: initialRecord, libraryUrl, pinned, onLeave, localScope, authScope, recoveryOnly, beforeLeaveRef, onBusyChange, insertion, ...props }: ReportingWorkspaceProps & {
  beforeLeaveRef?: RefObject<(() => boolean) | null>; onBusyChange?: (busy: boolean) => void; insertion?: NotebookInsertion | null;
  record: ReportResult; localScope?: string; authScope?: string; recoveryOnly?: boolean; libraryUrl: string; pinned: boolean; onLeave: () => void;
}) {
  const [record, setRecord] = useState(initialRecord);
  const [comparing, setComparing] = useState(false);
  const [recoveryError, setRecoveryError] = useState('');
  const ownBeforeLeave = useRef<(() => boolean) | null>(null);
  const beforeLeave = beforeLeaveRef ?? ownBeforeLeave;
  const [loaded] = useState(() => {
    try {
      const kind = documentKind(record);
      if (kind !== 'notebook') throw new Error('This document needs another editor.');
      const workspace = props.workspaceId ?? props.serviceUrl;
      const openDraft = !pinned ? listNotebooks(workspace).documents.find(doc => {
        const binding = documentBinding(workspace, 'notebook', doc.id);
        return binding?.url === libraryUrl && binding.localScope === localScope && binding.authScope === authScope && binding.record.report_id === record.report_id;
      }) : undefined;
      const scope = openDraft ? workspace : documentDraftScope(localScope ?? libraryUrl, record.report_id, pinned ? record.revision_served : null, authScope);
      const draftId = openDraft?.id ?? record.report_id;
      const body = portableBody(record), existing = documentBinding(scope, kind, draftId);
      let notebook: Notebook | undefined;
      const draft = existing ? openDraft ?? listNotebooks(scope).documents.find(d => d.id === draftId) : undefined;
      const intent = JSON.parse(localStorage.getItem(documentSaveIntentKey(scope, kind, draftId)) ?? 'null');
      const pending = intent && Boolean(new MutationJournal(new ReportClient(intent.url), intent.auth, intent.id).pending);
      const changed = Boolean(existing && existing.record.revision_served !== record.revision_served);
      const dirty = Boolean(existing && draft && documentIsDirty(kind, draft, existing));
      const conflict = changed && (dirty || pending);
      // A clean browser recovery draft must never hide a newer worker revision.
      const adopt = !existing || (!recoveryOnly && !conflict && (changed || !draft));
      if (existing && recoveryOnly) bindDocument(scope, kind, draftId, { ...existing, record: { ...existing.record, allowed_actions: [] }, readOnly: true });
      if (adopt) {
        // Persist the draft before binding; partial local-storage writes cannot lose worker data.
        notebook = decodeNotebook(record, props.serviceUrl, scope, draftId); saveNotebook(notebook);
        bindDocument(scope, kind, draftId, { localScope, authScope, pinnedRevision: pinned ? record.revision_served : undefined, url: libraryUrl, record, original: body, context: portableContext(body), readOnly: pinned || !record.allowed_actions.includes('edit') });
      } else {
        // Permissions come from the current response, even when retaining local edits.
        bindDocument(scope, kind, draftId, { ...existing!, record: { ...existing!.record, version: record.version, folder_id: record.folder_id, ownership: record.ownership, published_revision_id: record.published_revision_id, allowed_actions: record.allowed_actions }, readOnly: recoveryOnly || pinned || !record.allowed_actions.includes('edit') });
        notebook = draft;
      }
      if (kind === 'notebook' && !notebook) throw new Error('The local notebook draft is unavailable. Export recovery data or open another revision.');
      return { kind, scope, draftId, notebook, conflict, pending, draft, error: '' };
    } catch (e) { return { error: reportError(e), kind: '', scope: '' }; }
  });
  const [comparisonDraft, setComparisonDraft] = useState(loaded.draft);
  const [base, setBase] = useState(() => loaded.scope ? documentBinding(loaded.scope, 'notebook', loaded.draftId!) : null);
  useEffect(() => {
    if (!loaded.scope) return;
    const changed = () => setBase(documentBinding(loaded.scope, 'notebook', loaded.draftId!));
    const edited = (event: Event) => { const detail = (event as CustomEvent).detail; if (detail.id === record.report_id && detail.url === libraryUrl) setComparisonDraft(detail.doc); };
    const newer = (event: Event) => { const detail = (event as CustomEvent).detail; if (detail.url === libraryUrl && detail.record.report_id === record.report_id) setRecord(detail.record); };
    window.addEventListener('cupola:document-newer-version', newer);
    window.addEventListener(DOCUMENT_BINDING_CHANGED, changed); window.addEventListener('cupola:document-edit-state', edited);
    return () => { window.removeEventListener('cupola:document-newer-version', newer); window.removeEventListener(DOCUMENT_BINDING_CHANGED, changed); window.removeEventListener('cupola:document-edit-state', edited); };
  }, [loaded.scope, record.report_id, libraryUrl]);
  const conflict = !recoveryOnly && base && record.revision_number > base.record.revision_number;
  const intentRaw = loaded.scope ? localStorage.getItem(documentSaveIntentKey(loaded.scope, 'notebook', loaded.draftId!)) : null;
  const savedIntent = intentRaw ? JSON.parse(intentRaw) : null;
  const intent = savedIntent && Boolean(new MutationJournal(new ReportClient(savedIntent.url), savedIntent.auth, savedIntent.id).pending);
  if (loaded.error) return <p role="alert" className="p-5 text-destructive">{loaded.error}</p>;

  return <div className="flex h-full min-h-0 flex-col">
    {recoveryOnly && <p role="status" className="border-b p-3 text-sm">The worker could not be opened. This is your local recovery draft; save a copy to keep working.</p>}
    {conflict && <section aria-label="Newer version available" className="shrink-0 space-y-2 border-b bg-amber-50 p-3 text-sm dark:bg-amber-950/20">
      <p className="font-medium">A newer version is available</p><p>Your unsaved draft is kept on this device. Compare it with version {String(record.revision_number)} before choosing which to keep.</p>
      <div className="flex flex-wrap gap-2"><Button size="sm" variant="outline" onClick={() => setComparing(!comparing)}>{comparing ? 'Hide comparison' : 'Compare versions'}</Button><Button size="sm" variant="outline" disabled={Boolean(intent)} onClick={() => {
        if (!confirm('Load the latest saved version? Your edited draft will be saved as a recovered copy in Library → Local.')) return;
        try {
          if (!comparisonDraft || !base) throw new Error('The recovery draft is unavailable. Keep this editor open and save a copy first.');
          const kind = 'notebook', encoded = encodeDocument(kind, comparisonDraft, props.catalogs, props.workspaceId, base);
          encoded.envelope.title += ' (recovered draft)';
          saveLocalObject(props.workspaceId ?? props.serviceUrl, { id: crypto.randomUUID(), kind, ...encoded, updatedAt: Date.now() });
          resetDocumentBinding(loaded.scope, 'notebook', loaded.draftId!); location.reload();
        } catch (error) { setRecoveryError(reportError(error)); }
      }}>Load latest version</Button><Button size="sm" variant="outline" disabled={Boolean(intent)} onClick={() => window.dispatchEvent(new CustomEvent('cupola:document-save-copy', { detail: { scope: loaded.scope, id: loaded.draftId! } }))}>Save draft as a copy</Button></div>
      {recoveryError && <p role="alert" className="text-destructive">{recoveryError}</p>}
      {intent && <p>A save is awaiting confirmation. Open Save status and retry it before replacing this draft.</p>}
      {comparing && <div className="grid max-h-72 gap-3 overflow-auto sm:grid-cols-2"><section><h3 className="font-medium">Your draft</h3><pre className="whitespace-pre-wrap break-words rounded border bg-background p-2 text-xs">{JSON.stringify(comparisonDraft?.cells, null, 2)}</pre></section><section><h3 className="font-medium">Latest saved version</h3><pre className="whitespace-pre-wrap break-words rounded border bg-background p-2 text-xs">{JSON.stringify(portableBody(record).cells, null, 2)}</pre></section></div>}
    </section>}
    <div className="min-h-0 flex-1">{loaded.notebook && <NotebookWorkspace initial={loaded.notebook} beforeLeave={beforeLeave} catalogs={props.catalogs} libraryScope={props.workspaceId ?? props.serviceUrl} onClose={onLeave} onBusyChange={onBusyChange} insertion={insertion} onInsertionHandled={() => {}} />}</div>
  </div>;
}
