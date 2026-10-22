import { useCallback, useEffect, useState } from 'react';
import { reportError, type ReportClient } from './client';
import { SCHEDULES_PROTOCOL, type ScheduleSummary, type OwnershipCapabilities } from './contracts.generated';
import { REPORT_LIBRARY_CHANGED } from './navigation';
import { nextPollDelay, pollAfter } from './poll';

export interface ScheduleHost { url: string; name: string }
export interface WorkerSchedules extends ScheduleHost { records: ScheduleSummary[]; ownership?: OwnershipCapabilities; loading?: boolean; error?: string; supported?: boolean }

/** One inventory for sidebar navigation and the schedule activity page. */
export function useScheduleInventory(clients: ReadonlyMap<string, ReportClient>, filters: { query: string; limit: number; ownership_scope: OwnershipCapabilities['scopes'][number] } = { query: '', limit: 100, ownership_scope: 'all' }) {
  const [workers, setWorkers] = useState<WorkerSchedules[]>([]), [generation, setGeneration] = useState(0);
  const refresh = useCallback(() => setGeneration(n => n + 1), []);
  useEffect(() => {
    window.addEventListener(REPORT_LIBRARY_CHANGED, refresh);
    window.addEventListener('focus', refresh);
    return () => { window.removeEventListener(REPORT_LIBRARY_CHANGED, refresh); window.removeEventListener('focus', refresh); };
  }, [refresh]);
  useEffect(() => {
    const abort = new AbortController();
    const candidates: ScheduleHost[] = [...clients.keys()].map(url => ({ url, name: new URL(url).host }));
    setWorkers(old => candidates.map(host => {
      const previous = old.find(worker => worker.url === host.url);
      return { ...previous, ...host, records: [], loading: true };
    }));
    // Each host polls on its own, so one that fails backs off (or stops) without slowing the rest.
    async function load(host: ScheduleHost, failures: number) {
      const client = clients.get(host.url)!;
      let result: WorkerSchedules, delay: number | null;
      try {
        const supported = await client.discover(abort.signal, SCHEDULES_PROTOCOL);
        const info = supported ? await client.call('schedules.get_scheduler_info', {}, abort.signal) : null;
        result = { ...host, supported, ownership: info?.ownership, records: supported ? await client.call('schedules.list_schedules', { action_kind: 'render_report', query: filters.query, ownership_scope: filters.ownership_scope, limit: BigInt(filters.limit) }, abort.signal) : [] };
        // A worker without schedules won't grow them mid-session.
        failures = 0; delay = supported ? nextPollDelay(15_000, 0) : null;
      } catch (e) { result = { ...host, records: [], error: reportError(e) }; delay = nextPollDelay(15_000, ++failures, e); }
      if (abort.signal.aborted) return;
      setWorkers(old => old.map(worker => worker.url === host.url ? result : worker));
      if (delay !== null) pollAfter(delay, () => void load(host, failures), abort.signal);
    }
    for (const host of candidates) void load(host, 0);
    return () => abort.abort();
  }, [clients, generation, filters.query, filters.limit, filters.ownership_scope]);
  return { workers, refresh };
}
