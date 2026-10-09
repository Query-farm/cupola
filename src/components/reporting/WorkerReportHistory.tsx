import { useMemo, useState } from 'react';
import { Eye, GitCompare, User } from 'lucide-react';
import { Button } from '../ui/button';
import { ReportNotice } from './ReportNotice';
import { RevisionComparison } from './RevisionComparison';
import type { ReportClient } from '../../lib/reporting/client';
import type { RevisionRow } from '../../lib/reporting/contracts.generated';

export function WorkerReportHistory({ client, reportId, revisions, headId, publishedId, pinnedId, blocked, loading, error, onRetry, onView, onCopyLink, onRestore, onRedact }: {
  client: ReportClient; reportId: string; revisions: RevisionRow[]; headId?: string; publishedId?: string | null; pinnedId: string | null;
  blocked: boolean; loading: boolean; error: string; onRetry: () => void; onView: (id: string) => void;
  onCopyLink: (revision: RevisionRow) => void; onRestore?: (revision: RevisionRow) => void; onRedact?: (revision: RevisionRow) => void;
}) {
  const [comparison, setComparison] = useState<{ from: string; to: string } | null>(null);
  const sorted = useMemo(() => [...revisions].sort((a, b) => a.revision_number < b.revision_number ? 1 : a.revision_number > b.revision_number ? -1 : 0), [revisions]);
  const readable = sorted.filter(r => r.redacted_at === null);
  if (loading) return <p role="status" className="py-3 text-sm">Loading report history…</p>;
  if (error) return <ReportNotice kind="error" title="Could not load report history" action={<Button variant="outline" size="sm" onClick={onRetry}>Retry history</Button>}>{error}</ReportNotice>;
  if (comparison) return <RevisionComparison client={client} reportId={reportId} revisions={sorted} initialFrom={comparison.from} initialTo={comparison.to} blocked={blocked} onBack={() => { setComparison(null); onRetry(); }} onView={onView} />;
  return <div className="space-y-3 py-3 text-sm">
    <p className="text-muted-foreground">View a saved revision or compare its changes. Restoring creates a new revision; redaction leaves an audit entry.</p>
    {blocked && <ReportNotice title="Changes are pending">Finish saving or resolve pending changes before opening or restoring another revision. Comparisons show saved definitions.</ReportNotice>}
    {!sorted.length && <p>No revisions are visible to your account.</p>}
    {sorted.map(revision => <article key={revision.revision_id} aria-label={`Revision ${revision.revision_number}`} className="space-y-2 rounded border p-3">
      <div className="flex flex-wrap items-center gap-2"><strong>Revision {String(revision.revision_number)}</strong><span>{revision.kind}</span>{headId === revision.revision_id && <span>· current head</span>}{publishedId === revision.revision_id && <span>· published</span>}{pinnedId === revision.revision_id && <span>· viewing</span>}</div>
      <p className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground"><User aria-hidden className="size-3" /><span>{revision.author.display_name || revision.author.id}</span><span>·</span><time dateTime={new Date(revision.created_at).toISOString()}>{new Date(revision.created_at).toLocaleString()}</time></p>
      {revision.message && <p>{revision.message}</p>}
      {revision.redacted_at !== null ? <p>Redacted: {revision.redaction_reason}</p> : <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="outline" disabled={blocked || pinnedId === revision.revision_id} aria-label={`View revision ${revision.revision_number}`} onClick={() => onView(revision.revision_id)}><Eye />View revision</Button>
        {readable.length > 1 && <Button size="sm" variant="outline" aria-label={`Compare revision ${revision.revision_number}`} onClick={() => {
          const index = readable.findIndex(r => r.revision_id === revision.revision_id), older = readable[index + 1], newer = readable[index - 1];
          setComparison(older ? { from: older.revision_id, to: revision.revision_id } : { from: revision.revision_id, to: newer.revision_id });
        }}><GitCompare />Compare changes</Button>}
        {onRestore && <Button size="sm" variant="outline" disabled={blocked || revision.revision_id === headId} onClick={() => onRestore(revision)}>Restore revision {String(revision.revision_number)}</Button>}
        <Button size="sm" variant="ghost" onClick={() => onCopyLink(revision)}>Copy revision link</Button>
        {onRedact && <Button size="sm" variant="ghost" disabled={blocked || revision.revision_id === headId || revision.revision_id === publishedId} onClick={() => onRedact(revision)}>Redact revision {String(revision.revision_number)}…</Button>}
      </div>}
    </article>)}
  </div>;
}
