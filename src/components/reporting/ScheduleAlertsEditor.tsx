import { useState } from 'react';
import { Bell } from 'lucide-react';
import { Button } from '../ui/button';
import { ScheduleSection, ScheduleField, scheduleInput } from './ScheduleFields';
import { ReportNotice } from './ReportNotice';
import { ReportClient, reportError } from '../../lib/reporting/client';
import { checkEmailRecipients } from '../../lib/reporting/schedules';
import type { ScheduleAlerts, SchedulerInfo } from '../../lib/reporting/contracts.generated';

export const alertEventLabels: Record<string, string> = {
  run_failed: 'Report generation or delivery fails',
  access_expiring: 'Scheduled access expires soon',
  access_expired: 'Scheduled access is missing or expired',
};

export function ScheduleAlertsEditor({ value, onChange, client, scheduler, emailEnabled, disabled }: {
  value: ScheduleAlerts | null; onChange: (value: ScheduleAlerts | null) => void; client: ReportClient;
  scheduler: SchedulerInfo; emailEnabled: boolean; disabled: boolean;
}) {
  const events = (scheduler.alert_events ?? []).filter(e => e in alertEventLabels);
  const [error, setError] = useState(''), [status, setStatus] = useState(''), [checking, setChecking] = useState(false);
  const [recipients, setRecipients] = useState(() => value?.destinations.map(d => d.address).join(', ') ?? '');
  const update = (next: ScheduleAlerts | null) => { setError(''); setStatus(''); onChange(next); };
  const destinations = (text: string) => text.split(/[,;\n]/).map(s => s.trim()).filter(Boolean).map(address => ({ kind: 'email', address }));
  const supported = emailEnabled && events.length > 0;
  return <ScheduleSection title="Failure alerts and access reminders" icon={Bell}>
    <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={Boolean(value)} disabled={disabled || !supported} onChange={e => update(e.target.checked ? { events, destinations: destinations(recipients) } : null)} />Email me when this schedule needs attention</label>
    <p className="text-sm text-muted-foreground">Choose alert recipients separately from the people who receive the report. The worker controls warning times and groups repeated failures until the issue is resolved.</p>
    {!supported && <p className="text-sm text-muted-foreground">This worker does not offer email alerts for schedules.</p>}
    {value && <>
      <ScheduleField label="Alert recipients" hint="Separate email addresses with commas, semicolons, or new lines."><textarea className={scheduleInput} value={recipients} disabled={disabled || checking} rows={2} onChange={e => { setRecipients(e.target.value); update({ ...value, destinations: destinations(e.target.value) }); }} /></ScheduleField>
      <div className="space-y-2">{events.map(event => <label key={event} className="flex items-center gap-2 text-sm"><input type="checkbox" disabled={disabled || checking} checked={value.events.includes(event)} onChange={e => update({ ...value, events: e.target.checked ? [...value.events, event] : value.events.filter(v => v !== event) })} />{alertEventLabels[event]}</label>)}</div>
      <Button type="button" variant="outline" disabled={disabled || checking} onClick={async () => { setChecking(true); setError(''); setStatus(''); try { const allowed = await checkEmailRecipients(client, recipients); setStatus(`${allowed.length} alert recipient${allowed.length === 1 ? '' : 's'} allowed. No email was sent.`); } catch (e) { setError(reportError(e)); } finally { setChecking(false); } }}>Check alert recipients</Button>
      {status && <p role="status" className="text-sm">{status}</p>}
      {error && <ReportNotice kind="error" title="Check alert recipients">{error}</ReportNotice>}
    </>}
  </ScheduleSection>;
}
