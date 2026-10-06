import { useEffect, useRef } from 'react';

export type SavedDocumentAction =
  | { type: 'rename'; title: string }
  | { type: 'duplicate' | 'export' | 'delete' };
type DocumentKind = 'notebook' | 'report';
const ACTION_EVENT = 'cupola:saved-document-action';
interface ActionRequest {
  kind: DocumentKind;
  scope: string;
  id: string;
  action: SavedDocumentAction;
  result?: Promise<void>;
}

/** Open editors own their changes. Only an unopened document uses the stored definition. */
export function requestSavedDocumentAction(
  request: Omit<ActionRequest, 'result'>,
  fallback: () => void,
): Promise<void> {
  const detail: ActionRequest = { ...request };
  window.dispatchEvent(new CustomEvent<ActionRequest>(ACTION_EVENT, { detail }));
  return detail.result ?? Promise.resolve().then(fallback);
}

export function useSavedDocumentActions(
  kind: DocumentKind,
  scope: string,
  id: string,
  handler: (action: SavedDocumentAction) => void,
) {
  const current = useRef(handler);
  current.current = handler;
  useEffect(() => {
    const handle = (event: Event) => {
      const detail = (event as CustomEvent<ActionRequest>).detail;
      if (
        detail.kind !== kind ||
        detail.scope !== scope ||
        detail.id !== id ||
        detail.result
      )
        return;
      detail.result = Promise.resolve().then(() => current.current(detail.action));
    };
    window.addEventListener(ACTION_EVENT, handle);
    return () => window.removeEventListener(ACTION_EVENT, handle);
  }, [kind, scope, id]);
}

export function downloadDocumentFile(contents: string, filename: string) {
  const url = URL.createObjectURL(new Blob([contents], { type: 'application/json' }));
  const link = Object.assign(document.createElement('a'), { href: url, download: filename });
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
