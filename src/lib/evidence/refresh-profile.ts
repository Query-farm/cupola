/** Where a report refresh spends its time: each phase, and every query it ran, on one clock
 *  (`performance.now()`), so the editor can draw a waterfall and name the slow parts. */

export type RefreshPhase = 'engine' | 'choices' | 'setup' | 'semantic' | 'render';
export const PHASE_LABELS: Record<RefreshPhase, string> = {
  engine: 'Waiting for the engine', choices: 'Parameter choices', setup: 'Setup SQL', semantic: 'Semantic datasets', render: 'Rendering the report',
};

export interface ProfiledQuery {
  id: number;
  phase: RefreshPhase;
  /** The SQL as sent, or a description for work that isn't one query (a semantic compile). */
  sql: string;
  /** The report query, parameter or dataset it belongs to, when that can be told. */
  name?: string;
  rows?: number;
  startedAt: number;
  durationMs: number;
  error: string | null;
  /** Served from a cache without running. */
  cached?: boolean;
}
export interface PhaseSpan { phase: RefreshPhase; start: number; end: number }
export interface RefreshProfile {
  startedAt: number;
  finishedAt?: number;
  outcome?: 'done' | 'failed' | 'stopped';
  phases: PhaseSpan[];
  queries: ProfiledQuery[];
}

/** Queries a profile keeps; a report with thousands of component queries keeps the first ones. */
export const MAX_PROFILED_QUERIES = 1_000;

/** Records one refresh. Mutations are batched into one `onChange` per animation frame, so a
 *  burst of component queries doesn't re-render the editor for each. */
export class RefreshProfiler {
  readonly profile: RefreshProfile;
  private next = 0;
  private frame = 0;
  private open = new Map<RefreshPhase, number>();
  constructor(private onChange: (profile: RefreshProfile) => void, now = performance.now()) {
    this.profile = { startedAt: now, phases: [], queries: [] };
    this.emit();
  }
  begin(phase: RefreshPhase, at = performance.now()) {
    this.open.set(phase, at);
  }
  end(phase: RefreshPhase, at = performance.now()) {
    const start = this.open.get(phase);
    if (start === undefined) return;
    this.open.delete(phase);
    this.profile.phases.push({ phase, start, end: at });
    this.emit();
  }
  query(entry: Omit<ProfiledQuery, 'id'>) {
    if (this.profile.queries.length >= MAX_PROFILED_QUERIES) return;
    this.profile.queries.push({ ...entry, id: ++this.next });
    this.emit();
  }
  /** Close any open phases and mark the refresh finished. */
  finish(outcome: NonNullable<RefreshProfile['outcome']>, at = performance.now()) {
    if (this.profile.finishedAt !== undefined) return;
    for (const phase of [...this.open.keys()]) this.end(phase, at);
    this.profile.finishedAt = at;
    this.profile.outcome = outcome;
    this.emit();
  }
  get finished() { return this.profile.finishedAt !== undefined; }
  private emit() {
    if (this.frame) return;
    const flush = () => { this.frame = 0; this.onChange({ ...this.profile, phases: [...this.profile.phases], queries: [...this.profile.queries] }); };
    if (typeof requestAnimationFrame === 'function') this.frame = requestAnimationFrame(flush);
    else flush();
  }
}

const normalize = (sql: string) => sql.replace(/\s+/g, ' ').trim().toLowerCase();

/** Name component queries after the report query they read. Evidence runs a named query's SQL
 *  as written, and wraps it (or selects from it) for each component that uses it; a query whose
 *  SQL contains a named query's SQL, or names it, belongs to it. */
export function nameRenderQueries(queries: ProfiledQuery[], named: { name: string; sql: string }[]): ProfiledQuery[] {
  const candidates = named.map(query => ({ name: query.name, sql: normalize(query.sql) })).filter(query => query.name && query.sql)
    // Longest first, so a query that contains a shorter one's SQL is named after itself.
    .sort((a, b) => b.sql.length - a.sql.length);
  return queries.map(query => {
    if (query.name || query.phase !== 'render') return query;
    const sql = normalize(query.sql);
    const exact = candidates.find(candidate => candidate.sql === sql);
    if (exact) return { ...query, name: exact.name };
    const inside = candidates.find(candidate => sql.includes(candidate.sql))
      ?? candidates.find(candidate => new RegExp(`\\b${candidate.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(query.sql));
    return inside ? { ...query, name: `${inside.name} · component` } : query;
  });
}

export interface ProfileSummary {
  totalMs: number;
  byPhase: { phase: RefreshPhase; ms: number }[];
  queryCount: number;
  /** Summed query time; more than the wall time when queries overlap. */
  queryMs: number;
  failed: number;
  slowest: ProfiledQuery[];
}
export function summarizeProfile(profile: RefreshProfile, now = performance.now()): ProfileSummary {
  const end = profile.finishedAt ?? now;
  const byPhase = new Map<RefreshPhase, number>();
  for (const span of profile.phases) byPhase.set(span.phase, (byPhase.get(span.phase) ?? 0) + (span.end - span.start));
  const ran = profile.queries.filter(query => !query.cached);
  return {
    totalMs: end - profile.startedAt,
    byPhase: (Object.keys(PHASE_LABELS) as RefreshPhase[]).filter(phase => byPhase.has(phase)).map(phase => ({ phase, ms: byPhase.get(phase)! })),
    queryCount: ran.length,
    queryMs: ran.reduce((sum, query) => sum + query.durationMs, 0),
    failed: profile.queries.filter(query => query.error).length,
    slowest: [...ran].sort((a, b) => b.durationMs - a.durationMs).slice(0, 3),
  };
}

export function formatMs(ms: number): string {
  if (ms < 1) return '<1 ms';
  if (ms < 1_000) return `${Math.round(ms)} ms`;
  return `${(ms / 1_000).toFixed(ms < 10_000 ? 2 : 1)} s`;
}
