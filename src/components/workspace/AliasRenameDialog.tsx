/**
 * Renaming a catalog's alias (multi-catalog phase 3). The alias is the SQL contract, so the dialog
 * first counts what references it in the workspace: saved reports (their ```sql fences, setup
 * SQL and parameter choices queries) and SQL editor tabs, each listed with its count. Then:
 *
 * - **Rename and update N references**: every reference is rewritten (`alias-rewrite.ts`, a
 *   tokenizer that skips strings and comments), each changed report saved with a revision
 *   ("Renamed catalog sales → sales_eu"), then the alias is renamed.
 * - **Rename only**: the alias changes; the references are left to fail with "catalog not found".
 *
 * The rename itself goes through `onRename` (the app's: store, then re-attach under the new name
 * when the workspace is open in this tab). Without one, only the store changes.
 *
 * Open it with `onAliasRenameRequested(...)` (`lib/workspace/events.ts`) when `AliasRenameHost` is
 * mounted, or render `AliasRenameDialog` with a request directly.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../ui/dialog";
import { Button } from "../ui/button";
import { aliasProblem } from "@/lib/workspace/aliases";
import { getWorkspace, setExpandedCatalogs, getOverlay, updateCatalog } from "@/lib/workspace/store";
import { legacyScopeFor, setLegacyScope } from "@/lib/workspace/legacy-scope";
import { ALIAS_RENAME_EVENT, type AliasRenameRequest } from "@/lib/workspace/events";
import {
  aliasRenameLabel, planAliasRename, requestEditorDocs, requestEditorRewrite, requestReportRewrite, rewriteEditorState, rewriteReportForRename,
} from "@/lib/workspace/alias-rename";
import { listEvidenceReports, describeReportError, type EvidenceReport } from "@/lib/evidence/reports";
import { saveReportWithRevision } from "@/lib/evidence/report-save";
import { readEditorState, saveEditorState, type EditorDoc } from "@/lib/editor/editor-store";

export type { AliasRenameRequest };

/** Rename a catalog's alias in the store, keeping the sidebar's expansion. Null, or why not. */
export function renameCatalogAliasInStore(workspaceId: string, catalogId: string, alias: string): string | null {
  const ws = getWorkspace(workspaceId);
  const old = ws?.catalogs.find((c) => c.id === catalogId)?.alias;
  if (!ws || old === undefined) return "That catalog is no longer in the workspace.";
  if (!updateCatalog(workspaceId, catalogId, { alias })) return `"${alias}" cannot be used as an alias here.`;
  const expanded = getOverlay(workspaceId).expanded;
  if (expanded && old) setExpandedCatalogs(workspaceId, expanded.map((a) => (a === old ? alias : a)));
  return null;
}

/** Read what the dialog counts: the workspace's saved reports and its editor tabs (the live ones
 *  when the editor is open on this workspace). */
function readSources(workspaceId: string): { reports: EvidenceReport[]; docs: EditorDoc[]; problems: string[] } {
  const problems: string[] = [];
  // A workspace that isn't the open one still reads its pre-workspace reports and tabs.
  const ws = getWorkspace(workspaceId);
  if (ws?.legacyServiceUrl && !legacyScopeFor(workspaceId)) setLegacyScope(workspaceId, ws.legacyServiceUrl);
  let reports: EvidenceReport[] = [];
  try { reports = listEvidenceReports(workspaceId); } catch (e) { problems.push(`Saved reports could not be read: ${describeReportError(e)}`); }
  const docs = requestEditorDocs(workspaceId) ?? readEditorState(workspaceId)?.docs ?? [];
  return { reports, docs, problems };
}

