/**
 * Load one catalog of the active set: ask its server what it is (RPC
 * `catalogsInfo` + tree), work out its options, and say whether it can be
 * attached, needs sign-in, needs options, or failed. CatalogApp runs this for
 * every catalog in parallel; the engine then attaches the ready ones one at a
 * time (attach/attach-catalog.ts).
 *
 * Nothing here redirects. Whether a sign-in requirement becomes a page
 * redirect (the only catalog) or a Sign in button (several) is the caller's
 * decision.
 */
import * as Sentry from "@sentry/astro";
import { fetchCatalog, type CatalogData } from "../service";
import { finalizeConnection, hasAnyOptions, type ConnectionInput } from "../attach/connection";
import { partitionSecrets, type AttachSpec, type OptionSpecInfo } from "../attach/options";
import { attachErrorDetail, type ShellCatalog } from "../attach/attach-catalog";
import type { AttachErrorDetail } from "../attach/error-detail";
import type { CatalogConnection } from "../catalog-inventory";
import { isRecoverableAuthError } from "../auth-errors";
import { getAuthTokenForService, hadAuthToken } from "../auth";
import { extractOrigin, hasTokens as hasOAuthTokens } from "../oauth-client";
import { grainliftHttpUrl } from "../url-params";
import { serviceAlias, uniqueAlias } from "./aliases";
import type { ActiveCatalog } from "./spec";

export type CatalogLoad =
  | { state: "loading" }
  | { state: "ready"; data: CatalogData; shell: ShellCatalog; connection: CatalogConnection }
  | { state: "sign-in-required"; message: string }
  | { state: "options-needed"; catalogName: string; specs: OptionSpecInfo[]; options: Record<string, string>; detail: AttachErrorDetail }
  | { state: "failed"; message: string; detail?: AttachErrorDetail };

export interface CatalogEntry {
  catalog: ActiveCatalog;
  input: ConnectionInput;
  load: CatalogLoad;
}

export interface LoadResult {
  load: CatalogLoad;
  /** The alias, once known (a `?service=` catalog learns it from the server). */
  alias: string;
  /** The server's catalog name, once known. */
  catalogName: string;
}

export interface LoadOptions {
  /** Persist options to the recent-services list (the `?service=` catalog). */
  persist: boolean;
  /** The `?service=` Grainlift alias (`?name=` or the target). */
  grainliftAlias?: string;
  /** Aliases the workspace's other catalogs hold: a catalog whose alias is
   *  learned from its server is kept clear of them. */
  takenAliases?: readonly string[];
}

/** The sign-in requirement message used throughout. */
export const SIGN_IN_REQUIRED = "Sign-in required.";

function connectionFor(catalog: ShellCatalog, databaseType: string, defaultSchema: string | null): CatalogConnection {
  const { plain, secret } = partitionSecrets(catalog.options, catalog.specs);
  return {
    sourceUrl: catalog.url,
    catalogName: catalog.catalogName,
    databaseType,
    specs: catalog.specs,
    attachOptions: plain,
    secretOptionNames: Object.keys(secret),
    defaultSchema,
  };
}

