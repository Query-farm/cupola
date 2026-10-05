import { SavedDocumentsSidebar } from '../shared/SavedDocumentsSidebar';
import { appBase } from '../../lib/app-base';
import { useEffect, useState, type MouseEvent } from 'react';
import { FileChartColumn, FileText } from 'lucide-react';
import {
  EVIDENCE_REPORTS_CHANGED,
  LEGACY_STORAGE_PREFIX,
  STORAGE_PREFIX,
  listEvidenceReports,
  type EvidenceReport,
} from '../../lib/evidence/reports';
import { OPEN_REPORT_EVENT, type OpenReportDetail } from '../../lib/evidence/open-report';

export function SavedReportsSidebar({ serviceUrl, search = '' }: { serviceUrl: string; search?: string }) {
  const [reports, setReports] = useState<EvidenceReport[]>([]);
  const [error, setError] = useState(false);
  useEffect(() => {
    const reload = () => {
      try {
        setReports(listEvidenceReports(serviceUrl));
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
  }, [serviceUrl]);
  const base = `${appBase.replace(/\/$/, '')}/reports`;
  const href = (id?: string) =>
    `${base}${id ? '' : '/saved'}?${new URLSearchParams({ service: serviceUrl, ...(id ? { evidence_report: id } : {}) })}`;
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
      new CustomEvent<OpenReportDetail>(OPEN_REPORT_EVENT, { detail: { serviceUrl, id, href: href(id) } }),
    );
  }
  return (
    <SavedDocumentsSidebar
      title="Reports"
      icon={FileChartColumn}
      itemIcon={FileText}
      openKey="cupola.sidebar.reports-open"
      testId="sidebar-reports-toggle"
      items={reports.map((report) => ({ id: report.id, title: report.title, href: href(report.id) }))}
      search={search}
      libraryHref={href()}
      onNavigate={openReport}
      error={error ? 'Could not load saved reports.' : undefined}
      emptyMessage="No saved reports for this worker."
    />
  );
}
