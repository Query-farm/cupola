import { readEditorState, saveEditorState, type EditorDoc, type EditorState } from './editor-store';
import { bindDocument, documentBinding, documentConfigurationKey, documentDraftScope, documentIsDirty, documentSaveIntentKey, portableBody, portableContext, type DocumentBinding } from '../reporting/documents';
import { ReportClient } from '../reporting/client';
import { MutationJournal } from '../reporting/journal';
import type { LibraryDocumentRequest } from '../reporting/open-document';
import { appBase } from '../app-base';
import { REPORT_ROUTE_CHANGED } from '../reporting/navigation';

export const queryScope = (doc: EditorDoc, workspace: string) => doc.library?.scope ?? workspace;
export const queryDraft = (doc: EditorDoc): EditorDoc => ({ ...doc, id: doc.library?.id ?? doc.id });
export const queryBinding = (doc: EditorDoc, workspace: string) => documentBinding(queryScope(doc, workspace), 'query', queryDraft(doc).id);

export function showQueryTab(doc: EditorDoc, workspace: string) {
  const binding = queryBinding(doc, workspace), url = new URL(location.href);
  for (const key of [...url.searchParams.keys()]) if (key.startsWith('report_') || key.startsWith('evidence_') || key === 'local_report_folder' || key === 'notebook') url.searchParams.delete(key);
  url.pathname = `${appBase.replace(/\/$/, '')}/${binding && !binding.deleted ? 'reports' : ''}`;
  if (binding && !binding.deleted) {
    url.searchParams.set('report_service', binding.url);
    url.searchParams.set(binding.localScope ? 'evidence_report' : 'report_id', binding.record.report_id);
    if (doc.library?.revision) url.searchParams.set('report_revision', doc.library.revision);
  }
  history.replaceState(history.state, '', url);
  window.dispatchEvent(new Event(REPORT_ROUTE_CHANGED));
}

export function querySavePending(doc: EditorDoc, workspace: string): boolean {
  const raw = localStorage.getItem(documentSaveIntentKey(queryScope(doc, workspace), 'query', queryDraft(doc).id));
  const intent = raw ? JSON.parse(raw) : null;
  return Boolean(intent && new MutationJournal(new ReportClient(intent.url), intent.auth, intent.id).pending);
}

/** Workspace tabs are the navigation index; library drafts retain their recovery storage. */
export function saveQueryTabs(state: EditorState, workspace: string) {
  for (const doc of state.docs) {
    if (!doc.library) continue;
    const draft = queryDraft(doc), existing = readEditorState(doc.library.scope);
    saveEditorState({ version: 1, activeId: draft.id, docs: [...(existing?.docs.filter(d => d.id !== draft.id) ?? []), draft] }, doc.library.scope);
  }
  saveEditorState(state, workspace);
}

/** A query first saved from a scratch tab also needs a draft after that tab closes. */
export function retainClosedQuery(doc: EditorDoc, workspace: string) {
  if (doc.library) return;
  const binding = queryBinding(doc, workspace);
  if (!binding) return;
  const scope = documentDraftScope(binding.localScope ?? binding.url, binding.record.report_id, null, binding.authScope);
  const id = binding.record.report_id;
  saveEditorState({ version: 1, activeId: id, docs: [{ ...doc, id }] }, scope);
  if (readEditorState(scope)?.docs[0]?.sql !== doc.sql) throw new Error('The recovery draft could not be saved. Keep this tab open.');
  for (const makeKey of [documentSaveIntentKey, documentConfigurationKey]) {
    const value = localStorage.getItem(makeKey(workspace, 'query', doc.id));
    if (value) localStorage.setItem(makeKey(scope, 'query', id), value);
  }
  bindDocument(scope, 'query', id, binding);
}

/** Reconcile a fresh response with the current tab, including unsaved in-memory edits. */
export function openLibraryQuery(state: EditorState, request: LibraryDocumentRequest, workspace: string): EditorState {
  const { record, libraryUrl, localScope, authScope, pinned, recoveryOnly } = request;
  const body = portableBody(record);
  if (record.envelope?.body_format !== 'cupola.query/1' || typeof body.query !== 'string') throw new Error('Unsupported query format.');
  const revision = pinned ? record.revision_served : undefined;
  const existingTab = state.docs.find(doc => {
    if (doc.library) return doc.library.url === libraryUrl && doc.library.localScope === localScope && doc.library.id === record.report_id
      && doc.library.revision === revision && doc.library.authScope === authScope;
    const binding = queryBinding(doc, workspace);
    return binding && binding.url === libraryUrl && binding.localScope === localScope && binding.record.report_id === record.report_id
      && !revision && binding.authScope === authScope;
  });
  const scope = existingTab ? queryScope(existingTab, workspace) : documentDraftScope(localScope ?? libraryUrl, record.report_id, revision ?? null, authScope);
  const draftId = existingTab ? queryDraft(existingTab).id : record.report_id;
  const binding = documentBinding(scope, 'query', draftId);
  const draft = existingTab ?? readEditorState(scope)?.docs.find(doc => doc.id === draftId);
  const tabId = existingTab?.id ?? scope;
  const tab: EditorDoc = { id: tabId, name: record.envelope.title, sql: body.query, createdAt: Date.now(), updatedAt: Date.now(),
    ...(existingTab && !existingTab.library ? {} : { library: { scope, id: draftId, url: libraryUrl, authScope, localScope, revision } }) };
  const pending = draft && querySavePending({ ...draft, library: tab.library }, workspace);
  const dirty = binding && draft && documentIsDirty('query', queryDraft(draft), binding);
  const staleResponse = binding && (binding.record.revision_number > record.revision_number || binding.record.version > record.version);
  const changed = binding && binding.record.revision_served !== record.revision_served;
  const adopt = !binding || !draft || (!recoveryOnly && !staleResponse && changed && !dirty && !pending);
  const nextDoc = adopt ? tab : { ...tab, ...draft, id: tabId, library: tab.library };
  const nextBinding: DocumentBinding = adopt
    ? { url: libraryUrl, localScope, authScope, record, original: body, context: portableContext(body) }
    : { ...binding!, authScope, record: { ...binding!.record, version: staleResponse ? binding!.record.version : record.version, folder_id: record.folder_id, ownership: record.ownership, published_revision_id: record.published_revision_id, allowed_actions: record.allowed_actions } };
  nextBinding.readOnly = recoveryOnly || pinned || !record.allowed_actions.includes('edit');
  nextBinding.pinnedRevision = revision;
  const next = { ...state, docs: existingTab ? state.docs.map(d => d.id === tabId ? nextDoc : d) : [...state.docs, nextDoc], activeId: tabId };
  saveQueryTabs(next, workspace);
  // Verify that recovery storage was written before installing the save binding.
  const saved = readEditorState(scope)?.docs.find(d => d.id === draftId);
  if (!saved || saved.sql !== nextDoc.sql || saved.name !== nextDoc.name) throw new Error('The browser could not preserve this query draft. Free storage and reopen it.');
  bindDocument(scope, 'query', draftId, nextBinding);
  return next;
}
