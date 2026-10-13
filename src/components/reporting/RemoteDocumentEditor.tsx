import { useRef, useState } from 'react';
import { NotebookWorkspace } from '../notebooks/NotebookPanel';
import { SqlEditorView } from '../editor/SqlEditorView';
import { bindDocument, documentBinding, documentDraftScope, decodeNotebook, portableBody, portableContext } from '../../lib/reporting/documents';
import { documentKind } from '../../lib/reporting/object-adapter';
import { listNotebooks, saveNotebook, type Notebook } from '../../lib/notebooks/model';
import { loadEditorState, readEditorState, saveEditorState } from '../../lib/editor/editor-store';
import { reportError } from '../../lib/reporting/client';
import type { ReportResult } from '../../lib/reporting/contracts.generated';
import type { ReportingWorkspaceProps } from './ReportingWorkspace';

/** The ordinary editors retain a local recovery draft for a shared document. */
export function RemoteDocumentEditor({ record, libraryUrl, pinned, onLeave, localScope, authScope, recoveryOnly, ...props }: ReportingWorkspaceProps & {
  record: ReportResult; localScope?: string; authScope?: string; recoveryOnly?: boolean; libraryUrl: string; pinned: boolean; onLeave: () => void;
}) {
  const beforeLeave = useRef<(() => boolean) | null>(null);
  const [loaded] = useState(() => {
    try {
      const kind = documentKind(record);
      if (kind !== 'query' && kind !== 'notebook') throw new Error('This document needs another editor.');
      const scope = documentDraftScope(localScope ?? libraryUrl, record.report_id, pinned ? record.revision_served : null, authScope);
      const body = portableBody(record), existing = documentBinding(scope, kind, record.report_id);
      let notebook: Notebook | undefined;
      if (existing && recoveryOnly) bindDocument(scope, kind, record.report_id, { ...existing, record: { ...existing.record, allowed_actions: [] }, readOnly: true });
      if (!existing) {
        // Persist the draft before binding; partial local-storage writes cannot lose worker data.
        if (kind === 'notebook') {
          notebook = decodeNotebook(record, props.serviceUrl, scope, record.report_id); saveNotebook(notebook);
        } else {
          if (record.envelope?.body_format !== 'cupola.query/1' || typeof body.query !== 'string') throw new Error('Unsupported query format.');
          saveEditorState({ version: 1, activeId: record.report_id, docs: [{ id: record.report_id, name: record.envelope.title, sql: body.query, createdAt: Date.now(), updatedAt: Date.now() }] }, scope);
        }
        if (kind === 'query' && readEditorState(scope)?.docs.find(d => d.id === record.report_id)?.sql !== body.query) throw new Error('The browser could not preserve this query draft. Free storage and reopen it.');
        bindDocument(scope, kind, record.report_id, { localScope, url: libraryUrl, record, original: body, context: portableContext(body), readOnly: pinned || !record.allowed_actions.includes('edit') });
      } else if (kind === 'notebook') notebook = listNotebooks(scope).documents.find(d => d.id === record.report_id);
      else loadEditorState(scope);
      if (kind === 'notebook' && !notebook) throw new Error('The local notebook draft is unavailable. Export recovery data or open another revision.');
      return { kind, scope, notebook, error: '' };
    } catch (e) { return { error: reportError(e), kind: '', scope: '' }; }
  });
  if (loaded.error) return <p role="alert" className="p-5 text-destructive">{loaded.error}</p>;
  if (loaded.notebook) return <NotebookWorkspace initial={loaded.notebook} beforeLeave={beforeLeave} catalogs={props.catalogs} libraryScope={props.workspaceId ?? props.serviceUrl} onClose={onLeave} onInsertionHandled={() => {}} />;
  const catalog = props.catalogs[0];
  if (!catalog) return <p className="p-5">Connect a catalog to open the query editor. The saved query remains available in this library.</p>;
  return <SqlEditorView serviceUrl={props.serviceUrl} workspaceId={loaded.scope} libraryScope={props.workspaceId ?? props.serviceUrl} catalogData={catalog} attachedCatalogs={[...props.catalogs]} />;
}
