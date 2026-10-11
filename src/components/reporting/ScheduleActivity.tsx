import { useEffect, useMemo, useState } from 'react';
import { Bell, CalendarClock, CheckCircle2, KeyRound, RefreshCw, TriangleAlert } from 'lucide-react';
import { Button, buttonVariants } from '../ui/button';
import { ReportPage } from './ReportPage';
import { ReportNotice } from './ReportNotice';
import { useReportLocations } from './ReportLocations';
import { ReportClient, reportError, serviceLocation } from '../../lib/reporting/client';
import { SCHEDULES_PROTOCOL, type ScheduleRecord } from '../../lib/reporting/contracts.generated';
import { dateLabel, scheduleIssues, statusLabel } from '../../lib/reporting/schedules';
import { REPORT_LIBRARY_CHANGED, REPORT_ROUTE_CHANGED, reportNavigationHref } from '../../lib/reporting/navigation';
import { appBase } from '../../lib/app-base';
import type { CatalogData } from '../../lib/service';

export function openScheduleActivity(serviceUrl: string) {
  const next = new URL(reportNavigationHref(serviceUrl, { location: 'all' }, location.href, appBase), location.origin);
  next.searchParams.set('report_view', 'activity');
  history.pushState({}, '', next); window.dispatchEvent(new Event(REPORT_ROUTE_CHANGED));
}

export function ScheduleActivityButton({ serviceUrl }: { serviceUrl: string }) {
  return <Button variant="outline" size="sm" onClick={() => openScheduleActivity(serviceUrl)}><Bell />Schedules & alerts</Button>;
}

export function scheduleActivityHref(record: ScheduleRecord, scheduler: string, serviceUrl: string, action: 'schedule' | 'renew' | 'run', current = location.href) {
  const report = record.definition.action.render_report?.report;
  if (!report) return null;
  const next = new URL(reportNavigationHref(serviceUrl, { location: report.service_url, reportId: report.report_id }, current, appBase), new URL(current).origin);
  next.searchParams.set('report_view', 'schedules'); next.searchParams.set('report_scheduler', scheduler); next.searchParams.set('report_schedule', record.schedule_id);
  const issue = scheduleIssues(record).find(i => i.run_id);
  if (action === 'renew') next.searchParams.set('report_schedule_access', '1');
  if (action === 'run' && (issue?.run_id || record.last_run)) next.searchParams.set('report_run', issue?.run_id ?? record.last_run!.run_id);
  return next.href;
}

