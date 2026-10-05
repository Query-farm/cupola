import { notebookHref, type NotebookNavigation } from '../../lib/notebooks/navigation';
import { lazy, Suspense, useEffect, useRef, useState, type CSSProperties, type RefObject } from 'react';
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
import { MoreHorizontal, Plus, Undo2, Redo2, ChevronLeft, Check, Loader2, AlertCircle } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from '../ui/dropdown-menu';
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
  deleteNotebook,
  NOTEBOOKS_CHANGED,
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
  navigation,
  onActiveChange,
}: {
  navigation?: NotebookNavigation | null;
  onActiveChange?: (id: string | null) => void;
  serviceUrl: string;
  catalogs: readonly CatalogData[];
  onBusyChange?: (busy: boolean) => void;
}) {
  const [active, setActive] = useState<Notebook | null>(null);
  const [navigationError, setNavigationError] = useState('');
  const beforeLeave = useRef<(() => boolean) | null>(null);
  const handledNavigation = useRef<number | null>(null);
  function openDocument(doc: Notebook | null, fromHistory = false) {
    setNavigationError('');
    setActive(doc);
    onActiveChange?.(doc?.id ?? null);
    const href = notebookHref(serviceUrl, doc?.id) + window.location.hash;
    if (!fromHistory && href !== window.location.pathname + window.location.search + window.location.hash)
      window.history.pushState(window.history.state, '', href);
  }
  useEffect(() => {
    if (!navigation || navigation.serviceUrl !== serviceUrl || handledNavigation.current === navigation.token)
      return;
    handledNavigation.current = navigation.token;
    if (!navigation.create && navigation.id === active?.id) return;
    if (beforeLeave.current && !beforeLeave.current()) {
      setNavigationError(
        'Notebook was kept open. Stop the running query or AI response, or resolve the save error, before switching notebooks.',
      );
      if (navigation.fromHistory)
        window.history.pushState(
          window.history.state,
          '',
          notebookHref(serviceUrl, active?.id) + window.location.hash,
        );
      return;
    }
    try {
      const target = navigation.create
        ? newNotebook(serviceUrl)
        : navigation.id
          ? listNotebooks(serviceUrl).documents.find((doc) => doc.id === navigation.id)
          : null;
      if (navigation.id && !target) {
        setNavigationError(
          'This notebook is unavailable in this browser for the current connection. It may have been deleted.',
        );
        return;
      }
      openDocument(target ?? null, navigation.fromHistory);
    } catch (e) {
      setNavigationError(`Could not open notebook: ${String(e)}`);
    }
  }, [navigation, serviceUrl]);
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
    window.addEventListener(NOTEBOOKS_CHANGED, handler);
    return () => {
      window.removeEventListener('storage', handler);
      window.removeEventListener(NOTEBOOKS_CHANGED, handler);
    };
  }, [serviceUrl]);
  if (active)
    return (
      <div className="h-full flex flex-col min-h-0">
        {navigationError && (
          <p role="alert" className="shrink-0 border-b px-4 py-2 text-sm text-destructive">
            {navigationError}
          </p>
        )}
        <div className="flex-1 min-h-0">
          <NotebookWorkspace
            key={active.id}
            beforeLeave={beforeLeave}
            initial={active}
            catalogs={catalogs}
            onBusyChange={onBusyChange}
            onClose={() => {
              openDocument(null);
              refresh();
            }}
          />
        </div>
      </div>
    );
  return (
    <div className="h-full overflow-auto p-4 md:p-6" data-testid="notebook-library">
      <div className="mx-auto max-w-5xl space-y-5">
        {navigationError && (
          <p role="alert" className="text-sm text-destructive">
            {navigationError}
          </p>
        )}
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex-1">
            <h1 className="text-2xl font-semibold">Notebooks</h1>
            <p className="text-sm text-muted-foreground mt-1">
              Explore with SQL, charts, and notes in one document.
            </p>
          </div>
          <Button onClick={() => openDocument(newNotebook(serviceUrl))}>New notebook</Button>
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
              openDocument(doc);
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
                <button className="text-left flex-1 min-w-40" onClick={() => openDocument(doc)}>
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
                    deleteNotebook(serviceUrl, deleteId);
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
  beforeLeave,
  initial,
  catalogs,
  onClose,
  onBusyChange,
}: {
  beforeLeave: RefObject<(() => boolean) | null>;
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
  const aiReturnFocus = useRef<HTMLElement | null>(null);
  function openAi(returnTo: HTMLElement | null) {
    aiReturnFocus.current = returnTo;
    setAiMounted(true);
    setShowAi(true);
  }
  function closeAi() {
    setShowAi(false);
    requestAnimationFrame(() =>
      requestAnimationFrame(() => aiReturnFocus.current?.focus({ preventScroll: true })),
    );
  }
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
  useEffect(() => {
    beforeLeave.current = () => !busy && persist();
    return () => {
      beforeLeave.current = null;
    };
  }, [busy, doc]);
  const changed = doc.cells
    .filter((cell) => cell.type === 'sql' && (!results[cell.id]?.table || isStale(cell, results[cell.id])))
    .map((cell) => cell.id);
  function focusCell(id?: string, editor = true) {
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        const target = id ? window.document.getElementById(`notebook-${id}`) : null;
        target?.scrollIntoView({ block: 'nearest' });
        const control =
          (editor ? target?.querySelector<HTMLElement>('.cm-content') : null) ??
          target?.querySelector<HTMLElement>('input[aria-label="Cell name"]');
        control?.focus({ preventScroll: true });
        if (!target)
          window.document.querySelector<HTMLElement>('[aria-label="Insert cell at position 1"]')?.focus();
      }),
    );
  }
  function add(type: NotebookCell['type'], index = latest.current.cells.length) {
    if (busy || latest.current.cells.length >= 200) return;
    const cell = newCell(type);
    const cells = [...latest.current.cells];
    cells.splice(index, 0, cell);
    change({ ...latest.current, cells });
    setSelected(cell.id);
    focusCell(cell.id);
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
          aria-label="Notebooks"
          title="Back to notebooks"
        >
          <ChevronLeft className="size-4 sm:hidden" />
          <span className="hidden sm:inline">Notebooks</span>
        </Button>
        <Input
          className="flex-1 min-w-40 max-w-md font-medium"
          aria-label="Notebook title"
          value={doc.title}
          maxLength={200}
          onChange={(event) => change({ ...doc, title: event.target.value })}
        />
        <span
          className="text-xs text-muted-foreground"
          role="status"
          title={
            storageError ? 'Not saved' : saved === fingerprint(doc) ? 'Saved in this browser' : 'Saving…'
          }
        >
          <span className="sr-only sm:not-sr-only">
            {storageError ? 'Not saved' : saved === fingerprint(doc) ? 'Saved in this browser' : 'Saving…'}
          </span>
          {storageError ? (
            <AlertCircle className="size-4 text-destructive sm:hidden" />
          ) : saved === fingerprint(doc) ? (
            <Check className="size-4 sm:hidden" />
          ) : (
            <Loader2 className="size-4 animate-spin sm:hidden" />
          )}
        </span>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={<Button size="icon-sm" variant="ghost" aria-label="Notebook actions" />}
          >
            <MoreHorizontal className="size-4" />
          </DropdownMenuTrigger>
          <DropdownMenuContent className="w-48">
            <DropdownMenuItem onClick={persist}>Save</DropdownMenuItem>
            <DropdownMenuItem onClick={() => download(doc)}>Export notebook</DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem disabled={busy || !Object.keys(results).length} onClick={() => setResults({})}>
              Clear all outputs
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label="Undo"
          title="Undo"
          disabled={!canUndo || busy}
          onClick={() => restore('undo')}
        >
          <Undo2 className="size-4" />
        </Button>
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label="Redo"
          title="Redo"
          disabled={!canRedo || busy}
          onClick={() => restore('redo')}
        >
          <Redo2 className="size-4" />
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
          onClick={(event) => {
            if (showAi) closeAi();
            else openAi(event.currentTarget);
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
      <div className="relative flex-1 min-h-0 flex flex-col lg:flex-row">
        <main
          className={`flex-1 min-w-0 min-h-0 overflow-auto px-3 py-5 md:px-8 ${showAi ? 'hidden lg:block' : ''}`}
        >
          <div className="mx-auto max-w-5xl">
            <InsertCell index={0} disabled={busy || doc.cells.length >= 200} onAdd={add} />
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
                  onRunAbove={() => void run(doc.cells.slice(0, index).map((item) => item.id))}
                  onRunBelow={() => void run(doc.cells.slice(index).map((item) => item.id))}
                  onClearOutput={() =>
                    setResults((previous) =>
                      Object.fromEntries(Object.entries(previous).filter(([id]) => id !== cell.id)),
                    )
                  }
                  onAskAi={() => {
                    setSelected(cell.id);
                    openAi(
                      window.document
                        .getElementById(`notebook-${cell.id}`)
                        ?.querySelector<HTMLElement>('[aria-label="Cell actions"]') ?? null,
                    );
                  }}
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
                    focusCell(doc.cells[index + 1]?.id ?? doc.cells[index - 1]?.id, false);
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
                <InsertCell index={index + 1} disabled={busy || doc.cells.length >= 200} onAdd={add} />
              </div>
            ))}
            {!doc.cells.length && (
              <p className="text-sm text-muted-foreground">Add a SQL cell or Markdown notes to begin.</p>
            )}
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
              showAi
                ? 'absolute inset-0 z-20 flex min-h-0 w-full lg:static lg:z-auto lg:w-[var(--notebook-ai-width)] shrink-0'
                : 'hidden'
            }
            style={{ '--notebook-ai-width': `${aiSizing.width}px` } as CSSProperties}
          >
            <Suspense fallback={<p className="p-3">Loading assistant…</p>}>
              <NotebookAgent
                active={showAi}
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
                onClose={closeAi}
                onBusy={setAiBusy}
              />
            </Suspense>
          </div>
        )}
      </div>
    </div>
  );
}

function InsertCell({
  index,
  disabled,
  onAdd,
}: {
  index: number;
  disabled: boolean;
  onAdd: (type: NotebookCell['type'], index: number) => void;
}) {
  return (
    <div
      className="group/insert flex h-9 items-center justify-center gap-2"
      aria-label={`Insert at position ${index + 1}`}
    >
      <span className="h-px flex-1 bg-border/0 group-hover/insert:bg-border group-focus-within/insert:bg-border" />
      <DropdownMenu>
        <DropdownMenuTrigger
          disabled={disabled}
          render={
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={`Insert cell at position ${index + 1}`}
              className="text-muted-foreground/60 hover:text-foreground"
            />
          }
        >
          <Plus className="size-3.5" />
        </DropdownMenuTrigger>
        <DropdownMenuContent className="w-44">
          <DropdownMenuItem onClick={() => onAdd('sql', index)}>SQL cell</DropdownMenuItem>
          <DropdownMenuItem onClick={() => onAdd('markdown', index)}>Markdown cell</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <span className="h-px flex-1 bg-border/0 group-hover/insert:bg-border group-focus-within/insert:bg-border" />
    </div>
  );
}
