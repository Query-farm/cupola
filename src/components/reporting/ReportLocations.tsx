import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode, type Dispatch, type SetStateAction } from 'react';
import { ReportClient, reportError, serviceLocation } from '../../lib/reporting/client';
import { getWorkspace } from '../../lib/workspace/store';
import type { CatalogData } from '../../lib/service';
import type { ReportLocation } from '../../lib/reporting/locations';
import { OPEN_REPORT_EVENT } from '../../lib/evidence/open-report';
import { REPORT_ROUTE_CHANGED } from '../../lib/reporting/navigation';
import type { OwnershipScope } from '../../lib/reporting/discovery';
import type { TransferDestination, TransferSource } from '../../lib/reporting/transfers';
import { useScheduleInventory, type WorkerSchedules } from '../../lib/reporting/use-schedule-inventory';

interface ScheduleFilters { query: string; limit: number; ownership_scope: OwnershipScope }
interface TransferRequest { source: TransferSource; move: boolean; initialDestination?: TransferDestination }
const Context = createContext<{ locations: ReportLocation[]; refresh: () => void; refreshVersion: number; scheduleWorkers: WorkerSchedules[]; scheduleFilters: ScheduleFilters; setScheduleFilters: Dispatch<SetStateAction<ScheduleFilters>>; refreshSchedules: () => void; transfer: TransferRequest | null; setTransfer: (request: TransferRequest | null) => void } | null>(null);

/** The sidebar and report pages discover the same libraries, including a shared-link target. */
export function ReportLocationsProvider({ serviceUrl, workspaceId, catalogs, children }: {
  serviceUrl: string; workspaceId?: string; catalogs: readonly CatalogData[]; children: ReactNode;
}) {
  const [locations, setLocations] = useState<ReportLocation[]>([]), [generation, setGeneration] = useState(0);
  const [clients, setClients] = useState<ReadonlyMap<string, ReportClient>>(() => new Map());
  // A sidebar action survives closing the mobile drawer and lazy mounting Reports.
  const [transfer, setTransfer] = useState<TransferRequest | null>(null);
  const [linked, setLinked] = useState(() => new URLSearchParams(location.search).get('report_service'));
  const [linkedScheduler, setLinkedScheduler] = useState(() => new URLSearchParams(location.search).get('report_scheduler'));
  useEffect(() => {
    const read = () => queueMicrotask(() => { const params = new URLSearchParams(location.search); setLinked(params.get('report_service')); setLinkedScheduler(params.get('report_scheduler')); });
    for (const event of ['popstate', OPEN_REPORT_EVENT, REPORT_ROUTE_CHANGED]) window.addEventListener(event, read);
    return () => { for (const event of ['popstate', OPEN_REPORT_EVENT, REPORT_ROUTE_CHANGED]) window.removeEventListener(event, read); };
  }, []);
  const urls = useMemo(() => [...new Set([serviceUrl, ...catalogs.map(c => c.sourceUrl),
    ...(workspaceId ? getWorkspace(workspaceId)?.catalogs.filter(c => c.enabled !== false).map(c => c.url) ?? [] : []),
    ...(linked && !['all', 'local'].includes(linked) ? [linked] : []),
    linkedScheduler,
  ].flatMap(url => { try { return url ? [serviceLocation(url)] : []; } catch { return []; } }))].sort(), [serviceUrl, workspaceId, catalogs, linked, linkedScheduler]);
  const key = JSON.stringify(urls);
  useEffect(() => {
    const abort = new AbortController();
    // Both inventories share protocol discovery for this refresh. Create the
    // clients inside the effect so each run owns its requests and cancellation.
    const clients = new Map(urls.map(url => [url, new ReportClient(url)]));
    setClients(clients);
    setLocations(urls.map(url => ({ url, name: new URL(url).host, loading: true })));
    for (const [url, client] of clients) {
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
  const [scheduleFilters, setScheduleFilters] = useState<ScheduleFilters>({ query: '', limit: 100, ownership_scope: 'all' });
  const { workers, refresh: refreshSchedules } = useScheduleInventory(clients, scheduleFilters);
  // Names are presentation only; resolving a library name must not restart
  // schedule discovery or cancel an in-flight schedule request.
  const scheduleWorkers = workers.map(worker => ({ ...worker, name: locations.find(location => location.url === worker.url)?.name ?? catalogs.find(catalog => catalog.sourceUrl === worker.url)?.catalogName ?? worker.name }));
  return <Context.Provider value={{ locations, refresh, refreshVersion: generation, scheduleWorkers, scheduleFilters, setScheduleFilters, refreshSchedules, transfer, setTransfer }}>{children}</Context.Provider>;
}

export function useReportLocations() {
  const value = useContext(Context);
  if (!value) throw new Error('Report navigation requires a report locations provider.');
  return value;
}
