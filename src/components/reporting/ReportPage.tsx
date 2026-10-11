import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ArrowLeft } from 'lucide-react';
import { Button } from '../ui/button';
import { REPORT_ROUTE_CHANGED } from '../../lib/reporting/navigation';

export type ReportPageName = 'history' | 'details' | 'share' | 'source' | 'ownership' | 'schedules';
const pages = new Set(['history', 'details', 'share', 'source', 'ownership', 'schedules']);
const readPage = () => {
  const value = new URLSearchParams(location.search).get('report_view');
  return value && pages.has(value) ? value as ReportPageName : null;
};
/** Management views have URLs and browser navigation, while the editor stays mounted. */
export function useReportPage() {
  const [page, setPage] = useState(readPage);
  useEffect(() => {
    const read = () => setPage(readPage());
    window.addEventListener('popstate', read); window.addEventListener(REPORT_ROUTE_CHANGED, read);
    return () => { window.removeEventListener('popstate', read); window.removeEventListener(REPORT_ROUTE_CHANGED, read); };
  }, []);
  function navigate(value: ReportPageName | null) {
    const url = new URL(location.href);
    for (const key of ['report_scheduler', 'report_schedule', 'report_run', 'report_schedule_edit', 'report_schedule_access']) url.searchParams.delete(key);
    if (value) url.searchParams.set('report_view', value); else url.searchParams.delete('report_view');
    if (!value && history.state?.reportPageFrom === url.href) { history.back(); return; }
    if (url.href !== location.href) {
      if (value) history.pushState({ ...history.state, reportPageFrom: location.href }, '', url);
      else history.replaceState({}, '', url);
    }
    window.dispatchEvent(new Event(REPORT_ROUTE_CHANGED));
  }
  return [page, navigate] as const;
}
export function ReportPage({ title, description, onBack, backLabel = 'Back to report', children }: {
  title: string; description?: string; onBack: () => void; backLabel?: string; children: ReactNode;
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => { heading.current?.focus(); }, [title]);
  return <section aria-label={title} className="flex h-full min-h-0 flex-col">
    <header className="flex shrink-0 flex-wrap items-center gap-3 border-b px-5 py-4">
      <Button variant="ghost" size="sm" onClick={onBack}><ArrowLeft />{backLabel}</Button>
      <div><h1 ref={heading} tabIndex={-1} className="font-semibold outline-none">{title}</h1>{description && <p className="text-sm text-muted-foreground">{description}</p>}</div>
    </header>
    <div className="min-h-0 flex-1 overflow-auto p-5"><div className="mx-auto max-w-5xl space-y-5">{children}</div></div>
  </section>;
}
