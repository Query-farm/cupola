import { useEffect, useRef, useState } from 'react';
import { MarkdownContent } from '../content/MarkdownContent';
import { DocumentCodeEditor, markdownSupport } from '../content/DocumentCodeEditor';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '../ui/tabs';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { CodeMirrorSql, type CodeMirrorSqlHandle } from '../editor/CodeMirrorSql';
import { EditorResultsPane, emptyResult } from '../editor/EditorResultsPane';
import { sqlAutoCompleteSource } from '../../lib/editor/sql-autocomplete';
import { useSettings } from '../../lib/settings';
import { exportResult } from '../../lib/editor/result-export';
import { defaultChart, type NotebookCell } from '../../lib/notebooks/model';
import { isStale, type CellResult } from '../../lib/notebooks/execution';
import { chartData } from '../../lib/notebooks/charts';
import { NotebookChartView } from './NotebookChartView';

const markdownExtensions = markdownSupport();

export function NotebookCellView({
  cell,
  result,
  busy,
  first,
  last,
  onChange,
  onRun,
  onStop,
  onMove,
  onDuplicate,
  onDelete,
}: {
  cell: NotebookCell;
  result?: CellResult;
  busy: boolean;
  first: boolean;
  last: boolean;
  onChange: (cell: NotebookCell) => void;
  onRun: () => void;
  onStop: () => void;
  onMove: (direction: number) => void;
  onDuplicate: () => void;
  onDelete: () => void;
}) {
  const { settings } = useSettings();
  const sql = useRef<CodeMirrorSqlHandle>(null);
  const [editingMarkdown, setEditingMarkdown] = useState(!cell.source);
  const [output, setOutput] = useState('table');
  const [exportError, setExportError] = useState('');
  useEffect(() => {
    if (cell.type === 'sql' && sql.current && sql.current.getDoc() !== cell.source)
      sql.current.setDoc(cell.source);
  }, [cell.source, cell.collapsed]);
  const chart = cell.type === 'sql' ? cell.charts.find((chart) => chart.id === output) : undefined;
  const stale = cell.type === 'sql' && isStale(cell, result);
  return (
    <section
      className="rounded-lg border bg-card shadow-sm overflow-hidden"
      data-testid="notebook-cell"
      aria-label={`${cell.type === 'sql' ? 'SQL' : 'Markdown'} cell: ${cell.title}`}
      onKeyDown={(event) => {
        if (cell.type === 'sql' && event.key === 'Enter' && event.shiftKey) {
          event.preventDefault();
          if (!busy) onRun();
        }
      }}
    >
      <div className="flex flex-wrap items-center gap-1 border-b px-2 py-1.5">
        <Button
          size="sm"
          variant="ghost"
          aria-label={cell.collapsed ? 'Expand cell' : 'Collapse cell'}
          onClick={() => onChange({ ...cell, collapsed: !cell.collapsed })}
        >
          {cell.collapsed ? '▸' : '▾'}
        </Button>
        <span className="text-xs text-muted-foreground">{cell.type === 'sql' ? 'SQL' : 'Markdown'}</span>
        <Input
          className="h-7 flex-1 min-w-24 border-transparent shadow-none"
          aria-label="Cell name"
          value={cell.title}
          maxLength={200}
          onChange={(e) => onChange({ ...cell, title: e.target.value })}
        />
        <Button
          size="sm"
          variant="ghost"
          disabled={first || busy}
          aria-label="Move cell up"
          onClick={() => onMove(-1)}
        >
          ↑
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={last || busy}
          aria-label="Move cell down"
          onClick={() => onMove(1)}
        >
          ↓
        </Button>
        <Button size="sm" variant="ghost" disabled={busy} onClick={onDuplicate}>
          Duplicate
        </Button>
        <Button size="sm" variant="ghost" disabled={busy} onClick={onDelete}>
          Delete
        </Button>
        {cell.type === 'sql' &&
          (result?.running ? (
            <Button size="sm" variant="destructive" onClick={onStop}>
              Stop
            </Button>
          ) : (
            <Button size="sm" disabled={busy} onClick={onRun}>
              Run
            </Button>
          ))}
      </div>
      {cell.collapsed && cell.type === 'sql' && (
        <div className="px-3 py-2 text-xs" aria-live="polite">
          {result?.running ? (
            'Running…'
          ) : result?.error ? (
            <span className="text-destructive">Query failed — expand to inspect the error.</span>
          ) : result?.cancelled ? (
            'Query cancelled.'
          ) : result?.table ? (
            `${result.table.numRows.toLocaleString()} returned rows`
          ) : (
            'Not run'
          )}
          {stale && (
            <span className="ml-2 text-amber-700 dark:text-amber-400">Stale output — run to update</span>
          )}
        </div>
      )}
      {!cell.collapsed &&
        (cell.type === 'markdown' ? (
          <div className="p-3">
            <Button
              size="sm"
              variant="outline"
              className="mb-2"
              onClick={() => setEditingMarkdown(!editingMarkdown)}
            >
              {editingMarkdown ? 'Preview Markdown' : 'Edit Markdown'}
            </Button>
            {editingMarkdown ? (
              <div className="h-60">
                <DocumentCodeEditor
                  className="h-full"
                  ariaLabel="Markdown source"
                  value={cell.source}
                  extensions={markdownExtensions}
                  onChange={(source) => onChange({ ...cell, source })}
                />
              </div>
            ) : (
              <MarkdownContent
                document
                copyTables
                content={cell.source || 'Add notes to explain your analysis.'}
              />
            )}
          </div>
        ) : (
          <>
            <div className="h-40 border-b">
              <CodeMirrorSql
                completionSource={settings.editorAutocomplete === false ? null : sqlAutoCompleteSource}
                ref={sql}
                initialDoc={cell.source}
                onChange={(source) => onChange({ ...cell, source })}
                onRunStatement={() => {
                  if (!busy) onRun();
                }}
              />
            </div>
            <div className="px-3 py-1.5 text-xs flex flex-wrap gap-3" aria-live="polite">
              {result?.running ? (
                <span>Running…</span>
              ) : result?.completedAt ? (
                <span>
                  {result.table?.numRows.toLocaleString()} returned rows · Ran{' '}
                  {new Date(result.completedAt).toLocaleTimeString()} · {result.elapsedMs} ms
                </span>
              ) : (
                <span>Not run · Shift+Enter runs this cell</span>
              )}
              {stale && (
                <strong className="text-amber-700 dark:text-amber-400">Stale output — run to update</strong>
              )}
              {result?.cancelled && <span>Query cancelled.</span>}
            </div>
            {result?.error && (
              <p role="alert" className="px-3 py-2 text-sm text-destructive whitespace-pre-wrap">
                {result.error}
                {result.table ? ' Previous result retained.' : ''}
              </p>
            )}
            {exportError && (
              <p role="alert" className="px-3 text-destructive text-sm">
                {exportError}
              </p>
            )}
            <Tabs
              value={chart?.id ?? 'table'}
              onValueChange={(value) => setOutput(String(value))}
              className="gap-0"
            >
              <div className="flex gap-1 overflow-x-auto border-y px-2 py-1">
                <TabsList aria-label="Cell outputs" variant="line" activateOnFocus>
                  <TabsTrigger value="table">Table</TabsTrigger>
                  {cell.charts.map((item) => (
                    <TabsTrigger key={item.id} value={item.id}>
                      {item.title || 'Chart'}
                    </TabsTrigger>
                  ))}
                </TabsList>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={cell.charts.length >= 20}
                  onClick={() => {
                    const added = defaultChart(result?.table ? chartData(result.table).columns : []);
                    onChange({ ...cell, charts: [...cell.charts, added] });
                    setOutput(added.id);
                  }}
                >
                  + Chart
                </Button>
              </div>
              {chart ? (
                <TabsContent value={chart.id}>
                  <NotebookChartView
                    chart={chart}
                    table={result?.table}
                    onChange={(next) =>
                      onChange({
                        ...cell,
                        charts: cell.charts.map((item) => (item.id === next.id ? next : item)),
                      })
                    }
                    onDelete={() => {
                      onChange({
                        ...cell,
                        charts: cell.charts.filter((item) => item.id !== chart.id),
                      });
                      setOutput('table');
                    }}
                  />
                </TabsContent>
              ) : (
                <TabsContent value="table" aria-label="Table output">
                  <div className="flex flex-wrap items-center gap-2 border-b px-3 py-2 text-xs">
                    <label className="flex items-center gap-2">
                      Output height
                      <input
                        type="range"
                        aria-label="Output height"
                        min={240}
                        max={4000}
                        step={16}
                        value={cell.outputHeight ?? 288}
                        onChange={(event) =>
                          onChange({
                            ...cell,
                            outputHeight: Number(event.target.value),
                          })
                        }
                      />
                    </label>
                    <span>{cell.outputHeight ?? 288} px</span>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => onChange({ ...cell, outputHeight: 288 })}
                    >
                      Compact
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => onChange({ ...cell, outputHeight: 1200 })}
                    >
                      Tall
                    </Button>
                  </div>
                  <div style={{ height: cell.outputHeight ?? 288 }} data-testid="notebook-table-viewport">
                    <EditorResultsPane
                      state={{
                        ...emptyResult,
                        table: result?.table ?? null,
                        rowCount: result?.table?.numRows ?? 0,
                        ran: !!result?.completedAt,
                        running: !!result?.running,
                        ok: !!result?.table,
                        elapsedMs: result?.elapsedMs ?? 0,
                      }}
                      onExport={
                        result?.table
                          ? async (format) => {
                              try {
                                await exportResult(result.table, format, cell.title);
                                setExportError('');
                              } catch (e) {
                                setExportError(String(e));
                              }
                            }
                          : undefined
                      }
                    />
                  </div>
                </TabsContent>
              )}
            </Tabs>
          </>
        ))}
    </section>
  );
}
