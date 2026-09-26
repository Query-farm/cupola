import { formatParameterValue, type ParameterOptionsState } from './parameters';
import type { EvidenceParameter, ParameterValues } from './reports';

export interface FilterLine { label: string; value: string }
export interface FilterSummary { filters: FilterLine[]; appendix: { label: string; values: string[] }[] }
/** An Evidence input's state, as EvidenceDocument.svelte reports it. */
export interface InputFilter { id: string; component: string; value: unknown; title?: string }

/** Past this many values a list moves to the PDF's appendix; the header names the first few. */
export const LONG_LIST = 8;
const SHOWN = 3;

const pad = (n: number) => String(n).padStart(2, '0');
const isoDate = (date: Date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
const humanize = (id: string) => { const text = id.replace(/[_-]+/g, ' ').trim(); return text.charAt(0).toUpperCase() + text.slice(1); };

function scalar(value: unknown): string {
  if (value instanceof Date) return isoDate(value);
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  return String(value);
}

/** An Evidence input's value in words. Values come in several shapes: scalars, lists,
 *  date ranges ({ start, end }) and per-dimension selections ({ dim: [values] }). */
export function describeInputValue(value: unknown): string | string[] {
  if (value === undefined || value === null || value === '') return 'All';
  if (Array.isArray(value)) return value.length ? value.map(scalar) : 'All';
  if (value instanceof Date || typeof value !== 'object') return scalar(value);
  const record = value as Record<string, unknown>;
  if ('start' in record || 'end' in record) {
    const start = record.start ? scalar(record.start) : '';
    const end = record.end ? scalar(record.end) : '';
    return start && end ? `${start} – ${end}` : start ? `From ${start}` : end ? `Until ${end}` : 'All';
  }
  const parts = Object.entries(record).filter(([, part]) => part !== undefined && part !== null && !(Array.isArray(part) && !part.length))
    .map(([key, part]) => `${humanize(key)}: ${Array.isArray(part) ? part.map(scalar).join(', ') : scalar(part)}`);
  return parts.length ? parts.join('; ') : 'All';
}

/** One line per list: short lists in full, long ones summarized with the rest in the appendix. */
function listLine(label: string, values: string[], summary: FilterSummary) {
  if (values.length <= LONG_LIST) { summary.filters.push({ label, value: values.join(', ') }); return; }
  summary.filters.push({ label, value: `${values.length} selected: ${values.slice(0, SHOWN).join(', ')}, … (all listed under Filter values)` });
  summary.appendix.push({ label, values });
}

/** What a PDF's Filters section lists: the drill path, every report parameter by its labels,
 *  and every Evidence input on the page that isn't a report parameter. */
export function summarizeFilters({ parameters, values, states = {}, inputs = [], drill }: {
  parameters: EvidenceParameter[]; values: ParameterValues;
  states?: Record<string, ParameterOptionsState>; inputs?: InputFilter[];
  /** The drill path's breadcrumb, when the report has one. */
  drill?: string;
}): FilterSummary {
  const summary: FilterSummary = { filters: [], appendix: [] };
  if (drill) summary.filters.push({ label: 'Drill path', value: drill });
  const keys = new Set(parameters.map(parameter => parameter.key));
  for (const parameter of parameters) {
    const value = values[parameter.key];
    const options = states[parameter.key]?.options ?? (parameter.options?.kind === 'static' ? parameter.options.values : undefined);
    if (parameter.type === 'multi_select' && Array.isArray(value) && value.length) {
      listLine(parameter.label, value.map(item => formatParameterValue(parameter, [item], options)), summary);
    } else summary.filters.push({ label: parameter.label, value: formatParameterValue(parameter, value, options) });
  }
  for (const input of inputs) {
    if (keys.has(input.id)) continue;
    const label = input.title || humanize(input.id);
    const described = describeInputValue(input.value);
    if (Array.isArray(described)) listLine(label, described, summary);
    else summary.filters.push({ label, value: described });
  }
  return summary;
}
