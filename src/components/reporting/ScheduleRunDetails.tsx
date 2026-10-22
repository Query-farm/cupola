import { useEffect, useState } from 'react';
import { Download, RotateCcw, Square } from 'lucide-react';
import { Button } from '../ui/button';
import { ReportNotice } from './ReportNotice';
import type { Output, ScheduleRun, StepResolution, RunStep, RecoveryEvent, DestinationResult, StepAttempt } from '../../lib/reporting/contracts.generated';
import { ReportClient, reportError } from '../../lib/reporting/client';
import { artifactUrl, dateLabel, statusLabel } from '../../lib/reporting/schedules';

export function ScheduleArtifacts({ outputs }: { outputs: Output[] }) {
  return <ul className="flex flex-wrap gap-3">{outputs.map((output, i) => {
    const artifact = output.artifact, url = artifact && artifactUrl(artifact.url);
    const expired = artifact?.expires_at != null && artifact.expires_at <= Date.now();
    return <li key={i} className="rounded-md border px-3 py-2 text-sm">{url && !expired ? <a className="flex items-center gap-2 text-primary underline-offset-4 hover:underline" href={url} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer"><Download className="size-4" />{artifact!.filename}</a> : <span>{artifact?.filename ?? output.media_type}{expired ? ' · download expired' : ' · no download available'}</span>}{artifact?.expires_at != null && !expired && <p className="mt-1 text-xs text-muted-foreground">Available until {dateLabel(artifact.expires_at)}</p>}</li>;
  })}</ul>;
}
export function ScheduleRunDetails({ client, run, busy, onAction, onResolve, onRenew }: {
  client: ReportClient; run: ScheduleRun; busy: boolean; onAction: (action: 'retry' | 'cancel') => void;
  onResolve: (resolutions: StepResolution[], note: string) => void; onRenew: () => void;
}) {
  const [evidence, setEvidence] = useState(''), [note, setNote] = useState('');
  const [outcome, setOutcome] = useState<StepResolution['outcome']>('committed');
  const [steps, setSteps] = useState<RunStep[]>([]), [destinations, setDestinations] = useState<DestinationResult[]>([]), [events, setEvents] = useState<RecoveryEvent[]>([]);
  const [limit, setLimit] = useState(100), [historyError, setHistoryError] = useState(''), [loading, setLoading] = useState(true), [generation, setGeneration] = useState(0);
  useEffect(() => {
    const abort = new AbortController(); setLoading(true); setHistoryError(''); setSteps([]); setDestinations([]); setEvents([]);
    void Promise.all([
      client.call('schedules.list_run_steps', { run_id: run.run_id, limit: BigInt(limit) }, abort.signal),
      client.call('schedules.list_run_destinations', { run_id: run.run_id, limit: BigInt(limit) }, abort.signal),
      client.call('schedules.list_recovery_events', { run_id: run.run_id, limit: BigInt(limit) }, abort.signal),
    ]).then(([steps, destinations, events]) => { if (!abort.signal.aborted) { setSteps(steps); setDestinations(destinations); setEvents(events); } })
      .catch(e => { if (!abort.signal.aborted) setHistoryError(reportError(e)); }).finally(() => { if (!abort.signal.aborted) setLoading(false); });
    return () => abort.abort();
  }, [client, run.run_id, run.version, limit, generation]);
  const recover = run.recovery;
  const uncertain = steps.filter(step => step.effect_outcome === 'unknown');
  const [step, setStep] = useState(() => String(uncertain[0]?.step_index ?? recover.failed_step_index ?? ''));
  const selectedStep = uncertain.find(item => String(item.step_index) === step) ?? uncertain[0];
  return <div className="space-y-5">
    <div className="rounded-lg border p-5"><div className="flex flex-wrap items-center justify-between gap-3"><div><h2 className="font-semibold capitalize">{statusLabel(run.status)}</h2><p className="text-sm text-muted-foreground">{statusLabel(run.trigger_kind)} · {dateLabel(run.scheduled_for)}</p></div><div className="flex gap-2">
      {recover.allowed_actions.includes('retry') && recover.state !== 'needs_resolution' && <Button disabled={busy} variant="outline" onClick={() => onAction('retry')}><RotateCcw />Retry this run</Button>}
      {run.allowed_actions.includes('cancel') && <Button disabled={busy} variant="outline" onClick={() => onAction('cancel')}><Square />Cancel run</Button>}
    </div></div><dl className="mt-4 grid gap-x-6 gap-y-2 text-sm sm:grid-cols-[auto_1fr]"><dt className="text-muted-foreground">Runs as</dt><dd>{run.execution_principal.display_name || run.execution_principal.id}</dd><dt className="text-muted-foreground">Started</dt><dd>{dateLabel(run.started_at)}</dd><dt className="text-muted-foreground">Finished</dt><dd>{dateLabel(run.finished_at)}</dd><dt className="text-muted-foreground">Report version</dt><dd className="break-all">{run.revision_id ?? 'Not selected yet'}</dd></dl></div>
    {run.error && <ReportNotice title={statusLabel(run.error.kind)} kind="error">{run.error.message}</ReportNotice>}
    {run.skip_reason && <ReportNotice title="Run skipped">{run.skip_reason}</ReportNotice>}
    {recover.state !== 'none' && <ReportNotice title={statusLabel(recover.state)} action={recover.allowed_actions.includes('reauthorize') ? <Button variant="outline" disabled={busy} onClick={onRenew}>Renew scheduled access</Button> : undefined}>
      {recover.reason && <p>{recover.reason}</p>}{recover.next_retry_at != null && <p>The worker will retry at {dateLabel(recover.next_retry_at)}.</p>}
      {recover.state === 'needs_resolution' && <p>The worker cannot confirm whether a delivery was accepted. It needs a verified receipt before recovery can continue.</p>}
    </ReportNotice>}
    {run.outputs.length > 0 && <section className="space-y-3"><h2 className="font-semibold">Generated files</h2><ScheduleArtifacts outputs={run.outputs} /></section>}
    {destinations.length > 0 && <section className="space-y-3"><h2 className="font-semibold">Email delivery</h2><p className="text-xs text-muted-foreground">“Accepted” means the email provider accepted the message; it does not confirm inbox delivery.</p><ul className="divide-y rounded-lg border">{destinations.map((result, i) => <li key={i} className="space-y-1 p-4 text-sm"><div className="flex flex-wrap justify-between gap-2"><span className="break-all font-medium">{result.destination.address}</span><span className="capitalize">{statusLabel(result.status)}</span></div>{(result.message || result.reason) && <p className="text-muted-foreground">{result.message || result.reason}</p>}{result.provider_reference && <p className="break-all text-xs text-muted-foreground">Receipt: {result.provider_reference}</p>}</li>)}</ul></section>}
    <section className="space-y-3"><h2 className="font-semibold">Execution steps</h2><ol className="divide-y rounded-lg border">{steps.map(item => <li key={String(item.step_index)} className="p-4 text-sm"><p><span className="font-medium capitalize">{statusLabel(item.kind)}</span> · {statusLabel(item.status)} · {Number(item.attempt_count)} attempt{Number(item.attempt_count) === 1 ? '' : 's'}</p>{item.last_attempt && <p className="mt-1 text-xs text-muted-foreground">Last attempt: {dateLabel(item.last_attempt.started_at)} · {statusLabel(item.last_attempt.effect_outcome)}{item.last_attempt.error && ` · ${item.last_attempt.error.message}`}</p>}<StepHistory client={client} runId={run.run_id} step={item} /></li>)}</ol></section>
    {loading && <p role="status">Loading run history…</p>}
    {historyError && <ReportNotice kind="error" title="Run history unavailable" action={<Button variant="outline" onClick={() => setGeneration(n => n + 1)}>Retry history</Button>}>{historyError}</ReportNotice>}
    {[steps.length, destinations.length, events.length].some(count => count >= limit) && <Button variant="outline" onClick={() => setLimit(n => n + 100)}>Load more run history</Button>}
    {recover.allowed_actions.includes('resolve') && <details className="rounded-lg border p-4 text-sm"><summary className="cursor-pointer font-medium">Resolve using a worker-verified receipt</summary><form className="mt-4 space-y-3" onSubmit={e => { e.preventDefault(); if (!selectedStep || loading || historyError || busy) return; onResolve([{ step_index: selectedStep.step_index, outcome, evidence_ref: evidence.trim() }], note.trim()); }}>
      <p className="text-muted-foreground">An operator must obtain an evidence reference recognized by this worker. The worker verifies it before recording this outcome; submitting a receipt does not send the email again.</p>
      <label className="block">Step<select className="mt-1 w-full rounded border bg-background p-2" value={selectedStep ? String(selectedStep.step_index) : ''} onChange={e => setStep(e.target.value)} required>{uncertain.map(item => <option key={String(item.step_index)} value={String(item.step_index)}>{statusLabel(item.kind)} ({String(item.step_index)})</option>)}</select></label>
      <label className="block">Verified outcome<select className="mt-1 w-full rounded border bg-background p-2" value={outcome} onChange={e => setOutcome(e.target.value as typeof outcome)}><option value="committed">Accepted / committed</option><option value="rolled_back">Not accepted / rolled back</option><option value="partial">Partially accepted</option></select></label>
      <label className="block">Evidence reference<input className="mt-1 w-full rounded border bg-background p-2" value={evidence} onChange={e => setEvidence(e.target.value)} required /></label>
      <label className="block">Audit note<textarea className="mt-1 w-full rounded border bg-background p-2" value={note} onChange={e => setNote(e.target.value)} required /></label><Button disabled={busy || loading || Boolean(historyError) || !selectedStep || !evidence.trim() || !note.trim()}>Verify and record outcome</Button>
    </form></details>}
    {events.length > 0 && <section className="space-y-3"><h2 className="font-semibold">Recovery history</h2><ul className="space-y-2 text-sm">{events.map((event, i) => <li className="rounded border p-3" key={i}><p>{dateLabel(event.occurred_at)} · {event.actor.display_name || event.actor.id} · {statusLabel(event.action)}</p><p className="text-muted-foreground">{event.note}</p></li>)}</ul></section>}
  </div>;
}

function StepHistory({ client, runId, step }: { client: ReportClient; runId: string; step: RunStep }) {
  const [open, setOpen] = useState(false), [attempts, setAttempts] = useState<StepAttempt[]>([]), [limit, setLimit] = useState(100), [error, setError] = useState('');
  const [generation, setGeneration] = useState(0);
  useEffect(() => {
    if (!open) return;
    const abort = new AbortController(); setAttempts([]); setError('');
    void client.call('schedules.list_step_attempts', { run_id: runId, step_index: step.step_index, limit: BigInt(limit) }, abort.signal)
      .then(rows => { if (!abort.signal.aborted) setAttempts(rows); }).catch(e => { if (!abort.signal.aborted) setError(reportError(e)); });
    return () => abort.abort();
  }, [client, runId, step.step_index, step.attempt_count, step.last_attempt?.finished_at, open, limit, generation]);
  return <details open={open} onToggle={event => setOpen(event.currentTarget.open)}><summary className="mt-2 cursor-pointer text-xs">Attempt history</summary>
    {attempts.map(attempt => <p key={String(attempt.attempt)} className="mt-1 text-xs text-muted-foreground">{dateLabel(attempt.started_at)} · {statusLabel(attempt.effect_outcome)}{attempt.error && ` · ${attempt.error.message}`}</p>)}
    {error && <p role="alert">{error} <button className="underline" onClick={() => setGeneration(n => n + 1)}>Retry attempts</button></p>}
    {attempts.length >= limit && <Button variant="outline" size="sm" onClick={() => setLimit(n => n + 100)}>Load more attempts</Button>}
  </details>;
}
