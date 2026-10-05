/**
 * Workspace files: export and import of workspaces as JSON, the same JSON a
 * `#ws=` link carries (`spec.ts`), plus a `$schema` pointer to the published
 * JSON Schema (`public/schema/workspace-v1.json`).
 *
 * ```json
 * {"$schema": "https://cupola.query-farm.services/schema/workspace-v1.json",
 *  "format": "cupola-workspaces", "version": 1, "workspaces": [...]}
 * ```
 *
 * What an export holds is the **portable record** only: each workspace's id,
 * name, default catalog and schema, and per catalog its id, URL, server name,
 * alias, non-secret options, Grainlift target and pinned data version. Never a
 * secret value (only the secret options' names, so an import can say what to
 * enter), and never the personal overlay (colour, enabled, sidebar
 * expansion): that stays in the browser that set it.
 *
 * Import mirrors report files (`evidence/report-file.ts`): it accepts a file,
 * a bare workspace or an array of them, validates each workspace on its own so
 * one bad workspace doesn't lose the rest, and plans each by id: new,
 * identical (skipped) or conflicting, where the reader chooses Replace or Keep
 * both (a copy under a new id, named "… (imported)").
 *
 * `planImport` and the parsers are pure. `applyImport` writes through the
 * workspace store. Unit-tested in tests/unit/workspace-file.test.ts.
 */
import { assignAliases } from "./aliases";
import {
  validateWorkspaceFile,
  WORKSPACE_FORMAT,
  WORKSPACE_VERSION,
  type PortableCatalog,
  type PortableWorkspace,
  type PortableWorkspaceFile,
} from "./spec";
import {
  createWorkspace,
  deleteWorkspace,
  getWorkspace,
  newWorkspaceId,
  normalizeServiceUrl,
  workspaceLabel,
  type NewCatalog,
  type Workspace,
  type WorkspaceCatalog,
} from "./store";
import { catalogSecrets, saveCatalogSecrets } from "../attach/secret-store";

/** Where the schema is published. Unversioned on purpose: the Worker serves
 *  an unversioned path from the latest release, so editors resolve it
 *  whichever release wrote the file. */
export const WORKSPACE_SCHEMA_URL = "https://cupola.query-farm.services/schema/workspace-v1.json";
export const WORKSPACE_FILE_EXTENSION = ".cupola-workspaces.json";
/** Appended to a "Keep both" copy's name. */
export const IMPORTED_SUFFIX = " (imported)";

export interface WorkspaceFile extends PortableWorkspaceFile {
  $schema: string;
}

/** The secret option names a stored catalog takes. Values are never read
 *  into an export; only which options have one. */
export type SecretNamesOf = (workspace: Workspace, catalog: WorkspaceCatalog) => string[];

