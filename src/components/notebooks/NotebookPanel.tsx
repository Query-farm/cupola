import { lazy, Suspense, useEffect, useRef, useState, type CSSProperties } from 'react';
import { Button } from '../ui/button';
import { PanelResizeHandle, usePanelWidth } from '../shared/PanelResizeHandle';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '../ui/dialog';
import { Input } from '../ui/input';
import { NotebookCellView } from './NotebookCellView';
const NotebookAgent = lazy(() =>
  import('./NotebookAgent').then((module) => ({
    default: module.NotebookAgent,
  })),
);
import {
  newNotebook,
  newCell,
  duplicateCell,
  fingerprint,
  listNotebooks,
  saveNotebook,
  storageKey,
  importNotebook,
  type Notebook,
  type NotebookCell,
} from '../../lib/notebooks/model';
import { NotebookRunner, isStale, validateSelectQuery, type CellResult } from '../../lib/notebooks/execution';
import { EvidenceQueryRun } from '../../lib/evidence/query-run';
import { waitForEngineReady } from '../../lib/shell-bridge';
import { safeFileStem, triggerDownload } from '../../lib/editor/result-export';
import type { CatalogData } from '../../lib/service';

function download(doc: Notebook) {
  triggerDownload(
    new Blob([JSON.stringify(doc, null, 2)], { type: 'application/json' }),
    `${safeFileStem(doc.title)}.notebook.json`,
  );
}
export function NotebookPanel({
  serviceUrl,
  catalogs,
  onBusyChange,
}: {
  serviceUrl: string;
  catalogs: readonly CatalogData[];
  onBusyChange?: (busy: boolean) => void;
}) {
  const [active, setActive] = useState<Notebook | null>(null);
  const [documents, setDocuments] = useState<Notebook[]>([]);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const file = useRef<HTMLInputElement>(null);
  const keepNotebook = useRef<HTMLButtonElement>(null);
  function refresh() {
    try {
      const result = listNotebooks(serviceUrl);
      setDocuments(result.documents);
      setError(
        result.unreadable
          ? `${result.unreadable} saved notebook(s) could not be read. Their stored data has been preserved.`
          : '',
      );
    } catch (e) {
      setError(`Unable to read notebook storage: ${String(e)}`);
    }
  }
  useEffect(() => {
    refresh();
    const handler = () => refresh();
    window.addEventListener('storage', handler);
    return () => window.removeEventListener('storage', handler);
  }, [serviceUrl]);
  if (active)
    return (
      <NotebookWorkspace
        key={active.id}
        initial={active}
        catalogs={catalogs}
        onBusyChange={onBusyChange}
        onClose={() => {
          setActive(null);
          refresh();
        }}
      />
    );
  return (
    <div className="h-full overflow-auto p-4 md:p-6" data-testid="notebook-library">
      <div className="mx-auto max-w-5xl space-y-5">
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex-1">
            <h1 className="text-2xl font-semibold">Notebooks</h1>
            <p className="text-sm text-muted-foreground mt-1">
              Explore with SQL, charts, and notes in one document.
            </p>
          </div>
          <Button onClick={() => setActive(newNotebook(serviceUrl))}>New notebook</Button>
          <Button variant="outline" onClick={() => file.current?.click()}>
            Import notebook
          </Button>
        </div>
        <input
          ref={file}
          type="file"
          accept=".json,application/json"
          className="hidden"
          aria-label="Import notebook file"
          onChange={async (event) => {
            const selected = event.target.files?.[0];
            event.target.value = '';
            if (!selected) return;
            try {
              if (selected.size > 5_000_000) throw new Error('Notebook files must be smaller than 5 MB.');
              const doc = importNotebook(await selected.text(), serviceUrl);
              saveNotebook(doc);
              setActive(doc);
            } catch (e) {
              setError(`Import failed: ${e instanceof Error ? e.message : String(e)}`);
            }
          }}
        />
        <p className="text-xs text-muted-foreground">
          Saved in this browser for the current connection. Export a notebook file to back it up or share its
          definition. Results are rerun explicitly after opening.
        </p>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <Input
          aria-label="Search notebooks"
          placeholder="Search notebooks…"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
        {!documents.length && (
          <div className="rounded-lg border border-dashed p-12 text-center">
            <h2 className="font-medium">Start an investigation</h2>
            <p className="text-sm text-muted-foreground mt-2">
              Add SQL cells, turn results into charts, and explain your findings with Markdown.
            </p>
          </div>
        )}
        <div className="grid gap-3">
          {documents
            .filter((doc) => doc.title.toLowerCase().includes(search.toLowerCase()))
            .map((doc) => (
              <div key={doc.id} className="rounded-lg border p-4 flex flex-wrap items-center gap-3">
                <button className="text-left flex-1 min-w-40" onClick={() => setActive(doc)}>
                  <strong>{doc.title || 'Untitled notebook'}</strong>
                  <p className="text-xs text-muted-foreground mt-1">
                    {doc.cells.length} cells · Updated {new Date(doc.updatedAt).toLocaleString()}
                  </p>
                </button>
                <Button size="sm" variant="outline" onClick={() => download(doc)}>
                  Export
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setDeleteId(doc.id)}>
                  Delete
                </Button>
              </div>
            ))}
        </div>
        <Dialog
          open={deleteId !== null}
          onOpenChange={(open) => {
            if (!open) setDeleteId(null);
          }}
        >
          <DialogContent initialFocus={keepNotebook}>
            <DialogHeader>
              <DialogTitle>Delete notebook?</DialogTitle>
              <DialogDescription>
                Delete “{documents.find((doc) => doc.id === deleteId)?.title || 'Untitled notebook'}” from
                this browser? This cannot be undone.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button ref={keepNotebook} variant="outline" onClick={() => setDeleteId(null)}>
                Cancel
              </Button>
              <Button
                variant="destructive"
                onClick={() => {
                  if (!deleteId) return;
                  try {
                    localStorage.removeItem(storageKey(serviceUrl, deleteId));
                    setDeleteId(null);
                    refresh();
                  } catch (e) {
                    setError(String(e));
                    setDeleteId(null);
                  }
                }}
              >
                Confirm delete
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </div>
  );
}