/** Rewrite every reference in the workspace's reports and tabs. Returns problems to show. */
export function rewriteWorkspaceReferences(workspaceId: string, from: string, to: string): { reports: number; tabs: number; problems: string[] } {
  const problems: string[] = [];
  // Editor tabs: the mounted editor rewrites its own; otherwise storage.
  let tabs = 0;
  const live = requestEditorRewrite(workspaceId, from, to);
  if (live.handled) tabs = live.count;
  else {
    const stored = readEditorState(workspaceId);
    if (stored) {
      const rewritten = rewriteEditorState(stored, from, to);
      if (rewritten.count) saveEditorState(rewritten.state, workspaceId);
      tabs = rewritten.count;
    }
  }
  // Reports: the open one through its own save path, the rest here, each with a revision.
  const label = aliasRenameLabel(from, to);
  const open = requestReportRewrite(workspaceId, from, to, label);
  problems.push(...open.errors);
  let reports = open.handled.length;
  let saved: EvidenceReport[] = [];
  try { saved = listEvidenceReports(workspaceId); } catch (e) { problems.push(`Saved reports could not be read: ${describeReportError(e)}`); }
  for (const report of saved) {
    if (open.handled.includes(report.id)) continue;
    const next = rewriteReportForRename(report, from, to);
    if (!next) continue;
    try {
      const { problem } = saveReportWithRevision(report, next, { kind: "edit", label });
      if (problem) problems.push(`“${report.title}”: ${problem}`);
      reports++;
    } catch (e) {
      problems.push(`“${report.title}” could not be saved: ${describeReportError(e)}`);
    }
  }
  return { reports, tabs, problems };
}

