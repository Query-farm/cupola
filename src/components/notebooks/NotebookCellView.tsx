import { useEffect, useRef, useState } from 'react';
import { ChevronDown, MoreHorizontal, Play, Square, Pencil, Plus, Eye, EyeOff, Loader2 } from 'lucide-react';
import { MarkdownContent } from '../content/MarkdownContent';
import { DocumentCodeEditor, markdownSupport } from '../content/DocumentCodeEditor';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '../ui/tabs';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from '../ui/dropdown-menu';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '../ui/dialog';
import { CodeMirrorSql, type CodeMirrorSqlHandle } from '../editor/CodeMirrorSql';
import { EditorResultsPane, emptyResult } from '../editor/EditorResultsPane';
import { sqlAutoCompleteSource } from '../../lib/editor/sql-autocomplete';
import { useSettings } from '../../lib/settings';
import { exportResult } from '../../lib/editor/result-export';
import { defaultChart, uid, type NotebookCell, type NotebookChart } from '../../lib/notebooks/model';
import { isStale, type CellResult } from '../../lib/notebooks/execution';
import { chartData, chartSpec } from '../../lib/notebooks/charts';
import { NotebookChartView } from './NotebookChartView';
import { NotebookOutputResize } from './NotebookOutputResize';
import type { NotebookInsertion } from '../../lib/notebooks/navigation';
import type { CatalogData } from '../../lib/service';
import { buildCallSnippet } from '../../lib/editor/call-snippet';
import { buildTableSelect, isTableRef } from '../../lib/sql/table-select';
import { callablesForSelection } from '../../lib/callable';
import { parseSelection, treeIdToShellText } from '../../lib/tree';
import { quoteIdent } from '../../lib/duckdb-query';
import { type ParameterScope } from '../../lib/notebooks/parameters';
import { NotebookRunDetails, RunningStatus } from './NotebookRunDetails';
import { ExplainView } from '../editor/ExplainView';
import { buildCatalogIndex } from '../../lib/catalog-index';
import type { CompletionContext } from '@codemirror/autocomplete';

