/**
 * Manage workspaces (multi-catalog phase 3; docs/multi-catalog.md): a large
 * two-pane dialog, the workspaces on the left and the selected one on the
 * right. Opened from the picker's "Manage workspaces…" and from the welcome
 * page.
 *
 * What applies when (kept predictable on purpose):
 * - **Toggles apply at once**: enabled, the default radio, colour, order,
 *   Remove, + Add catalog, and the workspace's name. For the open workspace
 *   they go through the same live actions as the picker (`live`), so Enable
 *   attaches, Disable and Remove detach, the default gets `USE`, and the
 *   sidebar reorders, all without a reload.
 * - **Connection fields are a draft** (alias, URL, server catalog, options):
 *   nothing is stored until Save. For the open workspace the button reads
 *   "Save and re-attach", and saving re-attaches that catalog only
 *   (`live.reattach`), the same as the picker's Edit options. A half-typed
 *   URL never re-attaches anything.
 * - The open workspace cannot be deleted from here; the button says so.
 *
 * A changed alias goes through `onAliasRenameRequested` first (the SQL that
 * names the old alias is someone else's business: phase 3C's rewrite dialog).
 * Workspace file import/export is phase 3B's, in the footer slot.
 */
import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type DragEvent, type KeyboardEvent } from "react";
import {
  AlertTriangle, ArrowDown, ArrowUp, CheckCircle2, ChevronDown, ChevronRight, Copy, ExternalLink, GripVertical, Loader2, LogIn,
  MoreHorizontal, Pencil, Plug, Plus, Star, Trash2, X,
} from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "../ui/dialog";
import { Button, buttonVariants } from "../ui/button";
import { Switch } from "../ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../ui/tabs";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "../ui/dropdown-menu";
import { OptionsFields } from "../AttachOptions";
import { CatalogChip, ChipStack } from "./CatalogChip";
import { AttachCatalogForm, type AttachRequest } from "./AttachCatalogForm";
import { fetchServiceCatalogs, testServiceConnection } from "@/lib/service";
import { collectFormOptions, optionRows, optionsToSqlText, sqlTextToOptions } from "@/lib/attach/form";
import { partitionSecrets, type OptionSpecInfo } from "@/lib/attach/options";
import { saveFormOptions } from "@/lib/attach/connection";
import { catalogSecrets, saveCatalogSecrets } from "@/lib/attach/secret-store";
import type { CatalogAttachState } from "@/lib/shell-bridge";
import {
  addCatalog, catalogOptionSink, deleteWorkspace, duplicateWorkspace, hostOf, listWorkspaces, PALETTE_SIZE,
  removeCatalog, renameWorkspace, reorderCatalogs, setCatalogColor, setCatalogEnabled, setDefaultCatalog, subscribeWorkspaces,
  updateCatalog, workspaceLabel, type Workspace, type WorkspaceCatalog,
} from "@/lib/workspace/store";
import {
  aliasEditProblem, describeConnectionTest, draftChanges, draftOf, dropOnto, moveAnnouncement, moveBy, normalizeWorkspaceName,
  PALETTE_NAMES, urlProblem, type CatalogDraft, type ConnectionTest,
} from "@/lib/workspace/manager";
import { confirmAliasRename, type AliasRenameHandler } from "@/lib/workspace/alias-rename-confirm";
import { cn } from "@/lib/utils";

/** The running engine's side of the open workspace. Every action here also
 *  writes the store, so the manager calls these *instead of* the store for
 *  the open workspace (except `reattach` and `reordered`, which follow a
 *  store write the manager has already made). */
export interface LiveWorkspaceHooks {
  attach: (requests: AttachRequest[]) => Promise<string | null>;
  setEnabled: (catalogId: string, enabled: boolean) => void;
  makeDefault: (catalogId: string) => void;
  /** Remove from the workspace and detach (with the app's undo toast). */
  remove: (catalogId: string) => void;
  /** The stored connection changed (URL, alias, server catalog, options):
   *  detach it under its old alias and attach it again. */
  reattach: (catalogId: string) => Promise<void>;
  /** The stored catalog order changed: the sidebar follows it. */
  reordered: () => void;
  rename: (name: string | null) => void;
  /** The catalog's attach status on this page. */
  status: (catalogId: string) => { state: CatalogAttachState; error?: string } | undefined;
}

export type { AliasRenameHandler };
export { confirmAliasRename };

export interface WorkspaceManagerProps {
  open: boolean;
  onClose: () => void;
  /** The workspace this page has open, if any (the welcome page has none). */
  currentWorkspaceId?: string | null;
  /** Selected first; defaults to the open workspace, then the most recent. */
  initialWorkspaceId?: string | null;
  /** Open a workspace (navigates; the open one just closes the manager). */
  onOpenWorkspace: (id: string) => void;
  /** The engine's side of the open workspace. */
  live?: LiveWorkspaceHooks;
  /** Asked before an alias changes; resolves true once it has changed.
   *  Defaults to a plain confirm that rewrites nothing. */
  // phase3-wire: AliasRenameDialog
  onAliasRenameRequested?: AliasRenameHandler;
}

const EMPTY: Workspace[] = [];
const inputClass = "w-full px-2.5 py-1.5 rounded-md border border-input bg-card text-foreground text-sm focus:outline-none focus:ring-2 focus:ring-ring aria-[invalid=true]:border-destructive";

