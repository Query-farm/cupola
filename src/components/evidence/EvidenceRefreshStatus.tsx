import { useEffect, useState, type ReactNode } from 'react';
import { ChevronDown, ChevronUp, LoaderCircle, Square, TriangleAlert, X } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import type { RefreshPhase, RefreshProfile } from '../../lib/evidence/refresh-profile';
import { EvidenceRefreshProgress, friendlyTime, PHASES } from './EvidenceRefreshProgress';

/** A refresh waits this long before the bottom chip offers its progress and Stop. */
export const CHIP_DELAY_MS = 2_000;

/** Where a running refresh is, in one line: the phase, the step within it, and how far along. */
export function refreshSummary(profile: RefreshProfile | null, phases: RefreshPhase[]) {
  if (!profile || !phases.length) return { phase: '', step: '', fraction: 0.08 };
  const open = profile.open ?? [];
  const running = open.at(-1)?.phase;
  const done = phases.filter(phase => phase !== running && profile.phases.some(span => span.phase === phase)).length;
  const step = profile.running?.phase === running && profile.running?.total !== undefined && profile.running.total > 1 ? `step ${profile.running.index} of ${profile.running.total}` : '';
  return { phase: running ? PHASES[running] : '', step, fraction: Math.max(0.08, Math.min(0.96, (done + (running ? 0.5 : 0)) / phases.length)) };
}

/** Re-renders every 250ms while `active`, for elapsed times. */
export function useTicking(active: boolean) {
  const [, tick] = useState(0);
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => tick(n => n + 1), 250);
    return () => clearInterval(timer);
  }, [active]);
}

function Checklist({ profile, phases }: { profile: RefreshProfile | null; phases: RefreshPhase[] }) {
  return <EvidenceRefreshProgress profile={profile} phases={phases} fallback="Updating the report…" className="w-80 max-w-[calc(100vw-2rem)] p-4" />;
}

/** The header's refresh status while one runs: the verb, phase and elapsed time; opens the checklist. */
export function RefreshStatusPill({ verb, profile, phases }: { verb: string; profile: RefreshProfile | null; phases: RefreshPhase[] }) {
  useTicking(true);
  const summary = refreshSummary(profile, phases);
  const elapsed = profile ? performance.now() - profile.startedAt : 0;
  return <Popover>
    <PopoverTrigger render={<button type="button" aria-label="Refresh progress details" className="inline-flex max-w-full items-center gap-1.5 rounded-full border bg-background px-2 py-0.5 text-foreground hover:bg-muted" />}>
      <LoaderCircle aria-hidden className="size-3 shrink-0 animate-spin text-primary" />
      <span className="truncate">{verb}{summary.phase && <span className="text-muted-foreground"> · {summary.phase}{summary.step && ` · ${summary.step}`}</span>}</span>
      <span className="tabular-nums text-muted-foreground">{friendlyTime(elapsed)}</span>
      <ChevronDown aria-hidden className="size-3 shrink-0 text-muted-foreground" />
    </PopoverTrigger>
    <PopoverContent align="start" className="p-0"><Checklist profile={profile} phases={phases} /></PopoverContent>
  </Popover>;
}

/** A 2px bar along the top of the report pane (outside its scroller), so it shows wherever the
 *  report is scrolled. Place it in a positioned container. */
export function RefreshTopBar({ active, fraction }: { active: boolean; fraction: number }) {
  return <div aria-hidden data-testid="report-refresh-bar" className={`pointer-events-none absolute inset-x-0 top-0 z-20 h-0.5 overflow-hidden transition-opacity duration-300 ${active ? 'opacity-100' : 'opacity-0 delay-200'}`}>
    <div className="h-full bg-primary transition-[width] duration-500 ease-out" style={{ width: `${(active ? fraction : 1) * 100}%` }} />
  </div>;
}

export interface RefreshAlert { tone: 'error' | 'stopped'; text: string; actions: { label: string; onClick: () => void }[] }

/** Floats at the bottom of the report pane (place it in a positioned container) while a refresh runs long, so it is seen at any scroll
 *  depth; after a failure or Stop it carries that news when the report's own notice is out of view. */
export function RefreshChip({ visible, profile, phases, onStop, alert, onDismiss }: { visible: boolean; profile: RefreshProfile | null; phases: RefreshPhase[]; onStop: () => void; alert: RefreshAlert | null; onDismiss: () => void }) {
  useTicking(visible && !alert);
  const shown = visible || Boolean(alert);
  const summary = refreshSummary(profile, phases);
  const elapsed = profile ? performance.now() - profile.startedAt : 0;
  let body: ReactNode = null;
  if (alert) body = <div role={alert.tone === 'error' ? 'alert' : 'status'} className={`flex items-center gap-2 rounded-full border bg-popover py-1 pr-1 pl-3 text-xs shadow-lg ${alert.tone === 'error' ? 'border-destructive/40' : ''}`}>
    {alert.tone === 'error' ? <TriangleAlert aria-hidden className="size-3.5 shrink-0 text-destructive" /> : <Square aria-hidden className="size-3 shrink-0 text-muted-foreground" />}
    <span className="truncate">{alert.text}</span>
    {alert.actions.map(action => <button key={action.label} type="button" className="shrink-0 rounded-full px-2 py-1 font-medium hover:bg-muted" onClick={action.onClick}>{action.label}</button>)}
    <button type="button" aria-label="Dismiss" className="shrink-0 rounded-full p-1 text-muted-foreground hover:bg-muted" onClick={onDismiss}><X className="size-3.5" /></button>
  </div>;
  else if (visible) body = <div className="flex items-center rounded-full border bg-popover text-xs shadow-lg">
    <Popover>
      <PopoverTrigger render={<button type="button" aria-label="Refresh progress details" className="flex min-w-0 items-center gap-2 rounded-l-full py-1.5 pr-2 pl-3 hover:bg-muted" />}>
        <LoaderCircle aria-hidden className="size-3.5 shrink-0 animate-spin text-primary" />
        <span className="font-medium">Updating…</span>
        <span className="tabular-nums text-muted-foreground">{friendlyTime(elapsed)}</span>
        {summary.phase && <span className="hidden truncate text-muted-foreground sm:inline">· {summary.phase}{summary.step && ` · ${summary.step}`}</span>}
        <ChevronUp aria-hidden className="size-3 shrink-0 text-muted-foreground" />
      </PopoverTrigger>
      <PopoverContent side="top" align="center" sideOffset={10} className="p-0"><Checklist profile={profile} phases={phases} /></PopoverContent>
    </Popover>
    <span aria-hidden className="h-4 w-px bg-border" />
    <button type="button" className="flex shrink-0 items-center gap-1 rounded-r-full py-1.5 pr-3 pl-2 font-medium hover:bg-muted" onClick={onStop}><Square className="size-3" />Stop</button>
  </div>;
  return <div data-testid="report-refresh-chip" className={`pointer-events-none absolute inset-x-0 bottom-4 z-20 flex justify-center px-4 transition-all duration-200 ${shown ? 'translate-y-0 opacity-100' : 'translate-y-2 opacity-0'}`}>
    <div className={`min-w-0 max-w-full ${shown ? 'pointer-events-auto' : ''}`}>{body}</div>
  </div>;
}

