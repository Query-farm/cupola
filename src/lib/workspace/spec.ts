/**
 * The portable workspace format (`#ws=` links now; workspace files and the
 * phase 2 store later), its validator, and the normaliser that turns one
 * portable workspace into the catalog list the app attaches.
 *
 * ```json
 * {"format": "cupola-workspaces", "version": 1, "workspaces": [
 *   {"id": "…", "name": "Finance", "defaultCatalogId": "…", "defaultSchema": "main",
 *    "catalogs": [{"id": "…", "url": "https://…", "catalogName": "sales",
 *                  "alias": "sales", "options": {"region": "eu"},
 *                  "target": "…", "dataVersionSpec": "…"}]}]}
 * ```
 *
 * A portable workspace carries **no secrets**. The validator drops any option
 * whose name looks like a credential (it cannot know the server's specs), and
 * reports it, rather than letting a link plant a credential in someone's
 * session. A catalog may list its secret options' NAMES (`secrets`), never
 * their values, so an import can say what to enter (`file.ts`). Option values are DuckDB text, as in `lib/attach/options.ts`, and
 * go through the same quoting builder; names must be plain identifiers.
 *
 * Pure: unit-tested in tests/unit/workspace.test.ts.
 */
import { OPTION_NAME_RE, SECRET_NAME_RE, type CatalogKind } from "../attach/options";
import { assignAliases } from "./aliases";

export const WORKSPACE_FORMAT = "cupola-workspaces";
export const WORKSPACE_VERSION = 1;
/** More than this many catalogs in one workspace is refused: each is an
 *  ATTACH, run one at a time. */
export const MAX_CATALOGS = 16;

export interface PortableCatalog {
  /** Stable within the workspace; generated when absent. */
  id?: string;
  url: string;
  /** The catalog's name on the server. */
  catalogName: string;
  alias?: string;
  /** Option name → DuckDB text of the value. Never secrets. */
  options?: Record<string, string>;
  /** Names (never values) of the secret options the catalog takes, so an
   *  import can say which values to enter. Workspace files and scripts carry
   *  them; a value is never part of the portable record. */
  secrets?: string[];
  target?: string;
  dataVersionSpec?: string;
}

export interface PortableWorkspace {
  id?: string;
  name?: string | null;
  catalogs: PortableCatalog[];
  /** A catalog `id` (or, for hand-written links, an alias). */
  defaultCatalogId?: string | null;
  defaultSchema?: string | null;
}

export interface PortableWorkspaceFile {
  format: typeof WORKSPACE_FORMAT;
  version: typeof WORKSPACE_VERSION;
  workspaces: PortableWorkspace[];
}

/** One catalog as the app attaches it: everything normalised, alias fixed. */
export interface ActiveCatalog {
  id: string;
  url: string;
  kind: CatalogKind;
  /** The catalog's name on the server. Empty for a `?service=` catalog until
   *  the server has been asked. */
  catalogName: string;
  /** The DuckDB database name. Empty for a `?service=` catalog until the
   *  server has named it. */
  alias: string;
  /** Non-secret options from the link (DuckDB text). */
  options: Record<string, string>;
  target?: string;
  dataVersionSpec?: string;
}

/** The catalog set of this page load. */
export interface ActiveWorkspace {
  id: string;
  name: string | null;
  /** `service`: the frozen single-catalog `?service=` contract. `link`: a
   *  `#ws=` workspace link. */
  source: "service" | "link";
  catalogs: ActiveCatalog[];
  /** The catalog that gets `USE`; null means the first. */
  defaultCatalogId: string | null;
  defaultSchema: string | null;
  /** Things the validator and normaliser changed or dropped, shown on the
   *  consent screen. */
  notes: string[];
}

/** Exported for the JSON Schema test (`public/schema/workspace-v1.json`). */
export const SERVICE_URL = /^(?:https?|grainlift(?:\+(?:https?|iroh))?):\/\/\S+$/i;
const GRAINLIFT = /^grainlift(?:\+(?:https?|iroh))?:\/\//i;
export const MAX_TEXT = 2048;
export const MAX_CATALOG_NAME = 255;

export type ValidationResult =
  | { ok: true; file: PortableWorkspaceFile; warnings: string[] }
  | { ok: false; error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalText(value: unknown, field: string, errors: string[]): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") {
    errors.push(`${field} must be text.`);
    return undefined;
  }
  if (value.length > MAX_TEXT) {
    errors.push(`${field} is too long.`);
    return undefined;
  }
  return value;
}

/** Check a decoded workspace file. Unknown keys are ignored; anything that
 *  would change what is attached in a way the reader cannot see is refused. */
