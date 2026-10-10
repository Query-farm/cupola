import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { ReportClient, reportError, serviceLocation } from '../../lib/reporting/client';
import { getWorkspace } from '../../lib/workspace/store';
import type { CatalogData } from '../../lib/service';
import type { ReportLocation } from '../../lib/reporting/locations';
import { OPEN_REPORT_EVENT } from '../../lib/evidence/open-report';
import { REPORT_ROUTE_CHANGED } from '../../lib/reporting/navigation';
import type { TransferDestination, TransferSource } from '../../lib/reporting/transfers';

interface TransferRequest { source: TransferSource; move: boolean; initialDestination?: TransferDestination }
const Context = createContext<{ locations: ReportLocation[]; refresh: () => void; refreshVersion: number; transfer: TransferRequest | null; setTransfer: (request: TransferRequest | null) => void } | null>(null);

/** The sidebar and report pages discover the same libraries, including a shared-link target. */
export function ReportLocationsProvider({ serviceUrl, workspaceId, catalogs, children }: {
  serviceUrl: string; workspaceId?: string; catalogs: readonly CatalogData[]; children: ReactNode;
}) {
  const [locations, setLocations] = useState<ReportLocation[]>([]), [generation, setGeneration] = useState(0);
  // A sidebar action survives closing the mobile drawer and lazy mounting Reports.
  const [transfer, setTransfer] = useState<TransferRequest | null>(null);
  const [linked, setLinked] = useState(() => new URLSearchParams(location.search).get('report_service'));
  useEffect(() => {
    const read = () => queueMicrotask(() => setLinked(new URLSearchParams(location.search).get('report_service')));
    for (const event of ['popstate', OPEN_REPORT_EVENT, REPORT_ROUTE_CHANGED]) window.addEventListener(event, read);
    return () => { for (const event of ['popstate', OPEN_REPORT_EVENT, REPORT_ROUTE_CHANGED]) window.removeEventListener(event, read); };
  }, []);
  const urls = useMemo(() => [...new Set([serviceUrl, ...catalogs.map(c => c.sourceUrl),
    ...(workspaceId ? getWorkspace(workspaceId)?.catalogs.filter(c => c.enabled !== false).map(c => c.url) ?? [] : []),
    ...(linked && !['all', 'local'].includes(linked) ? [linked] : []),
  ].flatMap(url => { try { return url ? [serviceLocation(url)] : []; } catch { return []; } }))].sort(), [serviceUrl, workspaceId, catalogs, linked]);
  const key = JSON.stringify(urls);
  useEffect(() => {
    const abort = new AbortController();
    setLocations(urls.map(url => ({ url, name: new URL(url).host, loading: true })));
    for (const url of urls) {
      const client = new ReportClient(url);
      void client.discover(abort.signal).then(async supported => {
        if (!supported) { if (!abort.signal.aborted) setLocations(old => old.filter(l => l.url !== url)); return; }
        const info = await client.call('get_report_service_info', {}, abort.signal);
        if (info.protocol_version.split('.')[0] !== '1') throw new Error(`Unsupported reporting version: ${info.protocol_version}`);
        if (!abort.signal.aborted) setLocations(old => old.map(l => l.url === url ? { url, name: info.display_name.trim() || 'Report library', info } : l));
      }).catch(e => { if (!abort.signal.aborted) setLocations(old => old.map(l => l.url === url ? { ...l, loading: false, error: reportError(e) } : l)); });
    }
    return () => abort.abort();
  }, [key, generation]);
  const refresh = useCallback(() => setGeneration(n => n + 1), []);
  return <Context.Provider value={{ locations, refresh, refreshVersion: generation, transfer, setTransfer }}>{children}</Context.Provider>;
}

export function useReportLocations() {
  const value = useContext(Context);
  if (!value) throw new Error('Report navigation requires a report locations provider.');
  return value;
}