export async function loadCatalogEntry(entry: CatalogEntry, opts: LoadOptions): Promise<LoadResult> {
  const { catalog, input } = entry;
  if (catalog.kind === "grainlift") return loadGrainlift(entry, opts);

  const knownAlias = catalog.alias;
  // We previously had SPA tokens for this service and they are gone (revoked
  // remotely, expired without a refresh): sign in again rather than fetch
  // anonymously. A missing token on a first visit is fine — the fetch 401s.
  const token = await getAuthTokenForService(catalog.url);
  if (!token && hadAuthToken() && hasOAuthTokens(catalog.url)) {
    return { load: { state: "sign-in-required", message: "Your sign-in for this catalog has expired." }, alias: knownAlias || catalog.url, catalogName: catalog.catalogName };
  }
  try {
    const fetched = await fetchCatalog(catalog.url, { hasOptions: hasAnyOptions(input), catalogName: catalog.catalogName || undefined });
    const serverName = fetched.catalog.catalogName;
    const alias = knownAlias || (opts.takenAliases?.length
      ? uniqueAlias(serviceAlias(serverName), new Set(opts.takenAliases.map((a) => a.toLowerCase())))
      : serviceAlias(serverName));
    const finalized = finalizeConnection(input, serverName, fetched.specs, { persist: opts.persist });
    const shell: ShellCatalog = {
      kind: "vgi",
      url: catalog.url,
      catalogName: serverName,
      alias,
      options: finalized.options,
      pending: finalized.pending,
      specs: fetched.specs,
      serverVersion: fetched.implementationVersion,
      defaultSchema: fetched.catalog.defaultSchema,
    };
    if (finalized.missing.length) {
      // Say so before ATTACH, rather than letting the server refuse it.
      const stored = Object.fromEntries(Object.entries(finalized.options).filter(([name]) => !(name in input.sessionOptions)));
      const problems = finalized.missing.map((s) => ({ name: s.name, text: s.name, reason: "Required, and not set." }));
      const detail = await attachErrorDetail("Connection options needed", `Required options not set: ${finalized.missing.map((s) => s.name).join(", ")}`, specOf(shell), { ran: false, problems, serverVersion: fetched.implementationVersion });
      return { load: { state: "options-needed", catalogName: serverName, specs: fetched.specs, options: stored, detail }, alias, catalogName: serverName };
    }
    const data: CatalogData = { ...fetched.catalog, catalogName: alias, databaseType: "vgi" };
    return {
      load: { state: "ready", data, shell, connection: connectionFor(shell, "vgi", fetched.catalog.defaultSchema) },
      alias,
      catalogName: serverName,
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Failed to connect";
    const alias = knownAlias || catalog.url;
    if (isRecoverableAuthError(message)) {
      return { load: { state: "sign-in-required", message }, alias, catalogName: catalog.catalogName };
    }
    // Recoverable auth errors are routine and not reported; connection
    // errors and hard auth failures are.
    Sentry.captureException(err instanceof Error ? err : new Error(message), {
      tags: { component: "catalog", path: "load" },
      extra: { serviceUrl: catalog.url },
    });
    const spec = specOf({ kind: "vgi", url: catalog.url, catalogName: catalog.catalogName || "?", alias, options: { ...input.options, ...input.sessionOptions }, pending: [] });
    const detail = { ...(await attachErrorDetail(`Could not reach ${knownAlias || catalog.url}`, message, spec, { ran: false })), stage: "fetch" as const };
    return { load: { state: "failed", message, detail }, alias, catalogName: catalog.catalogName };
  }
}

function specOf(catalog: ShellCatalog): AttachSpec {
  return { kind: catalog.kind, url: catalog.url, catalogName: catalog.catalogName, alias: catalog.alias, options: catalog.options, specs: catalog.specs };
}

/** A Grainlift gateway has no VGI catalog to fetch: seed an empty catalog
 *  under its alias so the app (and the engine) start, and the inventory fills
 *  it in from DuckDB once attached. A gateway that advertises OAuth needs a
 *  sign-in first, so the ATTACH can carry the token. */
async function loadGrainlift(entry: CatalogEntry, opts: LoadOptions): Promise<LoadResult> {
  const { catalog, input } = entry;
  const alias = catalog.alias || opts.grainliftAlias || input.options.target;
  if (!alias) {
    return {
      load: { state: "failed", message: "A Grainlift service needs ?target= naming the gateway's target, e.g. ?service=grainlift+https://host&target=sqlite" },
      alias: catalog.url,
      catalogName: "",
    };
  }
  const httpUrl = grainliftHttpUrl(catalog.url);
  if (httpUrl && !(await getAuthTokenForService(catalog.url)) && (await advertisesOAuth(httpUrl))) {
    return { load: { state: "sign-in-required", message: SIGN_IN_REQUIRED }, alias, catalogName: catalog.catalogName || alias };
  }
  const finalized = finalizeConnection(input, alias, [], { persist: opts.persist });
  const data: CatalogData = { catalogName: alias, catalogComment: null, catalogTags: {}, defaultSchema: "main", schemas: [], databaseType: "grainlift" };
  const shell: ShellCatalog = {
    kind: "grainlift",
    url: catalog.url,
    catalogName: catalog.catalogName || alias,
    alias,
    options: finalized.options,
    pending: finalized.pending,
    specs: [],
    defaultSchema: "main",
  };
  return { load: { state: "ready", data, shell, connection: connectionFor(shell, "grainlift", "main") }, alias, catalogName: shell.catalogName };
}

/** Whether a Grainlift gateway publishes OAuth discovery (RFC 9728). */
export async function advertisesOAuth(httpUrl: string): Promise<boolean> {
  try {
    const response = await fetch(`${extractOrigin(httpUrl)}/.well-known/oauth-protected-resource`);
    return response.ok;
  } catch {
    return false;
  }
}
