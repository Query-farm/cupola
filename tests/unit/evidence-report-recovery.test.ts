import { describe, expect, test } from 'bun:test';
import { clearRecoveryDraft, describeReportError, isQuotaError, listUnsavedDrafts, loadRecoveryDraft, saveEvidenceReport, saveRecoveryDraft, STORAGE_FULL_MESSAGE, titled, UNTITLED_REPORT, type EvidenceReport } from '../../src/lib/evidence/reports';
import { emptyHistory, historyStorageKey, loadReportHistory, recordRevision, saveReportHistory, shrinkStoredHistory, trimHistory } from '../../src/lib/evidence/revisions';

const SERVICE = 'https://example.com';
function memoryStorage(limit = Infinity): Storage {
  const records = new Map<string, string>();
  const size = () => [...records.values()].reduce((total, value) => total + value.length, 0);
  return {
    get length() { return records.size; }, key: i => [...records.keys()][i] ?? null, getItem: key => records.get(key) ?? null,
    setItem: (key, value) => {
      if (size() - (records.get(key)?.length ?? 0) + value.length > limit) throw new DOMException('full', 'QuotaExceededError');
      records.set(key, value);
    },
    removeItem: key => { records.delete(key); }, clear: () => records.clear(),
  };
}
function report(id: string, title = 'Report'): EvidenceReport {
  return { version: 1, id, title, source: '# Report', setupSql: '', serviceUrl: SERVICE, createdAt: 1, updatedAt: 1, parameters: [], values: {} };
}

describe('report recovery', () => {
  test('lists drafts of reports that never saved, newest first, not drafts of saved ones', () => {
    const storage = memoryStorage();
    const now = Date.now;
    Date.now = () => 1000; saveRecoveryDraft(report('older', ''), storage);
    Date.now = () => 2000; saveRecoveryDraft(report('newer'), storage);
    saveRecoveryDraft(report('saved'), storage);
    saveRecoveryDraft({ ...report('elsewhere'), serviceUrl: 'https://other.example' }, storage);
    Date.now = now;
    expect(listUnsavedDrafts(SERVICE, new Set(['saved']), storage).map(draft => draft.report.id)).toEqual(['newer', 'older']);
    clearRecoveryDraft(SERVICE, 'newer', storage);
    expect(listUnsavedDrafts(SERVICE, new Set(['saved']), storage).map(draft => draft.report.id)).toEqual(['older']);
    expect(loadRecoveryDraft(SERVICE, 'older', storage)?.title).toBe('');
  });

  test('a blank title saves as "Untitled report"', () => {
    expect(() => saveEvidenceReport(report('blank', '  '), memoryStorage())).toThrow();
    expect(saveEvidenceReport(titled(report('blank', '  ')), memoryStorage()).title).toBe(UNTITLED_REPORT);
    const named = report('named', 'Kept');
    expect(titled(named)).toBe(named);
  });

  test('a full browser storage is named, and a recovery draft that cannot be kept says so', () => {
    const storage = memoryStorage(10);
    expect(saveRecoveryDraft(report('big'), storage)).toBe(false);
    let error: unknown;
    try { saveEvidenceReport(report('big'), storage); } catch (e) { error = e; }
    expect(isQuotaError(error)).toBe(true);
    expect(describeReportError(error)).toBe(STORAGE_FULL_MESSAGE);
  });

  test('history drops its oldest revisions to fit, keeping the latest', () => {
    let history = emptyHistory();
    for (let i = 0; i < 8; i++) history = recordRevision(history, { ...report('r'), source: `# Version ${i}\n${'x'.repeat(200)}` }, { kind: 'edit' });
    const full = JSON.stringify(history).length;
    const storage = memoryStorage(full / 2);
    const dropped = saveReportHistory(SERVICE, 'r', history, storage);
    expect(dropped).toBeGreaterThan(0);
    const kept = loadReportHistory(SERVICE, 'r', storage);
    expect(kept.revisions.length).toBe(8 - dropped);
    expect(kept.revisions.at(-1)!.id).toBe(history.revisions.at(-1)!.id);
    // Every blob kept is one a kept revision uses.
    expect(Object.keys(kept.blobs).length).toBe(Object.keys(trimHistory(history, kept.revisions.length).blobs).length);
    expect(saveReportHistory(SERVICE, 'r', history, memoryStorage())).toBe(0);
  });

  test('shrinking a stored history halves it, and stops at one revision', () => {
    const storage = memoryStorage();
    let history = emptyHistory();
    for (let i = 0; i < 4; i++) history = recordRevision(history, { ...report('r'), source: `# ${i}` }, { kind: 'edit' });
    saveReportHistory(SERVICE, 'r', history, storage);
    expect(shrinkStoredHistory(SERVICE, 'r', storage)).toBe(true);
    expect(loadReportHistory(SERVICE, 'r', storage).revisions.length).toBe(2);
    expect(shrinkStoredHistory(SERVICE, 'r', storage)).toBe(true);
    expect(shrinkStoredHistory(SERVICE, 'r', storage)).toBe(false);
    expect(storage.getItem(historyStorageKey(SERVICE, 'r'))).not.toBeNull();
  });
});
