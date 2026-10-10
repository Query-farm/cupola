import { Children, cloneElement, isValidElement, useEffect, useId, useState, type ReactElement, type ReactNode } from 'react';
import { CalendarClock, Mail, Play, Save, ShieldCheck } from 'lucide-react';
import { Button } from '../ui/button';
import { ReportNotice } from './ReportNotice';
import { ReportClient, reportError, errorCode } from '../../lib/reporting/client';
import type { NotifyInfo, ParameterSpec, ParamValue, ReportResult, RevisionRow, Schedule, ScheduleRecord, SchedulerInfo, ScheduleTest, TriggerPreview } from '../../lib/reporting/contracts.generated';
import { cronFor, dateLabel, emailDestinations, HTML, newSchedule, PDF, triggerFields, validateSchedule, type Frequency } from '../../lib/reporting/schedules';
import { ScheduleArtifacts } from './ScheduleRunDetails';
import { parseJournal, serializeJournal } from '../../lib/reporting/journal';

export const scheduleInput = 'w-full rounded-md border bg-background px-3 py-2 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50';
export function ScheduleField({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  const id = useId();
  return <div className="space-y-1.5 text-sm"><label htmlFor={id} className="block font-medium">{label}</label>{Children.map(children, child => isValidElement(child) && ['input', 'select', 'textarea'].includes(String(child.type)) ? cloneElement(child as ReactElement<{ id?: string; 'aria-describedby'?: string }>, { id, 'aria-describedby': hint ? `${id}-hint` : undefined }) : child)}{hint && <p id={`${id}-hint`} className="text-xs text-muted-foreground">{hint}</p>}</div>;
}
export function ScheduleSection({ title, icon: Icon, children }: { title: string; icon?: typeof Mail; children: ReactNode }) {
  return <section className="rounded-lg border bg-card"><h2 className="flex items-center gap-2 border-b bg-muted/30 px-5 py-3 text-sm font-semibold">{Icon && <Icon className="size-4" />}{title}</h2><div className="space-y-4 p-5">{children}</div></section>;
}

export function ScheduleForm({ initial, draftKey, report, reportClient, client, scheduler, notify, pinned, busy, access, onSources, onSave, onReload }: {
  initial?: ScheduleRecord; draftKey: string; report: ReportResult; reportClient: ReportClient; client: ReportClient; scheduler: SchedulerInfo; notify: NotifyInfo | null; pinned: boolean;
  busy: boolean; access: ReactNode; onSources: (report: ReportResult) => void; onSave: (schedule: Schedule, version?: bigint) => Promise<void>; onReload: () => void;
}) {
  const htmlBody = Boolean(notify?.channels.some(c => c.kind === 'email' && c.enabled && c.html_body));
  const [restored] = useState<{ definition: Schedule; version?: bigint } | null>(() => { try { return parseJournal(sessionStorage.getItem(draftKey) ?? 'null'); } catch { return null; } });
  // Keep the version the editor opened. Polling must never bless a stale draft with a newer CAS version.
  const [baseVersion] = useState(restored?.version ?? initial?.version);
  const [draft, setDraft] = useState(() => structuredClone(restored?.definition ?? initial?.definition ?? newSchedule(report, reportClient.url, pinned, htmlBody)));
  const [email, setEmail] = useState(() => draft.deliveries.length > 0);
  const [recipients, setRecipients] = useState(() => draft.deliveries[0]?.destinations.map(d => d.address).join(', ') ?? '');
  const [inline, setInline] = useState(() => draft.deliveries[0]?.inline ?? (htmlBody ? 'report' : 'summary'));
  const [attachPdf, setAttachPdf] = useState(() => draft.deliveries[0]?.attach.includes(PDF) ?? true);
  const [attachHtml, setAttachHtml] = useState(() => draft.deliveries[0]?.attach.includes(HTML) ?? false);
  const [frequency, setFrequency] = useState<Frequency>(() => triggerFields(draft.trigger).frequency);
  const [time, setTime] = useState(() => triggerFields(draft.trigger).time), [day, setDay] = useState(() => triggerFields(draft.trigger).day);
  const [error, setError] = useState(''), [working, setWorking] = useState(false), [preview, setPreview] = useState<ScheduleTest | null>(null);
  const [times, setTimes] = useState<TriggerPreview | null>(null), [timingError, setTimingError] = useState('');
  const [revisions, setRevisions] = useState<RevisionRow[]>([]), [selectedReport, setSelectedReport] = useState(report), [versionLoading, setVersionLoading] = useState(true), [versionError, setVersionError] = useState('');
  const [destinations, setDestinations] = useState<string[]>([]), [recipientStatus, setRecipientStatus] = useState('');
  const [conflict, setConflict] = useState(false);
  const action = draft.action.render_report!;
  const restricted = draft.deliveries.length > 1 || draft.deliveries.some(d => d.destinations.some(x => x.kind !== 'email') || !['none', 'summary', 'report'].includes(d.inline));
  const disabled = busy || working || !scheduler.writable || Boolean(initial && !initial.allowed_actions.includes('update')) || restricted;
  const patch = (value: Partial<Schedule>) => { setDraft(old => ({ ...old, ...value })); setPreview(null); };
  useEffect(() => {
    // Survives fresh-login redirects in this tab. Only schedule settings; never grants or tickets.
    const definition = restricted ? draft : { ...draft, deliveries: email ? [{ destinations: recipients.split(/[,;\n]/).map(s => s.trim()).filter(Boolean).map(address => ({ kind: 'email', address })), inline, attach: [...(attachPdf ? [PDF] : []), ...(attachHtml ? [HTML] : [])] }] : [] };
    try { sessionStorage.setItem(draftKey, serializeJournal({ definition, version: baseVersion })); } catch { /* Existing mutation journal still refuses dispatch if durable recovery is unavailable. */ }
  }, [draft, email, recipients, inline, attachPdf, attachHtml, draftKey, baseVersion]);
  function changeTrigger(f: Frequency, t = time, d = day) {
    setFrequency(f); setTime(t); setDay(d);
    patch({ trigger: { ...draft.trigger, kind: f === 'once' ? 'once' : 'cron', run_at: f === 'once' ? draft.trigger.run_at : null,
      cron: f === 'once' ? null : f === 'custom' ? draft.trigger.cron ?? '0 9 * * *' : cronFor(f, t || '09:00', d) } });
  }
  useEffect(() => {
    const abort = new AbortController(); setTimes(null); setTimingError('');
    const timer = setTimeout(() => void client.call('schedules.preview_trigger', { trigger: draft.trigger, after: Date.now(), count: 5n }, abort.signal)
      .then(value => { if (!abort.signal.aborted) setTimes(value); }).catch(e => { if (!abort.signal.aborted) setTimingError(reportError(e)); }), 300);
    return () => { clearTimeout(timer); abort.abort(); };
  }, [client, JSON.stringify(draft.trigger)]);
  useEffect(() => {
    const abort = new AbortController();
    void reportClient.call('list_revisions', { report_id: report.report_id }, abort.signal).then(setRevisions).catch(e => { if (!abort.signal.aborted) setError(reportError(e)); });
    if (notify) void client.call('notify.list_destinations', { kind: 'email' }, abort.signal).then(rows => setDestinations(rows.map(r => r.address))).catch(() => { /* Suggestions are optional; checks are required. */ });
    return () => abort.abort();
  }, [client, reportClient, report.report_id, notify]);
  useEffect(() => {
    const abort = new AbortController(); setVersionLoading(true); setVersionError('');
    const id = action.track === 'pinned' ? action.report.revision_id : action.track === 'published' ? report.published_revision_id : null;
    if (action.track === 'published' && !id) { setVersionError('Publish a version of this report before scheduling its published version.'); setVersionLoading(false); return; }
    void reportClient.call('get_report', { report_id: report.report_id, revision_id: id }, abort.signal).then(value => {
      if (!abort.signal.aborted) { setSelectedReport(value); onSources(value); }
    }).catch(e => { if (!abort.signal.aborted) setVersionError(reportError(e)); }).finally(() => { if (!abort.signal.aborted) setVersionLoading(false); });
    return () => abort.abort();
  }, [reportClient, report.report_id, report.published_revision_id, action.track, action.report.revision_id]);
  async function definition() {
    if (versionLoading || versionError) throw new Error(versionError || 'Wait for the selected report version to load.');
    let next = structuredClone(draft);
    if (email) {
      if (!notify?.channels.some(c => c.kind === 'email' && c.enabled)) throw new Error('Email is not enabled on this scheduling worker.');
      if (inline === 'report' && !htmlBody) throw new Error('This worker does not support report content in email. Choose a summary.');
      const addresses = emailDestinations(recipients);
      const checks = await client.call('notify.check_destinations', { destinations: addresses });
      if (checks.results.length !== addresses.length || checks.results.some((r, i) => r.address !== addresses[i].address || r.kind !== 'email')) throw new Error('The worker returned an incomplete recipient check.');
      const refused = checks.results.filter(r => !r.allowed);
      if (refused.length) throw new Error(refused.map(r => `${r.address}: ${r.reason || 'not allowed by this worker'}`).join('\n'));
      next.deliveries = [{ destinations: addresses, inline, attach: [...(attachPdf ? [PDF] : []), ...(attachHtml ? [HTML] : [])] }];
      next.action.render_report!.outputs = [...new Set([...(inline === 'report' || attachHtml ? [HTML] : []), ...(attachPdf ? [PDF] : [])])];
      if (!next.action.render_report!.outputs.length) next.action.render_report!.outputs = [PDF];
      setRecipientStatus(`${addresses.length} recipient${addresses.length === 1 ? '' : 's'} allowed by the worker.`);
    } else next.deliveries = [];
    validateSchedule(next);
    // Validate timing on the authoritative worker before admitting a mutation.
    await client.call('schedules.preview_trigger', { trigger: next.trigger, after: Date.now(), count: 1n });
    return next;
  }
  async function perform(kind: 'save' | 'preview' | 'recipients') {
    setWorking(true); setError('');
    try {
      const next = await definition();
      if (kind === 'save') { await onSave(next, baseVersion); sessionStorage.removeItem(draftKey); }
      else if (kind === 'preview') setPreview(await client.call('schedules.test_run', { schedule: next, execution: initial ? { principal_id: initial.execution_identity.principal.id } : null, as_of: Date.now() }));
    } catch (e) { setError(reportError(e)); if (errorCode(e) === 'ABORTED') setConflict(true); } finally { setWorking(false); }
  }
  const parameterValues = new Map(draft.parameter_values.map(value => [value.key, value]));
  function parameter(key: string, value: ParamValue | null) { patch({ parameter_values: [...draft.parameter_values.filter(p => p.key !== key), ...(value ? [value] : [])] }); }
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const localInstant = draft.trigger.run_at == null ? '' : new Date(draft.trigger.run_at - new Date(draft.trigger.run_at).getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  return <form className="space-y-5" onSubmit={event => { event.preventDefault(); void perform('save'); }}>
    {restricted && <ReportNotice title="This schedule uses additional delivery settings" kind="permission">Its worker-defined deliveries are preserved. You can pause it or view its runs from the schedules list.</ReportNotice>}
    <fieldset disabled={disabled} className="space-y-5">
      <ScheduleSection title="When to run" icon={CalendarClock}>
        <ScheduleField label="Schedule name"><input className={scheduleInput} value={draft.title} onChange={e => patch({ title: e.target.value })} required /></ScheduleField>
        <div className="grid gap-4 sm:grid-cols-2"><ScheduleField label="Frequency"><select className={scheduleInput} value={frequency} onChange={e => changeTrigger(e.target.value as Frequency)}><option value="weekdays">Every weekday</option><option value="daily">Every day</option><option value="weekly">Every week</option><option value="once">Once</option><option value="custom">Custom cron</option></select></ScheduleField>
          <ScheduleField label="Time zone"><input className={scheduleInput} value={draft.trigger.time_zone} list="schedule-time-zones" onChange={e => patch({ trigger: { ...draft.trigger, time_zone: e.target.value } })} required /><datalist id="schedule-time-zones">{['UTC', zone, 'America/New_York', 'America/Chicago', 'America/Los_Angeles', 'Europe/London', 'Europe/Paris', 'Asia/Tokyo', 'Australia/Sydney'].filter((v, i, a) => a.indexOf(v) === i).map(value => <option key={value} value={value} />)}</datalist></ScheduleField>
          {frequency === 'once' ? <ScheduleField label={`Run at (${zone})`}><input className={scheduleInput} type="datetime-local" value={localInstant} onChange={e => patch({ trigger: { ...draft.trigger, run_at: e.target.value ? new Date(e.target.value).getTime() : null } })} required /></ScheduleField> : frequency === 'custom' ? <ScheduleField label="Cron expression" hint="Minute, hour, day of month, month, day of week. The worker validates this expression."><input className={scheduleInput} value={draft.trigger.cron ?? ''} onChange={e => patch({ trigger: { ...draft.trigger, cron: e.target.value } })} required /></ScheduleField> : <ScheduleField label="Time"><input className={scheduleInput} type="time" value={time} onChange={e => changeTrigger(frequency, e.target.value)} required /></ScheduleField>}
          {frequency === 'weekly' && <ScheduleField label="Day"><select className={scheduleInput} value={day} onChange={e => changeTrigger(frequency, time, e.target.value)}>{['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'].map((name, i) => <option key={i} value={i}>{name}</option>)}</select></ScheduleField>}
        </div>
        {times && <div className="rounded-md bg-muted/40 p-3 text-sm" aria-label="Upcoming runs"><p className="font-medium">Next runs · {draft.trigger.time_zone}</p><ul className="mt-1 space-y-1 text-muted-foreground">{times.fire_times.map(time => <li key={time}>{dateLabel(time, draft.trigger.time_zone)}</li>)}</ul>{!times.fire_times.length && <p>No upcoming runs within this trigger’s bounds.</p>}{times.warnings.map(w => <p key={w}>{w}</p>)}</div>}
        {timingError && <p className="text-sm text-destructive" role="alert">{timingError}</p>}
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={draft.enabled} onChange={e => patch({ enabled: e.target.checked })} />Enable automatic runs after saving</label>
        <p className="text-xs text-muted-foreground">Runs continue on the worker when Cupola is closed. New schedules start paused until you enable them.</p>
      </ScheduleSection>
      <ScheduleSection title="Report version">
        <div className="grid gap-4 sm:grid-cols-2"><ScheduleField label="Version to generate"><select className={scheduleInput} value={action.track} onChange={e => patch({ action: { ...draft.action, render_report: { ...action, track: e.target.value as typeof action.track, report: { ...action.report, revision_id: e.target.value === 'pinned' ? report.revision_served : null } } } })}><option value="published" disabled={!report.published_revision_id}>Latest published version</option><option value="head">Latest saved version</option><option value="pinned">Specific version</option></select></ScheduleField>
          {action.track === 'pinned' && <ScheduleField label="Specific version"><select className={scheduleInput} value={action.report.revision_id ?? ''} onChange={e => patch({ action: { ...draft.action, render_report: { ...action, report: { ...action.report, revision_id: e.target.value } } } })}>{revisions.filter(r => r.redacted_at == null).map(r => <option key={r.revision_id} value={r.revision_id}>Version {String(r.revision_number)} · {dateLabel(r.created_at)}</option>)}</select></ScheduleField>}
        </div><p className="text-xs text-muted-foreground">{action.track === 'head' ? 'New edits will be used automatically, including unpublished changes.' : action.track === 'published' ? 'Publishing a new version updates future runs.' : 'Future runs keep using this version, even after edits.'}</p>
        {versionError && <p role="alert" className="text-sm text-destructive">{versionError}</p>}
        {selectedReport.envelope?.parameters.map(spec => {
          const value = parameterValues.get(spec.key);
          return <div key={spec.key} className="grid items-end gap-3 sm:grid-cols-2"><ScheduleField label={spec.label || spec.key} hint={spec.required ? 'Required report parameter' : undefined}><select className={scheduleInput} value={value?.kind ?? 'default'} onChange={e => parameter(spec.key, e.target.value === 'default' ? null : e.target.value === 'relative' ? { key: spec.key, kind: 'relative', relative: scheduler.relative_tokens[0], json: null } : { key: spec.key, kind: 'literal', json: spec.default_json, relative: null })}><option value="default">Report default</option><option value="literal">Fixed value</option>{scheduler.relative_tokens.length > 0 && ['date', 'datetime', 'date_range'].includes(spec.type) && <option value="relative">Relative to each run</option>}</select></ScheduleField>
            {value?.kind === 'relative' ? <ScheduleField label={`${spec.label} period`}><select className={scheduleInput} value={value.relative ?? ''} onChange={e => parameter(spec.key, { ...value, relative: e.target.value })}>{scheduler.relative_tokens.map(token => <option key={token}>{token}</option>)}</select></ScheduleField> : value?.kind === 'literal' ? <ParameterInput spec={spec} json={value.json ?? 'null'} onChange={json => parameter(spec.key, { ...value, json })} /> : <p className="pb-2 text-sm text-muted-foreground">{spec.default_json}</p>}
          </div>;
        })}
      </ScheduleSection>
      <ScheduleSection title="Email delivery" icon={Mail}>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={email} disabled={!notify?.channels.some(c => c.kind === 'email' && c.enabled)} onChange={e => { setEmail(e.target.checked); setPreview(null); }} />Email this report</label>
        {!notify?.channels.some(c => c.kind === 'email' && c.enabled) && <p className="text-sm text-muted-foreground">Email delivery is not available on this worker. You can still schedule report generation.</p>}
        {email ? <>
          <ScheduleField label="Recipients" hint="Separate email addresses with commas or new lines."><textarea className={scheduleInput} value={recipients} rows={2} onChange={e => { setRecipients(e.target.value); setRecipientStatus(''); setPreview(null); }} /></ScheduleField>
          {destinations.length > 0 && <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground"><span>Suggested:</span>{destinations.slice(0, 8).map(address => <button type="button" key={address} className="rounded border px-2 py-1 hover:bg-muted" onClick={() => { setRecipients(old => old ? `${old}, ${address}` : address); setRecipientStatus(''); }}>{address}</button>)}</div>}
          <p className="text-xs text-muted-foreground">{notify?.destination_policy_summary}</p>
          <Button type="button" variant="outline" size="sm" onClick={() => void perform('recipients')}>Check recipients</Button>{recipientStatus && <p role="status" className="text-sm">{recipientStatus}</p>}
          <ScheduleField label="Email content"><select className={scheduleInput} value={inline} onChange={e => { setInline(e.target.value as typeof inline); setPreview(null); }}><option value="report" disabled={!htmlBody}>Full report in the email</option><option value="summary">Summary</option><option value="none">Attachments only</option></select></ScheduleField>
          <div className="flex flex-wrap gap-5 text-sm"><label className="flex items-center gap-2"><input type="checkbox" checked={attachPdf} onChange={e => { setAttachPdf(e.target.checked); setPreview(null); }} />Attach PDF</label><label className="flex items-center gap-2"><input type="checkbox" checked={attachHtml} onChange={e => { setAttachHtml(e.target.checked); setPreview(null); }} />Attach HTML</label></div>
        </> : <ScheduleField label="Generated format"><select className={scheduleInput} value={action.outputs.includes(PDF) && action.outputs.includes(HTML) ? 'both' : action.outputs[0]} onChange={e => patch({ action: { ...draft.action, render_report: { ...action, outputs: e.target.value === 'both' ? [PDF, HTML] : [e.target.value] } } })}><option value={PDF}>PDF</option><option value={HTML}>HTML</option><option value="both">PDF and HTML</option></select></ScheduleField>}
      </ScheduleSection>
      <details className="rounded-lg border p-4 text-sm"><summary className="cursor-pointer font-medium">Advanced settings</summary><div className="mt-4"><ScheduleField label="Only run when this SQL returns true" hint="Optional read-only condition, evaluated with the report’s data sources and parameters."><textarea className={`${scheduleInput} font-mono`} value={draft.condition_sql} onChange={e => patch({ condition_sql: e.target.value })} rows={3} /></ScheduleField></div></details>
    </fieldset>
    <ScheduleSection title="Scheduled access" icon={ShieldCheck}>{access}</ScheduleSection>
    {error && <ReportNotice kind="error" title="Schedule needs attention" action={conflict ? <Button type="button" variant="outline" onClick={() => { sessionStorage.removeItem(draftKey); onReload(); }}>Discard draft and load current schedule</Button> : undefined}>{error}</ReportNotice>}
    {preview && <ScheduleSection title="Preview result"><p className="text-sm">Generated {dateLabel(preview.evaluated_at)}. No email was sent.</p>{preview.condition_evaluated && <p className="text-sm">Condition: {preview.condition_value ? 'passed' : 'not met — automatic runs would be skipped'}</p>}<ScheduleArtifacts outputs={preview.outputs} />{preview.messages.map((message, i) => <div key={i} className="rounded border p-3 text-sm"><p className="font-medium">{message.title}</p><p>{message.summary}</p>{message.body_html && <p>Includes the full report in the email body.</p>}<p>{message.attachments.map(a => a.filename).join(', ')}</p></div>)}</ScheduleSection>}
    <div className="flex flex-wrap items-center gap-3 border-t pt-4"><Button type="submit" disabled={disabled || versionLoading || Boolean(versionError)}><Save />{working ? 'Working…' : initial ? 'Save changes' : 'Create schedule'}</Button><Button type="button" variant="outline" disabled={disabled || versionLoading || Boolean(versionError)} onClick={() => void perform('preview')}><Play />Preview without sending</Button><span className="text-xs text-muted-foreground">{working ? 'Waiting for the worker…' : 'Recipient permissions are checked again when the worker sends.'}</span></div>
  </form>;
}

function ParameterInput({ spec, json, onChange }: { spec: ParameterSpec; json: string; onChange: (json: string) => void }) {
  let value: any = null; try { value = JSON.parse(json); } catch { /* Preserve malformed imported values until edited. */ }
  const label = `${spec.label || spec.key} value`;
  if (spec.type === 'select') return <ScheduleField label={label}><select className={scheduleInput} value={json} onChange={e => onChange(e.target.value)}><option value="null">Choose a value</option>{spec.options.map(option => <option key={option.value_json} value={option.value_json}>{option.label}</option>)}</select></ScheduleField>;
  if (spec.type === 'multi_select') return <ScheduleField label={label} hint="Select one or more values."><select multiple className={scheduleInput} value={(Array.isArray(value) ? value : []).map(v => JSON.stringify(v))} onChange={e => onChange(JSON.stringify([...e.target.selectedOptions].map(option => JSON.parse(option.value))))}>{spec.options.map(option => <option key={option.value_json} value={option.value_json}>{option.label}</option>)}</select></ScheduleField>;
  if (spec.type === 'boolean') return <ScheduleField label={label}><select className={scheduleInput} value={json} onChange={e => onChange(e.target.value)}><option value="null">No value</option><option value="true">Yes</option><option value="false">No</option></select></ScheduleField>;
  if (spec.type === 'date_range') return <div className="grid grid-cols-2 gap-2"><ScheduleField label={`${spec.label} start`}><input className={scheduleInput} type="date" value={value?.start ?? ''} onChange={e => onChange(JSON.stringify({ start: e.target.value, end: value?.end ?? '' }))} /></ScheduleField><ScheduleField label={`${spec.label} end (exclusive)`}><input className={scheduleInput} type="date" value={value?.end ?? ''} onChange={e => onChange(JSON.stringify({ start: value?.start ?? '', end: e.target.value }))} /></ScheduleField></div>;
  return <ScheduleField label={label}><input className={scheduleInput} type={spec.type === 'number' ? 'number' : spec.type === 'date' ? 'date' : 'text'} step={spec.type === 'number' ? 'any' : undefined} value={value ?? ''} onChange={e => onChange(JSON.stringify(spec.type === 'number' ? e.target.value === '' ? null : Number(e.target.value) : e.target.value))} /></ScheduleField>;
}
