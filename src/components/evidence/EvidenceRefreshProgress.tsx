import { useEffect, useState } from 'react';
import { Check, Circle, LoaderCircle, X } from 'lucide-react';
import type { ProfiledQuery, RefreshPhase, RefreshProfile, RunningStep } from '../../lib/evidence/refresh-profile';

/** Finished steps listed under the running phase; a long setup script shows its latest ones. */
const RECENT_STEPS = 4;

/** Readers of a report aren't necessarily its authors: the list speaks in what is happening,
 *  not in SQL. The Performance tab keeps the technical view. */
const PHASES: Record<RefreshPhase, string> = {
  engine: 'Starting up', choices: 'Loading filter options', setup: 'Preparing the data', semantic: 'Building datasets', render: 'Drawing the report',
};
const humanize = (name: string) => name.split('.').at(-1)!.replace(/^"|"$/g, '').replace(/[_-]+/g, ' ').trim();
/** A step as a reader would name it: the table being prepared, the filter being filled in. */
export function stepLabel(step: Pick<ProfiledQuery, 'phase' | 'name'>): string {
  const name = step.name ?? '';
  if (step.phase === 'choices') return name ? `Options for ${name}` : 'Filter options';
  if (step.phase === 'setup') {
    const target = name.replace(/^Dataset SQL · /, '');
    const numbered = /^statement (\d+)$/.exec(target);
    return numbered ? `Step ${numbered[1]}` : target ? `Preparing ${humanize(target)}` : 'Preparing data';
  }
  if (step.phase === 'semantic') return name ? `Building ${humanize(name)}` : 'Building a dataset';
  return 'Working';
}
/** Rounded, because tenths of a second mean nothing to a reader waiting on a report. */
export function friendlyTime(ms: number): string {
  if (ms < 1_000) return 'under a second';
  const seconds = Math.round(ms / 1_000);
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}
/** One line per label: a semantic dataset is compiled, then built, under one name. */
function mergeSteps(steps: ProfiledQuery[], current: RunningStep | null) {
  const merged = new Map<string, { label: string; ms: number; error: boolean }>();
  for (const step of steps) {
    const label = stepLabel(step);
    const entry = merged.get(label) ?? { label, ms: 0, error: false };
    entry.ms += step.cached ? 0 : step.durationMs; entry.error ||= Boolean(step.error);
    merged.delete(label); merged.set(label, entry);
  }
  if (current) merged.delete(stepLabel(current));
  return [...merged.values()];
}

/** What a refresh is doing before the report can draw: each phase it will pass through, and
 *  within the running one, the statement in flight. Read from the same profile as the
 *  Performance tab, and replaced by the report itself once rendering starts. */
export function EvidenceRefreshProgress({ profile, phases, fallback }: { profile: RefreshProfile | null; phases: RefreshPhase[]; fallback: string }) {
  const [, tick] = useState(0);
  const running = Boolean(profile && profile.finishedAt === undefined);
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => tick(n => n + 1), 250);
    return () => clearInterval(timer);
  }, [running]);
  if (!profile) return <p className="py-8 text-sm text-muted-foreground" role="status">{fallback}</p>;
  const now = profile.finishedAt ?? performance.now();
  const open = new Map((profile.open ?? []).map(item => [item.phase, item.start]));
  const done = new Map<RefreshPhase, number>();
  for (const span of profile.phases) done.set(span.phase, (done.get(span.phase) ?? 0) + span.end - span.start);

  return <div className="max-w-md space-y-3 py-8 text-sm" role="status" aria-label="Refresh progress">
    <p className="font-medium">Updating the report… <span className="tabular-nums font-normal text-muted-foreground">{friendlyTime(now - profile.startedAt)}</span></p>
    <ol className="space-y-2">
      {phases.map(phase => {
        const started = open.get(phase);
        const state = started !== undefined ? 'running' : done.has(phase) ? 'done' : 'pending';
        const current = state === 'running' && profile.running?.phase === phase ? profile.running : null;
        const steps = mergeSteps(profile.queries.filter(query => query.phase === phase), current);
        const failed = steps.some(step => step.error);
        return <li key={phase} data-phase={phase} data-state={state} className="space-y-1">
          <div className={`flex items-center gap-2 ${state === 'pending' ? 'text-muted-foreground' : ''}`}>
            {state === 'running' ? <LoaderCircle aria-hidden className="size-4 animate-spin text-primary" />
              : state === 'done' ? (failed ? <X aria-hidden className="size-4 text-destructive" /> : <Check aria-hidden className="size-4 text-primary" />)
              : <Circle aria-hidden className="size-4 opacity-40" />}
            <span>{PHASES[phase]}</span>
            {current?.total !== undefined && current.total > 1 && <span className="text-xs text-muted-foreground">step {current.index} of {current.total}</span>}
            <span className="ml-auto text-xs tabular-nums text-muted-foreground">
              {state === 'running' ? friendlyTime(now - started!) : state === 'done' ? friendlyTime(done.get(phase)!) : ''}
            </span>
          </div>
          {state === 'running' && (steps.length > 0 || current) && <ul className="ml-6 space-y-1 text-xs" aria-label={`${PHASES[phase]} steps`}>
            {steps.length > RECENT_STEPS && <li className="text-muted-foreground">{steps.length - RECENT_STEPS} earlier {steps.length - RECENT_STEPS === 1 ? 'step' : 'steps'} done</li>}
            {steps.slice(-RECENT_STEPS).map(step => <li key={step.label} className="flex items-center gap-2 text-muted-foreground">
              {step.error ? <X aria-hidden className="size-3 text-destructive" /> : <Check aria-hidden className="size-3" />}
              <span className="truncate">{step.label}</span>
              <span className="ml-auto tabular-nums">{friendlyTime(step.ms)}</span>
            </li>)}
            {current && <li className="flex items-center gap-2" aria-current="step">
              <LoaderCircle aria-hidden className="size-3 animate-spin" />
              <span className="truncate font-medium">{stepLabel(current)}</span>
              <span className="ml-auto tabular-nums text-muted-foreground">{friendlyTime(now - current.startedAt)}</span>
            </li>}
          </ul>}
        </li>;
      })}
    </ol>
  </div>;
}
