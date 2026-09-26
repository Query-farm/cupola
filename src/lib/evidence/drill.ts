import { formatParameterValue, hasChoices, isEmptyValue, type ParameterOption, type ParameterOptionsState } from './parameters';
import type { EvidenceDrillPath, EvidenceParameter, ParameterValue, ParameterValues } from './reports';

/** One step of a drill path's breadcrumb. `depth` is how many levels stay set when it is chosen. */
export interface DrillCrumb { label: string; depth: number }
export interface DrillState {
  path: EvidenceDrillPath;
  crumbs: DrillCrumb[];
  /** The level a click sets next, or null once every level is set. */
  next: EvidenceParameter | null;
}

/** Where a drill path stands: the levels set so far (from the top, without gaps) and the next one. */
export function drillState(path: EvidenceDrillPath, parameters: EvidenceParameter[], values: ParameterValues, states: Record<string, ParameterOptionsState> = {}): DrillState {
  const levels = path.levels.map(key => parameters.find(parameter => parameter.key === key)).filter((p): p is EvidenceParameter => Boolean(p));
  const crumbs: DrillCrumb[] = [{ label: path.label || 'All', depth: 0 }];
  let depth = 0;
  while (depth < levels.length && !isEmptyValue(values[levels[depth].key])) {
    const level = levels[depth];
    crumbs.push({ label: formatParameterValue(level, values[level.key], optionsOf(level, states)), depth: depth + 1 });
    depth++;
  }
  return { path, crumbs, next: levels[depth] ?? null };
}

function optionsOf(parameter: EvidenceParameter, states: Record<string, ParameterOptionsState>): ParameterOption[] | undefined {
  return states[parameter.key]?.options ?? (parameter.options?.kind === 'static' ? parameter.options.values : undefined);
}

/** The value a clicked category or cell names at a level: a choice matched by label, then by
 *  value. A level without choices takes the text itself (a text parameter). */
export function matchDrillValue(level: EvidenceParameter, text: string, states: Record<string, ParameterOptionsState> = {}): ParameterValue | undefined {
  const needle = text.trim();
  if (!needle) return undefined;
  if (!hasChoices(level)) return level.type === 'text' ? needle : undefined;
  const options = optionsOf(level, states);
  const match = options?.find(option => option.label === needle) ?? options?.find(option => String(option.value) === needle);
  if (!match) return undefined;
  return level.type === 'multi_select' ? [match.value] : match.value;
}

/** Values after drilling to `depth` levels: the levels below it are cleared. `value`, when
 *  given, sets the level at `depth` (a drill down); without it, it's a step back up. */
export function drillValues(path: EvidenceDrillPath, parameters: EvidenceParameter[], values: ParameterValues, depth: number, value?: ParameterValue): ParameterValues {
  const next = { ...values };
  path.levels.forEach((key, index) => {
    const parameter = parameters.find(p => p.key === key);
    if (!parameter) return;
    if (value !== undefined && index === depth) next[key] = value;
    else if (index >= depth) next[key] = parameter.type === 'multi_select' ? [] : null;
  });
  return next;
}

/** The part of an ECharts instance drilling uses. */
export interface DrillChart { on: (event: 'click', handler: (params: { name?: unknown }) => void) => void; isDisposed: () => boolean }

const STYLE = `
[data-cupola-drill] { cursor: pointer; text-decoration: underline dotted; text-underline-offset: 3px; }
[data-cupola-drill]:hover { color: var(--primary, currentColor); }
[data-cupola-drill]:focus-visible { outline: 2px solid var(--ring, currentColor); outline-offset: 1px; border-radius: 2px; }
`;

/** Wire click-to-drill into a rendered report. Chart clicks and marked table cells call
 *  `onDrill` with the text they carry when `match` accepts it. Returns `rescan` (call when the
 *  matcher's choices change) and `dispose`. */
export function attachDrill(root: ShadowRoot, { match, onDrill, getInstance }: {
  match: (text: string) => boolean;
  onDrill: (text: string) => void;
  /** echarts.getInstanceByDom, injected so this module stays free of the charting bundle. */
  getInstance: (element: HTMLElement) => DrillChart | undefined;
}): { rescan: () => void; dispose: () => void } {
  const style = document.createElement('style');
  style.textContent = STYLE;
  root.append(style);
  const wired = new WeakSet<object>();
  const scan = () => {
    for (const element of root.querySelectorAll<HTMLElement>('[_echarts_instance_]')) {
      const chart = getInstance(element);
      if (!chart || chart.isDisposed() || wired.has(chart)) continue;
      wired.add(chart);
      chart.on('click', params => { const name = params.name == null ? '' : String(params.name); if (match(name)) onDrill(name); });
    }
    for (const cell of root.querySelectorAll<HTMLElement>('[data-render="table"] tbody td')) {
      const text = cell.textContent?.trim() ?? '';
      if (text && match(text)) {
        if (!cell.hasAttribute('data-cupola-drill')) {
          cell.setAttribute('data-cupola-drill', '');
          cell.setAttribute('role', 'button');
          cell.tabIndex = 0;
          cell.setAttribute('aria-label', `Drill into ${text}`);
        }
      } else if (cell.hasAttribute('data-cupola-drill')) {
        cell.removeAttribute('data-cupola-drill'); cell.removeAttribute('role'); cell.removeAttribute('tabindex'); cell.removeAttribute('aria-label');
      }
    }
  };
  let frame = 0;
  const schedule = () => { if (!frame) frame = requestAnimationFrame(() => { frame = 0; scan(); }); };
  const observer = new MutationObserver(schedule);
  observer.observe(root, { childList: true, subtree: true, characterData: true });
  const activate = (event: Event) => {
    const cell = (event.target as Element | null)?.closest?.('[data-cupola-drill]');
    if (!cell) return;
    if (event instanceof KeyboardEvent && event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    event.stopPropagation();
    onDrill(cell.textContent?.trim() ?? '');
  };
  root.addEventListener('click', activate, true);
  root.addEventListener('keydown', activate, true);
  schedule();
  return {
    rescan: schedule,
    dispose: () => { observer.disconnect(); cancelAnimationFrame(frame); root.removeEventListener('click', activate, true); root.removeEventListener('keydown', activate, true); style.remove(); },
  };
}
