import { useEffect, useMemo, useRef, useState } from 'react';
import type { Table } from '@query-farm/apache-arrow';
import { Button } from '../ui/button';
import { ChartDownloadMenu } from '../chat/ChartDownloadMenu';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '../ui/select';
import { Input } from '../ui/input';
import { embedChart, downloadPNG, downloadSVG, type VegaView } from '../chat/chart-embed';
import { chartData, chartSpec, CHART_ROW_LIMIT } from '../../lib/notebooks/charts';
import type { NotebookChart } from '../../lib/notebooks/model';

export function NotebookChartView({
  chart,
  table,
  onChange,
  onDelete,
}: {
  chart: NotebookChart;
  table?: Table;
  onChange: (chart: NotebookChart) => void;
  onDelete: () => void;
}) {
  const data = useMemo(() => (table ? chartData(table) : undefined), [table]);
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<VegaView | null>(null);
  const [error, setError] = useState('');
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let disposed = false;
    let rendered: VegaView | undefined;
    setReady(false);
    setError('');
    const el = host.current;
    if (!el || !data) return;
    el.replaceChildren();
    let lastWidth = el.clientWidth;
    const resize = new ResizeObserver(() => {
      const width = el.clientWidth;
      if (width > 0 && width !== lastWidth && rendered && !disposed) {
        lastWidth = width;
        void (rendered as VegaView & { resize(): VegaView })
          .resize()
          .runAsync()
          .catch((e) => {
            if (!disposed) setError(String(e));
          });
      }
    });
    resize.observe(el);
    void (async () => {
      try {
        const spec = chartSpec(chart, data.columns);
        // A private target prevents a late embed from overwriting the next chart.
        const target = document.createElement('div');
        target.style.width = '100%';
        el.append(target);
        rendered = await embedChart(target, spec, data.rows);
        if (disposed) {
          rendered.finalize();
          target.remove();
          return;
        }
        view.current = rendered;
        setReady(true);
      } catch (e) {
        if (!disposed) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      disposed = true;
      resize.disconnect();
      rendered?.finalize();
      view.current = null;
      el.replaceChildren();
    };
  }, [chart, data]);
  const patch = (update: Partial<NotebookChart>) => onChange({ ...chart, ...update });
  const columns = data?.columns ?? [];
  const select = (
    label: string,
    value: string,
    options: { value: string; label: string }[],
    change: (value: string) => void,
  ) => (
    <div className="text-xs flex flex-col gap-1">
      <span>{label}</span>
      <Select
        value={value}
        onValueChange={(next) => {
          if (next !== null) change(next);
        }}
      >
        <SelectTrigger aria-label={label} className="w-full">
          <SelectValue>
            {options.find((option) => option.value === value)?.label ?? (value || 'Select column')}
          </SelectValue>
        </SelectTrigger>
        <SelectContent>
          {!options.some((option) => option.value === value) && (
            <SelectItem value={value}>{value || 'Select column'}</SelectItem>
          )}
          {options.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
  const fields = columns.map((column) => ({ value: column.name, label: column.name }));
  return (
    <div className="p-3 space-y-3" data-testid="notebook-chart">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <label className="text-xs space-y-1">
          Chart name
          <Input
            aria-label="Chart name"
            value={chart.title}
            onChange={(e) => patch({ title: e.target.value })}
            maxLength={200}
          />
        </label>
        {select(
          'Chart type',
          chart.type,
          ['bar', 'line', 'area', 'scatter', 'histogram'].map((value) => ({ value, label: value })),
          (value) => patch({ type: value as NotebookChart['type'] }),
        )}
        {select('X column', chart.x, fields, (value) => {
          const column = columns.find((column) => column.name === value);
          patch({
            x: value,
            xType: column?.temporal ? 'temporal' : column?.numeric ? 'quantitative' : 'nominal',
          });
        })}
        {chart.type !== 'histogram' &&
          select(
            'Y column',
            chart.y,
            fields.filter((option) => columns.find((column) => column.name === option.value)?.numeric),
            (value) => patch({ y: value }),
          )}
        {select('Color column', chart.color, [{ value: '', label: 'None' }, ...fields], (value) =>
          patch({ color: value }),
        )}
        {chart.type !== 'histogram' &&
          select(
            'X axis type',
            chart.xType,
            ['nominal', 'quantitative', 'temporal'].map((value) => ({ value, label: value })),
            (value) => patch({ xType: value as NotebookChart['xType'] }),
          )}
        {select(
          'X sort',
          chart.sort,
          ['ascending', 'descending'].map((value) => ({ value, label: value })),
          (value) => patch({ sort: value as NotebookChart['sort'] }),
        )}
      </div>
      <details>
        <summary className="cursor-pointer text-xs">Axis labels and formatting</summary>
        <div className="flex flex-wrap gap-3 mt-2">
          {(['xTitle', 'yTitle', 'yFormat'] as const).map((key, index) => (
            <label className="text-xs" key={key}>
              {['X axis label', 'Y axis label', 'Y number format'][index]}
              <Input
                value={chart[key]}
                maxLength={key === 'yFormat' ? 50 : 200}
                onChange={(e) => patch({ [key]: e.target.value })}
                placeholder={key === 'yFormat' ? ',.2f' : undefined}
              />
            </label>
          ))}
        </div>
      </details>
      {data?.truncated && (
        <p role="status" className="text-sm text-amber-700 dark:text-amber-400">
          Chart preview: first {CHART_ROW_LIMIT.toLocaleString()} of {table!.numRows.toLocaleString()}{' '}
          returned rows. Aggregate or filter in SQL for a complete chart.
        </p>
      )}
      {!table && (
        <p className="text-sm text-muted-foreground">Run this SQL cell to configure and display its chart.</p>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <div ref={host} className="w-full min-w-0 overflow-auto" />
      <div className="flex gap-2">
        <ChartDownloadMenu
          disabled={!ready}
          onDownload={async (format) => {
            if (!view.current) return;
            try {
              await (format === 'png' ? downloadPNG : downloadSVG)(view.current, chart.title);
            } catch (e) {
              setError(String(e));
            }
          }}
        />
        <Button size="sm" variant="ghost" onClick={onDelete}>
          Remove chart
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        Charts use this cell’s returned rows. Changing chart settings does not run SQL. Histograms count rows
        in bins; other aggregation belongs in SQL.
      </p>
    </div>
  );
}
