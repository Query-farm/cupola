import { useEffect, useMemo, useState } from 'react';
import { EvidenceWorkspace } from '../evidence/EvidenceWorkspace';
import { ReportLibrary } from './ReportLibrary';
import { ReportClient, reportError, serviceLocation } from '../../lib/reporting/client';
import { getWorkspace } from '../../lib/workspace/store';
import { OPEN_REPORT_EVENT, type OpenReportDetail } from '../../lib/evidence/open-report';
import type { CatalogData } from '../../lib/service';

export interface ReportingWorkspaceProps { catalogName: string; serviceUrl: string; workspaceId?: string; catalogs: readonly CatalogData[]; defaultToLibrary?: boolean }
export function ReportingWorkspace(props: ReportingWorkspaceProps) {
  const [selected, setSelected] = useState(() => new URLSearchParams(location.search).get('report_service') ?? 'local');
  const [services, setServices] = useState<Array<{ url: string; supported: boolean; error?: string }>>([]);
  const urls = useMemo(() => [...new Set([props.serviceUrl, ...props.catalogs.map(c => c.sourceUrl), ...(props.workspaceId ? getWorkspace(props.workspaceId)?.catalogs.map(c => c.url) ?? [] : []), selected === 'local' ? undefined : selected].filter((u): u is string => Boolean(u)))].flatMap(url => { try { return [serviceLocation(url)]; } catch { return []; } }), [props.serviceUrl, props.workspaceId, props.catalogs, selected]);
  useEffect(() => {
    const abort = new AbortController();
    void Promise.all(urls.map(async url => {
      try { return { url, supported: await new ReportClient(url).discover(abort.signal) }; }
      catch (error) { return { url, supported: false, error: reportError(error) }; }
    })).then(found => {
      if (abort.signal.aborted) return;
      setServices(found);
      const search = new URLSearchParams(location.search);
      if (!search.has('report_service') && !search.has('evidence_report') && !search.has('evidence_new')) {
        const first = found.find(s => s.supported);
        if (first) choose(first.url, true);
      }
    });
    return () => abort.abort();
  }, [urls]);
  useEffect(() => {
    const pop = () => setSelected(new URLSearchParams(location.search).get('report_service') ?? 'local');
    const local = (event: Event) => {
      const detail = (event as CustomEvent<OpenReportDetail>).detail;
      if ((detail.workspaceId ?? detail.serviceUrl) !== (props.workspaceId ?? props.serviceUrl)) return;
      history.replaceState({}, '', detail.href); setSelected('local');
    };
    window.addEventListener('popstate', pop); window.addEventListener(OPEN_REPORT_EVENT, local);
    return () => { window.removeEventListener('popstate', pop); window.removeEventListener(OPEN_REPORT_EVENT, local); };
  }, [props.workspaceId, props.serviceUrl]);
  function choose(value: string, replace = false) {
    const url = new URL(location.href);
    if (value === 'local') url.searchParams.set('report_service', 'local'); else url.searchParams.set('report_service', value);
    for (const key of ['report_id', 'report_revision', 'report_folder']) url.searchParams.delete(key);
    if (value !== 'local') for (const key of ['evidence_report', 'evidence_new']) url.searchParams.delete(key);
    history[replace ? 'replaceState' : 'pushState']({}, '', url); setSelected(value);
  }
  return <div className="flex h-full min-h-0 flex-col">
    <div className="flex shrink-0 items-center gap-3 border-b bg-card px-5 py-2 text-sm">
      <label htmlFor="report-library">Report library</label>
      <select id="report-library" className="max-w-full rounded border bg-background px-2 py-1" value={selected} onChange={e => choose(e.target.value)}>
        <option value="local">On this device</option>
        {[...new Set([...services.filter(s => s.supported || s.error).map(s => s.url), ...(selected !== 'local' ? [selected] : [])])].map(url => <option key={url} value={url}>{url}{services.find(s => s.url === url)?.error ? ' · connection unavailable' : ''}</option>)}
      </select>
    </div>
    <div className="min-h-0 flex-1">{selected === 'local' ? <EvidenceWorkspace {...props} /> : <ReportLibrary key={selected} {...props} libraryUrl={selected} />}</div>
  </div>;
}
