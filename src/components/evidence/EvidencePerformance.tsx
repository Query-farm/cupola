import { useEffect, useMemo, useState } from 'react';
import { Copy, SquareTerminal } from 'lucide-react';
import { Button } from '../ui/button';
import { ui } from '../../lib/shell-bridge';
import { formatMs, nameRenderQueries, PHASE_LABELS, summarizeProfile, type ProfiledQuery, type RefreshPhase, type RefreshProfile } from '../../lib/evidence/refresh-profile';

/** Phase colors: one hue each, readable in both themes. */
const PHASE_COLOR: Record<RefreshPhase | 'other', string> = {
  engine: 'bg-stone-400 dark:bg-stone-500', choices: 'bg-amber-500', setup: 'bg-sky-500', semantic: 'bg-violet-500', render: 'bg-primary', other: 'bg-muted-foreground/30',
};
const firstLine = (sql: string) => sql.replace(/\s+/g, ' ').trim().slice(0, 160);
const PHASE_TAGS: Record<RefreshPhase, string> = { engine: 'Engine', choices: 'Choices', setup: 'Setup', semantic: 'Semantic', render: 'Render' };

/** Where the last refresh spent its time: a phase breakdown and a waterfall of every query. */
/** `runnable` fills a query's `$parameters` in with the refresh's values, for copying and the Query Editor. */
export function EvidencePerformance({ profile, namedQueries, runnable = sql => sql }: { profile: RefreshProfile | null; namedQueries: { name: string; sql: string }[]; runnable?: (sql: string) => string }) {
  const [order, setOrder] = useState<'time' | 'slowest'>('time');
  const [open, setOpen] = useState<number | null>(null);
  const [, tick] = useState(0);
  // While a refresh runs, keep its elapsed time moving.
  useEffect(() => {
    if (!profile || profile.finishedAt !== undefined) return;
    const timer = setInterval(() => tick(n => n + 1), 250);
    return () => clearInterval(timer);
  }, [profile]);
  const queries = useMemo(() => profile ? nameRenderQueries(profile.queries, namedQueries) : [], [profile, namedQueries]);
  if (!profile) return <p className="text-xs text-muted-foreground">Refresh the report to see where its time goes: each phase, and every query it runs.</p>;
  const summary = summarizeProfile(profile);
  const running = profile.finishedAt === undefined;
  const t0 = profile.startedAt;
  const span = Math.max(1, ...queries.map(query => query.startedAt + query.durationMs - t0), (profile.finishedAt ?? performance.now()) - t0);
  const phased = summary.byPhase.reduce((sum, item) => sum + item.ms, 0);
  const segments = [...summary.byPhase.map(item => ({ key: item.phase as RefreshPhase | 'other', label: PHASE_LABELS[item.phase], ms: item.ms })),
    ...(summary.totalMs - phased > 1 ? [{ key: 'other' as const, label: 'Other (drawing, waiting)', ms: summary.totalMs - phased }] : [])];
  const sorted = order === 'slowest' ? [...queries].sort((a, b) => b.durationMs - a.durationMs) : queries;
  const outcome = running ? `Refreshing… ${formatMs(summary.totalMs)} so far` : profile.outcome === 'done' ? `Refreshed in ${formatMs(summary.totalMs)}` : profile.outcome === 'failed' ? `Refresh failed after ${formatMs(summary.totalMs)}` : `Refresh stopped after ${formatMs(summary.totalMs)}`;

  return <section className="space-y-4 text-xs" aria-label="Refresh performance">
    <div className="space-y-1">
      <p role="status" aria-label="Refresh timing" className="text-sm font-medium">{outcome}</p>
      <p className="text-muted-foreground">
        {summary.queryCount} {summary.queryCount === 1 ? 'query' : 'queries'}, {formatMs(summary.queryMs)} of query time{summary.queryMs > summary.totalMs ? ' (they overlap)' : ''}
        {summary.failed > 0 && <span className="text-destructive"> · {summary.failed} failed</span>}
        {queries.some(query => query.cached) && <> · {queries.filter(query => query.cached).length} repeats served from cache</>}
      </p>
    </div>

    <div className="space-y-2">
      <div className="flex h-3 w-full overflow-hidden rounded-full bg-muted" aria-hidden>
        {segments.map(segment => <div key={segment.key} className={PHASE_COLOR[segment.key]} style={{ width: `${Math.max(0.5, segment.ms / Math.max(1, summary.totalMs) * 100)}%` }} />)}
      </div>
      <ul className="grid grid-cols-[auto_1fr_auto] items-center gap-x-2 gap-y-1" aria-label="Time by phase">
        {segments.map(segment => <li key={segment.key} className="contents">
          <span className={`size-2.5 rounded-sm ${PHASE_COLOR[segment.key]}`} aria-hidden />
          <span>{segment.label}</span>
          <span className="text-right tabular-nums text-muted-foreground">{formatMs(segment.ms)}</span>
        </li>)}
      </ul>
    </div>

    {summary.slowest.length > 0 && <div className="space-y-1">
      <h4 className="font-semibold">Slowest</h4>
      <ol className="space-y-1">{summary.slowest.map(query => {
        const named = queries.find(item => item.id === query.id)!;
        return <li key={query.id}><button type="button" className="text-left text-primary underline-offset-2 hover:underline" onClick={() => { setOrder('time'); setOpen(query.id); }}>
          <span className="tabular-nums">{formatMs(query.durationMs)}</span> · {named.name ?? firstLine(query.sql)}
        </button></li>;
      })}</ol>
    </div>}

    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <h4 className="font-semibold">Queries</h4>
        <div className="flex gap-1" role="radiogroup" aria-label="Order queries">
          {(['time', 'slowest'] as const).map(value => <button key={value} type="button" role="radio" aria-checked={order === value}
            className={`rounded px-2 py-0.5 ${order === value ? 'bg-muted font-medium' : 'text-muted-foreground'}`} onClick={() => setOrder(value)}>{value === 'time' ? 'As run' : 'Slowest first'}</button>)}
        </div>
      </div>
      {!queries.length && <p className="text-muted-foreground">{running ? 'No queries yet.' : 'This refresh ran no queries.'}</p>}
      <ul className="divide-y rounded-md border" aria-label="Queries run by the last refresh">
        {sorted.map(query => <QueryRow key={query.id} query={query} runnable={runnable} t0={t0} span={span} finishedAt={profile.finishedAt}
          open={open === query.id} onToggle={() => setOpen(open === query.id ? null : query.id)} />)}
      </ul>
      {profile.queries.length >= 1_000 && <p className="text-muted-foreground">Only the first 1,000 queries are shown.</p>}
    </div>
  </section>;
}

