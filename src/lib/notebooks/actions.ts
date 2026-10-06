import { downloadDocumentFile, type SavedDocumentAction } from '../saved-document-actions';
import { deleteNotebook, listNotebooks, saveNotebook, uid, type Notebook } from './model';

export function exportNotebook(doc: Notebook) {
  const stem =
    doc.title
      .trim()
      .replace(/[^A-Za-z0-9._-]+/g, '_')
      .replace(/^_+|_+$/g, '') || 'notebook';
  downloadDocumentFile(JSON.stringify(doc, null, 2), `${stem}.notebook.json`);
}

export function copyNotebook(doc: Notebook, storage: Storage = localStorage) {
  const copy = {
    ...doc,
    id: uid(),
    title: `${(doc.title || 'Untitled notebook').slice(0, 193)} (copy)`,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  saveNotebook(copy, storage);
  return copy;
}

export function actOnSavedNotebook(
  scope: string,
  id: string,
  action: SavedDocumentAction,
  storage: Storage = localStorage,
) {
  const doc = listNotebooks(scope, storage).documents.find((item) => item.id === id);
  if (!doc) throw new Error('That notebook is no longer saved in this browser.');
  switch (action.type) {
    case 'rename':
      saveNotebook({ ...doc, title: action.title, updatedAt: Date.now() }, storage);
      break;
    case 'duplicate':
      copyNotebook(doc, storage);
      break;
    case 'export':
      exportNotebook(doc);
      break;
    case 'delete':
      deleteNotebook(scope, id, storage);
      break;
  }
}
