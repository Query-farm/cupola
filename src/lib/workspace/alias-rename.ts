/**
 * Renaming a catalog's alias (multi-catalog phase 3): what references it, and updating them.
 *
 * An alias is the SQL contract, so renaming one breaks every report and editor tab that names
 * it. The dialog (`AliasRenameDialog`) counts the references in the workspace's saved reports
 * (their ```sql fences, setup SQL and parameter choices queries) and editor tabs, and can rewrite
 * them (`alias-rewrite.ts`) before the alias itself changes.
 *
 * The open page holds two of those stores in memory: the SQL editor's tabs (debounced saves) and
 * the open report (autosave). Writing their storage behind their backs would be undone by their
 * next save, so each is asked first through a window event, synchronously: a mounted
 * `SqlEditorView` / `EvidenceWorkspace` with that workspace's scope answers with its live state
 * and applies the rewrite itself (the report through its own save path, so the revision and the
 * open draft agree). Whatever no mounted view claims is read and written in storage here.
 *
 * The pure parts (planning, rewriting an editor state) are unit-tested in
 * tests/unit/alias-rename.test.ts.
 */
import { findAliasReferences, rewriteAlias, type AliasReference } from "./alias-rewrite";
import { findReportAliasReferences, rewriteReportAliases, type ReportAliasReference } from "../evidence/report-requires";
import type { EvidenceReport } from "../evidence/reports";
import type { EditorDoc, EditorState } from "../editor/editor-store";

export interface ReportRenameItem { report: EvidenceReport; references: ReportAliasReference[] }
export interface TabRenameItem { doc: EditorDoc; references: AliasReference[] }

export interface AliasRenamePlan {
  from: string;
  to: string;
  reports: ReportRenameItem[];
  tabs: TabRenameItem[];
  /** References across both. */
  total: number;
}

/** The revision label every rewritten report gets. */
export function aliasRenameLabel(from: string, to: string): string {
  return `Renamed catalog ${from} → ${to}`;
}

/** The revision label a Rebind gets. */
export function rebindLabel(pairs: readonly { from: string; to: string }[]): string {
  return `Rebound catalog ${pairs.map((p) => `${p.from} → ${p.to}`).join(", ")}`;
}

/** Which reports and tabs reference `from`, and how often. Only those with references are listed. */
export function planAliasRename(input: { reports: readonly EvidenceReport[]; docs: readonly EditorDoc[]; from: string; to: string }): AliasRenamePlan {
  const reports = input.reports
    .map((report) => ({ report, references: findReportAliasReferences(report, input.from) }))
    .filter((item) => item.references.length > 0);
  const tabs = input.docs
    .map((doc) => ({ doc, references: findAliasReferences(doc.sql, input.from).references }))
    .filter((item) => item.references.length > 0);
  const total = reports.reduce((n, r) => n + r.references.length, 0) + tabs.reduce((n, t) => n + t.references.length, 0);
  return { from: input.from, to: input.to, reports, tabs, total };
}

/** An editor state with `from` rewritten as `to` in every tab; the same object when nothing changed. */
export function rewriteEditorState(state: EditorState, from: string, to: string, now = Date.now()): { state: EditorState; count: number } {
  let count = 0;
  const docs = state.docs.map((doc) => {
    const n = findAliasReferences(doc.sql, from).count;
    if (!n) return doc;
    count += n;
    return { ...doc, sql: rewriteAlias(doc.sql, from, to), updatedAt: now };
  });
  return count ? { state: { ...state, docs }, count } : { state, count: 0 };
}

/** A report with `from` rewritten as `to`, or null when it has no references. */
export function rewriteReportForRename(report: EvidenceReport, from: string, to: string): EvidenceReport | null {
  const { report: next, count } = rewriteReportAliases(report, { [from]: to });
  return count ? next : null;
}

// ---------------------------------------------------------------------------
// Live views: the mounted editor and report answer for their workspace.
// ---------------------------------------------------------------------------

/** Ask a mounted SQL editor for its tabs. `docs` stays null when none answers. */
export const EDITOR_DOCS_REQUEST_EVENT = "cupola:editor-docs-request";
export interface EditorDocsRequest { scope: string; docs: EditorDoc[] | null }

/** Ask a mounted SQL editor to rewrite its tabs. It sets `count` (and `handled`). */
export const EDITOR_DOCS_REWRITE_EVENT = "cupola:editor-docs-rewrite";
export interface EditorDocsRewrite { scope: string; from: string; to: string; handled: boolean; count: number }

/** Ask a mounted report workspace to rewrite its open report through its own save path. It adds
 *  the report's id to `handled` when it did (or when the report had nothing to rewrite). */
export const REPORT_REWRITE_EVENT = "cupola:report-alias-rewrite";
export interface ReportRewrite { scope: string; from: string; to: string; label: string; handled: string[]; errors: string[] }

function dispatch<T>(name: string, detail: T): T {
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent<T>(name, { detail }));
  return detail;
}

export function requestEditorDocs(scope: string): EditorDoc[] | null {
  return dispatch<EditorDocsRequest>(EDITOR_DOCS_REQUEST_EVENT, { scope, docs: null }).docs;
}
export function requestEditorRewrite(scope: string, from: string, to: string): EditorDocsRewrite {
  return dispatch<EditorDocsRewrite>(EDITOR_DOCS_REWRITE_EVENT, { scope, from, to, handled: false, count: 0 });
}
export function requestReportRewrite(scope: string, from: string, to: string, label: string): ReportRewrite {
  return dispatch<ReportRewrite>(REPORT_REWRITE_EVENT, { scope, from, to, label, handled: [], errors: [] });
}
