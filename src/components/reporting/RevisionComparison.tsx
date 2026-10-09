import { useEffect, useMemo, useState } from 'react';
import { ArrowLeft, Download, Eye } from 'lucide-react';
import { Button } from '../ui/button';
import { ReportNotice } from './ReportNotice';
import { ReportClient, reportError } from '../../lib/reporting/client';
import type { ReportResult, RevisionRow } from '../../lib/reporting/contracts.generated';
import { reportRevisionChanges, type RevisionFieldChange, type RevisionChanges } from '../../lib/reporting/revision-changes';
import { diffWithContext, lineDiff } from '../../lib/line-diff';

function downloadFile(body: Blob, filename: string) {
  const url = URL.createObjectURL(body);
  const link = document.createElement('a'); link.href = url; link.download = filename; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function RevisionComparison({ client, reportId, revisions, initialFrom, initialTo, blocked, onBack, onView }: {
  client: ReportClient; reportId: string; revisions: RevisionRow[]; initialFrom: string; initialTo: string;
  blocked: boolean; onBack: () => void; onView: (revisionId: string) => void;
}) {
  const [from, setFrom] = useState(initialFrom), [to, setTo] = useState(initialTo), [retry, setRetry] = useState(0);
  const [loaded, setLoaded] = useState<{ key: string; before?: ReportResult; after?: ReportResult; changes?: RevisionChanges; error?: string } | null>(null);
  const readable = revisions.filter(r => r.redacted_at === null);
  const validSelection = readable.some(r => r.revision_id === from) && readable.some(r => r.revision_id === to);
  const key = JSON.stringify([reportId, from, to, retry, validSelection]);
  useEffect(() => {
    const abort = new AbortController();
    setLoaded(null);
    if (!validSelection) { setLoaded({ key, error: 'A selected revision is no longer available. Choose another revision.' }); return; }
    void Promise.all([client.call('get_report', { report_id: reportId, revision_id: from }, abort.signal), client.call('get_report', { report_id: reportId, revision_id: to }, abort.signal)])
      .then(([before, after]) => {
        if (before.revision_served !== from || after.revision_served !== to) throw new Error('The worker did not return the requested revisions.');
        const changes = reportRevisionChanges(before, after);
        if (!abort.signal.aborted) setLoaded({ key, before, after, changes });
      }).catch(e => { if (!abort.signal.aborted) setLoaded({ key, error: reportError(e) }); });
    return () => abort.abort();
  }, [client, key]);
  const result = loaded?.key === key ? loaded : null;
  function download(record: ReportResult) {
    if (record.body === null) return;
    downloadFile(new Blob([record.body.slice().buffer], { type: 'application/octet-stream' }), `${reportId}-revision-${record.revision_number}.bin`);
  }
  const selector = (label: string, value: string, onChange: (value: string) => void) => <label className="min-w-0 flex-1 space-y-1"><span className="font-medium">{label}</span><select aria-label={label} className="w-full min-w-0 rounded border border-input bg-background p-2 text-sm [appearance:auto]" value={value} onChange={e => onChange(e.target.value)}>
    {readable.map(r => <option key={r.revision_id} value={r.revision_id}>Revision {String(r.revision_number)} · {r.author.display_name || r.author.id} · {new Date(r.created_at).toLocaleString()}</option>)}
  </select></label>;
  return <section aria-label="Revision comparison" className="space-y-4 py-3 text-sm">
    <Button size="sm" variant="ghost" onClick={onBack}><ArrowLeft />Back to history</Button>
    <p className="text-muted-foreground">Compare saved report definitions. Queries are not run. Removed lines use −; added lines use +.</p>
    <div className="flex flex-col gap-3 sm:flex-row">{selector('From revision', from, setFrom)}{selector('To revision', to, setTo)}</div>
    {!result && <p role="status">Loading revision comparison…</p>}
    {result?.error && <ReportNotice kind="error" title="Could not compare revisions" action={<Button variant="outline" size="sm" onClick={() => setRetry(n => n + 1)}>Retry comparison</Button>}>{result.error}</ReportNotice>}
    {result?.changes && <>
      <div className="flex flex-wrap gap-2"><Button size="sm" variant="outline" disabled={blocked} onClick={() => onView(to)}><Eye />View selected revision</Button><Button size="sm" variant="ghost" onClick={() => download(result.before!)}><Download />Download before body</Button><Button size="sm" variant="ghost" onClick={() => download(result.after!)}><Download />Download after body</Button></div>
      {result.changes.fields.length ? <p>{result.changes.fields.length} changed {result.changes.fields.length === 1 ? 'field' : 'fields'}: {result.changes.fields.map(f => f.label).join(', ')}.</p> : <p>No definition changes between these revisions.</p>}
      {result.changes.encodingChanged && <ReportNotice title="Body encoding changed">The report body values match; their JSON formatting or property order differs.</ReportNotice>}
      {result.changes.fields.map(field => <FieldChanges key={field.key} field={field} />)}
    </>}
  </section>;
}

const EXCERPT = 20_000;
function FieldChanges({ field }: { field: RevisionFieldChange }) {
  const lines = useMemo(() => field.binary || field.before.length + field.after.length > 200_000 || field.before.split('\n').length + field.after.split('\n').length > 4000
    ? null : lineDiff(field.before, field.after), [field]);
  return <section aria-label={`${field.label} changes`} className="space-y-2">
    <h3 className="font-semibold">{field.label}</h3>
    {lines ? <pre className="max-h-80 overflow-auto rounded border bg-muted/30 p-2 text-xs leading-relaxed">{diffWithContext(lines, 3).map((line, i) => line === null ? <div key={i} className="text-muted-foreground">⋯</div>
      : <div key={i} className={line.kind === 'added' ? 'bg-emerald-500/15 text-emerald-800 dark:text-emerald-300' : line.kind === 'removed' ? 'bg-red-500/15 text-red-800 dark:text-red-300' : ''}><span className="select-none">{line.kind === 'added' ? '+ ' : line.kind === 'removed' ? '− ' : '  '}</span>{line.text || ' '}</div>)}</pre>
      : <><p className="text-muted-foreground">{field.binary ? 'Binary content changed. Download the revisions to inspect the full bodies.' : 'This field is too large for a line comparison. Before and after are shown below.'}</p><div className="grid gap-2 sm:grid-cols-2">{(['before', 'after'] as const).map(side => <div key={side} className="min-w-0"><h4 className="font-medium">{side === 'before' ? 'Before' : 'After'}</h4><pre className="max-h-72 overflow-auto rounded border bg-muted/30 p-2 text-xs">{field[side].slice(0, EXCERPT)}{field[side].length > EXCERPT && '\n… (excerpt truncated)'}</pre>{field[side].length > EXCERPT && <Button size="sm" variant="ghost" onClick={() => downloadFile(new Blob([field[side]], { type: 'text/plain' }), `revision-field-${side}.txt`)}><Download />Download complete {side} field</Button>}</div>)}</div></>}
  </section>;
}
