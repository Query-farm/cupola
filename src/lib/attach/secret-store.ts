/**
 * Secret attach-option values, kept apart from everything else.
 *
 * A secret (an option the catalog declares `secret`, or one whose name reads
 * like a credential) never goes into the recent-services list, a share link, an
 * export, query history, a console log or Sentry. Its value lives here, in its
 * own localStorage key, and is read back only to build the ATTACH statement and
 * to prefill the masked field of the options form.
 *
 * Keys (multi-catalog phase 2): a value is keyed `workspaceId:catalogId:option`
 * (`catalogSecrets` / `saveCatalogSecrets`). Before workspaces it was keyed by
 * service URL + catalog name + option, as a JSON array (`secretsFor` /
 * `saveSecrets`); those keys are kept as a read-only fallback, which the boot
 * migration also copies under the workspace (`copyLegacySecrets`). The
 * catalog name in an old key may be "" when a value was entered before the
 * server named its catalog. A workspace key holding "" is a deletion: it hides
 * the old key's value without deleting the old key.
 */
import { registerSecretValues } from "../sentry-scrub";

export const SECRET_STORE_KEY = "cupola.catalog-secrets.v1";

type Store = Record<string, string>;

function key(url: string, catalogName: string, option: string): string {
  return JSON.stringify([url, catalogName, option.toLowerCase()]);
}

function parseKey(k: string): [string, string, string] | null {
  try {
    const v = JSON.parse(k);
    return Array.isArray(v) && v.length === 3 && v.every((x) => typeof x === "string") ? (v as [string, string, string]) : null;
  } catch {
    return null;
  }
}

