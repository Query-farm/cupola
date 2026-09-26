import type { ReportParameter } from '../reports/types';
import type { EvidenceParameter, ParameterValue, ParameterValues } from './reports';

/** One choice of a select or multi-select parameter. */
export interface ParameterOption { value: string | number; label: string }

/** A parameter's choices as the parameter bar sees them. */
export type ParameterOptionsState =
  | { status: 'static'; options: ParameterOption[] }
  | { status: 'loading'; options: ParameterOption[] }
  | { status: 'ready'; options: ParameterOption[]; truncated: boolean }
  | { status: 'error'; options: ParameterOption[]; error: string };

/** Choices past this are dropped, and the parameter bar says so. */
export const MAX_PARAMETER_OPTIONS = 1_000;

export function hasChoices(parameter: EvidenceParameter): boolean {
  return parameter.type === 'select' || parameter.type === 'multi_select';
}

export function isEmptyValue(value: ParameterValue | undefined): boolean {
  if (value === null || value === undefined || value === '') return true;
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === 'object') return !value.start && !value.end;
  return false;
}

/** The value a parameter starts from, before any reader choice. */
export function initialValue(parameter: EvidenceParameter): ParameterValue {
  if (parameter.defaultMode === 'all' || parameter.defaultMode === 'none') return parameter.type === 'multi_select' ? [] : null;
  return structuredClone(parameter.defaultValue);
}

/** Rows of an options query → choices: `value` / `label` columns by default, else the
 *  configured ones, else the first (and second) column. */
export function optionsFromRows(parameter: EvidenceParameter, rows: Record<string, unknown>[], columns: string[]): { options: ParameterOption[]; truncated: boolean } {
  const config = parameter.options?.kind === 'query' ? parameter.options : undefined;
  const valueColumn = config?.valueColumn || (columns.includes('value') ? 'value' : columns[0]);
  const labelColumn = config?.labelColumn || (columns.includes('label') ? 'label' : columns.length > 1 && valueColumn === columns[0] ? columns[1] : valueColumn);
  if (!valueColumn || !columns.includes(valueColumn)) throw new Error(`${parameter.label}: choices query has no "${valueColumn ?? 'value'}" column.`);
  if (!columns.includes(labelColumn)) throw new Error(`${parameter.label}: choices query has no "${labelColumn}" column.`);
  const seen = new Set<string>();
  const options: ParameterOption[] = [];
  for (const row of rows) {
    const raw = row[valueColumn];
    if (raw === null || raw === undefined) continue;
    const value = typeof raw === 'number' ? raw : typeof raw === 'bigint' ? Number(raw) : String(raw);
    const key = `${typeof value}:${value}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const label = row[labelColumn];
    options.push({ value, label: label === null || label === undefined ? String(value) : String(label) });
    if (options.length === MAX_PARAMETER_OPTIONS) return { options, truncated: rows.length > options.length };
  }
  return { options, truncated: false };
}

const same = (a: unknown, b: unknown) => String(a) === String(b);

/** Fit a value to a fresh set of choices. Returns the value to use and, when a reader-visible
 *  value had to change, a note explaining why. Values stay put while choices are unknown. */
export function reconcileValue(parameter: EvidenceParameter, value: ParameterValue, options: ParameterOption[] | undefined, labelOf: (value: unknown) => string = String): { value: ParameterValue; note?: string } {
  if (!hasChoices(parameter) || !options) return { value };
  const fallback = (): ParameterValue => {
    if (parameter.defaultMode === 'first') return parameter.type === 'multi_select' ? (options[0] ? [options[0].value] : []) : options[0]?.value ?? null;
    if (parameter.defaultMode === 'value') {
      const preset = parameter.defaultValue;
      if (parameter.type === 'multi_select') return Array.isArray(preset) ? preset.filter(item => options.some(option => same(option.value, item))) : [];
      if (preset !== null && options.some(option => same(option.value, preset))) return preset;
    }
    return parameter.type === 'multi_select' ? [] : null;
  };
  if (parameter.type === 'multi_select') {
    const list = Array.isArray(value) ? value : [];
    if (!list.length) return { value: parameter.defaultMode === 'first' && !parameter.allowAll ? fallback() : list };
    const kept = list.filter(item => options.some(option => same(option.value, item)));
    if (kept.length === list.length) return { value: kept.map(item => options.find(option => same(option.value, item))!.value) };
    const dropped = list.filter(item => !kept.includes(item)).map(labelOf);
    return { value: kept.length ? kept : fallback(), note: `${parameter.label}: ${dropped.join(', ')} ${dropped.length === 1 ? 'is' : 'are'} no longer a choice.` };
  }
  if (value === null || value === '') {
    // Unset: only "first" fills it in; an explicit All or None stays.
    return { value: parameter.defaultMode === 'first' && !parameter.allowAll ? fallback() : value };
  }
  const match = options.find(option => same(option.value, value));
  if (match) return { value: match.value };
  const next = fallback();
  const now = next === null ? (parameter.allowAll ? 'All' : 'not set') : labelOf(next);
  return { value: next, note: `${parameter.label} reset to ${now}: ${labelOf(value)} is no longer a choice.` };
}

/** How a value reads to a person: option labels, "All", ranges, lists. */
export function formatParameterValue(parameter: EvidenceParameter, value: ParameterValue | undefined, options?: ParameterOption[]): string {
  const label = (item: unknown) => options?.find(option => same(option.value, item))?.label ?? String(item);
  if (isEmptyValue(value)) return hasChoices(parameter) && parameter.allowAll ? 'All' : parameter.type === 'date_range' ? 'Any dates' : 'Not set';
  if (Array.isArray(value)) return value.map(label).join(', ');
  if (typeof value === 'object' && value !== null) {
    if (value.start && value.end) return `${value.start} – ${value.end}`;
    return value.start ? `From ${value.start}` : `Until ${value.end}`;
  }
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  return hasChoices(parameter) ? label(value) : String(value);
}

/** Resolve every parameter's value: saved reader values first, then the parameter's initial value. */
export function currentValues(parameters: EvidenceParameter[], values: ParameterValues): ParameterValues {
  return Object.fromEntries(parameters.map(parameter => [parameter.key, Object.hasOwn(values, parameter.key) ? values[parameter.key] : initialValue(parameter)]));
}

/** The SQL binder's view of Evidence parameters (it reads key, type and value only). */
export function toReportParameters(parameters: EvidenceParameter[], values: ParameterValues): ReportParameter[] {
  return parameters.map(({ options: _options, defaultMode: _mode, allowAll: _all, filterColumn: _column, ...parameter }) => ({
    ...parameter, defaultValue: Object.hasOwn(values, parameter.key) ? values[parameter.key] : parameter.defaultValue,
  }));
}
