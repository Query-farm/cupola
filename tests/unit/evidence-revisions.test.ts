import { describe, expect, test } from 'bun:test';
import { compactHistory, describeChanges, SESSION_WINDOW_MS, emptyHistory, lineDiff, loadReportHistory, mergeHistories, recordRevision, removeRevision, REVISION_FIELDS, revisionReport, saveReportHistory, specOf, validateHistory } from '../../src/lib/evidence/revisions';
import { editableFields } from '../../src/lib/evidence/agent';
import type { EvidenceReport } from '../../src/lib/evidence/reports';

const base: EvidenceReport = {
  version: 1, id: 'r', title: 'Sales', source: '# Sales\n\nline 2\nline 3', setupSql: '', serviceUrl: 'https://a.example',
  parameters: [], values: {}, createdAt: 1, updatedAt: 1,
};
let n = 0;
const id = () => `rev-${++n}`;

class MemoryStorage {
  private items = new Map<string, string>();
  get length() { return this.items.size; }
  key(i: number) { return [...this.items.keys()][i] ?? null; }
  getItem(key: string) { return this.items.get(key) ?? null; }
  setItem(key: string, value: string) { this.items.set(key, value); }
  removeItem(key: string) { this.items.delete(key); }
  clear() { this.items.clear(); }
}

describe('revisions', () => {
  test('track every field the agent can edit', () => {
    expect([...REVISION_FIELDS].sort()).toEqual([...editableFields].sort());
  });
  test('record what changed, label it, and skip saves that change nothing', () => {
    let history = recordRevision(emptyHistory(), base, { kind: 'edit' }, id);
    expect(history.revisions[0]).toMatchObject({ kind: 'edit', label: 'First saved version' });
    expect(describeChanges(['title', 'source', 'values'])).toBe('Changed Title, Document and Parameter values');
    const edited = { ...base, source: '# Sales\n\nline 2 changed\nline 3', setupSql: 'SELECT 1' };
    history = recordRevision(history, edited, { kind: 'edit' }, id);
    expect(history.revisions[1]).toMatchObject({ changed: ['source', 'setupSql'], label: 'Changed Document and Dataset SQL' });
    expect(recordRevision(history, { ...edited, updatedAt: 99 }, { kind: 'edit' }, id)).toBe(history);
    const byAgent = recordRevision(history, { ...edited, title: 'Sales by region' }, { kind: 'agent', agentSummaries: ['Rename the report', 'Tidy up'], alsoEdited: true }, id);
    expect(byAgent.revisions[2]).toMatchObject({ kind: 'agent', label: 'Rename the report; Tidy up', agentSummaries: ['Rename the report', 'Tidy up'], alsoEdited: true, changed: ['title'] });
  });
  test('resolve any revision back to the report it was', () => {
    const v1 = base, v2 = { ...base, source: '# Two', drillPaths: [{ id: 'd', levels: ['x'] }] }, v3 = { ...v2, source: '# Three' };
    delete (v3 as Partial<EvidenceReport>).drillPaths;
    let history = emptyHistory();
    for (const version of [v1, v2, v3]) history = recordRevision(history, version, { kind: 'edit' }, id);
    const current = { ...v3, updatedAt: 50 };
    expect(specOf(revisionReport(history, history.revisions[0], current))).toBe(specOf(v1));
    expect(specOf(revisionReport(history, history.revisions[1], current))).toBe(specOf(v2));
    expect(revisionReport(history, history.revisions[2], current)).not.toHaveProperty('drillPaths');
    expect(revisionReport(history, history.revisions[0], current).updatedAt).toBe(50);
  });
  test('store each value once', () => {
    let history = emptyHistory();
    for (let i = 0; i < 5; i++) history = recordRevision(history, { ...base, title: `Sales ${i}` }, { kind: 'edit' }, id);
    // Five titles, and one copy of each unchanged field.
    expect(Object.keys(history.blobs)).toHaveLength(5 + 4);
  });
  test('merge two copies of a history that went separate ways', () => {
    const shared = recordRevision(emptyHistory(), base, { kind: 'edit', savedAt: 1 }, id);
    const mine = recordRevision(shared, { ...base, title: 'Mine' }, { kind: 'edit', savedAt: 3 }, id);
    const theirs = recordRevision(shared, { ...base, title: 'Theirs' }, { kind: 'edit', savedAt: 2 }, id);
    const merged = mergeHistories(mine, theirs);
    expect(merged.revisions.map(revision => revision.savedAt)).toEqual([1, 2, 3]);
    expect(merged.revisions.map(revision => revisionReport(merged, revision, base).title)).toEqual(['Sales', 'Theirs', 'Mine']);
    expect(mergeHistories(merged, merged)).toEqual(merged);
  });
  test('refuse a history whose revisions point at missing values', () => {
    const history = recordRevision(emptyHistory(), base, { kind: 'edit' }, id);
    expect(() => validateHistory({ ...history, blobs: {} })).toThrow('missing its title');
    expect(validateHistory(JSON.parse(JSON.stringify(history)))).toEqual(history);
  });
  test('persist per report, dropping unused values', () => {
    const storage = new MemoryStorage() as unknown as Storage;
    const history = recordRevision(emptyHistory(), base, { kind: 'edit' }, id);
    saveReportHistory('https://a.example', 'r', { ...history, blobs: { ...history.blobs, orphan: '"x"' } }, storage);
    expect(loadReportHistory('https://a.example', 'r', storage)).toEqual(compactHistory(history));
    expect(loadReportHistory('https://a.example', 'other', storage)).toEqual(emptyHistory());
  });
});

