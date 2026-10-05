import { appBase } from "../../lib/app-base";
import { useEffect, useState, type MouseEvent } from 'react';
import { ChevronRight, FileChartColumn, FileText, LayoutList } from 'lucide-react';
import { EVIDENCE_REPORTS_CHANGED, LEGACY_STORAGE_PREFIX, STORAGE_PREFIX, listEvidenceReports, type EvidenceReport } from '../../lib/evidence/reports';
import { OPEN_REPORT_EVENT, type OpenReportDetail } from '../../lib/evidence/open-report';

/** Rows drawn like the catalog tree's (`tree-view.tsx`): same chevron, icon size, indent guide and
 *  hover, so the two read as one sidebar. They stay real links rather than tree items, so a report
 *  can open in a new tab or be copied; a plain click opens it inside the app instead of loading the
 *  whole page again. */
const OPEN_KEY = 'cupola.sidebar.reports-open';
const ROW = 'flex items-center rounded-md px-2 py-2 text-sm transition-colors hover:bg-muted/60';
export function SavedReportsSidebar({ serviceUrl, search = '' }: { serviceUrl: string; search?: string }) {
  const [reports, setReports] = useState<EvidenceReport[]>([]);
  const [error, setError] = useState(false);
  const [open, setOpen] = useState(() => { try { return localStorage.getItem(OPEN_KEY) !== '0'; } catch { return true; } });
  const toggle = () => setOpen(current => { try { localStorage.setItem(OPEN_KEY, current ? '0' : '1'); } catch { /* Stays as toggled for this page. */ } return !current; });
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
  const base = `${appBase.replace(/\/$/, '')}/reports`;
  const href = (id?: string) => `${base}${id ? '' : '/saved'}?${new URLSearchParams({ service: serviceUrl, ...(id ? { evidence_report: id } : {}) })}`;
  function openReport(event: MouseEvent<HTMLAnchorElement>, id?: string) {
    // Modified and middle clicks keep the browser's own behavior (new tab, new window).
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    window.dispatchEvent(new CustomEvent<OpenReportDetail>(OPEN_REPORT_EVENT, { detail: { serviceUrl, id, href: href(id) } }));
  }
  const visible = reports.filter(report => report.title.toLocaleLowerCase().includes(search.toLocaleLowerCase()));
  // While filtering, the section shows only when a report matches, like a catalog with no matches.
  if (search && !visible.length && !error) return null;
  const expanded = open || Boolean(search);
  return <div className="text-sm">
    <button type="button" onClick={toggle} aria-expanded={expanded} className={`${ROW} w-full font-bold text-primary`} data-testid="sidebar-reports-toggle">
      <ChevronRight aria-hidden className={`mr-1 h-4 w-4 shrink-0 text-muted-foreground/60 transition-transform duration-200 ${expanded ? 'rotate-90' : ''}`} />
      <FileChartColumn aria-hidden className="mr-2 h-4 w-4 shrink-0" />
      <span className="truncate">Reports</span>
      <span className="ml-1.5 text-xs font-normal text-muted-foreground">{reports.length}</span>
    </button>
    {expanded && <nav aria-label="Saved reports" className="ml-4 border-l pb-1 pl-1">
      <a href={href()} onClick={event => openReport(event)} className={`${ROW} ml-5 text-muted-foreground hover:text-foreground`}><LayoutList aria-hidden className="mr-2 h-4 w-4 shrink-0" />All reports</a>
      {visible.map(report => <a key={report.id} href={href(report.id)} onClick={event => openReport(event, report.id)} title={report.title} className={`${ROW} ml-5`}><FileText aria-hidden className="mr-2 h-4 w-4 shrink-0" /><span className="truncate">{report.title}</span></a>)}
      {error ? <p className="ml-5 px-2 py-1 text-xs text-destructive">Could not load saved reports.</p> : !visible.length && <p className="ml-5 px-2 py-1 text-xs text-muted-foreground">No saved reports for this worker.</p>}
    </nav>}
  </div>;
}
