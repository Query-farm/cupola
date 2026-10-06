import { useEffect, useState } from 'react';
import { Button } from '../ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '../ui/dialog';
import { PHASE_LABELS, type RunRecord, type CellResult } from '../../lib/notebooks/execution';
import { triggerDownload } from '../../lib/editor/result-export';

export function RunningStatus({ record }: { record?: RunRecord }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(timer);
  }, [record?.number]);
  const label =
    record?.mode === 'explain' && record.phase === 'executing'
      ? 'Planning query'
      : record
        ? PHASE_LABELS[record.phase]
        : 'Running';
  return (
    <>{record ? `${label} · ${Math.max(0, (now - record.startedAt) / 1000).toFixed(1)} s` : 'Running…'}</>
  );
}
export function RunRecordView({ record }: { record: RunRecord }) {
  return (
    <div className="space-y-3 text-sm">
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 break-all">
        <dt>Execution</dt>
        <dd>
          #{record.number} · {record.mode === 'explain' ? 'Explain' : 'Query'} · {PHASE_LABELS[record.phase]}
        </dd>
        <dt>Connection</dt>
        <dd>{record.serviceUrl || 'Not recorded'}</dd>
        <dt>Started</dt>
        <dd>{new Date(record.startedAt).toLocaleString()}</dd>
        {record.completedAt && (
          <>
            <dt>Finished</dt>
            <dd>{new Date(record.completedAt).toLocaleString()}</dd>
          </>
        )}
        {record.elapsedMs !== undefined && (
          <>
            <dt>Total duration</dt>
            <dd>{record.elapsedMs} ms (including waiting and validation)</dd>
          </>
        )}
        {record.rows !== undefined && (
          <>
            <dt>Returned rows</dt>
            <dd>{record.rows.toLocaleString()}</dd>
          </>
        )}
        <dt>Notebook session</dt>
        <dd>{record.sessionId || 'Not recorded'}</dd>
        {record.engineVersion && (
          <>
            <dt>Engine version</dt>
            <dd>{record.engineVersion}</dd>
          </>
        )}
      </dl>
      {record.error && <p className="whitespace-pre-wrap text-destructive">{record.error}</p>}
      <div>
        <p className="font-medium">SQL at run time</p>
        <pre className="mt-1 overflow-auto rounded bg-muted p-2 text-xs whitespace-pre-wrap">
          {record.source}
        </pre>
      </div>
      <div>
        <p className="font-medium">Parameter values at run time</p>
        <pre className="mt-1 overflow-auto rounded bg-muted p-2 text-xs">
          {JSON.stringify(record.values, null, 2)}
        </pre>
      </div>
      <details>
        <summary className="cursor-pointer text-xs">Prepared SQL and bound values</summary>
        <pre className="mt-1 overflow-auto rounded bg-muted p-2 text-xs whitespace-pre-wrap">
          {record.sql}
          {'\n\n'}
          {JSON.stringify(record.params, null, 2)}
        </pre>
      </details>
      <Button
        size="sm"
        variant="outline"
        onClick={() =>
          triggerDownload(
            new Blob([JSON.stringify(record, null, 2)], { type: 'application/json' }),
            `notebook-run-${record.number}.json`,
          )
        }
      >
        Export run details
      </Button>
    </div>
  );
}
export function NotebookRunDetails({
  result,
  open,
  onOpenChange,
}: {
  result?: CellResult;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-3xl max-h-[90dvh] flex flex-col overflow-hidden">
        <DialogHeader>
          <DialogTitle>Cell run details</DialogTitle>
          <DialogDescription>
            Run metadata and pinned results are kept for this notebook session. Export run details to retain
            them. Data may have changed since a result was produced.
          </DialogDescription>
        </DialogHeader>
        <div className="min-h-0 overflow-y-auto space-y-4">
          {result?.provenance && (
            <section aria-label="Displayed result provenance" className="space-y-2">
              <h3 className="font-semibold">Current result · run #{result.provenance.number}</h3>
              <RunRecordView record={result.provenance} />
            </section>
          )}
          {result?.attempt && result.attempt.number !== result.provenance?.number && (
            <section aria-label="Latest attempt" className="border-t pt-3 space-y-2">
              <h3 className="font-semibold">Latest attempt</h3>
              {result.running && (
                <p role="status">
                  <RunningStatus record={result.attempt} />
                </p>
              )}
              <RunRecordView record={result.attempt} />
            </section>
          )}
          {result?.pinned && (
            <details className="border-t pt-3">
              <summary className="cursor-pointer font-medium">
                Pinned result · run #{result.pinned.provenance.number}
              </summary>
              <RunRecordView record={result.pinned.provenance} />
            </details>
          )}
          {(result?.history ?? [])
            .filter(
              (run) => run.number !== result?.attempt?.number && run.number !== result?.provenance?.number,
            )
            .map((run) => (
              <details key={run.number} className="border-t pt-3">
                <summary className="cursor-pointer">
                  Run #{run.number} · {PHASE_LABELS[run.phase]} ·{' '}
                  {new Date(run.startedAt).toLocaleTimeString()}
                </summary>
                <RunRecordView record={run} />
              </details>
            ))}
          <p className="text-xs text-muted-foreground">
            The last 10 attempts retain metadata. Pin a result before rerunning to retain its rows for
            comparison.
          </p>
        </div>
      </DialogContent>
    </Dialog>
  );
}