export function validateWorkspaceFile(value: unknown): ValidationResult {
  if (!isRecord(value)) return { ok: false, error: "The workspace is not a JSON object." };
  if (value.format !== WORKSPACE_FORMAT) return { ok: false, error: `Not a Cupola workspace (format must be "${WORKSPACE_FORMAT}").` };
  if (value.version !== WORKSPACE_VERSION) return { ok: false, error: `Unsupported workspace version ${JSON.stringify(value.version)}; this Cupola reads version ${WORKSPACE_VERSION}.` };
  if (!Array.isArray(value.workspaces) || value.workspaces.length === 0) return { ok: false, error: "The workspace file lists no workspaces." };

  const warnings: string[] = [];
  const workspaces: PortableWorkspace[] = [];
  for (const [wi, raw] of value.workspaces.entries()) {
    const where = value.workspaces.length > 1 ? `Workspace ${wi + 1}: ` : "";
    if (!isRecord(raw)) return { ok: false, error: `${where}not an object.` };
    if (!Array.isArray(raw.catalogs) || raw.catalogs.length === 0) return { ok: false, error: `${where}lists no catalogs.` };
    if (raw.catalogs.length > MAX_CATALOGS) return { ok: false, error: `${where}lists ${raw.catalogs.length} catalogs; at most ${MAX_CATALOGS} are allowed.` };
    const errors: string[] = [];
    const catalogs: PortableCatalog[] = [];
    for (const [ci, rawCatalog] of raw.catalogs.entries()) {
      const label = `${where}catalog ${ci + 1}`;
      if (!isRecord(rawCatalog)) {
        errors.push(`${label} is not an object.`);
        continue;
      }
      const url = typeof rawCatalog.url === "string" ? rawCatalog.url.trim() : "";
      if (!SERVICE_URL.test(url) || url.length > MAX_TEXT) {
        errors.push(`${label}: "url" must be an http(s) or grainlift URL.`);
        continue;
      }
      const catalogName = typeof rawCatalog.catalogName === "string" ? rawCatalog.catalogName.trim() : "";
      if (!catalogName || catalogName.length > MAX_CATALOG_NAME) {
        errors.push(`${label}: "catalogName" is required.`);
        continue;
      }
      const catalog: PortableCatalog = { url, catalogName };
      const id = optionalText(rawCatalog.id, `${label} id`, errors);
      if (id) catalog.id = id;
      const alias = optionalText(rawCatalog.alias, `${label} alias`, errors);
      if (alias) catalog.alias = alias;
      const target = optionalText(rawCatalog.target, `${label} target`, errors);
      if (target) catalog.target = target;
      const dvs = optionalText(rawCatalog.dataVersionSpec, `${label} dataVersionSpec`, errors);
      if (dvs) catalog.dataVersionSpec = dvs;
      if (rawCatalog.options !== undefined && rawCatalog.options !== null) {
        if (!isRecord(rawCatalog.options)) {
          errors.push(`${label}: "options" must be an object of name → value.`);
        } else {
          const options: Record<string, string> = {};
          for (const [name, optionValue] of Object.entries(rawCatalog.options)) {
            if (!OPTION_NAME_RE.test(name)) {
              warnings.push(`${label}: option ${JSON.stringify(name)} is not a valid option name and was dropped.`);
              continue;
            }
            if (SECRET_NAME_RE.test(name)) {
              warnings.push(`${label}: option "${name}" looks like a credential. Links never carry secrets, so it was dropped; enter it in this browser instead.`);
              continue;
            }
            if (typeof optionValue === "string") options[name] = optionValue;
            else if (typeof optionValue === "number" || typeof optionValue === "boolean") options[name] = String(optionValue);
            else warnings.push(`${label}: option "${name}" must be text (DuckDB's text form of the value) and was dropped.`);
          }
          if (Object.keys(options).length) catalog.options = options;
        }
      }
      if (rawCatalog.secrets !== undefined && rawCatalog.secrets !== null) {
        if (!Array.isArray(rawCatalog.secrets)) {
          errors.push(`${label}: "secrets" must be a list of option names.`);
        } else {
          const names: string[] = [];
          for (const name of rawCatalog.secrets) {
            if (typeof name !== "string" || !OPTION_NAME_RE.test(name)) {
              warnings.push(`${label}: secret ${JSON.stringify(name)} is not a valid option name and was dropped.`);
              continue;
            }
            if (names.some((n) => n.toLowerCase() === name.toLowerCase())) continue;
            names.push(name);
            // A secret's value is never portable, whatever its name.
            for (const key of Object.keys(catalog.options ?? {})) {
              if (key.toLowerCase() !== name.toLowerCase()) continue;
              delete catalog.options![key];
              warnings.push(`${label}: option "${key}" is secret, so its value was dropped; enter it in this browser instead.`);
            }
          }
          if (catalog.options && !Object.keys(catalog.options).length) delete catalog.options;
          if (names.length) catalog.secrets = names;
        }
      }
      catalogs.push(catalog);
    }
    if (errors.length) return { ok: false, error: errors.join(" ") };
    const workspace: PortableWorkspace = { catalogs };
    const id = optionalText(raw.id, `${where}id`, errors);
    if (id) workspace.id = id;
    if (raw.name !== undefined && raw.name !== null && typeof raw.name !== "string") errors.push(`${where}"name" must be text.`);
    else if (typeof raw.name === "string" && raw.name.trim()) workspace.name = raw.name.trim().slice(0, 200);
    const defaultCatalogId = optionalText(raw.defaultCatalogId, `${where}defaultCatalogId`, errors);
    if (defaultCatalogId) workspace.defaultCatalogId = defaultCatalogId;
    const defaultSchema = optionalText(raw.defaultSchema, `${where}defaultSchema`, errors);
    if (defaultSchema) workspace.defaultSchema = defaultSchema;
    if (errors.length) return { ok: false, error: errors.join(" ") };
    workspaces.push(workspace);
  }
  return { ok: true, file: { format: WORKSPACE_FORMAT, version: WORKSPACE_VERSION, workspaces }, warnings };
}

