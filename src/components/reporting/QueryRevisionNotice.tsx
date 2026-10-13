import { useState } from 'react';
import type { EditorDoc } from '../../lib/editor/editor-store';
import type { ReportResult } from '../../lib/reporting/contracts.generated';
import { encodeDocument, portableBody, type DocumentBinding } from '../../lib/reporting/documents';
import { saveLocalObject } from '../../lib/reporting/local-objects';
import { reportError } from '../../lib/reporting/client';
import type { CatalogData } from '../../lib/service';
import { Button } from '../ui/button';

export function QueryRevisionNotice({ doc, scope, binding, latest, pending, catalogs, libraryScope, workspaceId, onLoad }: {
  doc: EditorDoc; scope: string; binding: DocumentBinding; latest: ReportResult; pending: boolean;
  catalogs: readonly CatalogData[]; libraryScope: string; workspaceId?: string; onLoad: () => void;
}) {
  const [comparing, setComparing] = useState(false), [error, setError] = useState('');
  return <section aria-label="Newer version available" className="shrink-0 space-y-2 border-b bg-amber-50 p-3 text-sm dark:bg-amber-950/20">
    <p className="font-medium">A newer version is available</p><p>Your unsaved draft is kept on this device. Compare it with version {String(latest.revision_number)} before choosing which to keep.</p>
    <div className="flex flex-wrap gap-2"><Button size="sm" variant="outline" onClick={() => setComparing(!comparing)}>{comparing ? 'Hide comparison' : 'Compare versions'}</Button><Button size="sm" variant="outline" disabled={pending} onClick={() => {
      if (!confirm('Load the latest saved version? Your edited draft will be saved as a recovered copy in Library → Local.')) return;
      try {
        const encoded = encodeDocument('query', doc, catalogs, workspaceId, binding);
        encoded.envelope.title += ' (recovered draft)';
        saveLocalObject(libraryScope, { id: crypto.randomUUID(), kind: 'query', ...encoded, updatedAt: Date.now() });
        onLoad();
      } catch (e) { setError(reportError(e)); }
    }}>Load latest version</Button><Button size="sm" variant="outline" disabled={pending} onClick={() => window.dispatchEvent(new CustomEvent('cupola:document-save-copy', { detail: { scope, id: doc.id } }))}>Save draft as a copy</Button></div>
    {error && <p role="alert" className="text-destructive">{error}</p>}
    {pending && <p>A save is awaiting confirmation. Open Save status and retry it before replacing this draft.</p>}
    {comparing && <div className="grid max-h-72 gap-3 overflow-auto sm:grid-cols-2"><section><h3 className="font-medium">Your draft</h3><pre className="whitespace-pre-wrap break-words rounded border bg-background p-2 text-xs">{doc.sql}</pre></section><section><h3 className="font-medium">Latest saved version</h3><pre className="whitespace-pre-wrap break-words rounded border bg-background p-2 text-xs">{portableBody(latest).query}</pre></section></div>}
  </section>;
}
