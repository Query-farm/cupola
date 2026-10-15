import { useEffect, useState } from 'react';
import { Bell, CalendarClock, CheckCircle2, KeyRound, RefreshCw, TriangleAlert } from 'lucide-react';
import { Button, buttonVariants } from '../ui/button';
import { ReportPage } from './ReportPage';
import { ReportNotice } from './ReportNotice';
import { useReportLocations } from './ReportLocations';
import { type ScheduleRecord } from '../../lib/reporting/contracts.generated';
import { dateLabel, scheduleIssues, statusLabel } from '../../lib/reporting/schedules';
import { REPORT_ROUTE_CHANGED, reportNavigationHref } from '../../lib/reporting/navigation';
import { appBase } from '../../lib/app-base';
import { OPEN_REPORT_EVENT, type OpenReportDetail } from '../../lib/evidence/open-report';

export function scheduleOverviewHref(serviceUrl: string, schedulerUrl?: string) {
  const next = new URL(reportNavigationHref(serviceUrl, { location: 'all' }, location.href, appBase), location.origin);
  next.searchParams.set('report_view', 'activity');
  if (schedulerUrl) next.searchParams.set('report_scheduler', schedulerUrl);
  return next.href;
}

export function openScheduleActivity(serviceUrl: string, schedulerUrl?: string) {
  const next = new URL(scheduleOverviewHref(serviceUrl, schedulerUrl));
  window.dispatchEvent(new CustomEvent<OpenReportDetail>(OPEN_REPORT_EVENT, { detail: { serviceUrl, workspaceId: next.searchParams.get('local_ws') ?? undefined, href: next.href } }));
}

export function ScheduleActivityButton({ serviceUrl, schedulerUrl }: { serviceUrl: string; schedulerUrl?: string }) {
  return <Button variant="outline" size="sm" onClick={() => openScheduleActivity(serviceUrl, schedulerUrl)}><Bell />Schedules & alerts</Button>;
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

export function ScheduleActivity({ serviceUrl, onBack }: { serviceUrl: string; onBack: () => void }) {
  const { scheduleWorkers: workers, refreshSchedules } = useReportLocations();
  const [filter, setFilter] = useState<'attention' | 'all'>('all'), [query, setQuery] = useState('');
  const [workerFilter, setWorkerFilter] = useState(() => new URLSearchParams(location.search).get('report_scheduler') ?? '');
  useEffect(() => {
    const read = () => setWorkerFilter(new URLSearchParams(location.search).get('report_scheduler') ?? '');
    window.addEventListener('popstate', read);
    window.addEventListener(REPORT_ROUTE_CHANGED, read);
    return () => { window.removeEventListener('popstate', read); window.removeEventListener(REPORT_ROUTE_CHANGED, read); };
  }, []);
  function selectWorker(value: string) {
    setWorkerFilter(value);
    const url = new URL(location.href);
    if (value) url.searchParams.set('report_scheduler', value); else url.searchParams.delete('report_scheduler');
    history.replaceState(history.state, '', url); window.dispatchEvent(new Event(REPORT_ROUTE_CHANGED));
  }
  const selectedWorkers = workers.filter(worker => !workerFilter || worker.url === workerFilter);
  const all = selectedWorkers.flatMap(worker => worker.records.map(record => ({ worker, record, issues: scheduleIssues(record) })));
  const attention = all.filter(row => row.issues.length > 0);
  const rows = (filter === 'attention' ? attention : all).filter(({ record, worker }) => `${record.definition.title} ${worker.name}`.toLowerCase().includes(query.toLowerCase()));
  const loading = selectedWorkers.some(w => w.loading), errors = selectedWorkers.filter(w => w.error);
  return <ReportPage title="Schedules & alerts" description="Report schedules across your connected workers" backLabel="Back to reports" onBack={onBack}>
    <div className="flex flex-wrap items-center gap-2"><Button variant={filter === 'attention' ? 'default' : 'outline'} aria-pressed={filter === 'attention'} onClick={() => setFilter('attention')}><TriangleAlert />Needs attention ({attention.length})</Button><Button variant={filter === 'all' ? 'default' : 'outline'} aria-pressed={filter === 'all'} onClick={() => setFilter('all')}><CalendarClock />All schedules ({all.length})</Button><Button variant="ghost" onClick={refreshSchedules}><RefreshCw />Refresh schedules</Button></div>
    <label className="block max-w-lg space-y-1 text-sm"><span className="font-medium">Worker</span><select aria-label="Schedule worker" className="block h-9 w-full rounded-lg border border-input bg-card px-3 text-sm [appearance:auto]" value={workerFilter} onChange={event => selectWorker(event.target.value)}><option value="">All workers</option>{workers.map(worker => <option key={worker.url} value={worker.url}>{worker.name} · {new URL(worker.url).host}</option>)}</select></label>
    {workerFilter && selectedWorkers.some(worker => worker.supported === false) && <ReportNotice title="Scheduling is not available on this worker">Choose another worker or All workers to browse report schedules.</ReportNotice>}
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
