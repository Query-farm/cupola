/**
 * The persistent workspace store (multi-catalog phase 2; docs/multi-catalog.md).
 *
 * Two localStorage keys, kept apart on purpose:
 *
 * - `cupola.workspaces.v1`: the **portable** record of every workspace — its
 *   catalogs (URL, server catalog name, alias, non-secret options), default
 *   catalog and timestamps. This is what a `#ws=` link or a workspace file
 *   carries, minus the timestamps.
 * - `cupola.workspaces.local.v1`: the **personal overlay** — each catalog's
 *   colour and enabled flag, and which catalog roots are expanded in the
 *   sidebar. Never shared, never exported.
 *
 * Secrets are in neither: they live in the secret store
 * (`lib/attach/secret-store.ts`), keyed `workspaceId:catalogId:option`.
 *
 * Untitled workspaces (`name: null`) save themselves and are de-duplicated by
 * a fingerprint of their catalog set, so a server that redirects here again
 * and again reuses one workspace. At most `MAX_UNTITLED` are kept; the oldest
 * go first, and a retired one's id is remembered by fingerprint, so reopening
 * the same catalogs later finds its editor tabs, history and reports again.
 * Named workspaces are kept until deleted. Renaming an untitled workspace
 * names it.
 *
 * A full localStorage is not an error the page dies of: a write that does not
 * fit retires untitled workspaces (oldest first) and retries, and if it still
 * does not fit the change lives in memory for this page and `lastSaveError()`
 * says so.
 */
import { assignAliases, isValidAlias, serviceAlias } from "./aliases";
import { catalogKind, type ActiveCatalog, type ActiveWorkspace } from "./spec";
import type { OptionSink } from "../attach/connection";
import { catalogSecrets, clearCatalogSecrets, removeWorkspaceSecrets, saveCatalogSecrets } from "../attach/secret-store";

export const WORKSPACES_KEY = "cupola.workspaces.v1";
export const WORKSPACE_OVERLAY_KEY = "cupola.workspaces.local.v1";
/** Untitled workspaces kept; named ones are never pruned. */
export const MAX_UNTITLED = 10;
/** Colours in the catalog chip palette (`--catalog-chip-N` in global.css). */
export const PALETTE_SIZE = 8;
/** Retired untitled workspaces remembered by fingerprint. */
const MAX_RETIRED = 100;

export interface WorkspaceCatalog {
  /** Stable within the workspace; secrets are keyed by it. */
  id: string;
  url: string;
  /** The catalog's name on the server; "" until a `?service=` server names it. */
  catalogName: string;
  /** The DuckDB database name: the SQL contract. "" until known. */
  alias: string;
  /** Non-secret options, name → DuckDB text. */
  options: Record<string, string>;
  /** Legacy raw text still awaiting evaluation (never spliced into SQL). */
  rawOptions?: string;
  target?: string;
  dataVersionSpec?: string;
  /** Personal (overlay): chip colour index. */
  color: number;
  /** Personal (overlay): attached at load. A disabled catalog is kept. */
  enabled: boolean;
}

export interface Workspace {
  id: string;
  /** null: untitled. */
  name: string | null;
  catalogs: WorkspaceCatalog[];
  defaultCatalogId: string | null;
  defaultSchema?: string | null;
  createdAt: number;
  updatedAt: number;
  lastOpenedAt: number;
  /** The service URL this workspace inherits pre-workspace data from (editor
   *  tabs, history and reports keyed by URL), read as a fallback. Set for a
   *  `?service=` workspace and for one migrated from a recent server. */
  legacyServiceUrl?: string;
}

/** Personal state, per workspace. */
export interface WorkspaceOverlay {
  catalogs: Record<string, { color?: number; enabled?: boolean }>;
  /** Aliases of the catalog roots expanded in the sidebar; absent until the
   *  reader expands or collapses one. */
  expanded?: string[];
}

type StoredCatalog = Omit<WorkspaceCatalog, "color" | "enabled">;
type StoredWorkspace = Omit<Workspace, "catalogs"> & { catalogs: StoredCatalog[] };

