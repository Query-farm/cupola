import { downloadDocumentFile, type SavedDocumentAction } from '../saved-document-actions';
import {
  deleteEvidenceReport,
  listEvidenceReports,
  saveEvidenceReport,
  titled,
  reportScope,
  type EvidenceReport,
} from './reports';
import { reportFileName, serializeReportFile } from './report-file';
import { loadReportHistory, recordRevision, saveReportHistory } from './revisions';

export function exportSavedReport(report: EvidenceReport) {
  downloadDocumentFile(
    serializeReportFile([
      { report: titled(report), history: loadReportHistory(reportScope(report), report.id) },
    ]),
    reportFileName([report]),
  );
}

export function copyReport(report: EvidenceReport, storage: Storage = localStorage) {
  const scope = reportScope(report);
  const history = loadReportHistory(scope, report.id, storage);
  const baseline = history.revisions.length
    ? history
    : recordRevision(history, titled(report), { kind: 'baseline', savedAt: report.updatedAt });
  const copy = saveEvidenceReport(
    {
      ...titled(report),
      id: crypto.randomUUID(),
      title: `${titled(report).title} (copy)`,
      createdAt: Date.now(),
    },
    storage,
  );
  saveReportHistory(
    scope,
    copy.id,
    recordRevision(baseline, copy, { kind: 'edit', label: `Saved as a copy of “${report.title}”` }),
    storage,
  );
  return copy;
}

export function actOnSavedReport(
  scope: string,
  id: string,
  action: SavedDocumentAction,
  storage: Storage = localStorage,
) {
  const report = listEvidenceReports(scope, storage).find((item) => item.id === id);
  if (!report) throw new Error('That report is no longer saved in this browser.');
  switch (action.type) {
    case 'rename': {
      const history = loadReportHistory(scope, id, storage);
      const baseline = history.revisions.length
        ? history
        : recordRevision(history, report, { kind: 'baseline', savedAt: report.updatedAt });
      const next = saveEvidenceReport({ ...report, title: action.title }, storage);
      saveReportHistory(
        scope,
        id,
        recordRevision(baseline, next, { kind: 'edit', label: 'Renamed report' }),
        storage,
      );
      break;
    }
    case 'duplicate':
      copyReport(report, storage);
      break;
    case 'export':
      exportSavedReport(report);
      break;
    case 'delete':
      deleteEvidenceReport(scope, id, storage);
      break;
  }
}