function QueryRow({ query, runnable, t0, span, finishedAt, open, onToggle }: { query: ProfiledQuery; runnable: (sql: string) => string; t0: number; span: number; finishedAt?: number; open: boolean; onToggle: () => void }) {
  const late = finishedAt !== undefined && query.startedAt > finishedAt;
  // A semantic compile is timed work, not a query.
  const isSql = !(query.phase === 'semantic' && !query.sql.startsWith('CREATE'));
  const sql = open && isSql ? runnable(query.sql) : query.sql;
  const label = query.name ?? firstLine(query.sql);
  return <li className={query.error ? 'bg-destructive/5' : ''}>
    <button type="button" aria-expanded={open} onClick={onToggle} className="grid w-full grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-1 px-2 py-1.5 text-left hover:bg-muted/50"
      aria-label={`${label}: ${formatMs(query.durationMs)}${query.cached ? ', from cache' : ''}${query.error ? ', failed' : ''}`}>
      <span className="min-w-0 truncate">
        <span className="mr-1.5 text-muted-foreground">{PHASE_TAGS[query.phase]}</span>
        <span className={query.error ? 'text-destructive' : ''}>{label}</span>
        {query.cached && <span className="ml-1.5 text-muted-foreground">(cache)</span>}
        {late && <span className="ml-1.5 text-muted-foreground">(after the refresh, e.g. scrolled into view)</span>}
      </span>
      <span className="whitespace-nowrap text-right tabular-nums text-muted-foreground">{query.rows !== undefined && `${query.rows.toLocaleString()} rows · `}{formatMs(query.durationMs)}</span>
      <span className="relative col-span-2 h-1.5 rounded-full bg-muted/60" aria-hidden>
        <span className={`absolute top-0 h-1.5 rounded-full ${query.error ? 'bg-destructive' : PHASE_COLOR[query.phase]} ${query.cached ? 'opacity-40' : ''}`}
          style={{ left: `${Math.min(100, (query.startedAt - t0) / span * 100)}%`, width: `max(3px, ${query.durationMs / span * 100}%)` }} />
      </span>
    </button>
    {open && <div className="space-y-2 px-2 pb-2">
      <p className="text-muted-foreground">Started {formatMs(query.startedAt - t0)} into the refresh{query.error ? '' : `, took ${formatMs(query.durationMs)}`}.</p>
      {query.error && <p className="text-destructive">{query.error}</p>}
      <pre aria-label="Query SQL" className="max-h-64 overflow-auto whitespace-pre-wrap rounded bg-muted p-2 font-mono text-[11px]">{sql}</pre>
      {sql !== query.sql && <p className="text-muted-foreground">Parameter values are filled in, so it runs as is.</p>}
      {isSql && <div className="flex gap-2">
        <Button variant="outline" size="sm" onClick={() => { void navigator.clipboard?.writeText(sql).catch(() => {}); }}><Copy />Copy SQL</Button>
        <Button variant="outline" size="sm" disabled={!ui.openInEditor} onClick={() => ui.openInEditor?.(sql)}><SquareTerminal />Open in Query Editor</Button>
      </div>}
    </div>}
  </li>;
}
