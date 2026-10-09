import { useMemo } from 'react';
import { diffWithContext, lineDiff } from '../../lib/line-diff';
import { fingerprint, type Notebook, type NotebookCell, type NotebookChart } from '../../lib/notebooks/model';

function SourceDiff({ before, after }: { before: string; after: string }) {
  const diff = useMemo(() => lineDiff(before, after), [before, after]);
  return (
    <div className="min-w-0 rounded border bg-muted/20 text-[13px]">
      {diff ? (
        <pre className="whitespace-pre-wrap break-words p-2" aria-label="Source changes">
          {diffWithContext(diff).map((line, i) => (
            <span
              key={i}
              className={`block ${line?.kind === 'added' ? 'bg-emerald-500/10 text-emerald-800 dark:text-emerald-300' : line?.kind === 'removed' ? 'bg-red-500/10 text-red-800 dark:text-red-300' : 'text-muted-foreground'}`}
            >
              {line === null
                ? '…'
                : `${line.kind === 'added' ? '+' : line.kind === 'removed' ? '−' : ' '} ${line.text}`}
            </span>
          ))}
        </pre>
      ) : (
        <>
          <p className="p-2 font-medium">Before</p>
          <pre className="whitespace-pre-wrap break-words p-2">{before}</pre>
          <p className="p-2 font-medium">After</p>
          <pre className="whitespace-pre-wrap break-words p-2">{after}</pre>
        </>
      )}
    </div>
  );
}
const chartLabels: Record<keyof NotebookChart, string> = {
  id: 'ID',
  title: 'Name',
  type: 'Chart type',
  x: 'X column',
  y: 'Y column',
  color: 'Color column',
  xType: 'X axis type',
  sort: 'Sort',
  xTitle: 'X axis label',
  yTitle: 'Y axis label',
  yFormat: 'Number format',
};
function ChartChanges({ before, after }: { before?: NotebookCell; after?: NotebookCell }) {
  const old = before?.type === 'sql' ? before.charts : [];
  const next = after?.type === 'sql' ? after.charts : [];
  return (
    <>
      {old
        .filter((chart) => !next.some((item) => item.id === chart.id))
        .map((chart) => (
          <p key={chart.id}>Removed chart: {chart.title || 'Untitled chart'}</p>
        ))}
      {next.map((chart) => {
        const previous = old.find((item) => item.id === chart.id);
        const fields = (Object.keys(chartLabels) as (keyof NotebookChart)[]).filter(
          (key) => key !== 'id' && chart[key] !== previous?.[key],
        );
        if (!fields.length) return null;
        return (
          <div key={chart.id} className="space-y-1">
            <p className="font-medium">
              {previous ? 'Changed' : 'Added'} chart: {chart.title || 'Untitled chart'}
            </p>
            <ul className="list-disc pl-4 text-muted-foreground">
              {fields
                .filter((key) => previous || chart[key] !== '')
                .map((key) => (
                  <li key={key}>
                    {chartLabels[key]}: {previous ? `${previous[key] || 'None'} → ` : ''}
                    {chart[key] || 'None'}
                  </li>
                ))}
            </ul>
          </div>
        );
      })}
    </>
  );
}
export function NotebookProposalReview({ before, after }: { before: Notebook; after: Notebook }) {
  const oldOrder = before.cells
    .filter((cell) => after.cells.some((next) => next.id === cell.id))
    .map((cell) => cell.id);
  const newOrder = after.cells
    .filter((cell) => before.cells.some((old) => old.id === cell.id))
    .map((cell) => cell.id);
  const ordered = [
    ...after.cells,
    ...before.cells.filter((cell) => !after.cells.some((next) => next.id === cell.id)),
  ];
  const changes = ordered.flatMap((cell) => {
    const old = before.cells.find((item) => item.id === cell.id);
    const next = after.cells.find((item) => item.id === cell.id);
    const moved = !!old && !!next && oldOrder.indexOf(cell.id) !== newOrder.indexOf(cell.id);
    const same =
      old && next && fingerprint({ ...before, cells: [old] }) === fingerprint({ ...before, cells: [next] });
    return same && !moved ? [] : [{ cell, old, next, moved }];
  });
  return (
    <div className="space-y-3 text-sm" data-testid="notebook-proposal-review">
      {before.title !== after.title && (
        <p>
          Notebook title: <span className="text-muted-foreground">{before.title}</span> →{' '}
          <strong>{after.title}</strong>
        </p>
      )}
      <p className="text-muted-foreground">
        {changes.length} changed {changes.length === 1 ? 'cell' : 'cells'}. Unchanged cells are omitted.
      </p>
      {JSON.stringify([before.parameters ?? [], before.values ?? {}]) !==
        JSON.stringify([after.parameters ?? [], after.values ?? {}]) && (
        <details className="rounded-md border p-2">
          <summary className="cursor-pointer font-medium">Parameter changes</summary>
          <div className="grid gap-2 sm:grid-cols-2 mt-2">
            {[
              ['Before', before],
              ['After', after],
            ].map(([label, value]) => {
              const doc = value as Notebook;
              return (
                <div key={String(label)}>
                  <p className="font-medium">{String(label)}</p>
                  <pre className="whitespace-pre-wrap break-words bg-muted/20 p-2 text-xs">
                    {JSON.stringify({ parameters: doc.parameters ?? [], values: doc.values ?? {} }, null, 2)}
                  </pre>
                </div>
              );
            })}
          </div>
        </details>
      )}
      <div className="space-y-2">
        {changes.map(({ cell, old, next, moved }) => (
          <details key={cell.id} className="rounded-md border p-2">
            <summary className="cursor-pointer font-medium">
              {!old ? 'Added' : !next ? 'Removed' : 'Updated'} {cell.type === 'sql' ? 'SQL' : 'Markdown'} ·{' '}
              {cell.title || 'Untitled cell'}
            </summary>
            <div className="mt-2 space-y-2">
              {moved && (
                <p>
                  Moved from cell {before.cells.indexOf(old!) + 1} to cell {after.cells.indexOf(next!) + 1}.
                </p>
              )}
              {old && next && old.title !== next.title && (
                <p>
                  Name: {old.title || 'Untitled'} → {next.title || 'Untitled'}
                </p>
              )}
              {old && next && old.type !== next.type && (
                <p>
                  Cell type: {old.type} → {next.type}
                </p>
              )}
              {(old?.source ?? '') !== (next?.source ?? '') && (
                <SourceDiff before={old?.source ?? ''} after={next?.source ?? ''} />
              )}
              <ChartChanges before={old} after={next} />
              {old &&
                next &&
                (['collapsed', 'codeHidden', 'outputHidden'] as const).map(
                  (key) =>
                    !!old[key] !== !!next[key] && (
                      <p key={key}>
                        {
                          {
                            collapsed: 'Cell collapsed',
                            codeHidden: 'Code hidden',
                            outputHidden: 'Output hidden',
                          }[key]
                        }
                        : {next[key] ? 'Yes' : 'No'}
                      </p>
                    ),
                )}
              {old?.type === 'sql' && next?.type === 'sql' && old.outputHeight !== next.outputHeight && (
                <p>
                  Output height: {old.outputHeight ?? 'Default'} → {next.outputHeight ?? 'Default'}
                </p>
              )}
            </div>
          </details>
        ))}
      </div>
    </div>
  );
}
