import { engine, waitForEngineReady } from '../shell-bridge';
import { decodeArrowBuffer } from '../duckdb-query';
import { compileReportQuery, materializeReportQuery } from '../reports/parameters';
import { evidenceResult } from './haybarn-query-service';
import { REPORT_QUERY_TIMEOUT_MS } from './query-run';
import { parameterOrder } from './parameter-graph';
import { currentValues, formatParameterValue, hasChoices, optionsFromRows, reconcileValue, type ParameterOption, type ParameterOptionsState } from './parameters';
import { toReportParameters, validateEvidenceReport, type EvidenceParameter, type EvidenceReport, type ParameterValues } from './reports';

type Loaded = { options: ParameterOption[]; truncated: boolean };
export interface ChoicesLoad { parameter: EvidenceParameter; sql: string; rows?: number; startedAt: number; durationMs: number; error: string | null; cached: boolean }

/** Runs choices queries on the shared engine, cached by the SQL and the values bound into it,
 *  so a parent change re-runs only the queries that read it. Failed loads are not cached. */
export class ParameterChoicesLoader {
  private cache = new Map<string, Promise<Loaded>>();
  /** Loads that have finished: joining one still in flight is a real wait, not a cache hit. */
  private settled = new Set<string>();

  /** `observe` hears each load: its SQL, how long it took, and whether the cache answered. */
  load(parameter: EvidenceParameter, parameters: EvidenceParameter[], values: ParameterValues, signal?: AbortSignal, observe?: (load: ChoicesLoad) => void): Promise<Loaded> {
    if (parameter.options?.kind !== 'query') throw new Error(`${parameter.label} has no choices query.`);
    const compiled = compileReportQuery(parameter.options.sql, { parameters: toReportParameters(parameters, values) }, values);
    const key = JSON.stringify([parameter.key, parameter.options, compiled.sql, compiled.params]);
    let pending = this.cache.get(key);
    const cached = this.settled.has(key);
    if (!pending) {
      pending = this.run(parameter, compiled.sql, compiled.params, signal);
      this.cache.set(key, pending);
      pending.then(() => this.settled.add(key), () => { if (this.cache.get(key) === pending) this.cache.delete(key); });
    }
    if (observe) {
      const startedAt = performance.now();
      // Logged with its values filled in, so it can be run as is.
      const runnable = materializeReportQuery(parameter.options.sql, { parameters: toReportParameters(parameters, values) }, values);
      const report = (options: number | undefined, error: string | null) => observe({ parameter, sql: runnable, rows: options, startedAt, durationMs: performance.now() - startedAt, error, cached });
      pending.then(result => report(result.options.length, null), error => report(undefined, error instanceof Error ? error.message : String(error)));
    }
    return pending;
  }

  private async run(parameter: EvidenceParameter, sql: string, params: unknown[], signal?: AbortSignal): Promise<Loaded> {
    if (!engine.query) throw new Error('Haybarn is not ready');
    const options = { signal, timeoutMs: REPORT_QUERY_TIMEOUT_MS };
    const response = params.length ? await engine.queryPrepared!(sql, params, options) : await engine.query(sql, options);
    signal?.throwIfAborted();
    if (!response.ok) throw new Error(response.error || 'Choices query failed');
    if (!response.arrowBuffers?.length) return { options: [], truncated: false };
    const { rows, columns } = evidenceResult(decodeArrowBuffer(response.arrowBuffers[0]));
    return optionsFromRows(parameter, rows, columns.map(column => column.name));
  }
}

export interface ChoicesResolution {
  /** Every parameter's value, fitted to its current choices. */
  values: ParameterValues;
  states: Record<string, ParameterOptionsState>;
  /** Reader-facing notes for values that had to change. */
  notes: string[];
}

/** Walk parameters parents-first: load each one's choices with its parents' (already fitted)
 *  values, then fit its own value. `onState` reports progress for the parameter bar. */
