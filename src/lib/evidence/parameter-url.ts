import { initialValue } from './parameters';
import type { EvidenceParameter, ParameterValue, ParameterValues } from './reports';

/** Report parameters live in the query string as `p.<key>`: the prefix keeps them apart from
 *  Evidence's own input params (`?category=`) and Cupola's (`service`, `evidence_report`). */
export const PARAMETER_URL_PREFIX = 'p.';

/** A value as it reads in a URL: plain text where possible, `a..b` for date ranges, a JSON
 *  list for multi-select, and empty for All / unset. */
export function serializeParameterValue(parameter: EvidenceParameter, value: ParameterValue): string {
  if (value === null || value === undefined) return '';
  if (parameter.type === 'multi_select') return Array.isArray(value) && value.length ? JSON.stringify(value) : '';
  if (parameter.type === 'date_range') {
    const range = value && typeof value === 'object' && !Array.isArray(value) ? value : { start: null, end: null };
    return range.start || range.end ? `${range.start ?? ''}..${range.end ?? ''}` : '';
  }
  return String(value);
}

/** Parse a URL value for a parameter; `undefined` when it isn't a valid value of that type. */
export function parseParameterValue(parameter: EvidenceParameter, raw: string): ParameterValue | undefined {
  switch (parameter.type) {
    case 'number': {
      if (raw === '') return null;
      const value = Number(raw);
      return Number.isFinite(value) ? value : undefined;
    }
    case 'boolean': return raw === 'true' ? true : raw === 'false' ? false : raw === '' ? null : undefined;
    case 'select': return raw === '' ? null : raw;
    case 'multi_select': {
      if (raw === '') return [];
      try {
        const list = JSON.parse(raw);
        return Array.isArray(list) && list.every(item => typeof item === 'string' || typeof item === 'number') ? list : undefined;
      } catch { return [raw]; }
    }
    case 'date_range': {
      if (raw === '') return { start: null, end: null };
      const [start, end, ...rest] = raw.split('..');
      if (rest.length || end === undefined) return undefined;
      return { start: start || null, end: end || null };
    }
    default: return raw;
  }
}

/** Parameter values a URL carries. Keys it doesn't name are absent, not defaulted. */
export function valuesFromUrl(parameters: EvidenceParameter[], search: URLSearchParams): ParameterValues {
  const values: ParameterValues = {};
  for (const parameter of parameters) {
    const raw = search.get(PARAMETER_URL_PREFIX + parameter.key);
    if (raw === null) continue;
    const value = parseParameterValue(parameter, raw);
    if (value !== undefined) values[parameter.key] = value;
  }
  return values;
}

/** The URL with exactly these parameter values: those differing from a parameter's initial
 *  value are written, every other `p.` param is removed. */
export function withParameterValues(url: URL, parameters: EvidenceParameter[], values: ParameterValues): URL {
  const next = new URL(url);
  for (const key of [...next.searchParams.keys()]) if (key.startsWith(PARAMETER_URL_PREFIX)) next.searchParams.delete(key);
  for (const parameter of parameters) {
    if (!Object.hasOwn(values, parameter.key)) continue;
    const value = values[parameter.key];
    if (JSON.stringify(value) === JSON.stringify(initialValue(parameter))) continue;
    next.searchParams.set(PARAMETER_URL_PREFIX + parameter.key, serializeParameterValue(parameter, value));
  }
  return next;
}

/** Every parameter's value for a URL: what it names, else the parameter's initial value. */
export function completeValuesFromUrl(parameters: EvidenceParameter[], search: URLSearchParams): ParameterValues {
  const named = valuesFromUrl(parameters, search);
  return Object.fromEntries(parameters.map(parameter => [parameter.key, Object.hasOwn(named, parameter.key) ? named[parameter.key] : initialValue(parameter)]));
}