export function WorkspaceManager({ open, onClose, currentWorkspaceId, initialWorkspaceId, onOpenWorkspace, live, onAliasRenameRequested = confirmAliasRename }: WorkspaceManagerProps) {
  const workspaces = useSyncExternalStore(subscribeWorkspaces, listWorkspaces, () => EMPTY);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  useEffect(() => {
    if (open) setSelectedId(initialWorkspaceId ?? currentWorkspaceId ?? listWorkspaces()[0]?.id ?? null);
  }, [open, initialWorkspaceId, currentWorkspaceId]);
  // A deleted (or retired) selection falls back to the first.
  const selected = workspaces.find((w) => w.id === selectedId) ?? workspaces[0] ?? null;

  const listKeys = (e: KeyboardEvent<HTMLUListElement>) => {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) return;
    const items = [...e.currentTarget.querySelectorAll<HTMLButtonElement>("button[data-ws-item]")];
    const i = items.indexOf(document.activeElement as HTMLButtonElement);
    const next = e.key === "Home" ? 0 : e.key === "End" ? items.length - 1 : e.key === "ArrowDown" ? Math.min(items.length - 1, i + 1) : Math.max(0, i - 1);
    e.preventDefault();
    items[next]?.focus();
    items[next]?.click();
  };

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
      <DialogContent
        className="sm:max-w-5xl w-[calc(100%-1rem)] h-[90dvh] p-0 gap-0 flex flex-col overflow-hidden"
        data-testid="workspace-manager"
      >
        <div className="px-4 py-3 border-b border-border pr-12">
          <DialogTitle>Manage workspaces</DialogTitle>
          <DialogDescription className="text-xs">
            Changes save as you make them. Connection fields (alias, URL, options) save when you press Save.
          </DialogDescription>
        </div>
        <div className="flex-1 min-h-0 flex flex-col sm:flex-row">
          <nav aria-label="Workspaces" className="sm:w-64 shrink-0 border-b sm:border-b-0 sm:border-r border-border bg-muted/30 overflow-y-auto max-h-40 sm:max-h-none">
            {workspaces.length === 0 ? (
              <p className="p-4 text-sm text-muted-foreground">No workspaces yet. Connect to a catalog to start one.</p>
            ) : (
              <ul className="p-2 space-y-0.5" onKeyDown={listKeys} data-testid="workspace-manager-list">
                {workspaces.map((w) => (
                  <li key={w.id}>
                    <button
                      type="button"
                      data-ws-item
                      aria-current={selected?.id === w.id ? "true" : undefined}
                      tabIndex={selected?.id === w.id ? 0 : -1}
                      onClick={() => setSelectedId(w.id)}
                      className={cn(
                        "w-full flex items-center gap-2 rounded-md px-2.5 py-2 text-left text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring",
                        selected?.id === w.id ? "bg-card ring-1 ring-border font-medium" : "hover:bg-muted",
                      )}
                      data-testid="workspace-manager-item"
                    >
                      <ChipStack catalogs={w.catalogs} />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate">{workspaceLabel(w)}</span>
                        <span className="block text-[11px] font-normal text-muted-foreground">
                          {w.name ? "" : "Untitled · "}{w.catalogs.length} {w.catalogs.length === 1 ? "catalog" : "catalogs"}
                          {w.id === currentWorkspaceId ? " · open" : ""}
                        </span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </nav>
          <section className="flex-1 min-w-0 min-h-0 overflow-y-auto" aria-label={selected ? `Workspace ${workspaceLabel(selected)}` : "Workspace"}>
            {selected ? (
              <WorkspaceDetail
                key={selected.id}
                ws={selected}
                isCurrent={selected.id === currentWorkspaceId}
                live={selected.id === currentWorkspaceId ? live : undefined}
                onOpen={() => { if (selected.id === currentWorkspaceId) onClose(); else onOpenWorkspace(selected.id); }}
                onSelect={setSelectedId}
                onAliasRenameRequested={onAliasRenameRequested}
              />
            ) : (
              <p className="p-6 text-sm text-muted-foreground">Select a workspace.</p>
            )}
          </section>
        </div>
        <div className="flex flex-wrap items-center gap-2 border-t border-border bg-muted/40 px-4 py-2.5" data-testid="workspace-manager-footer">
          {/* phase3-wire: WorkspaceFileActions */}
          <span className="flex-1" />
          <Button variant="outline" onClick={onClose}>Done</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// One workspace
// ---------------------------------------------------------------------------

function WorkspaceDetail({ ws, isCurrent, live, onOpen, onSelect, onAliasRenameRequested }: {
  ws: Workspace;
  isCurrent: boolean;
  live?: LiveWorkspaceHooks;
  onOpen: () => void;
  onSelect: (id: string) => void;
  onAliasRenameRequested: AliasRenameHandler;
}) {
  const [name, setName] = useState(ws.name ?? "");
  useEffect(() => { setName(ws.name ?? ""); }, [ws.name]);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [adding, setAdding] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [announcement, setAnnouncement] = useState("");
  const [dragging, setDragging] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<{ id: string; position: "before" | "after" } | null>(null);
  const handleRefs = useRef(new Map<string, HTMLButtonElement>());
  const focusAfterMove = useRef<string | null>(null);
  const cancelDeleteRef = useRef<HTMLButtonElement>(null);
  useEffect(() => { if (confirmDelete) cancelDeleteRef.current?.focus(); }, [confirmDelete]);

  const ids = ws.catalogs.map((c) => c.id);
  useEffect(() => {
    const id = focusAfterMove.current;
    if (!id) return;
    focusAfterMove.current = null;
    handleRefs.current.get(id)?.focus();
  });

  const commitName = () => {
    const next = normalizeWorkspaceName(name);
    if (next === ws.name) return;
    if (live) live.rename(next); else renameWorkspace(ws.id, next);
  };

  const applyOrder = (order: string[], movedId: string) => {
    if (!reorderCatalogs(ws.id, order)) return;
    live?.reordered();
    const alias = ws.catalogs.find((c) => c.id === movedId)?.alias || "catalog";
    setAnnouncement(moveAnnouncement(alias, order, movedId));
  };
  const move = (id: string, delta: number, refocus = false) => {
    const order = moveBy(ids, id, delta);
    if (order.every((x, i) => x === ids[i])) return;
    if (refocus) focusAfterMove.current = id;
    applyOrder(order, id);
  };

  const onDrop = (e: DragEvent<HTMLLIElement>, targetId: string) => {
    e.preventDefault();
    const dragged = dragging ?? e.dataTransfer.getData("text/x-cupola-catalog");
    setDragging(null);
    setDropTarget(null);
    if (!dragged || dragged === targetId) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const position = e.clientY < rect.top + rect.height / 2 ? "before" : "after";
    applyOrder(dropOnto(ids, dragged, targetId, position), dragged);
  };

  const setDefault = (id: string) => {
    if (ws.defaultCatalogId === id) return;
    if (live) live.makeDefault(id); else setDefaultCatalog(ws.id, id);
  };
  const setEnabled = (id: string, enabled: boolean) => {
    if (live) live.setEnabled(id, enabled); else setCatalogEnabled(ws.id, id, enabled);
  };
  const remove = (id: string) => {
    if (live) live.remove(id); else removeCatalog(ws.id, id);
  };

  const attach = async (requests: AttachRequest[]): Promise<string | null> => {
    if (live) {
      const error = await live.attach(requests);
      if (!error) setAdding(false);
      return error;
    }
    for (const r of requests) {
      const catalog = addCatalog(ws.id, { url: r.url, catalogName: r.catalogName, alias: r.alias, options: r.options, rawOptions: r.rawOptions });
      if (!catalog) return "The catalog could not be added to this workspace.";
      if (Object.keys(r.secrets).length) saveCatalogSecrets({ workspaceId: ws.id, catalogId: catalog.id, url: r.url, catalogName: r.catalogName }, r.secrets, { replace: true });
    }
    setAdding(false);
    return null;
  };

  return (
    <div className="p-4 sm:p-5 flex flex-col gap-5" data-testid="workspace-manager-detail" data-workspace-id={ws.id}>
      {/* Name and workspace actions */}
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-end gap-2">
          <label className="flex-1 min-w-48 flex flex-col gap-1 text-xs font-medium text-foreground">
            Name
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              onBlur={commitName}
              onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); commitName(); } }}
              placeholder={`Untitled (${workspaceLabel({ name: null, catalogs: ws.catalogs })})`}
              maxLength={200}
              className={inputClass}
              data-testid="workspace-manager-name"
            />
          </label>
          <Button variant="outline" onClick={onOpen} data-testid="workspace-manager-open">
            <ExternalLink className="size-4" aria-hidden="true" />{isCurrent ? "Back to it" : "Open"}
          </Button>
          <Button variant="outline" onClick={() => { const copy = duplicateWorkspace(ws.id); if (copy) onSelect(copy.id); }} data-testid="workspace-manager-duplicate">
            <Copy className="size-4" aria-hidden="true" />Duplicate
          </Button>
          <Button
            variant="outline"
            className="text-destructive"
            disabled={isCurrent}
            aria-describedby={isCurrent ? `ws-delete-note-${ws.id}` : undefined}
            onClick={() => setConfirmDelete(true)}
            data-testid="workspace-manager-delete"
          >
            <Trash2 className="size-4" aria-hidden="true" />Delete
          </Button>
        </div>
        {isCurrent && (
          <p id={`ws-delete-note-${ws.id}`} className="text-[11px] text-muted-foreground">
            This workspace is open in this tab, so it can't be deleted here. Open another workspace first.
          </p>
        )}
        {confirmDelete && (
          <div role="alertdialog" aria-labelledby={`ws-delete-title-${ws.id}`} aria-describedby={`ws-delete-desc-${ws.id}`} className="rounded-md border border-destructive/40 bg-destructive/5 p-3 flex flex-col gap-2" data-testid="workspace-manager-delete-confirm"
            onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); setConfirmDelete(false); } }}>
            <p id={`ws-delete-title-${ws.id}`} className="text-sm font-medium text-foreground flex items-center gap-1.5">
              <AlertTriangle className="size-4 text-destructive" aria-hidden="true" />Delete “{workspaceLabel(ws)}”?
            </p>
            <p id={`ws-delete-desc-${ws.id}`} className="text-xs text-muted-foreground">
              Its {ws.catalogs.length} {ws.catalogs.length === 1 ? "catalog" : "catalogs"} and the secrets stored for them are removed from this browser.
              Its editor tabs, query history and reports stay in storage. This can't be undone.
            </p>
            <div className="flex gap-2 justify-end">
              <Button ref={cancelDeleteRef} size="sm" variant="ghost" onClick={() => setConfirmDelete(false)}>Cancel</Button>
              <Button size="sm" variant="destructive" onClick={() => { setConfirmDelete(false); deleteWorkspace(ws.id); }} data-testid="workspace-manager-delete-confirm-button">
                Delete workspace
              </Button>
            </div>
          </div>
        )}
      </div>

      {/* Catalogs */}
      <div className="flex flex-col gap-2">
        <div className="flex items-baseline justify-between gap-2">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground" id={`ws-catalogs-${ws.id}`}>Catalogs</h3>
          <span className="text-[11px] text-muted-foreground">Order sets the sidebar order. Drag a handle, or focus it and press ↑ / ↓.</span>
        </div>
        <div className="sr-only" aria-live="polite" role="status">{announcement}</div>
        {ws.catalogs.length === 0 && !adding && <p className="text-sm text-muted-foreground">No catalogs in this workspace.</p>}
        <ol aria-labelledby={`ws-catalogs-${ws.id}`} className="flex flex-col gap-2" data-testid="workspace-manager-catalogs">
          {ws.catalogs.map((c, index) => (
            <li
              key={c.id}
              onDragOver={(e) => {
                if (!dragging) return;
                e.preventDefault();
                const rect = e.currentTarget.getBoundingClientRect();
                setDropTarget({ id: c.id, position: e.clientY < rect.top + rect.height / 2 ? "before" : "after" });
              }}
              onDragLeave={() => setDropTarget((t) => (t?.id === c.id ? null : t))}
              onDrop={(e) => onDrop(e, c.id)}
              className={cn(
                "rounded-lg border border-border bg-card",
                dragging === c.id && "opacity-50",
                dropTarget?.id === c.id && dropTarget.position === "before" && "border-t-2 border-t-primary",
                dropTarget?.id === c.id && dropTarget.position === "after" && "border-b-2 border-b-primary",
              )}
              data-testid="workspace-manager-catalog"
              data-catalog-id={c.id}
              data-alias={c.alias}
            >
              <CatalogRow
                ws={ws}
                catalog={c}
                index={index}
                count={ws.catalogs.length}
                isDefault={ws.defaultCatalogId === c.id}
                status={live?.status(c.id)}
                expanded={expanded.has(c.id)}
                onToggleExpanded={() => setExpanded((s) => { const n = new Set(s); if (n.has(c.id)) n.delete(c.id); else n.add(c.id); return n; })}
                handleRef={(el) => { if (el) handleRefs.current.set(c.id, el); else handleRefs.current.delete(c.id); }}
                onMove={(delta, refocus) => move(c.id, delta, refocus)}
                onDragStart={(e) => {
                  setDragging(c.id);
                  e.dataTransfer.effectAllowed = "move";
                  e.dataTransfer.setData("text/x-cupola-catalog", c.id);
                  const li = (e.currentTarget as HTMLElement).closest("li");
                  if (li) e.dataTransfer.setDragImage(li, 16, 16);
                }}
                onDragEnd={() => { setDragging(null); setDropTarget(null); }}
                onDefault={() => setDefault(c.id)}
                onEnabled={(on) => setEnabled(c.id, on)}
                onRemove={() => remove(c.id)}
              />
              {expanded.has(c.id) && (
                <CatalogEditor
                  ws={ws}
                  catalog={c}
                  live={live}
                  onAliasRenameRequested={onAliasRenameRequested}
                  onDone={() => setExpanded((s) => { const n = new Set(s); n.delete(c.id); return n; })}
                />
              )}
            </li>
          ))}
        </ol>
        {adding ? (
          <div className="rounded-lg border border-border bg-card" data-testid="workspace-manager-add">
            <AttachCatalogForm takenAliases={ws.catalogs.map((c) => c.alias).filter(Boolean)} onAttach={attach} onCancel={() => setAdding(false)} />
          </div>
        ) : (
          <div>
            <Button variant="outline" size="sm" onClick={() => setAdding(true)} data-testid="workspace-manager-add-catalog">
              <Plus className="size-4" aria-hidden="true" />Add catalog
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// One catalog's row
// ---------------------------------------------------------------------------

function StatusLine({ status, enabled }: { status?: { state: CatalogAttachState; error?: string }; enabled: boolean }) {
  if (!enabled) return <span className="text-[11px] text-muted-foreground">Disabled</span>;
  if (!status) return null;
  const common = "inline-flex items-center gap-1 text-[11px]";
  switch (status.state) {
    case "attached": return <span className={common}><CheckCircle2 className="size-3.5 text-emerald-600 dark:text-emerald-400" aria-hidden="true" />Attached</span>;
    case "connecting": return <span className={common}><Loader2 className="size-3.5 animate-spin text-muted-foreground" aria-hidden="true" />Connecting…</span>;
    case "sign-in-required": return <span className={common}><LogIn className="size-3.5 text-amber-600 dark:text-amber-400" aria-hidden="true" />Sign-in required</span>;
    case "failed": return <span className={common} title={status.error}><AlertTriangle className="size-3.5 text-destructive" aria-hidden="true" />Failed</span>;
    case "disabled": return <span className="text-[11px] text-muted-foreground">Disabled</span>;
  }
}

function TestResult({ result, catalogName }: { result: ConnectionTest | "running" | null; catalogName: string }) {
  if (!result) return null;
  if (result === "running") {
    return <p className="flex items-center gap-1.5 text-xs text-muted-foreground" data-testid="catalog-test-result"><Loader2 className="size-3.5 animate-spin" aria-hidden="true" />Testing…</p>;
  }
  const good = result.ok && result.catalogFound;
  return (
    <p className={cn("flex items-start gap-1.5 text-xs break-words", good ? "text-foreground" : "text-destructive")} data-testid="catalog-test-result" data-ok={good}>
      {good
        ? <CheckCircle2 className="size-3.5 mt-px shrink-0 text-emerald-600 dark:text-emerald-400" aria-hidden="true" />
        : <AlertTriangle className="size-3.5 mt-px shrink-0" aria-hidden="true" />}
      <span><span className="sr-only">{good ? "Success: " : "Problem: "}</span>{describeConnectionTest(result, catalogName)}</span>
    </p>
  );
}

function isGrainlift(url: string): boolean {
  return /^grainlift/i.test(url.trim());
}

function CatalogRow({
  ws, catalog: c, index, count, isDefault, status, expanded, onToggleExpanded, handleRef, onMove, onDragStart, onDragEnd, onDefault, onEnabled, onRemove,
}: {
  ws: Workspace;
  catalog: WorkspaceCatalog;
  index: number;
  count: number;
  isDefault: boolean;
  status?: { state: CatalogAttachState; error?: string };
  expanded: boolean;
  onToggleExpanded: () => void;
  handleRef: (el: HTMLButtonElement | null) => void;
  onMove: (delta: number, refocus?: boolean) => void;
  onDragStart: (e: DragEvent<HTMLElement>) => void;
  onDragEnd: () => void;
  onDefault: () => void;
  onEnabled: (enabled: boolean) => void;
  onRemove: () => void;
}) {
  const [test, setTest] = useState<ConnectionTest | "running" | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const label = c.alias || c.catalogName || hostOf(c.url);
  const hintId = `catalog-move-hint-${c.id}`;

  const runTest = async () => {
    if (isGrainlift(c.url)) {
      setTest({ ok: false, latencyMs: 0, error: "Test connection reads VGI servers over RPC; a Grainlift gateway is checked when it attaches.", signInRequired: false });
      return;
    }
    setTest("running");
    setTest(await testServiceConnection(c.url, c.catalogName));
  };

  return (
    <div className="flex flex-col gap-1.5 px-2 py-2">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <button
          type="button"
          ref={handleRef}
          draggable
          onDragStart={onDragStart}
          onDragEnd={onDragEnd}
          onKeyDown={(e) => {
            if (e.key === "ArrowUp" || e.key === "ArrowDown") {
              e.preventDefault();
              onMove(e.key === "ArrowUp" ? -1 : 1, true);
            }
          }}
          aria-label={`Reorder ${label}, position ${index + 1} of ${count}`}
          aria-describedby={hintId}
          className="cursor-grab active:cursor-grabbing rounded p-1 text-muted-foreground hover:text-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          data-testid="catalog-drag-handle"
        >
          <GripVertical className="size-4" aria-hidden="true" />
        </button>
        <span id={hintId} className="sr-only">Press Up or Down arrow to move it.</span>
        <CatalogChip alias={label} color={c.color} />
        <button
          type="button"
          onClick={onToggleExpanded}
          aria-expanded={expanded}
          className="min-w-0 flex-1 flex items-center gap-1.5 text-left rounded outline-none focus-visible:ring-2 focus-visible:ring-ring"
          data-testid="catalog-edit-toggle"
        >
          {expanded ? <ChevronDown className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" /> : <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />}
          <span className="min-w-0">
            <span className="flex items-center gap-1 font-mono text-sm font-medium text-foreground truncate">
              {label}
              {isDefault && <Star className="size-3.5 shrink-0 fill-current text-amber-500" aria-label="default" />}
            </span>
            <span className="block text-[11px] text-muted-foreground truncate">{hostOf(c.url)}{c.catalogName && c.catalogName !== c.alias ? ` · catalog ${c.catalogName}` : ""}</span>
          </span>
          <span className="sr-only">{expanded ? "Hide settings" : "Edit settings"}</span>
        </button>
        <StatusLine status={status} enabled={c.enabled} />
        <label className="flex items-center gap-1 text-xs text-foreground cursor-pointer">
          <input
            type="radio"
            name={`default-catalog-${ws.id}`}
            checked={isDefault}
            onChange={onDefault}
            className="accent-primary"
            data-testid="catalog-default-radio"
          />
          Default
        </label>
        <label className="flex items-center gap-1.5 text-xs text-foreground">
          <Switch checked={c.enabled} onCheckedChange={(on) => onEnabled(on)} aria-label={`Enabled: attach ${label} when the workspace opens`} data-testid="catalog-enabled-switch" />
          <span aria-hidden="true">{c.enabled ? "Enabled" : "Disabled"}</span>
        </label>
        <DropdownMenu>
          <DropdownMenuTrigger aria-label={`More actions for ${label}`} className={buttonVariants({ variant: "ghost", size: "icon-sm" })} data-testid="catalog-more">
            <MoreHorizontal aria-hidden="true" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={onToggleExpanded}><Pencil />{expanded ? "Hide settings" : "Edit settings"}</DropdownMenuItem>
            <DropdownMenuItem disabled={index === 0} onClick={() => onMove(-1)} data-testid="catalog-move-up"><ArrowUp />Move up</DropdownMenuItem>
            <DropdownMenuItem disabled={index === count - 1} onClick={() => onMove(1)} data-testid="catalog-move-down"><ArrowDown />Move down</DropdownMenuItem>
            <DropdownMenuItem onClick={() => void runTest()} data-testid="catalog-test"><Plug />Test connection</DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onClick={() => setConfirmRemove(true)} data-testid="catalog-remove"><Trash2 />Remove</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <div className="pl-8 flex flex-col gap-1">
        <div className="flex items-center gap-2">
          <Button size="xs" variant="ghost" onClick={() => void runTest()} disabled={test === "running"} data-testid="catalog-test-button">
            <Plug className="size-3.5" aria-hidden="true" />Test connection
          </Button>
          {test && test !== "running" && (
            <button type="button" className="text-muted-foreground hover:text-foreground" aria-label="Clear test result" onClick={() => setTest(null)}><X className="size-3.5" aria-hidden="true" /></button>
          )}
        </div>
        <div aria-live="polite"><TestResult result={test} catalogName={c.catalogName} /></div>
        {confirmRemove && (
          <div role="alertdialog" aria-label={`Remove ${label}`} className="flex flex-wrap items-center gap-2 rounded-md border border-destructive/40 bg-destructive/5 px-2.5 py-1.5" data-testid="catalog-remove-confirm"
            onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); setConfirmRemove(false); } }}>
            <span className="text-xs flex-1">Remove <span className="font-mono">{label}</span> from this workspace?</span>
            <Button size="xs" variant="ghost" autoFocus onClick={() => setConfirmRemove(false)}>Cancel</Button>
            <Button size="xs" variant="destructive" onClick={() => { setConfirmRemove(false); onRemove(); }} data-testid="catalog-remove-confirm-button">Remove</Button>
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// One catalog's connection fields
// ---------------------------------------------------------------------------

type Discovered = { state: "loading" } | { state: "ok"; catalogs: { name: string; specs: OptionSpecInfo[] }[] } | { state: "error"; error: string } | { state: "none" };

function CatalogEditor({ ws, catalog: c, live, onAliasRenameRequested, onDone }: {
  ws: Workspace;
  catalog: WorkspaceCatalog;
  live?: LiveWorkspaceHooks;
  onAliasRenameRequested: AliasRenameHandler;
  onDone: () => void;
}) {
  const secretRef = { workspaceId: ws.id, catalogId: c.id, url: c.url, catalogName: c.catalogName };
  const stored = useMemo(() => ({ ...draftOf(c, catalogSecrets(secretRef)), catalogName: c.catalogName }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [c.alias, c.url, c.target, c.catalogName, JSON.stringify(c.options), c.rawOptions]);
  const [draft, setDraft] = useState<CatalogDraft & { catalogName: string }>(stored);
  const [tab, setTab] = useState<"options" | "sql">("options");
  const [errors, setErrors] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [discovered, setDiscovered] = useState<Discovered>({ state: "none" });
  const idPrefix = `mgr-${c.id}`;

  // Read the server's catalogs and declared options for the draft URL.
  const url = draft.url.trim();
  useEffect(() => {
    if (urlProblem(url) || isGrainlift(url)) { setDiscovered({ state: "none" }); return; }
    let live = true;
    setDiscovered({ state: "loading" });
    const timer = setTimeout(() => {
      void fetchServiceCatalogs(url).then((found) => {
        if (!live) return;
        setDiscovered(found.ok ? { state: "ok", catalogs: found.catalogs } : { state: "error", error: found.error });
      });
    }, 300);
    return () => { live = false; clearTimeout(timer); };
  }, [url]);

  const serverCatalogs = discovered.state === "ok" ? discovered.catalogs : [];
  const match = serverCatalogs.find((x) => x.name === draft.catalogName) ?? (draft.catalogName ? undefined : serverCatalogs[0]);
  const specs = match?.specs ?? [];
  const rows = optionRows(specs, draft.values);
  const secretValues = partitionSecrets(Object.fromEntries(Object.entries(draft.values).filter(([, v]) => v !== "")), rows).secret;

  const changes = draftChanges(draft, stored);
  const catalogNameChanged = draft.catalogName !== stored.catalogName;
  const dirty = changes.any || catalogNameChanged;
  // Validated once it differs from the stored alias: an alias the server has
  // not named yet ("") is not an error until the reader types one.
  const aliasError = draft.alias.trim() !== c.alias ? aliasEditProblem(draft.alias, c.id, ws.catalogs) : null;
  const urlError = urlProblem(draft.url);

  const switchTab = (next: string) => {
    if (next === tab) return;
    if (next === "sql") {
      setDraft((d) => ({ ...d, sqlText: optionsToSqlText(d.values, d.raw, rows) }));
      setTab("sql");
      setErrors([]);
      return;
    }
    // Back to the fields: the text must parse first.
    const parsed = sqlTextToOptions(draft.sqlText ?? "", secretValues, rows);
    const blocking = parsed.errors.filter((e) => !/ is required\.$/.test(e));
    if (blocking.length) { setErrors(blocking); return; }
    setDraft((d) => ({ ...d, values: parsed.values, raw: parsed.rawOptions, sqlText: null }));
    setErrors([]);
    setTab("options");
  };

  const save = async () => {
    setSaved(false);
    const problems: string[] = [];
    if (aliasError) problems.push(`Alias: ${aliasError}`);
    if (urlError) problems.push(`URL: ${urlError}`);
    const collected = draft.sqlText !== null ? sqlTextToOptions(draft.sqlText, secretValues, rows) : collectFormOptions(draft.values, draft.raw, rows);
    problems.push(...collected.errors);
    if (problems.length) { setErrors(problems); return; }
    setErrors([]);
    setBusy(true);
    try {
      const newAlias = draft.alias.trim();
      if (newAlias !== c.alias) {
        const renamed = c.alias ? await onAliasRenameRequested(ws.id, c.id, c.alias, newAlias) : updateCatalog(ws.id, c.id, { alias: newAlias });
        if (!renamed) { setErrors([`The alias is still "${c.alias}"; nothing was saved.`]); return; }
      }
      updateCatalog(ws.id, c.id, {
        url: draft.url.trim(),
        catalogName: draft.catalogName,
        ...(isGrainlift(draft.url) ? { target: draft.target.trim() } : {}),
      });
      saveFormOptions(catalogOptionSink(ws.id, c.id), draft.catalogName, collected.options, collected.rawOptions, rows);
      if (live && c.enabled) await live.reattach(c.id);
      setDraft((d) => ({ ...d, sqlText: null }));
      setTab("options");
      setSaved(true);
    } finally {
      setBusy(false);
    }
  };

  // Once saved, the draft follows the stored record again.
  useEffect(() => { if (!busy) setDraft((d) => (draftChanges(d, stored).any || d.catalogName !== stored.catalogName ? d : stored)); }, [stored, busy]);

  return (
    <form
      className="border-t border-border px-3 py-3 flex flex-col gap-3"
      aria-label={`Settings for ${c.alias || c.url}`}
      onSubmit={(e) => { e.preventDefault(); void save(); }}
      data-testid="catalog-editor"
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="flex flex-col gap-1 text-xs font-medium text-foreground">
          Alias <span className="font-normal text-muted-foreground">the name SQL uses: <code>{draft.alias || "alias"}.main.table</code></span>
          <input
            value={draft.alias}
            onChange={(e) => setDraft((d) => ({ ...d, alias: e.target.value }))}
            spellCheck={false}
            aria-invalid={Boolean(aliasError)}
            aria-describedby={aliasError ? `${idPrefix}-alias-error` : undefined}
            className={`${inputClass} font-mono`}
            data-testid="catalog-alias-input"
          />
          {aliasError && <span id={`${idPrefix}-alias-error`} className="flex items-center gap-1 font-normal text-[11px] text-destructive"><AlertTriangle className="size-3" aria-hidden="true" />{aliasError}</span>}
        </label>
        <label className="flex flex-col gap-1 text-xs font-medium text-foreground">
          URL
          <input
            type="url"
            value={draft.url}
            onChange={(e) => setDraft((d) => ({ ...d, url: e.target.value }))}
            spellCheck={false}
            aria-invalid={Boolean(urlError)}
            aria-describedby={urlError ? `${idPrefix}-url-error` : undefined}
            className={`${inputClass} font-mono`}
            data-testid="catalog-url-input"
          />
          {urlError && <span id={`${idPrefix}-url-error`} className="flex items-center gap-1 font-normal text-[11px] text-destructive"><AlertTriangle className="size-3" aria-hidden="true" />{urlError}</span>}
        </label>
        {isGrainlift(draft.url) ? (
          <label className="flex flex-col gap-1 text-xs font-medium text-foreground">
            Gateway target
            <input value={draft.target} onChange={(e) => setDraft((d) => ({ ...d, target: e.target.value }))} spellCheck={false} className={`${inputClass} font-mono`} />
          </label>
        ) : (
          <label className="flex flex-col gap-1 text-xs font-medium text-foreground">
            Catalog on the server
            {serverCatalogs.length > 1 || (serverCatalogs.length === 1 && serverCatalogs[0].name !== draft.catalogName) ? (
              <select value={draft.catalogName} onChange={(e) => setDraft((d) => ({ ...d, catalogName: e.target.value }))} className={inputClass} data-testid="catalog-server-name">
                {!serverCatalogs.some((x) => x.name === draft.catalogName) && <option value={draft.catalogName}>{draft.catalogName || "(the first)"} (not on this server)</option>}
                {serverCatalogs.map((x) => <option key={x.name} value={x.name}>{x.name}</option>)}
              </select>
            ) : (
              <span className="px-2.5 py-1.5 font-mono text-sm text-muted-foreground" data-testid="catalog-server-name">{draft.catalogName || "(the service's first)"}</span>
            )}
          </label>
        )}
        <fieldset className="flex flex-col gap-1">
          <legend className="text-xs font-medium text-foreground mb-1">Colour <span className="font-normal text-muted-foreground">(applies at once)</span></legend>
          <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Colour">
            {Array.from({ length: PALETTE_SIZE }, (_, n) => (
              <label key={n} className="relative cursor-pointer" title={PALETTE_NAMES[n]}>
                <input
                  type="radio"
                  name={`colour-${c.id}`}
                  value={n}
                  checked={c.color === n}
                  onChange={() => setCatalogColor(ws.id, c.id, n)}
                  className="peer sr-only"
                  aria-label={PALETTE_NAMES[n]}
                  data-testid="catalog-colour"
                />
                <span className="flex rounded-md p-0.5 ring-offset-1 peer-checked:ring-2 peer-checked:ring-foreground peer-focus-visible:ring-2 peer-focus-visible:ring-ring">
                  <CatalogChip alias={draft.alias || "?"} color={n} className="h-5 w-5" />
                </span>
                {c.color === n && <span className="sr-only">(selected)</span>}
              </label>
            ))}
          </div>
        </fieldset>
      </div>

      <Tabs value={tab} onValueChange={(v) => switchTab(String(v))}>
        <TabsList>
          <TabsTrigger value="options" data-testid="catalog-options-tab">Options</TabsTrigger>
          <TabsTrigger value="sql" data-testid="catalog-sql-tab">SQL</TabsTrigger>
        </TabsList>
        <TabsContent value="options" className="pt-2">
          {discovered.state === "loading" && specs.length === 0 && (
            <p className="flex items-center gap-1.5 text-xs text-muted-foreground mb-2"><Loader2 className="size-3.5 animate-spin" aria-hidden="true" />Reading the server's options…</p>
          )}
          {discovered.state === "error" && (
            <p className="flex items-start gap-1.5 text-xs text-muted-foreground mb-2"><AlertTriangle className="size-3.5 mt-px shrink-0" aria-hidden="true" />The server's declared options could not be read ({discovered.error}). Stored options are shown as text.</p>
          )}
          {rows.length === 0 && discovered.state !== "loading" ? (
            <p className="text-xs text-muted-foreground">This catalog declares no options. The SQL tab takes any the extension accepts (<code>pool</code>, <code>cache</code>, …).</p>
          ) : (
            <OptionsFields
              idPrefix={idPrefix}
              specs={rows}
              values={draft.values}
              onChange={(values) => setDraft((d) => ({ ...d, values }))}
              raw={draft.raw}
              onRawChange={(raw) => setDraft((d) => ({ ...d, raw }))}
              showRaw={Boolean(draft.raw)}
              rich
            />
          )}
        </TabsContent>
        <TabsContent value="sql" className="pt-2 flex flex-col gap-1">
          <label htmlFor={`${idPrefix}-sql`} className="text-xs font-medium text-foreground">Options as DuckDB ATTACH text</label>
          <textarea
            id={`${idPrefix}-sql`}
            value={draft.sqlText ?? ""}
            onChange={(e) => setDraft((d) => ({ ...d, sqlText: e.target.value }))}
            rows={4}
            spellCheck={false}
            aria-describedby={`${idPrefix}-sql-help`}
            className={`${inputClass} text-xs font-mono resize-y`}
            data-testid="catalog-sql-text"
          />
          <p id={`${idPrefix}-sql-help`} className="text-[11px] text-muted-foreground">
            <code>name value</code> pairs, comma-separated, as in an ATTACH. Values must be constants (literals, casts, lists, structs, maps);
            they are checked before anything attaches, and nothing here runs as SQL. Secret options are edited on the Options tab only.
          </p>
        </TabsContent>
      </Tabs>

      {errors.length > 0 && (
        <ul role="alert" className="text-xs text-destructive space-y-0.5" data-testid="catalog-editor-errors">
          {errors.map((e) => <li key={e} className="flex items-start gap-1"><AlertTriangle className="size-3 mt-0.5 shrink-0" aria-hidden="true" />{e}</li>)}
        </ul>
      )}
      <div className="flex flex-wrap items-center justify-end gap-2">
        <span aria-live="polite" className="mr-auto text-[11px] text-muted-foreground">
          {saved && !dirty ? <span className="inline-flex items-center gap-1"><CheckCircle2 className="size-3 text-emerald-600 dark:text-emerald-400" aria-hidden="true" />Saved{live && c.enabled ? " and re-attached" : ""}</span>
            : dirty ? "Unsaved changes" : ""}
        </span>
        <Button type="button" size="sm" variant="ghost" onClick={() => { setDraft(stored); setTab("options"); setErrors([]); if (!dirty) onDone(); }} data-testid="catalog-editor-revert">
          {dirty ? "Revert" : "Close"}
        </Button>
        <Button type="submit" size="sm" disabled={busy || !dirty} data-testid="catalog-editor-save">
          {busy && <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />}
          {live && c.enabled ? "Save and re-attach" : "Save"}
        </Button>
      </div>
    </form>
  );
}
