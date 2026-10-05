import type { Table } from '@query-farm/apache-arrow';
import { evidenceResult } from '../evidence/haybarn-query-service';
import type { NotebookChart } from './model';

export const CHART_ROW_LIMIT = 10_000;
export function chartData(table: Table) {
  // Bound conversion as well as rendering, not just the visible marks.
  const converted = evidenceResult(table.slice(0, CHART_ROW_LIMIT));
  return {
    rows: converted.rows,
    columns: converted.columns.map((column) => ({
      name: column.name,
      numeric: column.jsType === 'number',
      temporal: column.jsType === 'date',
    })),
    truncated: table.numRows > CHART_ROW_LIMIT,
  };
}
export function chartSpec(
  chart: NotebookChart,
  columns: { name: string; numeric: boolean }[],
): Record<string, unknown> {
  const names = new Set(columns.map((column) => column.name));
  for (const field of [
    chart.x,
    ...(chart.type !== 'histogram' ? [chart.y] : []),
    ...(chart.color ? [chart.color] : []),
  ]) {
    if (!field || !names.has(field))
      throw new Error(
        `Choose a replacement for ${field ? `missing column “${field}”` : 'the unselected column'}.`,
      );
  }
  if (chart.type !== 'histogram' && !columns.find((column) => column.name === chart.y)?.numeric)
    throw new Error('Choose a numeric Y column.');
  if (
    (chart.type === 'histogram' || chart.xType === 'quantitative') &&
    !columns.find((column) => column.name === chart.x)?.numeric
  )
    throw new Error('Choose a numeric X column or change its axis type.');
  // Vega field syntax treats dots/brackets as property access; SQL column names are literal.
  const field = (name: string) => name.replace(/[.\[\]\\]/g, '\\$&');
  return {
    $schema: 'https://vega.github.io/schema/vega-lite/v5.json',
    height: 280,
    title: chart.title || undefined,
    mark: {
      type: chart.type === 'scatter' ? 'point' : chart.type === 'histogram' ? 'bar' : chart.type,
      tooltip: true,
    },
    encoding: {
      x: {
        field: field(chart.x),
        type: chart.type === 'histogram' ? 'quantitative' : chart.xType,
        ...(chart.type === 'histogram' ? { bin: true } : {}),
        sort: chart.sort,
        title: chart.xTitle || chart.x,
      },
      y:
        chart.type === 'histogram'
          ? { aggregate: 'count', type: 'quantitative', title: chart.yTitle || 'Count' }
          : {
              field: field(chart.y),
              type: 'quantitative',
              title: chart.yTitle || chart.y,
              stack: null,
              ...(chart.yFormat ? { axis: { format: chart.yFormat } } : {}),
            },
      ...(chart.color ? { color: { field: field(chart.color), type: 'nominal' } } : {}),
      // Distinct series must not obscure each other at the same categorical X.
      ...(chart.type === 'bar' && chart.color && chart.xType === 'nominal'
        ? { xOffset: { field: field(chart.color), type: 'nominal' } }
        : {}),
    },
  };
}
