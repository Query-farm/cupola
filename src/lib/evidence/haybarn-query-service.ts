import { DataType, type Table } from '@query-farm/apache-arrow';
import { normalizeSparklineRows } from '@evidence/core/connectors/normalize-sparkline-rows';
import { MotherDuckDialect } from '@evidence/core/sql-dialect/motherduck';
import type { QueryService, QueryOpts, QueryResult, AnyRowType, Column } from '@evidence/core/user-components/interfaces/query-service';
import { engine } from '../shell-bridge';
import { decodeArrowBuffer } from '../duckdb-query';
import { compileReportQuery } from '../reports/parameters';
import type { ReportParameter, ReportParameterValue } from '../reports/types';

export interface QueryLogEntry { sql: string; rows: number; durationMs: number; error: string | null }

/** Normalize nested Arrow vectors too: Evidence sparklines expect ordinary arrays. */
function arrowValue(value: any, type: DataType): any {
  if (value == null) return null;
  if (DataType.isList(type) || DataType.isFixedSizeList(type)) return Array.from(value, item => arrowValue(item, type.valueType));
  if (DataType.isStruct(type)) return Object.fromEntries(type.children.map(field => [field.name, arrowValue(value[field.name], field.type)]));
  if (DataType.isDecimal(type)) {
    const raw = BigInt(value.toString());
    const scale = type.scale;
    const digits = (raw < 0n ? -raw : raw).toString().padStart(scale + 1, '0');
    return `${raw < 0n ? '-' : ''}${scale > 0 ? `${digits.slice(0, -scale)}.${digits.slice(-scale)}` : digits + '0'.repeat(Math.max(0, -scale))}`;
  }
  if (DataType.isTimestamp(type) || DataType.isDate(type)) {
    const iso = (value instanceof Date ? value : new Date(Number(value))).toISOString();
    // Preserve SQL wall-clock dates. Evidence's chart pipeline interprets Date objects
    // in the viewer's timezone, which would shift timezone-free forecast hours.
    if (DataType.isDate(type)) return iso.slice(0, 10);
    return type.timezone ? iso : iso.slice(0, -1);
  }
  if (typeof value === 'bigint') return value <= BigInt(Number.MAX_SAFE_INTEGER) && value >= BigInt(Number.MIN_SAFE_INTEGER) ? Number(value) : value.toString();
  return value;
}

/** Preserve DECIMAL precision and temporal meaning across the Arrow/row boundary. */
export function evidenceResult(table: Table): Pick<QueryResult, 'rows' | 'columns'> {
  const columns: Column[] = table.schema.fields.map(field => ({
    name: field.name,
    clickhouseType: field.type.toString(), // Upstream's historical name; this is source type metadata.
    jsType: DataType.isTimestamp(field.type) || DataType.isDate(field.type) ? 'date'
      : DataType.isBool(field.type) ? 'boolean'
      : DataType.isInt(field.type) || DataType.isFloat(field.type) || DataType.isDecimal(field.type) ? 'number'
      : DataType.isUtf8(field.type) ? 'string' : 'unknown',
    nullable: field.nullable,
  }));
  const rows: AnyRowType[] = [];
  for (let i = 0; i < table.numRows; i++) {
    const row: AnyRowType = {};
    for (let j = 0; j < columns.length; j++) {
      const field = table.schema.fields[j];
      const value = table.getChildAt(j)?.get(i);
      row[field.name] = arrowValue(value, field.type);
    }
    rows.push(row);
  }
  normalizeSparklineRows(rows, columns);
  return { rows, columns };
}

/** Injected into Evidence; uses Cupola's existing connection, never a second WASM engine. */
export class HaybarnQueryService implements QueryService {
  readonly workspaceId = 'cupola';
  readonly dialect = new MotherDuckDialect();
  readonly connectionType = 'motherduck'; // Selects Evidence's DuckDB-compatible SQL/metadata dialect.
  private cache = new Map<string, Promise<QueryResult>>();
  constructor(
    private onQuery?: (entry: QueryLogEntry) => void,
    private parameters: ReportParameter[] = [],
    private values: Record<string, ReportParameterValue> = {},
  ) {}

  async query<RowType extends AnyRowType = AnyRowType>(sql: string, opts?: QueryOpts): Promise<QueryResult<RowType>> {
    if (opts?.signal?.aborted) throw new DOMException('Query cancelled', 'AbortError');
    let pending = opts?.noCache ? undefined : this.cache.get(sql);
    if (!pending) {
      pending = this.execute(sql);
      this.cache.set(sql, pending);
      void pending.then(result => { if (result.error) this.cache.delete(sql); });
    }
    const result = await pending;
    if (opts?.signal?.aborted) throw new DOMException('Query cancelled', 'AbortError');
    return result as QueryResult<RowType>;
  }
  async queryArrow(sql: string): Promise<ArrayBuffer> {
    if (!engine.query) throw new Error('Haybarn is not ready');
    const compiled = compileReportQuery(sql, { parameters: this.parameters.map(parameter => ({ ...parameter, defaultValue: Object.hasOwn(this.values, parameter.key) ? this.values[parameter.key] : parameter.defaultValue })) }, this.values);
    if (compiled.params.length && !engine.queryPrepared) throw new Error('Prepared queries are unavailable');
    const response = compiled.params.length ? await engine.queryPrepared!(compiled.sql, compiled.params) : await engine.query(compiled.sql);
    if (!response.ok) throw new Error(response.error || 'Query failed');
    if (!response.arrowBuffers?.length) throw new Error('Query returned no tabular result.');
    return response.arrowBuffers[0];
  }
  private async execute(sql: string): Promise<QueryResult> {
    const start = performance.now();
    let result: QueryResult;
    try {
      if (!engine.query) throw new Error('Haybarn is not ready');
      const compiled = compileReportQuery(sql, { parameters: this.parameters.map(parameter => ({ ...parameter, defaultValue: Object.hasOwn(this.values, parameter.key) ? this.values[parameter.key] : parameter.defaultValue })) }, this.values);
      if (compiled.params.length && !engine.queryPrepared) throw new Error('Prepared queries are unavailable');
      const response = compiled.params.length
        ? await engine.queryPrepared!(compiled.sql, compiled.params)
        : await engine.query(compiled.sql);
      if (!response.ok) throw new Error(response.error || 'Query failed');
      result = { ...(response.arrowBuffers?.length ? evidenceResult(decodeArrowBuffer(response.arrowBuffers[0])) : { rows: [], columns: [] }), error: null };
    } catch (error) {
      result = { rows: [], columns: [], error: error instanceof Error ? error.message : String(error) };
    }
    result.queryDurationMs = performance.now() - start;
    this.onQuery?.({ sql, rows: result.rows.length, durationMs: result.queryDurationMs, error: result.error });
    return result;
  }
}
