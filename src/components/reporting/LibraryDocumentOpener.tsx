import { useEffect } from 'react';
import { openLibraryDocument, type LibraryDocumentRequest } from '../../lib/reporting/open-document';

/** Existing library URLs remain valid, but editing belongs to Query / Notebooks. */
export function LibraryDocumentOpener(props: LibraryDocumentRequest) {
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const id = params.get(props.localScope ? 'evidence_report' : 'report_id');
    if (id === props.record.report_id && (params.get('report_service') ?? 'local') === props.libraryUrl && !params.has('report_view')) openLibraryDocument(props);
  }, []);
  return <p role="status" className="p-5 text-sm text-muted-foreground">Opening document…</p>;
}
