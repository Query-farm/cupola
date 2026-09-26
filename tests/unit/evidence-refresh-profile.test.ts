import { describe, expect, test } from 'bun:test';
import { formatMs, nameRenderQueries, RefreshProfiler, summarizeProfile, type ProfiledQuery, type RefreshProfile } from '../../src/lib/evidence/refresh-profile';

const query = (id: number, extra: Partial<ProfiledQuery>): ProfiledQuery => ({ id, phase: 'render', sql: 'SELECT 1', startedAt: 0, durationMs: 10, error: null, ...extra });

describe('refresh profiles', () => {
  test('the profiler records phases and queries on one clock, and finishing closes open phases', () => {
    let seen: RefreshProfile | null = null;
    const profiler = new RefreshProfiler(profile => { seen = profile; }, 100);
    profiler.begin('engine', 100); profiler.end('engine', 400);
    profiler.begin('render', 450);
    profiler.query({ phase: 'render', sql: 'SELECT 1', startedAt: 460, durationMs: 90, error: null });
    profiler.finish('done', 600);
    profiler.finish('failed', 900); // A second finish changes nothing.
    expect(profiler.profile).toMatchObject({ startedAt: 100, finishedAt: 600, outcome: 'done',
      phases: [{ phase: 'engine', start: 100, end: 400 }, { phase: 'render', start: 450, end: 600 }] });
    expect(seen).not.toBeNull();
  });
  test('the summary splits time by phase, counts only queries that ran, and names the slowest', () => {
    const profile: RefreshProfile = { startedAt: 0, finishedAt: 1000, outcome: 'done',
      phases: [{ phase: 'engine', start: 0, end: 300 }, { phase: 'setup', start: 300, end: 500 }, { phase: 'render', start: 500, end: 1000 }],
      queries: [query(1, { phase: 'setup', durationMs: 200 }), query(2, { durationMs: 400 }), query(3, { durationMs: 350 }), query(4, { durationMs: 5, cached: true }), query(5, { durationMs: 1, error: 'boom' })] };
    const summary = summarizeProfile(profile);
    expect(summary.totalMs).toBe(1000);
    expect(summary.byPhase).toEqual([{ phase: 'engine', ms: 300 }, { phase: 'setup', ms: 200 }, { phase: 'render', ms: 500 }]);
    expect(summary.queryCount).toBe(4);
    expect(summary.queryMs).toBe(951);
    expect(summary.failed).toBe(1);
    expect(summary.slowest.map(item => item.id)).toEqual([2, 3, 1]);
  });
  test('component queries are named after the report query whose SQL they contain', () => {
    const named = [{ name: 'by_city', sql: 'SELECT city, sum(revenue) AS revenue\nFROM sales GROUP BY city' }, { name: 'places', sql: 'SELECT * FROM places' }];
    const [own, component, byName, other, choices] = nameRenderQueries([
      query(1, { sql: 'select city, sum(revenue) as revenue from sales group by city' }),
      query(2, { sql: 'SELECT count(*) FROM (SELECT city, sum(revenue) AS revenue FROM sales GROUP BY city) AS t' }),
      query(3, { sql: 'SELECT * FROM places LIMIT 10' }),
      query(4, { sql: 'SELECT 42' }),
      query(5, { phase: 'choices', name: 'State', sql: 'SELECT * FROM places' }),
    ], named);
    expect(own.name).toBe('by_city');
    expect(component.name).toBe('by_city · component');
    expect(byName.name).toBe('places · component');
    expect(other.name).toBeUndefined();
    expect(choices.name).toBe('State');
  });
  test('durations read naturally', () => {
    expect([0.4, 12.6, 999, 1234, 15_400].map(formatMs)).toEqual(['<1 ms', '13 ms', '999 ms', '1.23 s', '15.4 s']);
  });
});