function NotebookWorkspace({
  initial,
  catalogs,
  onClose,
  onBusyChange,
}: {
  initial: Notebook;
  catalogs: readonly CatalogData[];
  onClose: () => void;
  onBusyChange?: (busy: boolean) => void;
}) {
  const [doc, setDoc] = useState(initial);
  const latest = useRef(doc);
  latest.current = doc;
  const [results, setResults] = useState<Record<string, CellResult>>({});
  const [running, setRunning] = useState(false);
  const [aiBusy, setAiBusy] = useState(false);
  const [showAi, setShowAi] = useState(false);
  const aiSizing = usePanelWidth('cupola-notebook-ai-width', 384);
  const keepEditing = useRef<HTMLButtonElement>(null);
  const [aiMounted, setAiMounted] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [saved, setSaved] = useState('');
  const [storageError, setStorageError] = useState('');
  const [discardRequested, setDiscardRequested] = useState(false);
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);
  const undo = useRef<Notebook[]>([]),
    redo = useRef<Notebook[]>([]);
  const alive = useRef(true);
  const baseline = useRef<string | null | undefined>(undefined);
  if (baseline.current === undefined) {
    try {
      baseline.current = localStorage.getItem(storageKey(initial.serviceUrl, initial.id));
    } catch {
      /* persist will report the failure */
    }
  }
  const runner = useRef<NotebookRunner | null>(null);
  if (!runner.current)
    runner.current = new NotebookRunner(
      async (sql, signal) => {
        const run = new EvidenceQueryRun();
        const stop = () => run.stop();
        signal.addEventListener('abort', stop, { once: true });
        try {
          signal.throwIfAborted();
          await run.wait(waitForEngineReady());
          await validateSelectQuery(sql, (text, params) => run.query(text, params, signal));
          return await run.query(sql, [], signal);
        } finally {
          signal.removeEventListener('abort', stop);
          run.stop();
        }
      },
      (id, update) => {
        if (alive.current && latest.current.cells.some((cell) => cell.id === id))
          setResults((previous) => ({
            ...previous,
            [id]: { ...previous[id], ...update },
          }));
      },
    );
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      runner.current?.stop();
      onBusyChange?.(false);
    };
  }, []);
  useEffect(() => {
    onBusyChange?.(running || aiBusy);
  }, [running, aiBusy, onBusyChange]);
  useEffect(() => {
    const ids = new Set(doc.cells.filter((cell) => cell.type === 'sql').map((cell) => cell.id));
    setResults((previous) =>
      Object.keys(previous).some((id) => !ids.has(id))
        ? Object.fromEntries(Object.entries(previous).filter(([id]) => ids.has(id)))
        : previous,
    );
  }, [doc.cells]);
  function persist(): boolean {
    try {
      const current = localStorage.getItem(storageKey(doc.serviceUrl, doc.id));
      if (baseline.current !== undefined && current !== baseline.current)
        throw new Error(
          'This notebook was changed or deleted in another tab. Export your edits, then reopen it to avoid overwriting the other version.',
        );
      saveNotebook(latest.current);
      baseline.current = localStorage.getItem(storageKey(doc.serviceUrl, doc.id));
      setSaved(fingerprint(latest.current));
      setStorageError('');
      return true;
    } catch (e) {
      setStorageError(`Not saved: ${e instanceof Error ? e.message : String(e)}`);
      return false;
    }
  }
  useEffect(() => {
    const timer = setTimeout(persist, 400);
    return () => clearTimeout(timer);
  }, [doc]);
  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (fingerprint(latest.current) !== saved) event.preventDefault();
    };
    window.addEventListener('beforeunload', beforeUnload);
    return () => window.removeEventListener('beforeunload', beforeUnload);
  }, [saved]);
  function change(next: Notebook) {
    if (fingerprint(latest.current) === fingerprint(next)) return;
    undo.current = [...undo.current.slice(-99), latest.current];
    redo.current = [];
    setCanUndo(true);
    setCanRedo(false);
    const value = { ...next, updatedAt: Date.now() };
    latest.current = value;
    setDoc(value);
  }
  function restore(direction: 'undo' | 'redo') {
    const from = direction === 'undo' ? undo : redo,
      to = direction === 'undo' ? redo : undo;
    const next = from.current.pop();
    if (!next) return;
    to.current.push(latest.current);
    latest.current = { ...next, updatedAt: Date.now() };
    setDoc(latest.current);
    setCanUndo(!!undo.current.length);
    setCanRedo(!!redo.current.length);
  }
  const updateCell = (cell: NotebookCell) =>
    change({
      ...latest.current,
      cells: latest.current.cells.map((item) => (item.id === cell.id ? cell : item)),
    });
  async function run(ids?: string[]) {
    if (runner.current!.running || aiBusy) return;
    const cells = latest.current.cells.filter(
      (cell) => cell.type === 'sql' && (!ids || ids.includes(cell.id)),
    );
    setRunning(true);
    try {
      await runner.current!.run(cells as Extract<NotebookCell, { type: 'sql' }>[]);
    } finally {
      if (alive.current) setRunning(false);
    }
  }
  const busy = running || aiBusy;
  const changed = doc.cells
    .filter((cell) => cell.type === 'sql' && (!results[cell.id]?.table || isStale(cell, results[cell.id])))
    .map((cell) => cell.id);
  function add(type: NotebookCell['type']) {
    const cell = newCell(type);
    change({ ...latest.current, cells: [...latest.current.cells, cell] });
    setSelected(cell.id);
    requestAnimationFrame(() =>
      window.document
        .getElementById(`notebook-${cell.id}`)
        ?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }),
    );
  }
  return (
    <div
      className="h-full flex flex-col bg-background"
      data-testid="notebook-workspace"
      onKeyDown={(event) => {
        if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
          event.preventDefault();
          persist();
        }
        if (
          (event.metaKey || event.ctrlKey) &&
          event.key.toLowerCase() === 'z' &&
          !busy &&
          !(event.target as HTMLElement).closest('input,textarea,[contenteditable="true"]')
        ) {
          event.preventDefault();
          restore(event.shiftKey ? 'redo' : 'undo');
        }
      }}
    >
      <header className="border-b p-2 flex flex-wrap gap-2 items-center">
        <Button
          size="sm"
          variant="ghost"
          disabled={busy}
          onClick={() => {
            if (persist()) onClose();
          }}
        >
          Notebooks
        </Button>
        <Input
          className="flex-1 min-w-40 max-w-md font-medium"
          aria-label="Notebook title"
          value={doc.title}
          maxLength={200}
          onChange={(event) => change({ ...doc, title: event.target.value })}
        />
        <span className="text-xs text-muted-foreground" role="status">
          {storageError ? 'Not saved' : saved === fingerprint(doc) ? 'Saved in this browser' : 'Saving…'}
        </span>
        <Button size="sm" variant="outline" onClick={persist}>
          Save
        </Button>
        <Button size="sm" variant="outline" onClick={() => download(doc)}>
          Export
        </Button>
        <Button size="sm" variant="ghost" disabled={!canUndo || busy} onClick={() => restore('undo')}>
          Undo
        </Button>
        <Button size="sm" variant="ghost" disabled={!canRedo || busy} onClick={() => restore('redo')}>
          Redo
        </Button>
        {running ? (
          <Button size="sm" variant="destructive" onClick={() => runner.current!.stop()}>
            Stop all
          </Button>
        ) : (
          <Button
            size="sm"
            disabled={busy || !doc.cells.some((cell) => cell.type === 'sql')}
            onClick={() => void run()}
          >
            Run all
          </Button>
        )}
        <Button
          size="sm"
          variant="outline"
          disabled={busy || !changed.length}
          onClick={() => void run(changed)}
        >
          Run changed
        </Button>
        <Button
          size="sm"
          variant={showAi ? 'secondary' : 'outline'}
          onClick={() => {
            setAiMounted(true);
            setShowAi(!showAi);
          }}
        >
          Ask AI
        </Button>
      </header>
      {storageError && (
        <div className="p-2 text-sm border-b space-y-2">
          <p role="alert" className="text-destructive">
            {storageError} Export remains available.
          </p>
          <Button size="sm" variant="outline" disabled={busy} onClick={() => setDiscardRequested(true)}>
            Discard local edits…
          </Button>
        </div>
      )}
      <Dialog open={discardRequested} onOpenChange={setDiscardRequested}>
        <DialogContent initialFocus={keepEditing}>
          <DialogHeader>
            <DialogTitle>Discard unsaved edits?</DialogTitle>
            <DialogDescription>
              Return to the library and discard your local edits. The saved notebook will be kept.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button ref={keepEditing} variant="outline" onClick={() => setDiscardRequested(false)}>
              Keep editing
            </Button>
            <Button variant="destructive" disabled={busy} onClick={onClose}>
              Discard and return
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <div className="flex-1 min-h-0 flex flex-col lg:flex-row">
        <main className="flex-1 min-w-0 min-h-0 overflow-auto p-3 md:p-5 space-y-4">
          <p className="text-xs text-muted-foreground">
            SQL cells run independently against the current connection. Run all executes top to bottom and
            stops on an error. Charts use the last returned result.
          </p>
          {doc.cells.map((cell, index) => (
            <div key={cell.id} id={`notebook-${cell.id}`} onFocusCapture={() => setSelected(cell.id)}>
              <NotebookCellView
                cell={cell}
                result={results[cell.id]}
                busy={busy}
                first={index === 0}
                last={index === doc.cells.length - 1}
                onChange={updateCell}
                onRun={() => void run([cell.id])}
                onStop={() => runner.current!.stop()}
                onMove={(direction) => {
                  const cells = [...doc.cells];
                  [cells[index], cells[index + direction]] = [cells[index + direction], cells[index]];
                  change({ ...doc, cells });
                }}
                onDuplicate={() => {
                  if (doc.cells.length >= 200) return;
                  const cells = [...doc.cells];
                  cells.splice(index + 1, 0, duplicateCell(cell));
                  change({ ...doc, cells });
                }}
                onDelete={() => {
                  change({
                    ...doc,
                    cells: doc.cells.filter((item) => item.id !== cell.id),
                  });
                  setResults((previous) => {
                    const next = { ...previous };
                    delete next[cell.id];
                    return next;
                  });
                }}
              />
            </div>
          ))}
          {!doc.cells.length && (
            <p className="text-sm text-muted-foreground">Add a SQL cell or Markdown notes to begin.</p>
          )}
          <div className="flex gap-2 pb-5">
            <Button variant="outline" disabled={doc.cells.length >= 200 || busy} onClick={() => add('sql')}>
              + SQL cell
            </Button>
            <Button
              variant="outline"
              disabled={doc.cells.length >= 200 || busy}
              onClick={() => add('markdown')}
            >
              + Markdown cell
            </Button>
          </div>
        </main>
        {showAi && (
          <PanelResizeHandle
            sizing={aiSizing}
            label="Resize notebook assistant"
            className="hidden lg:block"
          />
        )}
        {aiMounted && (
          <div
            className={
              showAi ? 'flex min-h-0 h-96 lg:h-auto lg:w-[var(--notebook-ai-width)] shrink-0' : 'hidden'
            }
            style={{ '--notebook-ai-width': `${aiSizing.width}px` } as CSSProperties}
          >
            <Suspense fallback={<p className="p-3">Loading assistant…</p>}>
              <NotebookAgent
                disabled={running}
                document={doc}
                results={results}
                selectedCell={selected}
                catalogs={catalogs}
                onApply={(next) => {
                  const previous = latest.current;
                  const target =
                    next.cells.find((cell) => !previous.cells.some((old) => old.id === cell.id)) ??
                    next.cells.find(
                      (cell) =>
                        JSON.stringify(cell) !==
                        JSON.stringify(previous.cells.find((old) => old.id === cell.id)),
                    );
                  change(next);
                  if (target) {
                    setSelected(target.id);
                    requestAnimationFrame(() =>
                      window.document
                        .getElementById('notebook-' + target.id)
                        ?.scrollIntoView({ block: 'nearest' }),
                    );
                  }
                }}
                onClose={() => setShowAi(false)}
                onBusy={setAiBusy}
              />
            </Suspense>
          </div>
        )}
      </div>
    </div>
  );
}
