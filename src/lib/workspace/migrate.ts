/**
 * The one-time boot migration to workspaces (multi-catalog phase 2).
 *
 * Before workspaces, everything per connection was keyed by the default
 * catalog's service URL. This runs once at boot, before anything reads those
 * stores, behind the marker `cupola.workspaces.migrated.v1`:
 *
 * - every `vgi-recent-services` entry becomes an untitled single-catalog
 *   workspace, aliased under its old catalog name (saved reports reference
 *   it), with its non-secret options and pending raw text;
 * - its editor tabs (`vgi-sql-editor-docs::<url>`), query history
 *   (`cupola.query-history.v1::<url>`), Evidence reports, report histories and
 *   recovery drafts (`cupola.evidence.{report.v2,history.v1,draft.v1}:<url>:<id>`)
 *   are copied under the workspace id; a report's copy also records it;
 * - its secrets (`cupola.catalog-secrets.v1`, keyed by URL + catalog name +
 *   option) are copied under `workspaceId:catalogId:option`.
 *
 * Copies, never moves: the old keys stay as a read-only fallback
 * (`legacy-scope.ts`) for one release. Idempotent: a second run is a no-op,
 * and a copy never overwrites a key that already exists. A copy that does not
 * fit in storage is skipped and counted; the fallback still finds the data.
 *
 * Unit-tested with stubbed storage in tests/unit/workspace-migrate.test.ts.
 */
import { getRecentServices } from "../recent-services";
import { copyLegacySecrets } from "../attach/secret-store";
import { serviceAlias } from "./aliases";
import { createWorkspace, findUntitledForService, listWorkspaces } from "./store";

export const MIGRATED_KEY = "cupola.workspaces.migrated.v1";

const EDITOR_PREFIX = "vgi-sql-editor-docs::";
const HISTORY_PREFIX = "cupola.query-history.v1::";
/** Evidence keys are `<prefix><encodeURIComponent(scope)>:<encodeURIComponent(id)>`. */
const EVIDENCE_PREFIXES = ["cupola.evidence.report.v2:", "cupola.evidence.history.v1:", "cupola.evidence.draft.v1:"];

export interface MigrationReport {
  ran: boolean;
  workspaces: number;
  copied: number;
  /** Keys that could not be copied (storage full, unreadable). */
  failed: number;
}

function storage(): Storage | null {
  try { return typeof localStorage === "undefined" ? null : localStorage; } catch { return null; }
}

export function isMigrated(): boolean {
  try { return Boolean(storage()?.getItem(MIGRATED_KEY)); } catch { return true; }
}

export function migrateToWorkspaces(): MigrationReport {
  const s = storage();
  const report: MigrationReport = { ran: false, workspaces: 0, copied: 0, failed: 0 };
  if (!s || isMigrated()) return report;
  report.ran = true;

  const keys: string[] = [];
  for (let i = 0; i < s.length; i++) {
    const k = s.key(i);
    if (k) keys.push(k);
  }

  // Oldest first, so the most recently used ends up opened last.
  const recents = [...getRecentServices()].reverse();
  for (const recent of recents) {
    if (!recent?.url) continue;
    let ws = findUntitledForService(recent.url);
    if (!ws) {
      ws = createWorkspace([{
        url: recent.url,
        catalogName: recent.catalogName ?? "",
        alias: recent.catalogName ? serviceAlias(recent.catalogName) : "",
        options: recent.options,
        rawOptions: recent.rawOptions,
      }], { legacyServiceUrl: recent.url, lastOpenedAt: Date.parse(recent.lastUsed) || 0 });
      report.workspaces++;
    }
    const catalog = ws.catalogs[0];
    if (catalog) report.copied += copyLegacySecrets(recent.url, recent.catalogName ?? "", ws.id, catalog.id);
    rekeyService(s, keys, recent.url, ws.id, report);
  }

  // Pruning while creating may have retired some; their copies stay put and
  // come back with the id when the same catalog set is opened again.
  try {
    s.setItem(MIGRATED_KEY, JSON.stringify({ at: Date.now(), workspaces: listWorkspaces().length, copied: report.copied, failed: report.failed }));
  } catch {
    // Storage full: the migration ran; a second run would copy nothing new.
  }
  return report;
}

/** Copy one service's per-URL keys under a workspace id. */
export function rekeyService(s: Storage, keys: readonly string[], url: string, workspaceId: string, report: MigrationReport): void {
  const copy = (from: string, to: string, transform?: (text: string) => string) => {
    if (s.getItem(to) !== null) return;
    const value = s.getItem(from);
    if (value === null) return;
    try {
      s.setItem(to, transform ? transform(value) : value);
      report.copied++;
    } catch {
      report.failed++;
    }
  };
  copy(EDITOR_PREFIX + url, EDITOR_PREFIX + workspaceId);
  copy(HISTORY_PREFIX + url, HISTORY_PREFIX + workspaceId);
  const fromScope = `${encodeURIComponent(url)}:`;
  const toScope = `${encodeURIComponent(workspaceId)}:`;
  for (const prefix of EVIDENCE_PREFIXES) {
    for (const key of keys) {
      if (!key.startsWith(prefix + fromScope)) continue;
      const rest = key.slice((prefix + fromScope).length);
      copy(key, prefix + toScope + rest, prefix === "cupola.evidence.history.v1:" ? undefined : (text) => stampWorkspace(text, workspaceId));
    }
  }
}

/** A report (or a draft's report) records the workspace it now belongs to. */
function stampWorkspace(text: string, workspaceId: string): string {
  try {
    const value = JSON.parse(text);
    if (value && typeof value === "object") {
      if (value.report && typeof value.report === "object") value.report.workspaceId = workspaceId;
      else value.workspaceId = workspaceId;
      return JSON.stringify(value);
    }
  } catch { /* copied as is */ }
  return text;
}
