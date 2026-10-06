import { describe, expect, test } from 'bun:test';
import { actOnSavedNotebook, copyNotebook } from '../../src/lib/notebooks/actions';
import { listNotebooks, newNotebook, saveNotebook } from '../../src/lib/notebooks/model';
import { actOnSavedReport, copyReport } from '../../src/lib/evidence/report-actions';
import {
  listEvidenceReports,
  saveEvidenceReport,
  type EvidenceReport,
} from '../../src/lib/evidence/reports';
import {
  loadReportHistory,
  recordRevision,
  revisionReport,
  saveReportHistory,
  emptyHistory,
} from '../../src/lib/evidence/revisions';
import { setLegacyScope } from '../../src/lib/workspace/legacy-scope';

function memoryStorage(): Storage {
  const records = new Map<string, string>();
  return {
    get length() {
      return records.size;
    },
    key: (index) => [...records.keys()][index] ?? null,
    getItem: (key) => records.get(key) ?? null,
    setItem: (key, value) => {
      records.set(key, value);
    },
    removeItem: (key) => {
      records.delete(key);
    },
    clear: () => records.clear(),
  };
}

function report(): EvidenceReport {
  return {
    version: 1,
    id: 'same-id',
    serviceUrl: 'https://first.example',
    title: 'Original report',
    source: '# Original',
    setupSql: '',
    parameters: [],
    values: {},
    createdAt: 1,
    updatedAt: 1,
  };
}

