import { useEffect, useState } from 'react';
import { FileText, FolderOpen } from 'lucide-react';
import { EVIDENCE_REPORTS_CHANGED, LEGACY_STORAGE_PREFIX, STORAGE_PREFIX, listEvidenceReports, type EvidenceReport } from '../../lib/evidence/reports';

/** Links preserve browser navigation and the report editor's beforeunload guard. */
export function SavedReportsSidebar({ serviceUrl, search = '' }: { serviceUrl: string; search?: string }) {
  const [reports, setReports] = useState<EvidenceReport[]>([]);
  const [error, setError] = useState(false);
  useEffect(() => {
    const reload = () => {
      try { setReports(listEvidenceReports(serviceUrl)); setError(false); }
      catch { setReports([]); setError(true); }
    };
    const storageChanged = (event: StorageEvent) => {
      if (event.key === null || event.key.startsWith(STORAGE_PREFIX) || event.key.startsWith(LEGACY_STORAGE_PREFIX)) reload();
    };
    reload();
    window.addEventListener(EVIDENCE_REPORTS_CHANGED, reload);
    window.addEventListener('storage', storageChanged);
    return () => {
      window.removeEventListener(EVIDENCE_REPORTS_CHANGED, reload);
      window.removeEventListener('storage', storageChanged);
    };
  }, [serviceUrl]);
  const base = `${import.meta.env.BASE_URL.replace(/\/$/, '')}/reports`;
  const href = (id?: string) => `${base}${id ? '' : '/saved'}?${new URLSearchParams({ service: serviceUrl, ...(id ? { evidence_report: id } : {}) })}`;
  const visible = reports.filter(report => report.title.toLocaleLowerCase().includes(search.toLocaleLowerCase()));
  return <details open className="mb-2 border-b pb-2" aria-label="Saved reports">
    <summary className="cursor-pointer rounded px-2 py-1.5 font-medium hover:bg-secondary">Reports <span className="text-xs text-muted-foreground">({reports.length})</span></summary>
    <nav aria-label="Saved reports" className="space-y-0.5 pl-3">
      <a href={href()} className="flex items-center gap-2 rounded px-2 py-1.5 text-muted-foreground hover:bg-secondary hover:text-foreground"><FolderOpen className="h-4 w-4 shrink-0" />All reports</a>
      {visible.map(report => <a key={report.id} href={href(report.id)} title={report.title} className="flex items-center gap-2 rounded px-2 py-1.5 hover:bg-secondary"><FileText className="h-4 w-4 shrink-0 text-muted-foreground" /><span className="truncate">{report.title}</span></a>)}
      {error ? <p className="px-2 py-1 text-xs text-destructive">Could not load saved reports.</p> : !visible.length && <p className="px-2 py-1 text-xs text-muted-foreground">{search ? 'No matching reports.' : 'No saved reports for this worker.'}</p>}
    </nav>
  </details>;
}