const markdownExtensions = markdownSupport();
export function NotebookCellView({
  cell,
  catalogs,
  parameterScope,
  insertion,
  result,
  busy,
  first,
  last,
  onChange,
  onRun,
  onExplain,
  onPin,
  onUnpin,
  onRunAbove,
  onRunBelow,
  onStop,
  onMove,
  onDuplicate,
  onDelete,
  onClearOutput,
  onAskAi,
}: {
  cell: NotebookCell;
  catalogs: readonly CatalogData[];
  parameterScope: ParameterScope;
  insertion?: NotebookInsertion | null;
  result?: CellResult;
  busy: boolean;
  first: boolean;
  last: boolean;
  onChange: (cell: NotebookCell) => void;
  onRun: () => void;
  onExplain: () => void;
  onPin: () => void;
  onUnpin: () => void;
  onRunAbove: () => void;
  onRunBelow: () => void;
  onStop: () => void;
  onMove: (direction: number) => void;
  onDuplicate: () => void;
  onDelete: () => void;
  onClearOutput: () => void;
  onAskAi: () => void;
}) {
  const { settings } = useSettings();
  const sql = useRef<CodeMirrorSqlHandle>(null);
  const scope = useRef(parameterScope);
  scope.current = parameterScope;
  const complete = (context: CompletionContext) => {
    const word = context.matchBefore(/\$[A-Za-z0-9_]*/);
    if (word)
      return {
        from: word.from,
        options: (scope.current.parameters ?? []).map((parameter) => ({
          label: `$${parameter.key}`,
          type: 'variable',
          detail: parameter.label,
        })),
      };
    return sqlAutoCompleteSource(context);
  };
  const handledInsertion = useRef<number | null>(null);
  function insert(request: Pick<NotebookInsertion, 'text' | 'callable'>) {
    const editor = sql.current;
    if (!editor) return;
    if (request.callable)
      editor.insertSnippet(buildCallSnippet(request.callable, { emptyDoc: !editor.getDoc().trim() }));
    else if (request.text)
      editor.insertAtCursor(
        isTableRef(request.text) && !editor.getDoc().trim()
          ? buildTableSelect(request.text, [...catalogs])
          : request.text,
      );
    editor.focus();
    window.document.getElementById(`notebook-${cell.id}`)?.scrollIntoView({ block: 'nearest' });
  }
  const [editingMarkdown, setEditingMarkdown] = useState(!cell.source);
  const [output, setOutput] = useState('table');
  const [draft, setDraft] = useState<NotebookChart | null>(null);
  const [draftError, setDraftError] = useState('');
  const [exportError, setExportError] = useState('');
  const [showDetails, setShowDetails] = useState(false);
  const [showPlan, setShowPlan] = useState(false);
  useEffect(() => {
    if (cell.type === 'sql' && sql.current && sql.current.getDoc() !== cell.source)
      sql.current.setDoc(cell.source);
  }, [cell.source, cell.collapsed, cell.codeHidden]);
  useEffect(() => {
    if (!insertion || handledInsertion.current === insertion.token || !sql.current) return;
    handledInsertion.current = insertion.token;
    insert(insertion);
  }, [insertion, cell.collapsed, cell.codeHidden]);
  const chart = cell.type === 'sql' ? cell.charts.find((item) => item.id === output) : undefined;
  const pinned = output === 'pinned' ? result?.pinned : undefined;
  const outputValue = pinned ? 'pinned' : (chart?.id ?? 'table');
  const displayedTable = pinned?.table ?? result?.table;
  const displayedRun = pinned?.provenance ?? result?.provenance;
  const stale = cell.type === 'sql' && isStale(cell, result, parameterScope);
  const reevaluating = !!result?.running && !!result.table && result.attempt?.mode !== 'explain';
  const editChart = (value: NotebookChart) => {
    setDraft({ ...value });
    setDraftError('');
  };
  const status = result?.running ? (
    <span className="inline-flex items-center gap-1.5">
      <Loader2 className="size-3.5 motion-safe:animate-spin" aria-hidden="true" />
      <span>
        {reevaluating && 'Reevaluating · '}
        <RunningStatus record={result.attempt} />
      </span>
    </span>
  ) : result?.cancelled ? (
    'Cancelled'
  ) : result?.error ? (
    'Query failed'
  ) : result?.table ? (
    `${result.table.numRows.toLocaleString()} returned rows · ${result.elapsedMs} ms`
  ) : (
    'Not run'
  );
  return (
    <section
      className={`group/cell min-w-0 rounded-lg border bg-background focus-within:border-primary/40 ${result?.running ? 'border-primary/60 ring-1 ring-primary/15' : cell.type === 'markdown' && !editingMarkdown ? 'border-transparent hover:border-border/60' : 'border-border/60'}`}
      data-testid="notebook-cell"
      aria-label={`${cell.type === 'sql' ? 'SQL' : 'Markdown'} cell: ${cell.title}`}
    >
      <div className="flex flex-wrap items-center gap-1 px-2 py-1 text-muted-foreground">
        {cell.type === 'sql' && (
          <>
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label={result?.running ? 'Stop' : 'Run'}
              title={result?.running ? 'Stop cell' : 'Run cell (Shift+Enter)'}
              disabled={busy && !result?.running}
              onClick={result?.running ? onStop : onRun}
            >
              {result?.running ? <Square className="size-3.5" /> : <Play className="size-3.5" />}
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger
                render={<Button size="icon-sm" variant="ghost" aria-label="Run options" />}
              >
                <ChevronDown className="size-3" />
              </DropdownMenuTrigger>
              <DropdownMenuContent className="w-44">
                <DropdownMenuItem disabled={busy} onClick={onRun}>
                  Run cell
                </DropdownMenuItem>
                <DropdownMenuItem
                  disabled={busy || !cell.source.trim()}
                  onClick={() => {
                    setShowPlan(true);
                    onExplain();
                  }}
                >
                  Explain query
                </DropdownMenuItem>
                <DropdownMenuItem disabled={busy || first} onClick={onRunAbove}>
                  Run above
                </DropdownMenuItem>
                <DropdownMenuItem disabled={busy} onClick={onRunBelow}>
                  Run below
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </>
        )}
        <span className="px-1 text-[11px] uppercase tracking-wide">
          {cell.type === 'sql' ? 'SQL' : 'Text'}
        </span>
        <Input
          className="h-7 min-w-0 flex-1 border-transparent bg-transparent px-1 text-sm shadow-none hover:border-border"
          aria-label="Cell name"
          value={cell.title}
          maxLength={200}
          onChange={(event) => onChange({ ...cell, title: event.target.value })}
        />
        {cell.type === 'sql' && (
          <span
            className={`order-last w-full pl-2 text-[11px] whitespace-nowrap sm:order-none sm:w-auto sm:pl-0 ${result?.running ? 'rounded bg-primary/10 px-2 py-1 font-medium text-primary sm:pl-2' : ''}`}
            title={
              result?.completedAt
                ? `Last run ${new Date(result.completedAt).toLocaleTimeString()}`
                : 'Shift+Enter runs this cell'
            }
            role="status"
          >
            {status}
          </span>
        )}
        {cell.type === 'sql' && !cell.collapsed && (
          <Button
            size="sm"
            variant="ghost"
            className="h-7 text-xs"
            aria-expanded={!cell.codeHidden}
            aria-controls={`notebook-source-${cell.id}`}
            onClick={() => onChange({ ...cell, codeHidden: !cell.codeHidden })}
          >
            {cell.codeHidden ? <Eye className="size-3.5" /> : <EyeOff className="size-3.5" />}
            {cell.codeHidden ? 'Show code' : 'Hide code'}
          </Button>
        )}
        {cell.type === 'markdown' && !cell.collapsed && (
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label={editingMarkdown ? 'Preview Markdown' : 'Edit Markdown'}
            title={editingMarkdown ? 'Preview Markdown' : 'Edit Markdown'}
            onClick={() => setEditingMarkdown(!editingMarkdown)}
          >
            {editingMarkdown ? <Eye className="size-3.5" /> : <Pencil className="size-3.5" />}
          </Button>
        )}
        <DropdownMenu>
          <DropdownMenuTrigger render={<Button size="icon-sm" variant="ghost" aria-label="Cell actions" />}>
            <MoreHorizontal className="size-4" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-48">
            <DropdownMenuItem onClick={onAskAi}>Ask AI about this cell</DropdownMenuItem>
            <DropdownMenuItem onClick={() => onChange({ ...cell, collapsed: !cell.collapsed })}>
              {cell.collapsed ? 'Expand cell' : 'Collapse cell'}
            </DropdownMenuItem>
            {cell.type === 'sql' && (
              <>
                <DropdownMenuItem onClick={() => onChange({ ...cell, codeHidden: !cell.codeHidden })}>
                  {cell.codeHidden ? 'Show code' : 'Hide code'}
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => onChange({ ...cell, outputHidden: !cell.outputHidden })}>
                  {cell.outputHidden ? 'Show output' : 'Hide output'}
                </DropdownMenuItem>
                <DropdownMenuItem disabled={busy || !result} onClick={onClearOutput}>
                  Clear output
                </DropdownMenuItem>
              </>
            )}
            <DropdownMenuSeparator />
            <DropdownMenuItem disabled={first || busy} onClick={() => onMove(-1)}>
              Move cell up
            </DropdownMenuItem>
            <DropdownMenuItem disabled={last || busy} onClick={() => onMove(1)}>
              Move cell down
            </DropdownMenuItem>
            <DropdownMenuItem disabled={busy} onClick={onDuplicate}>
              Duplicate cell
            </DropdownMenuItem>
            <DropdownMenuItem disabled={busy} variant="destructive" onClick={onDelete}>
              Delete cell
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {cell.type === 'sql' && result?.attempt && (
        <div className="flex flex-wrap items-center gap-2 px-3 pb-1 text-xs text-muted-foreground">
          {result.provenance && (
            <span>
              Result from run #{result.provenance.number} ·{' '}
              {new Date(result.provenance.startedAt).toLocaleString()}
            </span>
          )}
          <Button size="sm" variant="ghost" onClick={() => setShowDetails(true)}>
            Run details
          </Button>
          {result.table && (
            <Button size="sm" variant="ghost" disabled={result.running} onClick={onPin}>
              {result.pinned ? 'Replace pinned result' : 'Pin result'}
            </Button>
          )}
          {result.pinned && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                onUnpin();
                if (output === 'pinned') setOutput('table');
              }}
            >
              Unpin result
            </Button>
          )}
        </div>
      )}
      {stale && (
        <p className="px-4 py-1 text-xs text-amber-700 dark:text-amber-400" role="status">
          {reevaluating ? 'Showing previous output while this cell is reevaluating.' : 'Stale output — run to update'}
        </p>
      )}
      {cell.collapsed ? (
        <button
          className="w-full px-4 py-2 text-left text-xs text-muted-foreground hover:bg-muted/40"
          onClick={() => onChange({ ...cell, collapsed: false })}
        >
          Expand cell
        </button>
      ) : cell.type === 'markdown' ? (
        <div className="px-4 pb-4">
          {editingMarkdown ? (
            <div
              className="min-h-48"
              style={{
                height: Math.min(480, Math.max(120, cell.source.split('\n').length * 22 + 40)),
              }}
            >
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
          {!cell.codeHidden && (
            <div
              id={`notebook-source-${cell.id}`}
              className="border-t border-border/40"
              style={{
                height: Math.min(480, Math.max(88, cell.source.split('\n').length * 22 + 24)),
              }}
            >
              <CodeMirrorSql
                completionSource={settings.editorAutocomplete === false ? null : complete}
                getCatalogIndex={() => buildCatalogIndex(catalogs)}
                ref={sql}
                initialDoc={cell.source}
                onDropText={(raw) => {
                  const [callable] = /::[fm]:/.test(raw)
                    ? callablesForSelection([...catalogs], parseSelection(raw))
                    : [];
                  const text = raw.includes('::c:')
                    ? quoteIdent(raw.split('::c:')[1].split('/').slice(1).join('/'))
                    : (treeIdToShellText(raw) ?? (raw.includes('::') ? undefined : raw));
                  insert(callable ? { callable } : { text });
                }}
                onChange={(source) => onChange({ ...cell, source })}
                onRunCell={() => {
                  if (!busy) onRun();
                }}
                onRunStatement={() => {
                  if (!busy) onRun();
                }}
              />
            </div>
          )}
          {result?.error && (
            <p role="alert" className="px-4 py-2 text-sm text-destructive whitespace-pre-wrap">
              {result.error}
              {result.table ? ' Previous result retained.' : ''}
            </p>
          )}
          {exportError && (
            <p role="alert" className="px-4 text-sm text-destructive">
              {exportError}
            </p>
          )}
          {cell.outputHidden ? (
            <Button
              size="sm"
              variant="ghost"
              className="m-2 text-xs text-muted-foreground"
              onClick={() => onChange({ ...cell, outputHidden: false })}
            >
              Show output
            </Button>
          ) : (
            (result?.table || result?.running || cell.charts.length > 0) && (
              <Tabs value={outputValue} onValueChange={(value) => setOutput(String(value))} className="gap-0">
                <div className="flex items-center gap-1 overflow-x-auto border-y border-border/50 px-3">
                  <TabsList aria-label="Cell outputs" variant="line" activateOnFocus>
                    <TabsTrigger className="text-muted-foreground" value="table">
                      Table
                    </TabsTrigger>
                    {result?.pinned && (
                      <TabsTrigger value="pinned">Pinned #{result.pinned.provenance.number}</TabsTrigger>
                    )}
                    {cell.charts.map((item) => (
                      <TabsTrigger className="text-muted-foreground" key={item.id} value={item.id}>
                        {item.title || 'Chart'}
                      </TabsTrigger>
                    ))}
                  </TabsList>
                  {chart && (
                    <DropdownMenu>
                      <DropdownMenuTrigger
                        render={
                          <Button
                            size="icon-sm"
                            variant="ghost"
                            aria-label={`Actions for ${chart.title || 'Chart'}`}
                            title={`Edit, duplicate or delete ${chart.title || 'chart'}`}
                          />
                        }
                      >
                        <ChevronDown className="size-3" />
                      </DropdownMenuTrigger>
                      <DropdownMenuContent className="w-40">
                        <DropdownMenuItem onClick={() => editChart(chart)}>Edit chart</DropdownMenuItem>
                        <DropdownMenuItem
                          disabled={busy || cell.charts.length >= 20}
                          onClick={() => {
                            const added = {
                              ...chart,
                              id: uid(),
                              title: `${chart.title} copy`.slice(0, 200),
                            };
                            onChange({
                              ...cell,
                              charts: [...cell.charts, added],
                            });
                            setOutput(added.id);
                          }}
                        >
                          Duplicate chart
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem
                          variant="destructive"
                          disabled={busy}
                          onClick={() => {
                            onChange({
                              ...cell,
                              charts: cell.charts.filter((value) => value.id !== chart.id),
                            });
                            if (output === chart.id) setOutput('table');
                          }}
                        >
                          Delete chart
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  )}
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    aria-label="Add chart"
                    title="Add chart"
                    disabled={busy || !result?.table || cell.charts.length >= 20}
                    onClick={() => editChart(defaultChart(chartData(result!.table!).columns))}
                  >
                    <Plus className="size-4" />
                  </Button>
                </div>
                <TabsContent
                  value={outputValue}
                  aria-label={pinned ? 'Pinned output' : chart ? 'Chart output' : 'Table output'}
                >
                  {pinned && (
                    <p className="px-3 py-2 text-xs text-muted-foreground">
                      Pinned run #{pinned.provenance.number} ·{' '}
                      {new Date(pinned.provenance.startedAt).toLocaleString()} ·{' '}
                      {JSON.stringify(pinned.provenance.values)} · Kept until you close this notebook.
                    </p>
                  )}
                  <NotebookOutputResize
                    height={cell.outputHeight ?? (chart ? 420 : 320)}
                    label="cell output"
                    onChange={(outputHeight) => onChange({ ...cell, outputHeight })}
                  >
                    {(height) =>
                      chart ? (
                        <NotebookChartView
                          chart={chart}
                          table={result?.table}
                          onChange={() => {}}
                          height={height}
                        />
                      ) : (
                        <EditorResultsPane
                          state={{
                            ...emptyResult,
                            table: displayedTable ?? null,
                            rowCount: displayedTable?.numRows ?? 0,
                            ran: !!displayedRun,
                            running: !pinned && !!result?.running && result.attempt?.mode !== 'explain',
                            ok: !!displayedTable,
                            elapsedMs: displayedRun?.elapsedMs ?? 0,
                          }}
                          onExport={
                            displayedTable
                              ? async (format) => {
                                  try {
                                    await exportResult(displayedTable, format, cell.title);
                                    setExportError('');
                                  } catch (e) {
                                    setExportError(String(e));
                                  }
                                }
                              : undefined
                          }
                        />
                      )
                    }
                  </NotebookOutputResize>
                </TabsContent>
              </Tabs>
            )
          )}
        </>
      )}
      <Dialog
        open={draft !== null}
        onOpenChange={(open) => {
          if (!open) setDraft(null);
        }}
      >
        <DialogContent className="sm:max-w-3xl max-h-[90dvh] flex flex-col overflow-hidden">
          <DialogHeader>
            <DialogTitle>
              {cell.type === 'sql' && cell.charts.some((item) => item.id === draft?.id)
                ? 'Edit chart'
                : 'Add chart'}
            </DialogTitle>
            <DialogDescription>
              Configure a chart from this cell’s results. Save to add it to the notebook.
            </DialogDescription>
          </DialogHeader>
          <div className="min-h-0 overflow-y-auto">
            {draft && (
              <NotebookChartView
                chart={draft}
                table={result?.table}
                editing
                onChange={(next) => {
                  setDraft(next);
                  setDraftError('');
                }}
              />
            )}
          </div>
          {draftError && (
            <p role="alert" className="text-sm text-destructive">
              {draftError}
            </p>
          )}
          <DialogFooter className="shrink-0">
            <Button variant="outline" onClick={() => setDraft(null)}>
              Cancel
            </Button>
            <Button
              disabled={busy || !result?.table}
              onClick={() => {
                if (!draft || cell.type !== 'sql' || !result?.table) return;
                try {
                  chartSpec(draft, chartData(result.table).columns);
                } catch (e) {
                  setDraftError(e instanceof Error ? e.message : String(e));
                  return;
                }
                const exists = cell.charts.some((item) => item.id === draft.id);
                if (!exists && cell.charts.length >= 20) {
                  setDraftError('A cell can have up to 20 charts.');
                  return;
                }
                onChange({
                  ...cell,
                  charts: exists
                    ? cell.charts.map((item) => (item.id === draft.id ? draft : item))
                    : [...cell.charts, draft],
                });
                setOutput(draft.id);
                setDraft(null);
              }}
            >
              Save chart
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <NotebookRunDetails result={result} open={showDetails} onOpenChange={setShowDetails} />
      <Dialog open={showPlan} onOpenChange={setShowPlan}>
        <DialogContent className="sm:max-w-4xl max-h-[90dvh] flex flex-col overflow-hidden">
          <DialogHeader>
            <DialogTitle>Query plan</DialogTitle>
            <DialogDescription>
              EXPLAIN plans this cell with the current parameter values without executing its query.
            </DialogDescription>
          </DialogHeader>
          <div className="min-h-0 overflow-auto">
            {result?.running && result.attempt?.mode === 'explain' ? (
              <p role="status">
                <RunningStatus record={result.attempt} />
              </p>
            ) : result?.attempt?.mode === 'explain' && result.error ? (
              <p role="alert" className="text-destructive whitespace-pre-wrap">
                {result.error}
              </p>
            ) : result?.plan ? (
              <>
                <p className="text-xs text-muted-foreground">
                  Plan from run #{result.planProvenance?.number}
                </p>
                <ExplainView table={result.plan} />
              </>
            ) : (
              <p>No plan available.</p>
            )}
          </div>
          {result?.running && (
            <Button variant="outline" onClick={onStop}>
              Stop explanation
            </Button>
          )}
        </DialogContent>
      </Dialog>
    </section>
  );
}