/** The names of the secrets stored for a catalog in this browser. */
export function storedSecretNames(workspace: Workspace, catalog: WorkspaceCatalog): string[] {
  try {
    return Object.keys(catalogSecrets({ workspaceId: workspace.id, catalogId: catalog.id, url: catalog.url, catalogName: catalog.catalogName })).sort();
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

/** One stored workspace's portable record. `notes` names what was left out
 *  that the reader may expect (option expressions still awaiting evaluation). */
export function toPortableWorkspace(ws: Workspace, secretNames: SecretNamesOf = () => []): { workspace: PortableWorkspace; notes: string[] } {
  const notes: string[] = [];
  const catalogs: PortableCatalog[] = ws.catalogs.map((c) => {
    const secrets = uniqueNames(secretNames(ws, c));
    const lower = new Set(secrets.map((s) => s.toLowerCase()));
    // Defence in depth: a stored option that is also a secret's name is never written.
    const options = Object.fromEntries(Object.entries(c.options).filter(([name]) => !lower.has(name.toLowerCase())));
    if (c.rawOptions) notes.push(`${c.alias || c.catalogName}: options not yet evaluated (${c.rawOptions}) are not included; connect once so they are evaluated, then export again.`);
    return {
      id: c.id,
      url: c.url,
      catalogName: c.catalogName,
      ...(c.alias ? { alias: c.alias } : {}),
      ...(Object.keys(options).length ? { options } : {}),
      ...(secrets.length ? { secrets } : {}),
      ...(c.target ? { target: c.target } : {}),
      ...(c.dataVersionSpec ? { dataVersionSpec: c.dataVersionSpec } : {}),
    };
  });
  return {
    workspace: {
      id: ws.id,
      name: ws.name,
      ...(ws.defaultCatalogId ? { defaultCatalogId: ws.defaultCatalogId } : {}),
      ...(ws.defaultSchema ? { defaultSchema: ws.defaultSchema } : {}),
      catalogs,
    },
    notes,
  };
}

/** A workspace file holding `workspaces` (one or all). A catalog whose
 *  server has not named it yet (an unconnected `?service=` catalog) cannot be
 *  described portably and is left out, with a note; a workspace left with no
 *  catalogs is left out too. */
export function buildWorkspaceFile(workspaces: readonly Workspace[], secretNames?: SecretNamesOf): { file: WorkspaceFile; notes: string[] } {
  const notes: string[] = [];
  const out: PortableWorkspace[] = [];
  for (const ws of workspaces) {
    const { workspace, notes: wsNotes } = toPortableWorkspace(ws, secretNames);
    const label = workspaceLabel(ws);
    notes.push(...wsNotes.map((n) => `${label}: ${n}`));
    const named = workspace.catalogs.filter((c) => c.catalogName);
    if (named.length < workspace.catalogs.length) notes.push(`${label}: a catalog the server has not named yet (never connected) is not included.`);
    if (!named.length) {
      notes.push(`${label}: not included (no catalog to export).`);
      continue;
    }
    if (workspace.defaultCatalogId && !named.some((c) => c.id === workspace.defaultCatalogId)) delete workspace.defaultCatalogId;
    out.push({ ...workspace, catalogs: named });
  }
  return { file: { $schema: WORKSPACE_SCHEMA_URL, format: WORKSPACE_FORMAT, version: WORKSPACE_VERSION, workspaces: out }, notes };
}

export function serializeWorkspaceFile(file: WorkspaceFile): string {
  return JSON.stringify(file, null, 2) + "\n";
}

/** Named after the workspace, or "cupola-workspaces" for several. */
export function workspaceFileName(workspaces: readonly Pick<Workspace, "name" | "catalogs">[], extension = WORKSPACE_FILE_EXTENSION): string {
  return `${fileStem(workspaces) || "cupola-workspaces"}${extension}`;
}

export function fileStem(workspaces: readonly Pick<Workspace, "name" | "catalogs">[]): string {
  if (workspaces.length !== 1) return "";
  return workspaceLabel(workspaces[0]).normalize("NFKD").replace(/[^\w\s-]/g, "").trim().replace(/\s+/g, "-").toLowerCase().slice(0, 80);
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

/** A portable workspace whose ids are all set. */
export type ImportedWorkspaceSpec = Omit<PortableWorkspace, "id" | "catalogs"> & { id: string; catalogs: (PortableCatalog & { id: string })[] };

/** One workspace to import. Ids are always set (generated when the source
 *  had none). */
export interface ImportWorkspace {
  workspace: ImportedWorkspaceSpec;
  /** Catalog id → option expressions to evaluate in the engine at connect
   *  time (a DuckDB script's `[1, 2]`, `'2024-01-01'::DATE`), the same path
   *  as the options form's raw text: checked against the constant allowlist
   *  before anything runs. */
  rawOptions?: Record<string, string>;
  /** Catalog id → secret option → where its value came from (a script's
   *  `getenv('SALES_API_KEY')`), for the post-import notice. */
  secretNotes?: Record<string, Record<string, string>>;
  /** What the reader should know about this workspace (from the validator,
   *  or the script parser's getenv() notes). */
  notes: string[];
}

export interface ParsedWorkspaceImport {
  workspaces: ImportWorkspace[];
  /** Workspaces that could not be read, by name or position. */
  errors: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Fill in missing ids. */
export function withIds(workspace: PortableWorkspace, notes: string[], newId: () => string = newWorkspaceId): ImportWorkspace {
  const seen = new Set<string>();
  const catalogs = workspace.catalogs.map((c) => {
    const id = c.id && !seen.has(c.id) ? c.id : newId();
    seen.add(id);
    return { ...c, id };
  });
  return { workspace: { ...workspace, id: workspace.id || newId(), catalogs }, notes };
}

/** Read a workspace file (or a bare workspace, or an array of workspaces).
 *  Throws only when the text is not one of those at all. */
export function parseWorkspaceImport(text: string, newId: () => string = newWorkspaceId): ParsedWorkspaceImport {
  let input: unknown;
  try { input = JSON.parse(text); } catch { throw new Error("This is not a workspace file: it is not valid JSON."); }
  let items: unknown[];
  if (Array.isArray(input)) items = input;
  else if (isRecord(input) && input.format === WORKSPACE_FORMAT) {
    if (typeof input.version !== "number" || input.version > WORKSPACE_VERSION) throw new Error("This workspace file was made by a newer version of Cupola. Update Cupola to import it.");
    if (input.version !== WORKSPACE_VERSION) throw new Error(`Unsupported workspace file version ${JSON.stringify(input.version)}.`);
    if (!Array.isArray(input.workspaces)) throw new Error("This workspace file has no workspaces.");
    items = input.workspaces;
  } else if (isRecord(input) && Array.isArray(input.catalogs)) items = [input];
  else throw new Error("This is not a Cupola workspace file.");
  if (!items.length) throw new Error("This workspace file has no workspaces.");

  const workspaces: ImportWorkspace[] = [];
  const errors: string[] = [];
  items.forEach((item, index) => {
    const title = isRecord(item) && typeof item.name === "string" && item.name.trim() ? `“${item.name.trim()}”` : `Workspace ${index + 1}`;
    // Each on its own: one bad workspace doesn't lose the rest.
    const result = validateWorkspaceFile({ format: WORKSPACE_FORMAT, version: WORKSPACE_VERSION, workspaces: [item] });
    if (!result.ok) {
      errors.push(`${title}: ${result.error}`);
      return;
    }
    workspaces.push(withIds(result.file.workspaces[0], result.warnings, newId));
  });
  return { workspaces, errors };
}

export type ImportStatus = "new" | "identical" | "conflict";

export interface ImportPlanItem {
  incoming: ImportWorkspace;
  status: ImportStatus;
  /** The stored workspace with the same id. */
  existing?: Workspace;
}

/** The name an imported workspace is saved under. An untitled one is named
 *  after its catalogs: an import is deliberate, so it is kept like a named
 *  workspace rather than pruned with the untitled ones. */
export function importedName(workspace: PortableWorkspace): string {
  return workspace.name?.trim() || workspaceLabel({ name: null, catalogs: workspace.catalogs.map((c) => ({ alias: c.alias ?? "", catalogName: c.catalogName, url: c.url })) });
}

/** What makes two workspaces the same, ignoring catalog ids (a script has
 *  none), secrets and the personal overlay. */
function canonical(name: string, catalogs: readonly { url: string; catalogName: string; alias?: string; options?: Record<string, string>; target?: string; dataVersionSpec?: string; id?: string }[], defaultCatalogId: string | null | undefined, defaultSchema: string | null | undefined): string {
  const aliases = catalogs.map((c) => c.alias ?? "");
  const defaultIndex = Math.max(0, catalogs.findIndex((c) => c.id === defaultCatalogId));
  return JSON.stringify({
    name,
    defaultSchema: defaultSchema || null,
    default: aliases[defaultIndex]?.toLowerCase() ?? "",
    catalogs: catalogs.map((c, i) => [
      normalizeServiceUrl(c.url),
      c.catalogName,
      aliases[i].toLowerCase(),
      Object.entries(c.options ?? {}).sort(([a], [b]) => a.localeCompare(b)),
      c.target ?? "",
      c.dataVersionSpec ?? "",
    ]),
  });
}

function incomingCanonical(item: ImportWorkspace): string {
  const ws = item.workspace;
  const { aliases } = assignAliases(ws.catalogs);
  return canonical(importedName(ws), ws.catalogs.map((c, i) => ({ ...c, alias: aliases[i] })), ws.defaultCatalogId, ws.defaultSchema);
}

function storedCanonical(ws: Workspace): string {
  return canonical(ws.name ?? workspaceLabel(ws), ws.catalogs, ws.defaultCatalogId, ws.defaultSchema);
}

/** Plan an import by id: a workspace whose id is not stored is new; one that
 *  is stored and the same (ignoring catalog ids, secrets and personal state)
 *  is skipped; otherwise it conflicts and the reader chooses. Pending option
 *  expressions always make a conflict, since they cannot be compared. */
export function planImport(existing: readonly Workspace[], incoming: readonly ImportWorkspace[]): ImportPlanItem[] {
  const seen = new Set<string>();
  return incoming.map((item) => {
    const match = existing.find((w) => w.id === item.workspace.id);
    // The same id twice in one import: the second is a copy.
    const duplicate = seen.has(item.workspace.id);
    seen.add(item.workspace.id);
    if (!match) return { incoming: item, status: duplicate ? "conflict" : "new" };
    const pending = item.rawOptions && Object.values(item.rawOptions).some(Boolean);
    const same = !pending && storedCanonical(match) === incomingCanonical(item);
    return { incoming: item, status: same && !duplicate ? "identical" : "conflict", existing: match };
  });
}

export type ConflictChoice = "replace" | "keep-both";

export interface SecretNeeded {
  workspaceId: string;
  workspaceName: string;
  catalogId: string;
  alias: string;
  option: string;
  /** e.g. the environment variable the script read it from. */
  note?: string;
}

export interface ImportResult {
  imported: { id: string; name: string; action: "new" | "replace" | "copy" }[];
  skipped: { id: string; name: string }[];
  /** Secret options with no value in this browser: enter them before (or
   *  when) the catalog connects. */
  secretsNeeded: SecretNeeded[];
  /** Validator, parser and alias notes, per workspace. */
  notes: string[];
  errors: string[];
}

/** Save a plan. Conflicts take `choose(item)`'s answer (default: keep both,
 *  which never loses anything).
 *
 *  Replace keeps the stored workspace's id, so its editor tabs, history and
 *  reports carry over, and keeps the personal overlay of catalogs whose id
 *  survives. Secrets stay only for a catalog whose id, URL and server name are
 *  all unchanged: a file that points a catalog id at another server never
 *  inherits the credential entered for the first one. */
export function applyImport(plan: readonly ImportPlanItem[], choose: (item: ImportPlanItem) => ConflictChoice = () => "keep-both"): ImportResult {
  const result: ImportResult = { imported: [], skipped: [], secretsNeeded: [], notes: [], errors: [] };
  for (const item of plan) {
    const ws = item.incoming.workspace;
    const name = importedName(ws);
    result.notes.push(...item.incoming.notes.map((n) => `${name}: ${n}`));
    if (item.status === "identical") {
      result.skipped.push({ id: ws.id, name });
      continue;
    }
    try {
      const choice = item.status === "conflict" ? choose(item) : null;
      const existing = item.existing ?? getWorkspace(ws.id) ?? undefined;
      const replace = choice === "replace" && existing;
      const kept: Record<string, Record<string, string>> = {};
      if (replace) {
        for (const c of ws.catalogs) {
          const old = existing.catalogs.find((o) => o.id === c.id);
          if (!old || normalizeServiceUrl(old.url) !== normalizeServiceUrl(c.url) || old.catalogName !== c.catalogName) continue;
          const values = catalogSecrets({ workspaceId: existing.id, catalogId: old.id, url: old.url, catalogName: old.catalogName });
          if (Object.keys(values).length) kept[c.id] = values;
        }
        deleteWorkspace(existing.id);
      }
      const copy = choice === "keep-both";
      const catalogs: NewCatalog[] = ws.catalogs.map((c) => {
        const old = replace ? existing.catalogs.find((o) => o.id === c.id) : undefined;
        return {
          id: c.id,
          url: c.url,
          catalogName: c.catalogName,
          alias: c.alias,
          options: { ...(c.options ?? {}) },
          ...(item.incoming.rawOptions?.[c.id] ? { rawOptions: item.incoming.rawOptions[c.id] } : {}),
          ...(c.target ? { target: c.target } : {}),
          ...(c.dataVersionSpec ? { dataVersionSpec: c.dataVersionSpec } : {}),
          ...(old ? { color: old.color, enabled: old.enabled } : {}),
        };
      });
      const savedName = copy ? `${name}${IMPORTED_SUFFIX}` : name;
      const saved = createWorkspace(catalogs, {
        id: copy ? newWorkspaceId() : ws.id,
        name: savedName,
        defaultCatalogId: ws.defaultCatalogId ?? null,
        defaultSchema: ws.defaultSchema ?? null,
        // Imported, not opened: it sorts after the workspaces in use.
        lastOpenedAt: replace ? existing.lastOpenedAt : 0,
      });
      for (const [catalogId, values] of Object.entries(kept)) {
        const c = saved.catalogs.find((x) => x.id === catalogId);
        if (c) saveCatalogSecrets({ workspaceId: saved.id, catalogId, url: c.url, catalogName: c.catalogName }, values);
      }
      // Aliases the store had to change (reserved, taken, invalid).
      ws.catalogs.forEach((c, i) => {
        const got = saved.catalogs[i]?.alias;
        if (c.alias && got && got !== c.alias) result.notes.push(`${savedName}: catalog "${c.alias}" is attached as "${got}".`);
      });
      for (const c of ws.catalogs) {
        const stored = saved.catalogs.find((x) => x.id === c.id);
        if (!stored || !c.secrets?.length) continue;
        const have = catalogSecrets({ workspaceId: saved.id, catalogId: stored.id, url: stored.url, catalogName: stored.catalogName });
        for (const option of c.secrets) {
          if (have[option.toLowerCase()]) continue;
          const note = item.incoming.secretNotes?.[c.id]?.[option];
          result.secretsNeeded.push({
            workspaceId: saved.id,
            workspaceName: savedName,
            catalogId: stored.id,
            alias: stored.alias,
            option,
            ...(note ? { note } : {}),
          });
        }
      }
      result.imported.push({ id: saved.id, name: savedName, action: replace ? "replace" : copy ? "copy" : "new" });
    } catch (error) {
      result.errors.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return result;
}

function uniqueNames(names: readonly string[]): string[] {
  const out: string[] = [];
  for (const n of names) if (!out.some((o) => o.toLowerCase() === n.toLowerCase())) out.push(n);
  return out;
}
