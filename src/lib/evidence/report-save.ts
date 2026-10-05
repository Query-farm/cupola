import { reportScope, saveEvidenceReport, type EvidenceReport } from './reports';
import { emptyHistory, loadReportHistory, recordRevision, saveReportHistory, specOf, type RevisionMeta } from './revisions';

/** Save a report that is not open in the editor, with a revision, the way the open report's own
 *  save does (`persist` in `EvidenceWorkspace.tsx`): a report saved before history was kept gets
 *  its previous version as the baseline first. Used for changes made to many reports at once (an
 *  alias rename). Throws when the report can't be saved; a history that can't be stored is
 *  reported in `problem` instead, since the report itself was saved. */
export function saveReportWithRevision(before: EvidenceReport, next: EvidenceReport, meta: RevisionMeta, storage: Storage = localStorage): { report: EvidenceReport; problem: string } {
  const stored = saveEvidenceReport(next, storage);
  const scope = reportScope(stored);
  try {
    let history = emptyHistory();
    try { history = loadReportHistory(scope, stored.id, storage); } catch { /* Starts again from this save. */ }
    if (!history.revisions.length && specOf(before) !== specOf(stored)) history = recordRevision(history, before, { kind: 'baseline', savedAt: before.updatedAt });
    history = recordRevision(history, stored, meta);
    saveReportHistory(scope, stored.id, history, storage);
    return { report: stored, problem: '' };
  } catch (e) {
    return { report: stored, problem: `its revision history could not be stored: ${e instanceof Error ? e.message : String(e)}` };
  }
}
