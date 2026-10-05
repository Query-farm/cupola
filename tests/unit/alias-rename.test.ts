import { afterEach, describe, expect, test } from 'bun:test';
import { aliasRenameLabel, planAliasRename, rebindLabel, rewriteEditorState, rewriteReportForRename } from '../../src/lib/workspace/alias-rename';
import { saveReportWithRevision } from '../../src/lib/evidence/report-save';
import { listEvidenceReports, saveEvidenceReport, type EvidenceReport } from '../../src/lib/evidence/reports';
import { loadReportHistory } from '../../src/lib/evidence/revisions';
import { readEditorState, type EditorDoc, type EditorState } from '../../src/lib/editor/editor-store';

function memoryStorage(): Storage {
  const records = new Map<string, string>();
  return { get length() { return records.size; }, key: i => [...records.keys()][i] ?? null, getItem: key => records.get(key) ?? null, setItem: (key, value) => { records.set(key, value); }, removeItem: key => { records.delete(key); }, clear: () => records.clear() };
}
const report = (id: string, sql: string, setupSql = ''): EvidenceReport => ({
  version: 1, id, title: `Report ${id}`, source: `# ${id}\n\n\`\`\`sql q\n${sql}\n\`\`\`\n`, setupSql,
  serviceUrl: 'https://a.example', workspaceId: 'ws1', createdAt: 1, updatedAt: 1, parameters: [], values: {},
});
const doc = (id: string, sql: string): EditorDoc => ({ id, name: `Query ${id}`, sql, createdAt: 1, updatedAt: 1 });

describe('planAliasRename', () => {
  test('counts references per report and tab, listing only those with any', () => {
    const plan = planAliasRename({
      reports: [report('a', 'SELECT * FROM sales.main.t JOIN sales.main.u ON true', 'SELECT * FROM sales.main.v'), report('b', 'SELECT sales FROM t'), report('c', "SELECT 'sales.main.t'")],
      docs: [doc('1', 'USE sales'), doc('2', 'SELECT * FROM crm.main.t'), doc('3', '-- sales.main.t')],
      from: 'sales', to: 'sales_eu',
    });
    expect(plan.reports.map(r => [r.report.id, r.references.length])).toEqual([['a', 3]]);
    expect(plan.tabs.map(t => [t.doc.id, t.references.length])).toEqual([['1', 1]]);
    expect(plan.total).toBe(4);
  });
  test('nothing referenced: total 0', () => {
    expect(planAliasRename({ reports: [], docs: [doc('1', 'SELECT 1')], from: 'sales', to: 'x' }).total).toBe(0);
  });
});

describe('rewriting', () => {
  test('editor state: only tabs with references change', () => {
    const state: EditorState = { version: 1, docs: [doc('1', 'SELECT * FROM sales.main.t'), doc('2', 'SELECT 1')], activeId: '2' };
    const { state: next, count } = rewriteEditorState(state, 'sales', 'eu', 99);
    expect(count).toBe(1);
    expect(next.docs[0]).toEqual({ ...state.docs[0], sql: 'SELECT * FROM eu.main.t', updatedAt: 99 });
    expect(next.docs[1]).toBe(state.docs[1]);
    expect(next.activeId).toBe('2');
    expect(rewriteEditorState(state, 'nope', 'x').state).toBe(state);
  });
  test('a report with no references: null', () => {
    expect(rewriteReportForRename(report('a', 'SELECT 1'), 'sales', 'eu')).toBeNull();
    expect(rewriteReportForRename(report('a', 'FROM sales.main.t'), 'sales', 'eu')?.source).toContain('FROM eu.main.t');
  });
  test('labels', () => {
    expect(aliasRenameLabel('sales', 'sales_eu')).toBe('Renamed catalog sales → sales_eu');
    expect(rebindLabel([{ from: 'a', to: 'b' }, { from: 'c', to: 'd' }])).toBe('Rebound catalog a → b, c → d');
  });
});

describe('saveReportWithRevision', () => {
  test('saves the report and records a labelled revision, with a baseline for history-less reports', () => {
    const storage = memoryStorage();
    const before = saveEvidenceReport(report('a', 'SELECT * FROM sales.main.t'), storage);
    const next = rewriteReportForRename(before, 'sales', 'eu')!;
    const { report: saved, problem } = saveReportWithRevision(before, next, { kind: 'edit', label: aliasRenameLabel('sales', 'eu') }, storage);
    expect(problem).toBe('');
    expect(listEvidenceReports('ws1', storage)[0].source).toBe(saved.source);
    const history = loadReportHistory('ws1', 'a', storage);
    expect(history.revisions.map(r => [r.kind, r.label])).toEqual([['baseline', 'Saved before revision history began'], ['edit', 'Renamed catalog sales → eu']]);
    expect(history.revisions[1].changed).toEqual(['source']);
  });
});

describe('readEditorState', () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  afterEach(() => {
    if (original) Object.defineProperty(globalThis, 'localStorage', original);
    else delete (globalThis as { localStorage?: Storage }).localStorage;
  });
  test('reads a scope\'s tabs without seeding or migrating anything', () => {
    const storage = memoryStorage();
    storage.setItem('vgi-sql-editor-docs', JSON.stringify({ version: 1, docs: [doc('legacy', 'SELECT 1')], activeId: 'legacy' }));
    Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true, writable: true });
    expect(readEditorState('ws-none')).toBeNull();
    // The unscoped legacy key is untouched (loadEditorState would have moved it).
    expect(storage.getItem('vgi-sql-editor-docs')).not.toBeNull();
    expect(storage.length).toBe(1);
    storage.setItem('vgi-sql-editor-docs::ws1', JSON.stringify({ version: 1, docs: [doc('1', 'FROM sales.main.t')], activeId: 'gone' }));
    expect(readEditorState('ws1')).toEqual({ version: 1, docs: [doc('1', 'FROM sales.main.t')], activeId: '1' });
  });
});
