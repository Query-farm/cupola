import { SavedDocumentsSidebar } from '../shared/SavedDocumentsSidebar';
import { useEffect, useState, type MouseEvent } from 'react';
import { FileChartColumn, FileText } from 'lucide-react';
import {
  EVIDENCE_REPORTS_CHANGED,
  LEGACY_STORAGE_PREFIX,
  STORAGE_PREFIX,
  listEvidenceReports,
  type EvidenceReport,
} from '../../lib/evidence/reports';
import { OPEN_REPORT_EVENT, reportHref, type OpenReportDetail } from '../../lib/evidence/open-report';
import { requestSavedDocumentAction } from '../../lib/saved-document-actions';
import { actOnSavedReport } from '../../lib/evidence/report-actions';

export function SavedReportsSidebar({ serviceUrl, workspaceId, search = '' }: { serviceUrl: string; workspaceId?: string; search?: string }) {
  // Reports are kept per workspace (multi-catalog phase 2); without one, per service.
  const scope = workspaceId ?? serviceUrl;
  const [reports, setReports] = useState<EvidenceReport[]>([]);
  const [error, setError] = useState(false);
  useEffect(() => {
    const reload = () => {
      try {
        setReports(listEvidenceReports(scope));
        setError(false);
      } catch {
        setReports([]);
        setError(true);
      }
    };
    const storageChanged = (event: StorageEvent) => {
      if (
        event.key === null ||
        event.key.startsWith(STORAGE_PREFIX) ||
        event.key.startsWith(LEGACY_STORAGE_PREFIX)
      )
        reload();
    };
    reload();
    window.addEventListener(EVIDENCE_REPORTS_CHANGED, reload);
    window.addEventListener('storage', storageChanged);
    return () => {
      window.removeEventListener(EVIDENCE_REPORTS_CHANGED, reload);
      window.removeEventListener('storage', storageChanged);
    };
  }, [scope]);
  // `?local_ws=` when this tab names a workspace, else `?service=`.
  const href = (id?: string) => reportHref(serviceUrl, id);
  function openReport(event: MouseEvent<HTMLAnchorElement>, id?: string) {
    // Modified and middle clicks keep the browser's own behavior (new tab, new window).
    if (
      event.defaultPrevented ||
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    )
      return;
    event.preventDefault();
    window.dispatchEvent(
      new CustomEvent<OpenReportDetail>(OPEN_REPORT_EVENT, { detail: { serviceUrl, workspaceId, id, href: href(id) } }),
    );
  }
  return (
    <SavedDocumentsSidebar
      title="Reports"
      documentKind="report"
      onAction={(id, action) => requestSavedDocumentAction({ kind: 'report', scope, id, action }, () => actOnSavedReport(scope, id, action))}
      icon={FileChartColumn}
      itemIcon={FileText}
      openKey="cupola.sidebar.reports-open"
      testId="sidebar-reports-toggle"
      items={reports.map((report) => ({ id: report.id, title: report.title, href: href(report.id) }))}
      search={search}
      libraryHref={href()}
      onNavigate={openReport}
      onCreate={() => window.dispatchEvent(new CustomEvent<OpenReportDetail>(OPEN_REPORT_EVENT, {
        detail: { serviceUrl, workspaceId, create: true, href: reportHref(serviceUrl, undefined, true) },
      }))}
      createLabel="New report"
      error={error ? 'Could not load saved reports.' : undefined}
    />
  );
}
