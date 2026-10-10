import { useState } from 'react';
import { queryErrorSummary, queryFailureText, queryFailureTitle, type ReportQueryFailure } from '../../lib/evidence/query-error';

export function EvidenceQueryError({ failure }: { failure: ReportQueryFailure }) {
  const [copyStatus, setCopyStatus] = useState('');
  return <section aria-label={queryFailureTitle(failure)} className="min-w-0 space-y-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm">
    <div className="flex flex-wrap items-start justify-between gap-2">
      <p className="font-semibold text-destructive">{queryFailureTitle(failure)}</p>
      <button type="button" className="shrink-0 text-xs text-primary underline" onClick={async () => {
        try { await navigator.clipboard.writeText(queryFailureText(failure)); setCopyStatus('Copied'); }
        catch { setCopyStatus('Could not copy. Select the SQL and error details to copy manually.'); }
      }}>Copy diagnostics</button>
    </div>
    {copyStatus && <p role="status" className="text-xs text-muted-foreground">{copyStatus}</p>}
    <p className="break-words text-destructive">{queryErrorSummary(failure.message)}</p>
    <div>
      <p className="mb-1 text-xs font-medium">Failed SQL</p>
      <pre className="max-h-64 overflow-auto rounded border bg-background p-2 text-xs"><code>{failure.sql}</code></pre>
    </div>
    {failure.executedSql && failure.executedSql !== failure.sql && <details>
      <summary className="cursor-pointer text-xs">Executed SQL (parameters bound separately)</summary>
      <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words p-2 text-xs">{failure.executedSql}</pre>
    </details>}
    <details>
      <summary className="cursor-pointer text-xs">Full error details</summary>
      <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words p-2 text-xs">{failure.message}</pre>
    </details>
  </section>;
}