export async function resolveChoices(
  parameters: EvidenceParameter[],
  values: ParameterValues,
  loader: ParameterChoicesLoader,
  { signal, previous = {}, onState, observe }: { signal?: AbortSignal; previous?: Record<string, ParameterOptionsState>; onState?: (states: Record<string, ParameterOptionsState>) => void; observe?: (load: ChoicesLoad) => void } = {},
): Promise<ChoicesResolution> {
  const byKey = new Map(parameters.map(parameter => [parameter.key, parameter]));
  const working = currentValues(parameters, values);
  const states: Record<string, ParameterOptionsState> = {};
  const notes: string[] = [];
  for (const key of parameterOrder({ parameters })) {
    const parameter = byKey.get(key)!;
    if (!hasChoices(parameter) || !parameter.options) continue;
    let options: ParameterOption[] | undefined;
    if (parameter.options.kind === 'static') {
      options = parameter.options.values;
      states[key] = { status: 'static', options };
    } else {
      states[key] = { status: 'loading', options: previous[key]?.options ?? [] };
      onState?.({ ...states });
      try {
        const loaded = await loader.load(parameter, parameters, working, signal, observe);
        options = loaded.options;
        states[key] = { status: 'ready', ...loaded };
      } catch (error) {
        signal?.throwIfAborted();
        states[key] = { status: 'error', options: previous[key]?.options ?? [], error: error instanceof Error ? error.message : String(error) };
        continue;
      }
    }
    // A value being reset is, by definition, missing from the new choices: name it from the old ones.
    const labelOf = (value: unknown) => [...options!, ...(previous[key]?.options ?? [])].find(option => String(option.value) === String(value))?.label ?? String(value);
    const fitted = reconcileValue(parameter, working[key], options, labelOf);
    working[key] = fitted.value;
    if (fitted.note) notes.push(fitted.note);
  }
  onState?.({ ...states });
  return { values: working, states, notes };
}

/** A parameter's value as a reader should see it, using loaded choice labels. */
export function describeParameter(parameter: EvidenceParameter, values: ParameterValues, states: Record<string, ParameterOptionsState>): string {
  return formatParameterValue(parameter, values[parameter.key], states[parameter.key]?.options ?? (parameter.options?.kind === 'static' ? parameter.options.values : undefined));
}

/** The report agent's `preview_parameter_options` tool: run a parameter's choices query (an
 *  existing one by key, or a draft definition) against the report's current values. */
export async function previewParameterOptions(report: Pick<EvidenceReport, 'parameters' | 'values'>, input: unknown, loader: ParameterChoicesLoader): Promise<string> {
  const request = (input ?? {}) as { key?: unknown; parameter?: unknown };
  let parameters = report.parameters;
  let parameter: EvidenceParameter | undefined;
  if (request.parameter && typeof request.parameter === 'object') {
    const draft = validateEvidenceReport({
      version: 1, id: 'preview', title: 'Preview', source: '', setupSql: '', serviceUrl: '', createdAt: 0, updatedAt: 0, values: {},
      parameters: [...report.parameters.filter(p => p.key !== (request.parameter as { key?: unknown }).key), request.parameter],
    });
    parameters = draft.parameters;
    parameter = parameters[parameters.length - 1];
  } else if (typeof request.key === 'string') parameter = parameters.find(p => p.key === request.key);
  if (!parameter) throw new Error('Pass the key of an existing parameter, or a parameter definition.');
  if (parameter.options?.kind === 'static') return JSON.stringify({ count: parameter.options.values.length, choices: parameter.options.values.slice(0, 25) });
  if (parameter.options?.kind !== 'query') throw new Error(`${parameter.label} has no choices query.`);
  await waitForEngineReady();
  // Parents first, so the draft sees the values its parents would have.
  const fitted = await resolveChoices(parameters.filter(p => p.key !== parameter.key), report.values, loader);
  const { options, truncated } = await loader.load(parameter, parameters, fitted.values);
  return JSON.stringify({ count: options.length, truncated, choices: options.slice(0, 25), boundWith: Object.fromEntries(Object.entries(fitted.values).filter(([key]) => key !== parameter.key)) });
}
