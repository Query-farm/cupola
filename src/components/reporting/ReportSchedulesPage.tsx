import { useEffect, useMemo, useRef, useState } from 'react';
import { CalendarClock, Mail, Pause, Pencil, Play, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { Button } from '../ui/button';
import { ReportPage } from './ReportPage';
import { ReportNotice } from './ReportNotice';
import { useReportLocations } from './ReportLocations';
import { ScheduleForm, scheduleInput, ScheduleSection } from './ScheduleForm';
import { ScheduleAccess } from './ScheduleAccess';
import { ScheduleRunDetails } from './ScheduleRunDetails';
import { ReportClient, reportError, errorCode, serviceLocation } from '../../lib/reporting/client';
import { MutationJournal } from '../../lib/reporting/journal';
import { NOTIFY_PROTOCOL, SCHEDULES_PROTOCOL, type NotifyInfo, type ReportResult, type Schedule, type ScheduleRecord, type SchedulerInfo, type ScheduleRun } from '../../lib/reporting/contracts.generated';
import { dateLabel, requiredDelegations, sameService, statusLabel } from '../../lib/reporting/schedules';
import { REPORT_ROUTE_CHANGED } from '../../lib/reporting/navigation';
import type { CatalogData } from '../../lib/service';

const readRoute = () => { const p = new URLSearchParams(location.search); return { host: p.get('report_scheduler'), schedule: p.get('report_schedule'), run: p.get('report_run'), edit: p.get('report_schedule_edit') === '1' }; };
export function ReportSchedulesPage({ report, reportClient, catalogs, workspaceId, pinned = false, onBack }: {
  report: ReportResult; reportClient: ReportClient; catalogs: readonly CatalogData[]; workspaceId?: string; pinned?: boolean; onBack: () => void;
}) {
  const { locations } = useReportLocations();
  const [route, setRoute] = useState(readRoute);
  const hosts = useMemo(() => [...new Map([{ url: reportClient.url, name: 'Report’s worker' }, ...locations,
    ...catalogs.filter(c => c.sourceUrl).map(c => ({ url: c.sourceUrl!, name: c.catalogName }))].map(item => [serviceLocation(item.url), item])).values()], [reportClient, locations, catalogs]);
  const chosenHost = route.host && hosts.some(h => sameService(h.url, route.host!)) ? route.host : reportClient.url;
  const client = useMemo(() => new ReportClient(chosenHost, { timeoutMs: 180_000 }), [chosenHost]);
  const [info, setInfo] = useState<SchedulerInfo | null>(null), [notify, setNotify] = useState<NotifyInfo | null>(null), [supported, setSupported] = useState(true);
  const [records, setRecords] = useState<ScheduleRecord[]>([]), [runs, setRuns] = useState<ScheduleRun[]>([]), [run, setRun] = useState<ScheduleRun | null>(null);
  const [journal, setJournal] = useState<MutationJournal | null>(null), [loading, setLoading] = useState(true), [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [generation, setGeneration] = useState(0), [selectedReport, setSelectedReport] = useState(report), [deleting, setDeleting] = useState(false), [reviewed, setReviewed] = useState(false);
  const [connectionGeneration, setConnectionGeneration] = useState(0), [formGeneration, setFormGeneration] = useState(0), [listLoading, setListLoading] = useState(true);
  const selected = records.find(s => s.schedule_id === route.schedule);
  const blocked = busy || Boolean(journal?.pending), current = useRef(0);
  useEffect(() => { const read = () => setRoute(readRoute()); window.addEventListener('popstate', read); window.addEventListener(REPORT_ROUTE_CHANGED, read); return () => { window.removeEventListener('popstate', read); window.removeEventListener(REPORT_ROUTE_CHANGED, read); }; }, []);
  function navigate(schedule: string | null, runId: string | null = null, edit = false, host = chosenHost) {
    const url = new URL(location.href);
    for (const [key, value] of Object.entries({ report_scheduler: host, report_schedule: schedule, report_run: runId, report_schedule_edit: edit ? '1' : null })) { if (value) url.searchParams.set(key, value); else url.searchParams.delete(key); }
    history.pushState({ ...history.state }, '', url); window.dispatchEvent(new Event(REPORT_ROUTE_CHANGED)); setDeleting(false); setError('');
  }
  useEffect(() => {
    const abort = new AbortController(); const id = ++current.current; setLoading(true); setError(''); setInfo(null); setNotify(null); setRecords([]); setJournal(null); setRun(null); setRuns([]); setSupported(true);
    void (async () => {
      if (!await client.discover(abort.signal, SCHEDULES_PROTOCOL)) { if (!abort.signal.aborted) setSupported(false); return; }
      const [details, scope] = await Promise.all([client.call('schedules.get_scheduler_info', {}, abort.signal), client.recoveryScope()]);
      if (abort.signal.aborted) return;
      setInfo(details); setJournal(new MutationJournal(client, scope, `schedules:${reportClient.url}:${report.report_id}`));
      if (await client.discover(abort.signal, NOTIFY_PROTOCOL)) {
        const n = await client.call('notify.get_notify_info', {}, abort.signal); if (!abort.signal.aborted) setNotify(n);
      }
    })().catch(e => { if (!abort.signal.aborted) setError(reportError(e)); }).finally(() => { if (id === current.current) setLoading(false); });
    return () => { abort.abort(); current.current++; };
  }, [client, reportClient, report.report_id, connectionGeneration]);
  useEffect(() => {
    if (!info) return;
    const abort = new AbortController(); let timer: ReturnType<typeof setTimeout>;
    // Sequential polling avoids overlapping reads and stale responses after navigation.
    async function refresh() {
      try {
        const list = await client.call('schedules.list_schedules', { report_id: report.report_id, action_kind: 'render_report' }, abort.signal);
        if (abort.signal.aborted) return;
        const filtered = list.filter(s => s.definition.action.render_report && sameService(s.definition.action.render_report.report.service_url, reportClient.url));
        setRecords(filtered);
        if (route.schedule && route.schedule !== 'new' && filtered.some(s => s.schedule_id === route.schedule)) {
          const history = await client.call('schedules.list_runs', { schedule_id: route.schedule }, abort.signal);
          if (!abort.signal.aborted) setRuns(history.sort((a, b) => b.admitted_at - a.admitted_at));
          if (route.run) { const value = await client.call('schedules.get_run', { run_id: route.run }, abort.signal); if (!abort.signal.aborted && value.schedule_id === route.schedule) setRun(value); }
        }
      } catch (e) { if (!abort.signal.aborted) { setError(reportError(e)); if (['NOT_FOUND', 'PERMISSION_DENIED', 'UNAUTHENTICATED'].includes(errorCode(e) ?? '')) { setRecords([]); setRuns([]); setRun(null); } } }
      finally { if (!abort.signal.aborted) { setListLoading(false); timer = setTimeout(refresh, 5000); } }
    }
    setRun(null); setRuns([]); setListLoading(true); void refresh();
    return () => { abort.abort(); clearTimeout(timer); };
  }, [client, info, report.report_id, reportClient, route.schedule, route.run, generation]);
  async function perform(action: () => Promise<void>) {
    setBusy(true); setError(''); setNotice('');
    try { await action(); setGeneration(n => n + 1); } catch (e) { setError(reportError(e)); } finally { setBusy(false); }
  }
  async function save(schedule: Schedule, version?: bigint) {
    if (!journal || blocked) throw new Error('Resolve the pending change first.');
    setBusy(true);
    try {
    const next = selected ? await journal.run('schedules.update_schedule', { schedule_id: selected.schedule_id, expected_version: version!, schedule }) : await journal.run('schedules.create_schedule', { schedule });
    setRecords(old => [...old.filter(s => s.schedule_id !== next.schedule_id), next]); setNotice('Schedule saved.'); navigate(next.schedule_id); setGeneration(n => n + 1);
    } finally { setBusy(false); }
  }
  const list = !route.schedule, editing = route.schedule === 'new' || route.edit;
  const access = <><ScheduleAccess client={client} requirements={editing ? requiredDelegations(reportClient.url, selectedReport.envelope?.data_sources ?? []) : selected?.credentials ?? requiredDelegations(reportClient.url, report.envelope?.data_sources ?? [])} catalogs={catalogs} workspaceId={workspaceId} title={selected?.definition.title ?? report.envelope?.title ?? 'Report'} busy={blocked || !info?.writable} onChange={() => setGeneration(n => n + 1)} />{selected && <p className="mt-3 text-xs text-muted-foreground">This schedule runs as {selected.execution_identity.principal.display_name || selected.execution_identity.principal.id}. Access is renewed for your signed-in scheduling account. A different execution account must renew its own access.</p>}</>;
  return <ReportPage title={route.run ? 'Schedule run' : editing ? route.schedule === 'new' ? 'New schedule' : 'Edit schedule' : selected?.definition.title ?? 'Schedules & email'} description={report.envelope?.title}
    backLabel={list ? 'Back to report' : route.run || route.edit ? 'Back to schedule' : 'All schedules'} onBack={() => list ? onBack() : navigate(route.run || route.edit ? route.schedule : null)}>
    {list && hosts.length > 1 && <label className="block max-w-md space-y-1 text-sm"><span className="font-medium">Scheduling worker</span><select className={scheduleInput} value={chosenHost} disabled={blocked} onChange={e => navigate(null, null, false, e.target.value)}>{hosts.map(h => <option key={h.url} value={h.url}>{h.name} · {new URL(h.url).host}</option>)}</select></label>}
    {loading && <p role="status">Checking scheduling support…</p>}
    {!loading && !supported && <ReportNotice title="Scheduling is not available on this worker">Choose a worker that offers report scheduling, or ask its administrator to enable the schedules protocol.</ReportNotice>}
    {error && <ReportNotice title="Could not complete this action" kind="error" action={<Button variant="outline" onClick={() => { setError(''); if (!info) setConnectionGeneration(n => n + 1); else setGeneration(n => n + 1); }}>Refresh status</Button>}>{error}</ReportNotice>}
    {notice && <p role="status" className="text-sm">{notice}</p>}
    {journal?.pending && <ReportNotice title="A request is awaiting confirmation" action={<div className="space-y-2"><Button disabled={busy} onClick={() => void perform(async () => { const result = await journal.retry(); if (result.run_id) navigate(result.schedule_id, result.run_id); else if (result.schedule_id) navigate(result.schedule_id); else navigate(null); })}>Confirm pending request</Button><label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={reviewed} onChange={e => setReviewed(e.target.checked)} />I checked the schedule and run history and want to discard local recovery.</label>{reviewed && <Button variant="outline" disabled={busy} onClick={() => void perform(() => journal.discard())}>Discard local recovery</Button>}</div>}>The worker may have accepted it. Confirming reuses the original request ID, including for “Run & send now,” to prevent a duplicate run. Recovery is available for 24 hours.</ReportNotice>}
    {info && !info.writable && <ReportNotice kind="permission" title="Read-only scheduling access">Your worker account can view schedules. Sign in with an account the worker allows to manage them.</ReportNotice>}
    {info && !info.action_kinds.includes('render_report') && <ReportNotice title="This worker does not schedule reports">Its scheduler supports other kinds of work. Select another scheduling worker.</ReportNotice>}
    {info?.action_kinds.includes('render_report') && <>
      {list && <>
        <div className="flex flex-wrap items-center justify-between gap-3"><p className="text-sm text-muted-foreground">{info.display_name} · Generate reports and deliver them while you’re away.</p><div className="flex gap-2"><Button variant="outline" size="sm" disabled={busy} onClick={() => setGeneration(n => n + 1)}><RefreshCw />Refresh</Button><Button disabled={blocked || !info.writable} onClick={() => navigate('new')}><Plus />New schedule</Button></div></div>
        {records.length === 0 ? <div className="rounded-lg border border-dashed p-10 text-center"><CalendarClock className="mx-auto mb-3 size-8 text-muted-foreground" /><h2 className="font-semibold">No schedules for this report</h2><p className="mt-1 text-sm text-muted-foreground">Create a schedule, choose recipients, and preview the result before enabling delivery.</p></div> : <ul className="divide-y overflow-hidden rounded-lg border">{records.map(item => <li key={item.schedule_id}><button className="flex w-full flex-wrap items-center gap-4 p-4 text-left hover:bg-muted/40 focus-visible:bg-muted" onClick={() => navigate(item.schedule_id)}><CalendarClock className="size-5 shrink-0 text-muted-foreground" /><span className="min-w-0 flex-1"><span className="block font-medium">{item.definition.title}</span><span className="mt-1 block text-xs text-muted-foreground">{item.definition.deliveries.flatMap(d => d.destinations.map(x => x.address)).join(', ') || 'Generate files only'}</span></span><span className="text-right text-sm"><span className="block">{item.definition.enabled ? item.disabled_reason ? 'Needs attention' : 'Active' : 'Paused'}</span><span className="block text-xs text-muted-foreground">{item.next_fire_at ? `Next ${dateLabel(item.next_fire_at, item.definition.trigger.time_zone)}` : item.last_run ? `Last run ${statusLabel(item.last_run.status)}` : 'No runs yet'}</span></span></button></li>)}</ul>}
      </>}
      {route.schedule && route.schedule !== 'new' && !selected && !listLoading && <ReportNotice title="Schedule unavailable">It may have been removed, or your access has changed. Return to All schedules to refresh the listing.</ReportNotice>}
      {route.run && selected && !run && !listLoading && <ReportNotice title="Run unavailable">This run is not available for the selected schedule, or your access has changed.</ReportNotice>}
      {editing && journal && !loading && (route.schedule === 'new' || selected) && <ScheduleForm key={`${chosenHost}:${route.schedule}:${formGeneration}`} draftKey={`cupola.reporting.schedule-draft.v1:${chosenHost}:${reportClient.url}:${report.report_id}:${route.schedule}`} initial={selected} report={report} reportClient={reportClient} client={client} scheduler={info} notify={notify} pinned={pinned} busy={blocked} access={access} onSources={setSelectedReport} onSave={save} onReload={() => void perform(async () => { const latest = await client.call('schedules.get_schedule', { schedule_id: route.schedule! }); setRecords(old => old.map(s => s.schedule_id === latest.schedule_id ? latest : s)); setFormGeneration(n => n + 1); })} />}
      {!list && !editing && selected && !route.run && <>
        <div className="flex flex-wrap gap-2">
          {selected.allowed_actions.includes('update') && <><Button variant="outline" disabled={blocked || !info.writable} onClick={() => navigate(selected.schedule_id, null, true)}><Pencil />Edit schedule</Button><Button variant="outline" disabled={blocked || !info.writable} onClick={() => void perform(async () => { await journal!.run('schedules.update_schedule', { schedule_id: selected.schedule_id, expected_version: selected.version, schedule: { ...selected.definition, enabled: !selected.definition.enabled } }); })}>{selected.definition.enabled ? <Pause /> : <Play />}{selected.definition.enabled ? 'Pause schedule' : 'Enable schedule'}</Button></>}
          {selected.allowed_actions.includes('run') && <Button disabled={blocked || !info.writable} onClick={() => void perform(async () => { const next = await journal!.run('schedules.run_now', { schedule_id: selected.schedule_id }); navigate(selected.schedule_id, next.run_id); })}>{selected.definition.deliveries.length ? <Mail /> : <Play />}{selected.definition.deliveries.length ? 'Run & send now' : 'Run now'}</Button>}
          {selected.allowed_actions.includes('delete') && <Button variant="ghost" disabled={blocked || !info.writable} onClick={() => setDeleting(!deleting)}><Trash2 />Delete schedule</Button>}
        </div>
        {deleting && <ReportNotice title="Delete this schedule?" action={<div className="flex gap-2"><Button variant="destructive" disabled={blocked} onClick={() => void perform(async () => { await journal!.run('schedules.delete_schedule', { schedule_id: selected.schedule_id, expected_version: selected.version }); navigate(null); })}>Confirm deletion</Button><Button variant="outline" onClick={() => setDeleting(false)}>Keep schedule</Button></div>}>Future scheduled runs stop. Completed runs and generated files follow the worker’s retention policy.</ReportNotice>}
        <ScheduleSection title="Schedule details"><dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-[auto_1fr]"><dt className="text-muted-foreground">Status</dt><dd>{selected.definition.enabled ? 'Active' : 'Paused'}{selected.disabled_reason && selected.disabled_reason !== 'paused' ? ` · ${selected.disabled_reason}` : ''}</dd><dt className="text-muted-foreground">Next run</dt><dd>{dateLabel(selected.next_fire_at, selected.definition.trigger.time_zone)} · {selected.definition.trigger.time_zone}</dd><dt className="text-muted-foreground">Report version</dt><dd>{selected.definition.action.render_report?.track === 'head' ? 'Latest saved version' : selected.definition.action.render_report?.track === 'published' ? 'Latest published version' : 'Specific version'}</dd><dt className="text-muted-foreground">Recipients</dt><dd className="break-words">{selected.definition.deliveries.flatMap(d => d.destinations.map(x => x.address)).join(', ') || 'Generate files only'}</dd><dt className="text-muted-foreground">Runs as</dt><dd>{selected.execution_identity.principal.display_name || selected.execution_identity.principal.id} · {statusLabel(selected.execution_identity.state)}</dd><dt className="text-muted-foreground">Created by</dt><dd>{selected.created_by.display_name || selected.created_by.id}</dd></dl>{selected.execution_identity.reason && <ReportNotice title="Scheduled access needs attention">{selected.execution_identity.reason}</ReportNotice>}</ScheduleSection>
        <ScheduleSection title="Run history">{runs.length ? <ul className="divide-y">{runs.map(item => <li key={item.run_id}><button className="flex w-full flex-wrap justify-between gap-2 rounded p-3 text-left text-sm hover:bg-muted" onClick={() => navigate(selected.schedule_id, item.run_id)}><span>{dateLabel(item.scheduled_for)}<span className="ml-2 text-xs text-muted-foreground">{statusLabel(item.trigger_kind)}</span></span><span className="capitalize">{statusLabel(item.status)}{item.recovery.state !== 'none' ? ` · ${statusLabel(item.recovery.state)}` : ''}</span></button></li>)}</ul> : <p className="text-sm text-muted-foreground">No runs yet. Preview from Edit schedule, or run this schedule now.</p>}</ScheduleSection>
        <details className="rounded-lg border p-4"><summary className="cursor-pointer text-sm font-medium">Manage scheduled access</summary><div className="mt-4">{access}</div></details>
      </>}
      {route.run && run && <ScheduleRunDetails key={run.run_id} run={run} busy={blocked || !info.writable} onRenew={() => navigate(route.schedule, null, true)} onAction={action => void perform(async () => { await journal!.run(action === 'retry' ? 'schedules.retry_run' : 'schedules.cancel_run', { run_id: run.run_id, expected_version: run.version }); })} onResolve={(resolutions, note) => void perform(async () => { await journal!.run('schedules.resolve_run', { run_id: run.run_id, expected_version: run.version, resolutions, note }); })} />}
    </>}
  </ReportPage>;
}