export function catalogKind(url: string): CatalogKind {
  return GRAINLIFT.test(url) ? "grainlift" : "vgi";
}

/** The catalog set for one portable workspace. Ids are generated where
 *  missing and aliases assigned here, once; the result is what gets stored, so
 *  a reload attaches under the same aliases. */
export function normaliseWorkspace(
  workspace: PortableWorkspace,
  newId: () => string,
  notes: string[] = [],
): ActiveWorkspace {
  const seen = new Set<string>();
  const ids = workspace.catalogs.map((c) => {
    const id = c.id && !seen.has(c.id) ? c.id : newId();
    seen.add(id);
    return id;
  });
  const { aliases, notes: aliasNotes } = assignAliases(workspace.catalogs);
  const catalogs: ActiveCatalog[] = workspace.catalogs.map((c, i) => ({
    id: ids[i],
    url: c.url,
    kind: catalogKind(c.url),
    catalogName: c.catalogName,
    alias: aliases[i],
    options: { ...(c.options ?? {}) },
    ...(c.target ? { target: c.target } : {}),
    ...(c.dataVersionSpec ? { dataVersionSpec: c.dataVersionSpec } : {}),
  }));
  // The default is named by id; hand-written links may name an alias (the one
  // asked for, or the one assigned) instead.
  const wanted = workspace.defaultCatalogId ?? null;
  const byId = wanted ? catalogs.find((c) => c.id === wanted) : undefined;
  const byAlias = wanted && !byId
    ? catalogs.find((c, i) => c.alias.toLowerCase() === wanted.toLowerCase() || workspace.catalogs[i].alias?.toLowerCase() === wanted.toLowerCase())
    : undefined;
  const defaultCatalog = byId ?? byAlias;
  const allNotes = [...notes, ...aliasNotes];
  if (wanted && !defaultCatalog) allNotes.push(`The default catalog "${wanted}" is not in the workspace; the first catalog is the default.`);
  return {
    id: workspace.id || newId(),
    name: workspace.name ?? null,
    source: "link",
    catalogs,
    defaultCatalogId: defaultCatalog?.id ?? null,
    defaultSchema: workspace.defaultSchema ?? null,
    notes: allNotes,
  };
}

/** The portable form of a catalog set: what a share link carries. Secrets are
 *  never in an ActiveCatalog's options, so there is nothing to strip. */
export function toPortableFile(workspace: ActiveWorkspace): PortableWorkspaceFile {
  return {
    format: WORKSPACE_FORMAT,
    version: WORKSPACE_VERSION,
    workspaces: [{
      id: workspace.id,
      name: workspace.name,
      defaultCatalogId: workspace.defaultCatalogId,
      ...(workspace.defaultSchema ? { defaultSchema: workspace.defaultSchema } : {}),
      catalogs: workspace.catalogs.map((c) => ({
        id: c.id,
        url: c.url,
        catalogName: c.catalogName,
        alias: c.alias,
        ...(Object.keys(c.options).length ? { options: { ...c.options } } : {}),
        ...(c.target ? { target: c.target } : {}),
        ...(c.dataVersionSpec ? { dataVersionSpec: c.dataVersionSpec } : {}),
      })),
    }],
  };
}

/** The catalog that gets `USE`: the named default, else the first. */
export function defaultCatalogOf(workspace: Pick<ActiveWorkspace, "catalogs" | "defaultCatalogId">): ActiveCatalog | undefined {
  return workspace.catalogs.find((c) => c.id === workspace.defaultCatalogId) ?? workspace.catalogs[0];
}
