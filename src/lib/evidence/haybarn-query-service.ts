import { DataType, type Field, type Table } from '@query-farm/apache-arrow';
import { normalizeSparklineRows } from '@evidence/core/connectors/normalize-sparkline-rows';
import { MotherDuckDialect } from '@evidence/core/sql-dialect/motherduck';
import type { QueryService, QueryOpts, QueryResult, AnyRowType, Column } from '@evidence/core/user-components/interfaces/query-service';
import { EvidenceQueryRun } from './query-run';
import { decodeArrowBuffer, duckdbExtensionDecoder } from '../duckdb-query';
import { getDuckDBExtensionType } from '../format';
import { compileReportQuery } from '../reports/parameters';
import type { ReportParameter, ReportParameterValue } from '../reports/types';

export interface QueryLogEntry { sql: string; rows: number; durationMs: number; error: string | null }

/** Normalize nested Arrow vectors too: Evidence sparklines expect ordinary arrays.
 *  DuckDB's lossless export sends HUGEINT/UUID/BIT/… as raw extension bytes;
 *  decode them the way every other result surface does, or a `sum()` renders
 *  as the byte list "12,3,0,0,…". */
function arrowValue(value: any, field: Field): any {
  if (value == null) return null;
  const decode = duckdbExtensionDecoder(field);
  if (decode) value = decode(value);
  const type = field.type;
  if (DataType.isList(type) || DataType.isFixedSizeList(type)) return Array.from(value, item => arrowValue(item, type.children[0]));
  if (DataType.isStruct(type)) return Object.fromEntries(type.children.map(child => [child.name, arrowValue(value[child.name], child)]));
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
      : DataType.isInt(field.type) || DataType.isFloat(field.type) || DataType.isDecimal(field.type)
        || ['hugeint', 'uhugeint', 'bignum', 'varint'].includes(getDuckDBExtensionType(field) ?? '') ? 'number'
      : DataType.isUtf8(field.type) ? 'string' : 'unknown',
    nullable: field.nullable,
  }));
  const rows: AnyRowType[] = [];
  for (let i = 0; i < table.numRows; i++) {
    const row: AnyRowType = {};
    for (let j = 0; j < columns.length; j++) {
      const field = table.schema.fields[j];
      const value = table.getChildAt(j)?.get(i);
      row[field.name] = arrowValue(value, field);
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
    private run = new EvidenceQueryRun(),
  ) {}

  async query<RowType extends AnyRowType = AnyRowType>(sql: string, opts?: QueryOpts): Promise<QueryResult<RowType>> {
    if (opts?.signal?.aborted) throw new DOMException('Query cancelled', 'AbortError');
    this.run.signal.throwIfAborted();
    let pending = opts?.noCache || opts?.signal ? undefined : this.cache.get(sql);
    if (!pending) {
      pending = this.execute(sql, opts?.signal);
      if (!opts?.signal) {
        this.cache.set(sql, pending);
        const cached = pending;
        void pending.then(result => { if (result.error && this.cache.get(sql) === cached) this.cache.delete(sql); });
      }
    }
    const result = await pending;
    if (opts?.signal?.aborted) throw new DOMException('Query cancelled', 'AbortError');
    return result as QueryResult<RowType>;
  }
  async queryArrow(sql: string): Promise<ArrayBuffer> {
    const compiled = compileReportQuery(sql, { parameters: this.parameters.map(parameter => ({ ...parameter, defaultValue: Object.hasOwn(this.values, parameter.key) ? this.values[parameter.key] : parameter.defaultValue })) }, this.values);
    const response = await this.run.query(compiled.sql, compiled.params);
    if (!response.ok) throw new Error(response.error || 'Query failed');
    if (!response.arrowBuffers?.length) throw new Error('Query returned no tabular result.');
    return response.arrowBuffers[0];
  }
  private async execute(sql: string, signal?: AbortSignal): Promise<QueryResult> {
    const start = performance.now();
    let result: QueryResult;
    try {
      const compiled = compileReportQuery(sql, { parameters: this.parameters.map(parameter => ({ ...parameter, defaultValue: Object.hasOwn(this.values, parameter.key) ? this.values[parameter.key] : parameter.defaultValue })) }, this.values);
      const response = await this.run.query(compiled.sql, compiled.params, signal);
      if (!response.ok) throw new Error(response.error || 'Query failed');
      result = { ...(response.arrowBuffers?.length ? evidenceResult(decodeArrowBuffer(response.arrowBuffers[0])) : { rows: [], columns: [] }), error: null };
    } catch (error) {
      result = { rows: [], columns: [], error: error instanceof Error ? error.message : String(error) };
    }
    result.queryDurationMs = performance.now() - start;
    // A query cancelled because its refresh was stopped or superseded did not fail:
    // logging it made every in-flight query of a stopped run a "report problem".
    const cancelled = this.run.signal.aborted || Boolean(signal?.aborted);
    if (!cancelled) this.onQuery?.({ sql, rows: result.rows.length, durationMs: result.queryDurationMs, error: result.error });
    return result;
  }
}
