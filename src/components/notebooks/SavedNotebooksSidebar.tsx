import { useEffect, useState, type MouseEvent } from 'react';
import { NotebookPen, FileText } from 'lucide-react';
import { SavedDocumentsSidebar } from '../shared/SavedDocumentsSidebar';
import { listNotebooks, NOTEBOOKS_CHANGED, STORAGE_PREFIX, type Notebook } from '../../lib/notebooks/model';
import { OPEN_NOTEBOOK_EVENT, notebookHref, type OpenNotebookDetail } from '../../lib/notebooks/navigation';
import { requestSavedDocumentAction } from '../../lib/saved-document-actions';
import { actOnSavedNotebook } from '../../lib/notebooks/actions';

export function SavedNotebooksSidebar({
  serviceUrl,
  workspaceId,
  search = '',
  activeId,
  libraryActive,
}: {
  serviceUrl: string;
  /** Notebooks are kept per workspace; without one, per service. */
  workspaceId?: string;
  search?: string;
  activeId?: string | null;
  libraryActive?: boolean;
}) {
  const scope = workspaceId ?? serviceUrl;
  const [documents, setDocuments] = useState<Notebook[]>([]);
  const [error, setError] = useState('');
  useEffect(() => {
    const reload = () => {
      try {
        const { documents, unreadable } = listNotebooks(scope);
        setDocuments(documents);
        setError(
          unreadable ? `${unreadable} saved notebook(s) could not be read. Their data is preserved.` : '',
        );
      } catch {
        setDocuments([]);
        setError('Could not load saved notebooks.');
      }
    };
    const onStorage = (event: StorageEvent) => {
      if (event.key === null || event.key.startsWith(STORAGE_PREFIX)) reload();
    };
    reload();
    window.addEventListener(NOTEBOOKS_CHANGED, reload);
    window.addEventListener('storage', onStorage);
    return () => {
      window.removeEventListener(NOTEBOOKS_CHANGED, reload);
      window.removeEventListener('storage', onStorage);
    };
  }, [scope]);
  const open = (detail: Omit<OpenNotebookDetail, 'serviceUrl'>) =>
    window.dispatchEvent(
      new CustomEvent<OpenNotebookDetail>(OPEN_NOTEBOOK_EVENT, { detail: { serviceUrl, ...detail } }),
    );
  const navigate = (event: MouseEvent<HTMLAnchorElement>, id?: string) => {
    if (
      event.defaultPrevented ||
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    )
      return;
    event.preventDefault();
    open({ id });
  };
  return (
    <SavedDocumentsSidebar
      title="Notebooks"
      documentKind="notebook"
      onAction={(id, action) => requestSavedDocumentAction({ kind: 'notebook', scope, id, action }, () => actOnSavedNotebook(scope, id, action))}
      icon={NotebookPen}
      itemIcon={FileText}
      openKey="cupola.sidebar.notebooks-open"
      testId="sidebar-notebooks-toggle"
      items={documents.map((doc) => ({
        id: doc.id,
        title: doc.title || 'Untitled notebook',
        href: notebookHref(serviceUrl, doc.id),
      }))}
      search={search}
      libraryHref={notebookHref(serviceUrl)}
      onNavigate={navigate}
      onCreate={() => open({ create: true })}
      createLabel="New notebook"
      activeId={activeId}
      libraryActive={libraryActive}
      error={error}
      emptyMessage="No saved notebooks for this connection."
    />
  );
}