export function AliasRenameDialog({
  request,
  onClose,
  onRename,
}: {
  request: AliasRenameRequest | null;
  /** `renamedTo` is the alias it renamed to, or null when it closed without renaming. */
  onClose: (renamedTo: string | null) => void;
  /** Rename the alias (store, and re-attach when the workspace is open). Resolves with an error
   *  to show, or null. Defaults to the store alone. */
  onRename?: (workspaceId: string, catalogId: string, alias: string) => Promise<string | null>;
}) {
  const [alias, setAlias] = useState("");
  const [sources, setSources] = useState<{ reports: EvidenceReport[]; docs: EditorDoc[]; problems: string[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);

  useEffect(() => {
    if (!request) return;
    setAlias(request.newAlias);
    setErrors([]);
    setBusy(false);
    setSources(readSources(request.workspaceId));
  }, [request]);

  const plan = useMemo(() => request && sources
    ? planAliasRename({ reports: sources.reports, docs: sources.docs, from: request.oldAlias, to: alias })
    : null, [request, sources, alias]);

  if (!request) return null;
  const workspace = getWorkspace(request.workspaceId);
  const others = (workspace?.catalogs ?? []).filter((c) => c.id !== request.catalogId).map((c) => c.alias).filter(Boolean);
  const problem = alias === request.oldAlias ? "Enter a different alias." : aliasProblem(alias, others);
  const total = plan?.total ?? 0;

  const run = async (updateReferences: boolean) => {
    if (problem || busy) return;
    setBusy(true);
    setErrors([]);
    const found: string[] = [];
    if (updateReferences && total) found.push(...rewriteWorkspaceReferences(request.workspaceId, request.oldAlias, alias).problems);
    const error = onRename && !request.storeOnly
      ? await onRename(request.workspaceId, request.catalogId, alias)
      : renameCatalogAliasInStore(request.workspaceId, request.catalogId, alias);
    setBusy(false);
    if (error) found.unshift(error);
    if (found.length) setErrors(found);
    else onClose(alias);
  };

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !busy) onClose(null); }}>
      <DialogContent className="sm:max-w-lg" data-testid="alias-rename-dialog">
        <DialogHeader>
          <DialogTitle>Rename catalog {request.oldAlias}</DialogTitle>
          <DialogDescription>
            The alias is how SQL names this catalog (<code>{request.oldAlias}.schema.table</code>). Queries that use the old alias stop working unless they are updated.
          </DialogDescription>
        </DialogHeader>
        <label className="grid gap-1 text-sm">
          <span className="font-medium">New alias</span>
          <input
            className="w-full rounded-md border border-input bg-card px-2.5 py-1.5 font-mono text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            value={alias}
            autoFocus
            readOnly={request.fixedAlias}
            spellCheck={false}
            aria-invalid={Boolean(problem)}
            aria-describedby="alias-rename-problem"
            onChange={(e) => setAlias(e.target.value.trim())}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void run(true); } }}
          />
          <span id="alias-rename-problem" className="min-h-4 text-xs text-destructive">{alias !== request.oldAlias ? problem : ""}</span>
        </label>
        <section aria-label="References to update" className="max-h-64 overflow-auto rounded-md border p-3 text-sm">
          {!plan ? <p className="flex items-center gap-2 text-muted-foreground"><Loader2 className="size-4 animate-spin" aria-hidden />Counting references…</p>
            : total === 0 ? <p className="text-muted-foreground" data-testid="alias-rename-none">No saved reports or editor tabs in this workspace reference <code>{request.oldAlias}</code>.</p>
            : <>
              <p className="mb-2" data-testid="alias-rename-summary">
                {total} {total === 1 ? "reference" : "references"} to <code>{request.oldAlias}</code> in {[
                  plan.reports.length && `${plan.reports.length} ${plan.reports.length === 1 ? "report" : "reports"}`,
                  plan.tabs.length && `${plan.tabs.length} editor ${plan.tabs.length === 1 ? "tab" : "tabs"}`,
                ].filter(Boolean).join(" and ")}:
              </p>
              <ul className="space-y-1">
                {plan.reports.map(({ report, references }) => (
                  <li key={`r:${report.id}`} className="flex justify-between gap-3"><span className="truncate">Report: {report.title}</span><span className="shrink-0 tabular-nums text-muted-foreground">{references.length}</span></li>
                ))}
                {plan.tabs.map(({ doc, references }) => (
                  <li key={`t:${doc.id}`} className="flex justify-between gap-3"><span className="truncate">Editor tab: {doc.name}</span><span className="shrink-0 tabular-nums text-muted-foreground">{references.length}</span></li>
                ))}
              </ul>
            </>}
          {sources?.problems.map((p) => <p key={p} className="mt-2 text-xs text-destructive">{p}</p>)}
        </section>
        {errors.length > 0 && <div role="alert" className="whitespace-pre-wrap rounded-md border border-destructive/30 bg-destructive/10 p-2 text-xs text-destructive">{errors.join("\n")}</div>}
        <DialogFooter>
          <Button variant="ghost" onClick={() => onClose(null)} disabled={busy}>Cancel</Button>
          {total > 0 && <Button variant="outline" onClick={() => void run(false)} disabled={busy || Boolean(problem)}>Rename only</Button>}
          <Button onClick={() => void run(true)} disabled={busy || Boolean(problem) || !plan}>
            {busy && <Loader2 className="animate-spin" aria-hidden />}
            {total > 0 ? `Rename and update ${total} ${total === 1 ? "reference" : "references"}` : "Rename"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Mounted once by the app: opens the dialog for `onAliasRenameRequested(...)`. */
export function AliasRenameHost({ onRename }: { onRename?: (workspaceId: string, catalogId: string, alias: string) => Promise<string | null> }) {
  const [request, setRequest] = useState<AliasRenameRequest | null>(null);
  // The open request's `settle`, outside React state so settling never runs inside an updater.
  const settleRef = useRef<AliasRenameRequest["settle"]>(undefined);
  useEffect(() => {
    const open = (event: Event) => {
      const detail = { ...(event as CustomEvent<AliasRenameRequest>).detail };
      // A second request while one is open: the first closes unrenamed.
      settleRef.current?.(null);
      settleRef.current = detail.settle;
      setRequest(detail);
    };
    window.addEventListener(ALIAS_RENAME_EVENT, open);
    return () => window.removeEventListener(ALIAS_RENAME_EVENT, open);
  }, []);
  const close = (renamedTo: string | null) => {
    const settle = settleRef.current;
    settleRef.current = undefined;
    setRequest(null);
    settle?.(renamedTo);
  };
  return <AliasRenameDialog request={request} onClose={close} onRename={onRename} />;
}