interface StoreFile {
  version: 1;
  workspaces: StoredWorkspace[];
  /** Fingerprint → id of untitled workspaces pruned for space. */
  retired?: Record<string, string>;
}
interface OverlayFile {
  version: 1;
  workspaces: Record<string, WorkspaceOverlay>;
}

/** A catalog to add: everything but the id, colour and enabled flag, which
 *  the store fills in. */
export interface NewCatalog {
  id?: string;
  url: string;
  catalogName: string;
  alias?: string;
  options?: Record<string, string>;
  rawOptions?: string;
  target?: string;
  dataVersionSpec?: string;
  color?: number;
  enabled?: boolean;
}

// ---------------------------------------------------------------------------
// Storage and cache
// ---------------------------------------------------------------------------

let cache: { store: StoreFile; overlay: OverlayFile } | null = null;
let snapshot: Workspace[] | null = null;
let saveError: string | null = null;
const listeners = new Set<() => void>();
let idFactory: () => string = () => {
  try { if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID(); } catch { /* fall through */ }
  return `ws-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
};
let clock: () => number = () => Date.now();

function storage(): Storage | null {
  try { return typeof localStorage === "undefined" ? null : localStorage; } catch { return null; }
}

function readJson<T>(key: string): T | null {
  try {
    const raw = storage()?.getItem(key);
    return raw ? JSON.parse(raw) as T : null;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sanitizeCatalog(raw: unknown): StoredCatalog | null {
  if (!isRecord(raw) || typeof raw.id !== "string" || typeof raw.url !== "string") return null;
  const options: Record<string, string> = {};
  if (isRecord(raw.options)) for (const [k, v] of Object.entries(raw.options)) if (typeof v === "string") options[k] = v;
  const catalog: StoredCatalog = {
    id: raw.id,
    url: raw.url,
    catalogName: typeof raw.catalogName === "string" ? raw.catalogName : "",
    alias: typeof raw.alias === "string" ? raw.alias : "",
    options,
  };
  if (typeof raw.rawOptions === "string" && raw.rawOptions) catalog.rawOptions = raw.rawOptions;
  if (typeof raw.target === "string" && raw.target) catalog.target = raw.target;
  if (typeof raw.dataVersionSpec === "string" && raw.dataVersionSpec) catalog.dataVersionSpec = raw.dataVersionSpec;
  return catalog;
}

function sanitizeWorkspace(raw: unknown): StoredWorkspace | null {
  if (!isRecord(raw) || typeof raw.id !== "string" || !Array.isArray(raw.catalogs)) return null;
  const catalogs = raw.catalogs.map(sanitizeCatalog).filter((c): c is StoredCatalog => c !== null);
  const num = (v: unknown) => typeof v === "number" && Number.isFinite(v) ? v : 0;
  const ws: StoredWorkspace = {
    id: raw.id,
    name: typeof raw.name === "string" && raw.name.trim() ? raw.name : null,
    catalogs,
    defaultCatalogId: typeof raw.defaultCatalogId === "string" ? raw.defaultCatalogId : null,
    createdAt: num(raw.createdAt),
    updatedAt: num(raw.updatedAt),
    lastOpenedAt: num(raw.lastOpenedAt),
  };
  if (typeof raw.defaultSchema === "string" && raw.defaultSchema) ws.defaultSchema = raw.defaultSchema;
  if (typeof raw.legacyServiceUrl === "string" && raw.legacyServiceUrl) ws.legacyServiceUrl = raw.legacyServiceUrl;
  return ws;
}

function load(): { store: StoreFile; overlay: OverlayFile } {
  if (cache) return cache;
  const rawStore = readJson<unknown>(WORKSPACES_KEY);
  const rawOverlay = readJson<unknown>(WORKSPACE_OVERLAY_KEY);
  const store: StoreFile = { version: 1, workspaces: [] };
  if (isRecord(rawStore) && Array.isArray(rawStore.workspaces)) {
    const seen = new Set<string>();
    for (const w of rawStore.workspaces) {
      const ws = sanitizeWorkspace(w);
      if (ws && !seen.has(ws.id)) { seen.add(ws.id); store.workspaces.push(ws); }
    }
    if (isRecord(rawStore.retired)) {
      store.retired = Object.fromEntries(Object.entries(rawStore.retired).filter((e): e is [string, string] => typeof e[1] === "string"));
    }
  }
  const overlay: OverlayFile = { version: 1, workspaces: {} };
  if (isRecord(rawOverlay) && isRecord(rawOverlay.workspaces)) {
    for (const [id, value] of Object.entries(rawOverlay.workspaces)) {
      if (!isRecord(value)) continue;
      const catalogs: WorkspaceOverlay["catalogs"] = {};
      if (isRecord(value.catalogs)) {
        for (const [cid, c] of Object.entries(value.catalogs)) {
          if (!isRecord(c)) continue;
          catalogs[cid] = {
            ...(typeof c.color === "number" ? { color: c.color } : {}),
            ...(typeof c.enabled === "boolean" ? { enabled: c.enabled } : {}),
          };
        }
      }
      overlay.workspaces[id] = {
        catalogs,
        ...(Array.isArray(value.expanded) ? { expanded: value.expanded.filter((a): a is string => typeof a === "string") } : {}),
      };
    }
  }
  cache = { store, overlay };
  return cache;
}

function notify() {
  snapshot = null;
  for (const listener of listeners) listener();
}

/** Write both files. On a full storage, retire untitled workspaces (oldest,
 *  never `keep`) one at a time and try again. */
function persist(keep?: string): boolean {
  const s = storage();
  const state = load();
  if (!s) { notify(); return false; }
  for (;;) {
    try {
      s.setItem(WORKSPACES_KEY, JSON.stringify(state.store));
      s.setItem(WORKSPACE_OVERLAY_KEY, JSON.stringify(state.overlay));
      saveError = null;
      notify();
      return true;
    } catch {
      const victim = state.store.workspaces
        .filter((w) => w.name === null && w.id !== keep)
        .sort((a, b) => a.lastOpenedAt - b.lastOpenedAt)[0];
      if (!victim) {
        saveError = "This browser's storage for Cupola is full, so workspace changes are kept for this page only. Delete saved reports or query history you no longer need.";
        notify();
        return false;
      }
      retire(state.store, victim);
    }
  }
}

function retire(store: StoreFile, victim: StoredWorkspace) {
  store.workspaces = store.workspaces.filter((w) => w.id !== victim.id);
  const retired = { ...(store.retired ?? {}), [fingerprintOf(victim.catalogs)]: victim.id };
  const entries = Object.entries(retired);
  store.retired = Object.fromEntries(entries.slice(Math.max(0, entries.length - MAX_RETIRED)));
}

function merge(ws: StoredWorkspace, overlay: OverlayFile): Workspace {
  const personal = overlay.workspaces[ws.id]?.catalogs ?? {};
  return {
    ...ws,
    catalogs: ws.catalogs.map((c, i) => ({
      ...c,
      options: { ...c.options },
      color: normalColor(personal[c.id]?.color ?? i),
      enabled: personal[c.id]?.enabled ?? true,
    })),
  };
}

function normalColor(n: number): number {
  return ((Math.trunc(n) % PALETTE_SIZE) + PALETTE_SIZE) % PALETTE_SIZE;
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/** Every workspace, most recently opened first. Stable identity between
 *  changes (for `useSyncExternalStore`). */
export function listWorkspaces(): Workspace[] {
  if (snapshot) return snapshot;
  const { store, overlay } = load();
  snapshot = store.workspaces.map((w) => merge(w, overlay)).sort((a, b) => b.lastOpenedAt - a.lastOpenedAt);
  return snapshot;
}

export function getWorkspace(id: string): Workspace | null {
  return listWorkspaces().find((w) => w.id === id) ?? null;
}

export function getOverlay(id: string): WorkspaceOverlay {
  return load().overlay.workspaces[id] ?? { catalogs: {} };
}

export function subscribeWorkspaces(listener: () => void): () => void {
  listeners.add(listener);
  const onStorage = (event: StorageEvent) => {
    if (event.key !== null && event.key !== WORKSPACES_KEY && event.key !== WORKSPACE_OVERLAY_KEY) return;
    cache = null;
    notify();
  };
  if (typeof window !== "undefined") window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    if (typeof window !== "undefined") window.removeEventListener("storage", onStorage);
  };
}

/** Why the last write did not reach localStorage, or null. */
export function lastSaveError(): string | null {
  return saveError;
}

/** A workspace's display name: its own, or its catalogs' aliases. */
export function workspaceLabel(ws: { name: string | null; catalogs: readonly Pick<WorkspaceCatalog, "alias" | "catalogName" | "url">[] }): string {
  if (ws.name) return ws.name;
  const names = ws.catalogs.map((c) => c.alias || c.catalogName || hostOf(c.url));
  if (!names.length) return "Empty workspace";
  return names.length <= 2 ? names.join(", ") : `${names.slice(0, 2).join(", ")} +${names.length - 2}`;
}

export function hostOf(url: string): string {
  try {
    const u = new URL(url.replace(/^grainlift\+/i, "").replace(/^grainlift:/i, "https:"));
    return u.host || url;
  } catch {
    return url;
  }
}

// ---------------------------------------------------------------------------
// Fingerprints
// ---------------------------------------------------------------------------

/** URLs compare without a trailing slash and with a lower-case scheme and host. */
export function normalizeServiceUrl(url: string): string {
  const trimmed = url.trim().replace(/\/+$/, "");
  const m = /^([a-z][a-z0-9+.-]*:\/\/)([^/?#]*)(.*)$/i.exec(trimmed);
  return m ? `${m[1].toLowerCase()}${m[2].toLowerCase()}${m[3]}` : trimmed;
}

/** A catalog set's identity: which catalogs, not what they are called or how
 *  they are configured. Order does not matter. */
export function fingerprintOf(catalogs: readonly Pick<WorkspaceCatalog, "url" | "catalogName" | "target">[]): string {
  return catalogs
    .map((c) => [normalizeServiceUrl(c.url), c.catalogName.toLowerCase(), c.target ?? ""].join("\u0001"))
    .sort()
    .join("\u0002");
}

function sameService(c: Pick<WorkspaceCatalog, "url" | "target">, url: string, target?: string): boolean {
  return normalizeServiceUrl(c.url) === normalizeServiceUrl(url) && (c.target ?? "") === (target ?? "");
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

function mutate<T>(id: string, change: (ws: StoredWorkspace, overlay: WorkspaceOverlay) => T): T | null {
  const state = load();
  const ws = state.store.workspaces.find((w) => w.id === id);
  if (!ws) return null;
  const overlay = state.overlay.workspaces[id] ?? (state.overlay.workspaces[id] = { catalogs: {} });
  const result = change(ws, overlay);
  persist(id);
  return result;
}

function newCatalog(input: NewCatalog, taken: Set<string>, color: number): { stored: StoredCatalog; color: number; enabled: boolean } {
  const id = input.id || idFactory();
  let alias = input.alias ?? "";
  if (alias || input.catalogName) {
    const assigned = assignAliases([{ alias: alias || null, catalogName: input.catalogName || alias }], taken).aliases[0];
    alias = assigned;
    taken.add(alias.toLowerCase());
  }
  const stored: StoredCatalog = { id, url: input.url.trim(), catalogName: input.catalogName, alias, options: { ...(input.options ?? {}) } };
  if (input.rawOptions) stored.rawOptions = input.rawOptions;
  if (input.target) stored.target = input.target;
  if (input.dataVersionSpec) stored.dataVersionSpec = input.dataVersionSpec;
  return { stored, color: input.color ?? color, enabled: input.enabled ?? true };
}

/** The colour least used so far (the first such, in palette order). */
export function nextColor(used: readonly number[]): number {
  const counts = new Array(PALETTE_SIZE).fill(0);
  for (const c of used) counts[normalColor(c)]++;
  return counts.indexOf(Math.min(...counts));
}

export interface CreateOptions {
  name?: string | null;
  defaultCatalogId?: string | null;
  defaultSchema?: string | null;
  legacyServiceUrl?: string;
  /** Reuse this id (a retired workspace coming back, a link's own id). */
  id?: string;
  lastOpenedAt?: number;
}

/** Create a workspace. Aliases are assigned here, once. */
export function createWorkspace(catalogs: readonly NewCatalog[], opts: CreateOptions = {}): Workspace {
  const state = load();
  const now = clock();
  const id = opts.id && !state.store.workspaces.some((w) => w.id === opts.id) ? opts.id : idFactory();
  const taken = new Set<string>();
  const overlay: WorkspaceOverlay = { catalogs: {} };
  const colors: number[] = [];
  const stored: StoredCatalog[] = [];
  for (const input of catalogs) {
    const made = newCatalog(input, taken, nextColor(colors));
    colors.push(made.color);
    stored.push(made.stored);
    overlay.catalogs[made.stored.id] = { color: made.color, enabled: made.enabled };
  }
  const ws: StoredWorkspace = {
    id,
    name: opts.name?.trim() || null,
    catalogs: stored,
    defaultCatalogId: opts.defaultCatalogId && stored.some((c) => c.id === opts.defaultCatalogId) ? opts.defaultCatalogId : stored[0]?.id ?? null,
    createdAt: now,
    updatedAt: now,
    lastOpenedAt: opts.lastOpenedAt ?? now,
  };
  if (opts.defaultSchema) ws.defaultSchema = opts.defaultSchema;
  if (opts.legacyServiceUrl) ws.legacyServiceUrl = opts.legacyServiceUrl;
  state.store.workspaces.push(ws);
  state.overlay.workspaces[id] = overlay;
  if (state.store.retired) {
    for (const [fp, rid] of Object.entries(state.store.retired)) if (rid === id) delete state.store.retired[fp];
  }
  pruneUntitled(state.store, id);
  persist(id);
  return getWorkspace(id) ?? merge(ws, state.overlay);
}

function pruneUntitled(store: StoreFile, keep: string) {
  const untitled = store.workspaces.filter((w) => w.name === null).sort((a, b) => b.lastOpenedAt - a.lastOpenedAt);
  for (const victim of untitled.slice(MAX_UNTITLED)) if (victim.id !== keep) retire(store, victim);
}

/** The untitled workspace holding exactly this catalog set, if any. */
export function findUntitledByFingerprint(fingerprint: string): Workspace | null {
  return listWorkspaces().find((w) => w.name === null && fingerprintOf(w.catalogs) === fingerprint) ?? null;
}

/** Open an untitled workspace for a catalog set: the existing one with the
 *  same fingerprint, a retired one coming back under its old id, or a new one. */
export function openUntitled(catalogs: readonly NewCatalog[], opts: Omit<CreateOptions, "name"> = {}): { workspace: Workspace; created: boolean } {
  const fp = fingerprintOf(catalogs.map((c) => ({ url: c.url, catalogName: c.catalogName, target: c.target })));
  const existing = findUntitledByFingerprint(fp);
  if (existing) {
    touchOpened(existing.id);
    return { workspace: getWorkspace(existing.id)!, created: false };
  }
  const retiredId = load().store.retired?.[fp];
  return { workspace: createWorkspace(catalogs, { ...opts, id: opts.id ?? retiredId }), created: true };
}

/** Store a consented `#ws=` link as an untitled workspace. One already
 *  holding the same catalog set is reused, keeping its catalog ids (secrets
 *  are keyed by them) and aliases (the SQL already written against it), and
 *  taking the link's non-secret options. */
export function adoptLinkWorkspace(active: ActiveWorkspace): Workspace {
  const existing = findUntitledByFingerprint(fingerprintOf(active.catalogs));
  if (existing) {
    for (const linked of active.catalogs) {
      const match = existing.catalogs.find((c) => fingerprintOf([c]) === fingerprintOf([linked]));
      if (match) updateCatalog(existing.id, match.id, { options: { ...match.options, ...linked.options } });
    }
    touchOpened(existing.id);
    return getWorkspace(existing.id)!;
  }
  const defaultCatalogId = active.defaultCatalogId;
  return createWorkspace(active.catalogs.map((c) => ({
    id: c.id,
    url: c.url,
    catalogName: c.catalogName,
    alias: c.alias,
    options: c.options,
    target: c.target,
    dataVersionSpec: c.dataVersionSpec,
  })), { id: active.id, defaultCatalogId, defaultSchema: active.defaultSchema });
}

/** The `?service=` workspace: an untitled workspace whose only catalog is
 *  this service (the server names its catalog later, so the name is not part
 *  of the match). Never a named one: a server redirect never changes those. */
export function findUntitledForService(url: string, target?: string): Workspace | null {
  return listWorkspaces().find((w) => w.name === null && w.catalogs.length === 1 && sameService(w.catalogs[0], url, target)) ?? null;
}

export interface ServiceSeed {
  catalogName?: string;
  alias?: string;
  options?: Record<string, string>;
  rawOptions?: string;
}

/** Open (or create) the untitled workspace for one service. `seed` fills a
 *  new one, from the pre-workspace recent-services entry. */
export function openServiceWorkspace(url: string, target: string | undefined, seed: ServiceSeed = {}): { workspace: Workspace; created: boolean } {
  const existing = findUntitledForService(url, target);
  if (existing) {
    touchOpened(existing.id);
    return { workspace: getWorkspace(existing.id)!, created: false };
  }
  const fp = fingerprintOf([{ url, catalogName: seed.catalogName ?? "", target }]);
  const retiredId = load().store.retired?.[fp];
  const workspace = createWorkspace([{
    url,
    catalogName: seed.catalogName ?? "",
    alias: seed.alias ?? (seed.catalogName ? serviceAlias(seed.catalogName) : ""),
    options: seed.options,
    rawOptions: seed.rawOptions,
    target,
  }], { legacyServiceUrl: url, id: retiredId });
  return { workspace, created: true };
}

/** Named workspaces holding this service, most recently opened first. */
export function namedWorkspacesWith(url: string, target?: string): Workspace[] {
  return listWorkspaces().filter((w) => w.name !== null && w.catalogs.some((c) => sameService(c, url, target)));
}

/** The named workspace opened last. */
export function lastNamedWorkspace(): Workspace | null {
  return listWorkspaces().find((w) => w.name !== null) ?? null;
}

export function touchOpened(id: string): void {
  mutate(id, (ws) => { ws.lastOpenedAt = Math.max(clock(), ws.lastOpenedAt + 1); });
}

/** Rename. A name makes an untitled workspace a named one; an empty name
 *  makes it untitled again. */
export function renameWorkspace(id: string, name: string | null): void {
  mutate(id, (ws) => { ws.name = name?.trim() ? name.trim().slice(0, 200) : null; ws.updatedAt = clock(); });
}

export function deleteWorkspace(id: string): void {
  const state = load();
  state.store.workspaces = state.store.workspaces.filter((w) => w.id !== id);
  delete state.overlay.workspaces[id];
  persist();
  removeWorkspaceSecrets(id);
}

/** Add a catalog. Its alias is made unique within the workspace (and saved). */
export function addCatalog(id: string, input: NewCatalog): WorkspaceCatalog | null {
  const added = mutate(id, (ws, overlay) => {
    const taken = new Set(ws.catalogs.map((c) => c.alias.toLowerCase()).filter(Boolean));
    const colors = ws.catalogs.map((c, i) => overlay.catalogs[c.id]?.color ?? i);
    const made = newCatalog(input, taken, nextColor(colors));
    ws.catalogs.push(made.stored);
    overlay.catalogs[made.stored.id] = { color: made.color, enabled: made.enabled };
    if (!ws.defaultCatalogId) ws.defaultCatalogId = made.stored.id;
    ws.updatedAt = clock();
    return made.stored.id;
  });
  return added ? getWorkspace(id)?.catalogs.find((c) => c.id === added) ?? null : null;
}

/** Put a removed catalog back where it was (Detach's undo). */
export function restoreCatalog(id: string, catalog: WorkspaceCatalog, index: number, wasDefault: boolean): void {
  mutate(id, (ws, overlay) => {
    if (ws.catalogs.some((c) => c.id === catalog.id)) return;
    const { color, enabled, ...stored } = catalog;
    ws.catalogs.splice(Math.min(index, ws.catalogs.length), 0, stored);
    overlay.catalogs[catalog.id] = { color, enabled };
    if (wasDefault || !ws.defaultCatalogId) ws.defaultCatalogId = catalog.id;
    ws.updatedAt = clock();
  });
}

/** Remove a catalog. Returns what Detach's undo needs. */
export function removeCatalog(id: string, catalogId: string): { catalog: WorkspaceCatalog; index: number; wasDefault: boolean } | null {
  const before = getWorkspace(id);
  const index = before?.catalogs.findIndex((c) => c.id === catalogId) ?? -1;
  if (!before || index < 0) return null;
  const catalog = before.catalogs[index];
  const wasDefault = before.defaultCatalogId === catalogId;
  mutate(id, (ws, overlay) => {
    ws.catalogs = ws.catalogs.filter((c) => c.id !== catalogId);
    delete overlay.catalogs[catalogId];
    if (ws.defaultCatalogId === catalogId) ws.defaultCatalogId = ws.catalogs[0]?.id ?? null;
    ws.updatedAt = clock();
  });
  return { catalog, index, wasDefault };
}

export type CatalogPatch = Partial<Pick<WorkspaceCatalog, "catalogName" | "alias" | "options" | "rawOptions" | "target" | "dataVersionSpec">>;

/** Update a catalog's portable fields. An alias that is not valid, or is
 *  taken, is refused (false). */
export function updateCatalog(id: string, catalogId: string, patch: CatalogPatch): boolean {
  const ws = getWorkspace(id);
  const current = ws?.catalogs.find((c) => c.id === catalogId);
  if (!ws || !current) return false;
  if (patch.alias !== undefined && patch.alias !== current.alias) {
    if (patch.alias && (!isValidAlias(patch.alias) || ws.catalogs.some((c) => c.id !== catalogId && c.alias.toLowerCase() === patch.alias!.toLowerCase()))) return false;
  }
  const unchanged = Object.entries(patch).every(([k, v]) => JSON.stringify((current as unknown as Record<string, unknown>)[k] ?? (k === "rawOptions" ? "" : undefined)) === JSON.stringify(v ?? (k === "rawOptions" ? "" : undefined)));
  if (unchanged) return true;
  mutate(id, (stored) => {
    const c = stored.catalogs.find((x) => x.id === catalogId)!;
    if (patch.catalogName !== undefined) c.catalogName = patch.catalogName;
    if (patch.alias !== undefined) c.alias = patch.alias;
    if (patch.options !== undefined) c.options = { ...patch.options };
    if (patch.rawOptions !== undefined) { if (patch.rawOptions) c.rawOptions = patch.rawOptions; else delete c.rawOptions; }
    if (patch.target !== undefined) { if (patch.target) c.target = patch.target; else delete c.target; }
    if (patch.dataVersionSpec !== undefined) { if (patch.dataVersionSpec) c.dataVersionSpec = patch.dataVersionSpec; else delete c.dataVersionSpec; }
    stored.updatedAt = clock();
  });
  return true;
}

export function setDefaultCatalog(id: string, catalogId: string): void {
  mutate(id, (ws) => {
    if (!ws.catalogs.some((c) => c.id === catalogId)) return;
    ws.defaultCatalogId = catalogId;
    ws.updatedAt = clock();
  });
}

/** Personal: whether a catalog is attached at load. */
export function setCatalogEnabled(id: string, catalogId: string, enabled: boolean): void {
  mutate(id, (_ws, overlay) => {
    overlay.catalogs[catalogId] = { ...(overlay.catalogs[catalogId] ?? {}), enabled };
  });
}

/** Personal: a catalog's chip colour. */
export function setCatalogColor(id: string, catalogId: string, color: number): void {
  mutate(id, (_ws, overlay) => {
    overlay.catalogs[catalogId] = { ...(overlay.catalogs[catalogId] ?? {}), color: normalColor(color) };
  });
}

/** Personal: the expanded catalog roots, by alias. */
export function setExpandedCatalogs(id: string, aliases: readonly string[]): void {
  const current = getOverlay(id).expanded;
  if (current && current.length === aliases.length && current.every((a, i) => a === aliases[i])) return;
  mutate(id, (_ws, overlay) => { overlay.expanded = [...aliases]; });
}

/** Where one workspace catalog's options and secrets are stored, for
 *  `attach/connection.ts`. Reads the record fresh each time, so a catalog
 *  edited elsewhere in the page is seen. */
export function catalogOptionSink(workspaceId: string, catalogId: string): OptionSink {
  const current = () => getWorkspace(workspaceId)?.catalogs.find((c) => c.id === catalogId);
  const ref = (catalogName: string) => ({ workspaceId, catalogId, url: current()?.url ?? "", catalogName: catalogName || current()?.catalogName || "" });
  return {
    stored: () => {
      const c = current();
      return { options: { ...(c?.options ?? {}) }, ...(c?.rawOptions ? { rawOptions: c.rawOptions } : {}) };
    },
    secrets: (catalogName) => catalogSecrets(ref(catalogName)),
    save: (catalogName, update) => {
      const c = current();
      if (!c) return;
      updateCatalog(workspaceId, catalogId, {
        ...(catalogName && !c.catalogName ? { catalogName } : {}),
        ...(update.options !== undefined ? { options: update.options } : {}),
        ...(update.rawOptions !== undefined ? { rawOptions: update.rawOptions } : {}),
      });
    },
    saveSecrets: (catalogName, values, opts) => saveCatalogSecrets(ref(catalogName), values, opts),
    clear: () => {
      updateCatalog(workspaceId, catalogId, { options: {}, rawOptions: "" });
      clearCatalogSecrets(ref(""));
    },
  };
}

// ---------------------------------------------------------------------------
// The page's catalog set
// ---------------------------------------------------------------------------

/** The catalogs this page load attaches: the enabled ones. */
export function toActiveWorkspace(ws: Workspace, source: ActiveWorkspace["source"], notes: string[] = []): ActiveWorkspace {
  const enabled = ws.catalogs.filter((c) => c.enabled);
  return {
    id: ws.id,
    name: ws.name,
    source,
    catalogs: enabled.map(toActiveCatalog),
    defaultCatalogId: ws.defaultCatalogId && enabled.some((c) => c.id === ws.defaultCatalogId) ? ws.defaultCatalogId : enabled[0]?.id ?? null,
    defaultSchema: ws.defaultSchema ?? null,
    notes,
  };
}

export function toActiveCatalog(c: WorkspaceCatalog): ActiveCatalog {
  return {
    id: c.id,
    url: c.url,
    kind: catalogKind(c.url),
    catalogName: c.catalogName,
    alias: c.alias,
    options: { ...c.options },
    ...(c.target ? { target: c.target } : {}),
    ...(c.dataVersionSpec ? { dataVersionSpec: c.dataVersionSpec } : {}),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

/** Drop the in-memory copy (tests, and after another tab's write). */
export function resetWorkspaceCache(): void {
  cache = null;
  snapshot = null;
  saveError = null;
}

/** Deterministic ids and time, for unit tests. Pass nothing to restore. */
export function setWorkspaceTestHooks(hooks: { newId?: () => string; now?: () => number } = {}): void {
  idFactory = hooks.newId ?? (() => {
    try { if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID(); } catch { /* fall through */ }
    return `ws-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  });
  clock = hooks.now ?? (() => Date.now());
}

export function newWorkspaceId(): string {
  return idFactory();
}