interface WorkerSchedules { url: string; name: string; records: ScheduleRecord[]; loading?: boolean; error?: string; supported?: boolean }
export function ScheduleActivity({ serviceUrl, catalogs, onBack }: { serviceUrl: string; catalogs: readonly CatalogData[]; onBack: () => void }) {
  const { locations, refreshVersion } = useReportLocations();
  const candidates = useMemo(() => [...new Map([{ url: serviceUrl, name: 'Connected worker' },
    ...catalogs.filter(c => c.sourceUrl).map(c => ({ url: c.sourceUrl!, name: c.catalogName })), ...locations].flatMap(item => {
      try { return [[serviceLocation(item.url), { url: serviceLocation(item.url), name: item.name }] as const]; } catch { return []; }
    })).values()], [serviceUrl, locations, catalogs]);
  const key = JSON.stringify(candidates);
  const [workers, setWorkers] = useState<WorkerSchedules[]>([]), [generation, setGeneration] = useState(0);
  const [filter, setFilter] = useState<'attention' | 'all'>('attention'), [query, setQuery] = useState('');
  useEffect(() => { const refresh = () => setGeneration(n => n + 1); window.addEventListener(REPORT_LIBRARY_CHANGED, refresh); window.addEventListener('focus', refresh); return () => { window.removeEventListener(REPORT_LIBRARY_CHANGED, refresh); window.removeEventListener('focus', refresh); }; }, []);
  useEffect(() => {
    const abort = new AbortController(); let timer: ReturnType<typeof setTimeout>;
    const hosts: Array<{ url: string; name: string }> = JSON.parse(key);
    setWorkers(hosts.map(h => ({ ...h, records: [], loading: true })));
    async function refresh() {
      await Promise.allSettled(hosts.map(async host => {
        const client = new ReportClient(host.url);
        let result: WorkerSchedules;
        try {
          const supported = await client.discover(abort.signal, SCHEDULES_PROTOCOL);
          result = { ...host, supported, records: supported ? await client.call('schedules.list_schedules', { action_kind: 'render_report' }, abort.signal) : [] };
        } catch (e) { result = { ...host, records: [], error: reportError(e) }; }
        if (!abort.signal.aborted) setWorkers(old => old.map(w => w.url === host.url ? result : w));
      }));
      if (!abort.signal.aborted) timer = setTimeout(refresh, 15_000);
    }
    void refresh();
    return () => { abort.abort(); clearTimeout(timer); };
  }, [key, generation, refreshVersion]);
  const all = workers.flatMap(worker => worker.records.map(record => ({ worker, record, issues: scheduleIssues(record) })));
  const attention = all.filter(row => row.issues.length > 0);
  const rows = (filter === 'attention' ? attention : all).filter(({ record, worker }) => `${record.definition.title} ${worker.name}`.toLowerCase().includes(query.toLowerCase()));
  const loading = workers.some(w => w.loading), errors = workers.filter(w => w.error);
  return <ReportPage title="Schedules & alerts" description="Report schedules across your connected workers" backLabel="Back to reports" onBack={onBack}>
    <div className="flex flex-wrap items-center gap-2"><Button variant={filter === 'attention' ? 'default' : 'outline'} aria-pressed={filter === 'attention'} onClick={() => setFilter('attention')}><TriangleAlert />Needs attention ({attention.length})</Button><Button variant={filter === 'all' ? 'default' : 'outline'} aria-pressed={filter === 'all'} onClick={() => setFilter('all')}><CalendarClock />All schedules ({all.length})</Button><Button variant="ghost" onClick={() => setGeneration(n => n + 1)}><RefreshCw />Refresh schedules</Button></div>
    <label className="block max-w-lg space-y-1 text-sm"><span className="font-medium">Find a schedule</span><input className="block w-full rounded border bg-card px-3 py-2" value={query} onChange={e => setQuery(e.target.value)} placeholder="Schedule or worker name" /></label>
    {loading && <p role="status" className="text-sm">Checking workers…</p>}
    {errors.map(w => <ReportNotice key={w.url} title={`Could not check ${w.name}`} kind="error">{w.error} Status for this worker is unknown.</ReportNotice>)}
    {!loading && !rows.length && <div className="rounded-lg border border-dashed bg-card p-8 text-center"><CheckCircle2 className="mx-auto mb-3 size-7 text-muted-foreground" /><p className="font-medium">{query ? 'No matching schedules' : filter === 'attention' ? errors.length ? 'No issues reported by the workers we could reach' : 'No schedules need attention' : 'No report schedules yet'}</p><p className="mt-2 text-sm text-muted-foreground">{filter === 'attention' ? 'Access reminders and failed runs appear here. Open All schedules to review upcoming runs.' : 'Open a saved report and choose Schedules & email to create one.'}</p></div>}
    <ul className="space-y-4">{rows.map(({ record, worker, issues }) => {
      const renew = issues.some(i => i.kind.startsWith('access_'));
      const link = (action: 'schedule' | 'renew' | 'run') => scheduleActivityHref(record, worker.url, serviceUrl, action);
      return <li key={`${worker.url}:${record.schedule_id}`} className="rounded-lg border bg-card p-5">
        <div className="flex flex-wrap items-start justify-between gap-3"><div className="min-w-0"><h2 className="break-words font-semibold">{record.definition.title}</h2><p className="mt-1 break-words text-xs text-muted-foreground">{worker.name} · {new URL(worker.url).host} · {record.definition.enabled ? 'Active' : 'Paused'}</p></div><span className="flex items-center gap-1 text-sm">{issues.length ? <TriangleAlert className="size-4 text-amber-600" /> : <CheckCircle2 className="size-4 text-emerald-600" />}{issues.length ? 'Needs attention' : record.last_run ? statusLabel(record.last_run.status) : 'No runs yet'}</span></div>
        {issues.length > 0 && <ul className="my-4 space-y-2 rounded-md border border-amber-500/30 bg-amber-500/5 p-3 text-sm">{issues.map((issue, i) => <li key={i}>{issue.message}{issue.expires_at != null && <span className="block text-xs">Expires {dateLabel(issue.expires_at)}</span>}</li>)}</ul>}
        <dl className="my-4 grid gap-3 text-sm sm:grid-cols-3"><div><dt className="text-xs text-muted-foreground">Last successful run</dt><dd>{dateLabel(record.last_successful_at ?? null)}</dd></div><div><dt className="text-xs text-muted-foreground" title="Accepted by the email provider; inbox delivery is not confirmed">Last email accepted</dt><dd>{dateLabel(record.last_delivery_at ?? null)}</dd></div><div><dt className="text-xs text-muted-foreground">Next run · {record.definition.trigger.time_zone}</dt><dd>{dateLabel(record.next_fire_at, record.definition.trigger.time_zone)}</dd></div></dl>
        <div className="flex flex-wrap gap-2">{renew && link('renew') && <a className={buttonVariants({ variant: 'default', size: 'sm' })} href={link('renew')!}><KeyRound />Renew access</a>}{(record.last_run || issues.some(i => i.run_id)) && link('run') && <a className={buttonVariants({ variant: 'outline', size: 'sm' })} href={link('run')!}>View run</a>}{link('schedule') && <a className={buttonVariants({ variant: 'outline', size: 'sm' })} href={link('schedule')!}>Manage schedule</a>}</div>
      </li>;
    })}</ul>
  </ReportPage>;
}