describe('saved document actions', () => {
  test('notebook copies preserve definitions and fit the title limit without changing the original', () => {
    const storage = memoryStorage();
    const notebook = { ...newNotebook('https://first.example'), title: 'n'.repeat(200) };
    saveNotebook(notebook, storage);
    const copy = copyNotebook(notebook, storage);
    expect(copy.id).not.toBe(notebook.id);
    expect(copy.title).toHaveLength(200);
    expect(copy.cells).toEqual(notebook.cells);
    expect(
      listNotebooks(notebook.serviceUrl, storage).documents.find((doc) => doc.id === notebook.id),
    ).toEqual(notebook);
  });

  test('report rename retains a restorable baseline and copying preserves the complete history', () => {
    const storage = memoryStorage();
    const original = saveEvidenceReport(report(), storage);
    actOnSavedReport(
      original.serviceUrl,
      original.id,
      { type: 'rename', title: 'Renamed report' },
      storage,
    );
    const renamed = listEvidenceReports(original.serviceUrl, storage)[0];
    const history = loadReportHistory(original.serviceUrl, original.id, storage);
    expect(renamed.id).toBe(original.id);
    expect(revisionReport(history, history.revisions[0], renamed).title).toBe('Original report');
    expect(revisionReport(history, history.revisions[1], renamed).title).toBe('Renamed report');
    const copy = copyReport(renamed, storage);
    const copiedHistory = loadReportHistory(original.serviceUrl, copy.id, storage);
    expect(copy.id).not.toBe(original.id);
    expect(copiedHistory.revisions.slice(0, 2)).toEqual(history.revisions);
    expect(
      listEvidenceReports(original.serviceUrl, storage).find((doc) => doc.id === original.id),
    ).toEqual(renamed);
  });

  test('actions are connection-scoped and stale menus cannot recreate a deleted document', () => {
    const storage = memoryStorage();
    const original = saveEvidenceReport(report(), storage);
    const other = saveEvidenceReport(
      { ...original, serviceUrl: 'https://second.example' },
      storage,
    );
    saveReportHistory(
      original.serviceUrl,
      original.id,
      recordRevision(emptyHistory(), original, { kind: 'baseline' }),
      storage,
    );
    actOnSavedReport(original.serviceUrl, original.id, { type: 'delete' }, storage);
    expect(listEvidenceReports(other.serviceUrl, storage)).toEqual([other]);
    expect(loadReportHistory(original.serviceUrl, original.id, storage).revisions).toHaveLength(0);
    expect(() =>
      actOnSavedReport(
        original.serviceUrl,
        original.id,
        { type: 'rename', title: 'Recreated' },
        storage,
      ),
    ).toThrow('no longer saved');
    expect(() =>
      actOnSavedNotebook(original.serviceUrl, original.id, { type: 'duplicate' }, storage),
    ).toThrow('no longer saved');
    expect(listEvidenceReports(original.serviceUrl, storage)).toHaveLength(0);
  });

  test('actions and copied report history stay in their workspace when catalogs share a service', () => {
    const storage = memoryStorage();
    const serviceUrl = 'https://shared.example';
    const notebook = { ...newNotebook(serviceUrl, 'workspace-one'), id: 'same-id' };
    const otherNotebook = { ...notebook, workspaceId: 'workspace-two' };
    saveNotebook(notebook, storage);
    saveNotebook(otherNotebook, storage);
    actOnSavedNotebook('workspace-one', notebook.id, { type: 'rename', title: 'Renamed' }, storage);
    expect(listNotebooks('workspace-two', storage).documents).toEqual([otherNotebook]);
    const copy = copyNotebook(listNotebooks('workspace-one', storage).documents[0], storage);
    expect(copy.workspaceId).toBe('workspace-one');
    expect(listNotebooks(serviceUrl, storage).documents).toHaveLength(0);
    actOnSavedNotebook('workspace-one', notebook.id, { type: 'delete' }, storage);
    expect(listNotebooks('workspace-one', storage).documents).toEqual([copy]);
    expect(listNotebooks('workspace-two', storage).documents).toEqual([otherNotebook]);

    const original = saveEvidenceReport({ ...report(), serviceUrl, workspaceId: 'workspace-one' }, storage);
    const otherReport = saveEvidenceReport({ ...original, workspaceId: 'workspace-two' }, storage);
    actOnSavedReport('workspace-one', original.id, { type: 'rename', title: 'Renamed report' }, storage);
    const renamed = listEvidenceReports('workspace-one', storage)[0];
    const history = loadReportHistory('workspace-one', original.id, storage);
    const reportCopy = copyReport(renamed, storage);
    expect(reportCopy.workspaceId).toBe('workspace-one');
    expect(loadReportHistory('workspace-one', reportCopy.id, storage).revisions.slice(0, 2)).toEqual(history.revisions);
    expect(loadReportHistory('workspace-two', original.id, storage).revisions).toHaveLength(0);
    expect(listEvidenceReports(serviceUrl, storage)).toHaveLength(0);
    actOnSavedReport('workspace-one', original.id, { type: 'delete' }, storage);
    expect(listEvidenceReports('workspace-two', storage)).toEqual([otherReport]);
    expect(loadReportHistory('workspace-one', original.id, storage).revisions).toHaveLength(0);
  });

  test('actions adopt legacy definitions and deletion removes the legacy fallback', () => {
    const storage = memoryStorage();
    const notebook = newNotebook('https://legacy-actions.example');
    const original = { ...report(), serviceUrl: notebook.serviceUrl };
    const scope = 'legacy-actions-workspace';
    setLegacyScope(scope, notebook.serviceUrl);
    try {
      saveNotebook(notebook, storage);
      saveEvidenceReport(original, storage);
      actOnSavedNotebook(scope, notebook.id, { type: 'rename', title: 'Adopted notebook' }, storage);
      actOnSavedReport(scope, original.id, { type: 'rename', title: 'Adopted report' }, storage);
      expect(listNotebooks(scope, storage).documents[0].workspaceId).toBe(scope);
      expect(listEvidenceReports(scope, storage)[0].workspaceId).toBe(scope);
      expect(listNotebooks(notebook.serviceUrl, storage).documents[0].title).toBe(notebook.title);
      expect(listEvidenceReports(original.serviceUrl, storage)[0].title).toBe(original.title);
      actOnSavedNotebook(scope, notebook.id, { type: 'delete' }, storage);
      actOnSavedReport(scope, original.id, { type: 'delete' }, storage);
      expect(listNotebooks(scope, storage).documents).toHaveLength(0);
      expect(listEvidenceReports(scope, storage)).toHaveLength(0);
      expect(listNotebooks(notebook.serviceUrl, storage).documents).toHaveLength(0);
      expect(listEvidenceReports(original.serviceUrl, storage)).toHaveLength(0);
    } finally {
      setLegacyScope(scope, null);
    }
  });
});