describe('autosave sessions', () => {
  const v = (title: string, source = base.source) => ({ ...base, title, source });
  test('one session\'s autosaves grow one revision; other kinds, other sessions and time start new ones', () => {
    let history = recordRevision(emptyHistory(), v('a'), { kind: 'edit', savedAt: 0 }, id);
    history = recordRevision(history, v('b'), { kind: 'edit', session: 's1', savedAt: 1_000 }, id);
    history = recordRevision(history, v('b', '# more'), { kind: 'edit', session: 's1', savedAt: 2_000 }, id);
    expect(history.revisions).toHaveLength(2);
    expect(history.revisions[1]).toMatchObject({ changed: ['title', 'source'], label: 'Changed Title and Document', savedAt: 2_000, startedAt: 1_000, session: 's1' });
    // The agent's proposal is its own revision, and the session's next edit starts another.
    history = recordRevision(history, v('c', '# more'), { kind: 'agent', agentSummaries: ['Retitle'], savedAt: 3_000 }, id);
    history = recordRevision(history, v('d', '# more'), { kind: 'edit', session: 's1', savedAt: 4_000 }, id);
    expect(history.revisions.map(revision => revision.label)).toEqual(['First saved version', 'Changed Title and Document', 'Retitle', 'Changed Title']);
    history = recordRevision(history, v('e', '# more'), { kind: 'edit', session: 's2', savedAt: 5_000 }, id);
    history = recordRevision(history, v('f', '# more'), { kind: 'edit', session: 's2', savedAt: 5_000 + SESSION_WINDOW_MS }, id);
    expect(history.revisions).toHaveLength(6);
  });
  test('edits undone within the session leave no revision', () => {
    let history = recordRevision(emptyHistory(), v('a'), { kind: 'edit', savedAt: 0 }, id);
    history = recordRevision(history, v('b'), { kind: 'edit', session: 's', savedAt: 1 }, id);
    history = recordRevision(history, v('a'), { kind: 'edit', session: 's', savedAt: 2 }, id);
    expect(history.revisions).toHaveLength(1);
  });
  test('a first version keeps its label as the session grows it', () => {
    let history = recordRevision(emptyHistory(), v('a'), { kind: 'edit', session: 's', savedAt: 0 }, id);
    history = recordRevision(history, v('b'), { kind: 'edit', session: 's', savedAt: 1 }, id);
    expect(history.revisions).toHaveLength(1);
    expect(history.revisions[0]).toMatchObject({ label: 'First saved version', changed: [] });
    expect(revisionReport(history, history.revisions[0], base).title).toBe('b');
  });
});

describe('removeRevision', () => {
  const versions = [base, { ...base, title: 'Two' }, { ...base, title: 'Two', source: '# Three' }, { ...base, title: 'Four', source: '# Three' }];
  const build = () => versions.reduce((history, version) => recordRevision(history, version, { kind: 'edit' }, id), emptyHistory());
  test('re-measures the next revision against the one before, and keeps blobs others use', () => {
    const history = build();
    const removed = removeRevision(history, history.revisions[2].id);
    expect(removed.revisions).toHaveLength(3);
    expect(removed.revisions[2]).toMatchObject({ id: history.revisions[3].id, changed: ['title', 'source'], label: 'Changed Title and Document' });
    // Every remaining revision still resolves to the report it was.
    expect(removed.revisions.map(revision => revisionReport(removed, revision, base).title)).toEqual(['Sales', 'Two', 'Four']);
    expect(validateHistory(removed)).toEqual(removed);
    // Its values are all shared with its neighbours, so every blob stays.
    expect(Object.keys(removed.blobs)).toHaveLength(Object.keys(history.blobs).length);
  });
  test('the next revision becomes the first, values only the removed one used go, and written labels are kept', () => {
    let history = build();
    const first = removeRevision(history, history.revisions[0].id);
    expect(first.revisions[0]).toMatchObject({ changed: [], label: 'First saved version' });
    // Only the first version was titled "Sales".
    expect(Object.values(first.blobs)).not.toContain('"Sales"');
    history = recordRevision(history, { ...base, title: 'Five' }, { kind: 'agent', agentSummaries: ['Retitle'] }, id);
    history = recordRevision(history, { ...base, title: 'Six' }, { kind: 'edit' }, id);
    const removed = removeRevision(history, history.revisions[3].id);
    expect(removed.revisions[3]).toMatchObject({ label: 'Retitle', changed: ['title', 'source'] });
  });
  test('refuses the latest revision, and ignores an unknown id', () => {
    const history = build();
    expect(() => removeRevision(history, history.revisions.at(-1)!.id)).toThrow('cannot be removed');
    expect(removeRevision(history, 'nope')).toBe(history);
  });
});

describe('lineDiff', () => {
  test('marks added and removed lines', () => {
    expect(lineDiff('a\nb\nc', 'a\nB\nc\nd')).toEqual([
      { kind: 'same', text: 'a' }, { kind: 'removed', text: 'b' }, { kind: 'added', text: 'B' }, { kind: 'same', text: 'c' }, { kind: 'added', text: 'd' },
    ]);
    expect(lineDiff('', 'x')).toEqual([{ kind: 'removed', text: '' }, { kind: 'added', text: 'x' }]);
  });
  test('gives up on very large changes', () => {
    const big = (tag: string) => Array.from({ length: 3000 }, (_, i) => `${tag}${i}`).join('\n');
    expect(lineDiff(big('a'), big('b'))).toBeNull();
    // A small change in a long text is cheap: the common head and tail are skipped.
    expect(lineDiff(big('a'), big('a').replace('a1500\n', 'changed\n'))?.filter(line => line.kind !== 'same')).toHaveLength(2);
  });
});