function read(): Store {
  try {
    const raw = localStorage.getItem(SECRET_STORE_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function write(store: Store): void {
  try {
    if (Object.keys(store).length) localStorage.setItem(SECRET_STORE_KEY, JSON.stringify(store));
    else localStorage.removeItem(SECRET_STORE_KEY);
  } catch {
    /* storage full or unavailable: the value lasts for this page only */
  }
}

/** The stored secrets for one catalog, option name → value. Registered with
 *  the Sentry scrubber as they are read, so no event can carry one. */
export function secretsFor(url: string, catalogName: string): Record<string, string> {
  const out: Record<string, string> = {};
  const store = read();
  for (const [k, value] of Object.entries(store)) {
    const parts = parseKey(k);
    if (!parts || parts[0] !== url) continue;
    if (parts[1] === catalogName) out[parts[2]] = value;
    else if (parts[1] === "" && !(parts[2] in out)) out[parts[2]] = value;
  }
  registerSecretValues(Object.values(out));
  return out;
}

/** Store a catalog's secret values. `replace` drops this catalog's other
 *  secrets (the form submitted the full set); otherwise values merge in. An
 *  empty value deletes the option. */
export function saveSecrets(
  url: string,
  catalogName: string,
  values: Record<string, string>,
  { replace = false }: { replace?: boolean } = {},
): void {
  const store = read();
  for (const k of Object.keys(store)) {
    const parts = parseKey(k);
    if (!parts || parts[0] !== url) continue;
    // Values saved before the catalog had a name now belong to it.
    if (catalogName && parts[1] === "") {
      const moved = key(url, catalogName, parts[2]);
      if (!(moved in store)) store[moved] = store[k];
      delete store[k];
    } else if (replace && parts[1] === catalogName) {
      delete store[k];
    }
  }
  for (const [option, value] of Object.entries(values)) {
    if (value) store[key(url, catalogName, option)] = value;
    else delete store[key(url, catalogName, option)];
  }
  registerSecretValues(Object.values(values));
  write(store);
}

/** Forget every secret stored for a service (all of its catalogs). */
export function clearSecretsForService(url: string): void {
  const store = read();
  for (const k of Object.keys(store)) {
    if (parseKey(k)?.[0] === url) delete store[k];
  }
  write(store);
}

/** Forget every stored secret. Used by the sign-out page. */
export function clearAllSecrets(): void {
  try {
    localStorage.removeItem(SECRET_STORE_KEY);
  } catch {
    /* nothing stored */
  }
}

// ---------------------------------------------------------------------------
// Per workspace catalog (phase 2)
// ---------------------------------------------------------------------------

/** One catalog of one workspace, plus what its old keys were named by. */
export interface SecretRef {
  workspaceId: string;
  catalogId: string;
  url: string;
  catalogName: string;
}

function catalogKey(workspaceId: string, catalogId: string, option: string): string {
  return `${workspaceId}:${catalogId}:${option.toLowerCase()}`;
}

function catalogPrefix(ref: Pick<SecretRef, "workspaceId" | "catalogId">): string {
  return `${ref.workspaceId}:${ref.catalogId}:`;
}

/** The secrets for one workspace catalog: its own keys, over the old
 *  service-URL keys for the same server and catalog. */
export function catalogSecrets(ref: SecretRef): Record<string, string> {
  const out: Record<string, string> = ref.url ? legacyValues(ref.url, ref.catalogName) : {};
  const prefix = catalogPrefix(ref);
  for (const [k, value] of Object.entries(read())) {
    if (!k.startsWith(prefix)) continue;
    const option = k.slice(prefix.length);
    if (value) out[option] = value;
    else delete out[option];
  }
  registerSecretValues(Object.values(out));
  return out;
}

/** Old keys only, without registering (catalogSecrets registers the result). */
function legacyValues(url: string, catalogName: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, value] of Object.entries(read())) {
    const parts = parseKey(k);
    if (!parts || parts[0] !== url) continue;
    if (parts[1] === catalogName) out[parts[2]] = value;
    else if (parts[1] === "" && !(parts[2] in out)) out[parts[2]] = value;
  }
  return out;
}

/** Store a workspace catalog's secrets. `replace` drops its other secrets
 *  (the form submitted the full set), hiding old-key values too. An empty
 *  value deletes the option. */
export function saveCatalogSecrets(ref: SecretRef, values: Record<string, string>, { replace = false }: { replace?: boolean } = {}): void {
  const store = read();
  const prefix = catalogPrefix(ref);
  if (replace) {
    for (const k of Object.keys(store)) if (k.startsWith(prefix)) delete store[k];
    for (const option of Object.keys(ref.url ? legacyValues(ref.url, ref.catalogName) : {})) {
      if (!(option in values)) store[catalogKey(ref.workspaceId, ref.catalogId, option)] = "";
    }
  }
  const legacy = ref.url ? legacyValues(ref.url, ref.catalogName) : {};
  for (const [option, value] of Object.entries(values)) {
    const k = catalogKey(ref.workspaceId, ref.catalogId, option);
    if (value) store[k] = value;
    else if (option.toLowerCase() in legacy) store[k] = "";
    else delete store[k];
  }
  registerSecretValues(Object.values(values));
  write(store);
}

/** Forget a workspace catalog's secrets (old-key values are hidden, not deleted). */
export function clearCatalogSecrets(ref: SecretRef): void {
  saveCatalogSecrets(ref, {}, { replace: true });
}

/** Forget every secret of a workspace (it was deleted). */
export function removeWorkspaceSecrets(workspaceId: string): void {
  const store = read();
  for (const k of Object.keys(store)) if (k.startsWith(`${workspaceId}:`)) delete store[k];
  write(store);
}

/** Copy the old service-URL secrets of one server and catalog under a
 *  workspace catalog (the boot migration). Existing workspace keys win.
 *  Returns how many were copied. */
export function copyLegacySecrets(url: string, catalogName: string, workspaceId: string, catalogId: string): number {
  const store = read();
  let copied = 0;
  for (const [option, value] of Object.entries(legacyValues(url, catalogName))) {
    const k = catalogKey(workspaceId, catalogId, option);
    if (k in store) continue;
    store[k] = value;
    copied++;
  }
  if (copied) write(store);
  return copied;
}
