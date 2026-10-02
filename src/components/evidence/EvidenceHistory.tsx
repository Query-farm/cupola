import { useMemo, useState } from 'react';
import { Bot, FileDown, History, RotateCcw, Trash2, User } from 'lucide-react';
import { Button } from '../ui/button';
import { fieldText, lineDiff, REVISION_FIELD_LABELS, revisionSpec, type DiffLine, type ReportHistory, type Revision, type RevisionField, type RevisionKind } from '../../lib/evidence/revisions';

const KIND_LABELS: Record<RevisionKind, string> = { edit: 'You', agent: 'Report agent', restore: 'Restored', import: 'Imported', baseline: 'Earlier version' };
const KIND_ICONS: Record<RevisionKind, typeof User> = { edit: User, agent: Bot, restore: RotateCcw, import: FileDown, baseline: History };
/** Unchanged lines kept around each change. */
const CONTEXT = 3;

/** Every saved version of the report, newest first: who changed what, and a line diff of each
 *  changed field against the version before it. Any version can be restored into the draft, and
 *  any but the latest (the saved report itself) removed. */
export function EvidenceHistory({ history, dirty, onRestore, onDelete }: { history: ReportHistory; dirty: boolean; onRestore: (revision: Revision) => void; onDelete: (revision: Revision) => void }) {
  const [open, setOpen] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const newestFirst = useMemo(() => [...history.revisions].reverse(), [history]);
  if (!history.revisions.length) return <p className="text-xs text-muted-foreground">No revisions yet. Each time you save the report, the saved version is kept here with what changed and who changed it: you, or the report agent’s applied proposals.</p>;
  const format = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  return <section className="space-y-3 text-xs" aria-label="Report history">
    <p className="text-muted-foreground">{history.revisions.length} saved {history.revisions.length === 1 ? 'version' : 'versions'}.{dirty ? ' Saving your latest changes…' : ''} Changes save automatically: edits made close together form one revision, and each applied agent proposal, undo and restore is its own. Report files include the history.</p>
    <ol className="divide-y rounded-md border" aria-label="Revisions, newest first">
      {newestFirst.map((revision, index) => {
        const previous = newestFirst[index + 1];
        const Icon = KIND_ICONS[revision.kind];
        const expanded = open === revision.id;
        const latest = index === 0;
        return <li key={revision.id} aria-label={`${revision.label}, ${format.format(revision.savedAt)}`}>
          <button type="button" aria-expanded={expanded} className="w-full space-y-1 px-3 py-2 text-left hover:bg-muted/50" onClick={() => setOpen(expanded ? null : revision.id)}>
            <span className="block font-medium">{revision.label}{latest && <span className="ml-2 rounded bg-muted px-1.5 py-0.5 text-[10px] font-normal text-muted-foreground">Latest</span>}</span>
            <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-muted-foreground">
              <span className="inline-flex items-center gap-1"><Icon className="size-3" aria-hidden />{KIND_LABELS[revision.kind]}{revision.alsoEdited ? ' and you' : ''}</span>
              <span aria-hidden>·</span><time dateTime={new Date(revision.savedAt).toISOString()}>{format.format(revision.savedAt)}</time>
              {revision.changed.length > 0 && <><span aria-hidden>·</span><span>{revision.changed.map(field => REVISION_FIELD_LABELS[field]).join(', ')}</span></>}
            </span>
          </button>
          {expanded && <div className="space-y-3 px-3 pb-3">
            {revision.agentSummaries && revision.agentSummaries.length > 1 && <div>
              <h4 className="font-semibold">Agent proposals applied</h4>
              <ul className="ml-4 list-disc">{revision.agentSummaries.map((summary, i) => <li key={i}>{summary}</li>)}</ul>
            </div>}
            {revision.changed.map(field => <FieldDiff key={field} field={field} before={previous ? revisionSpec(history, previous)[field] : undefined} after={revisionSpec(history, revision)[field]} />)}
            {!revision.changed.length && <p className="text-muted-foreground">{previous ? 'Nothing changed from the version before.' : 'The first version in this history.'}</p>}
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="outline" size="sm" onClick={() => onRestore(revision)} title="Replace the draft with this version; save to keep it"><RotateCcw />Restore this version</Button>
              {!latest && (confirming === revision.id
                ? <span role="group" aria-label="Confirm removing this version" className="inline-flex items-center gap-2">
                    <span className="text-muted-foreground">Remove this version from the history?</span>
                    <Button variant="destructive" size="sm" onClick={() => { setConfirming(null); setOpen(null); onDelete(revision); }}>Remove</Button>
                    <Button variant="ghost" size="sm" onClick={() => setConfirming(null)}>Cancel</Button>
                  </span>
                : <Button variant="ghost" size="sm" onClick={() => setConfirming(revision.id)} title="Remove this version from the history; the report itself is unchanged"><Trash2 />Remove from history</Button>)}
            </div>
          </div>}
        </li>;
      })}
    </ol>
  </section>;
}

function FieldDiff({ field, before, after }: { field: RevisionField; before: unknown; after: unknown }) {
  const lines = useMemo(() => lineDiff(fieldText(before), fieldText(after)), [before, after]);
  return <div className="space-y-1">
    <h4 className="font-semibold">{REVISION_FIELD_LABELS[field]}</h4>
    {lines
      ? <pre aria-label={`${REVISION_FIELD_LABELS[field]} changes`} className="max-h-72 overflow-auto rounded bg-muted p-2 font-mono text-[11px] leading-snug">{withContext(lines).map((line, i) => line === null
          ? <div key={i} className="text-muted-foreground">⋯</div>
          : <div key={i} className={line.kind === 'added' ? 'bg-emerald-500/15 text-emerald-800 dark:text-emerald-300' : line.kind === 'removed' ? 'bg-red-500/15 text-red-800 dark:text-red-300' : ''}>
              <span aria-hidden className="select-none text-muted-foreground">{line.kind === 'added' ? '+ ' : line.kind === 'removed' ? '- ' : '  '}</span>{line.text || ' '}
            </div>)}</pre>
      : <p className="text-muted-foreground">Too large to compare line by line.</p>}
  </div>;
}

/** Changed lines with a few unchanged lines around them; `null` marks lines left out. */
function withContext(lines: DiffLine[]): (DiffLine | null)[] {
  const keep = lines.map(() => false);
  lines.forEach((line, i) => {
    if (line.kind === 'same') return;
    for (let j = Math.max(0, i - CONTEXT); j <= Math.min(lines.length - 1, i + CONTEXT); j++) keep[j] = true;
  });
  const out: (DiffLine | null)[] = [];
  lines.forEach((line, i) => {
    if (keep[i]) out.push(line);
    else if (out.at(-1) !== null) out.push(null);
  });
  return out;
}
