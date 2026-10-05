/**
 * Attach a list of catalogs to the engine, one at a time, and `USE` the
 * default one.
 *
 * One at a time on purpose: the VGI extension's interactive OAuth popup routes
 * its code back through a single SharedArrayBuffer (`shell-init.ts`'s
 * `handleAuthUrl`), so two ATTACHes waiting on sign-in at once would race for
 * it. Each catalog ends in its own status (`shell-bridge.ts`'s
 * `CatalogStatus`): attached, failed (with the redacted statement and the
 * error panel's payload) or sign-in-required. A failure is that catalog's; it
 * never sets the engine's lifecycle error, so the shell, `memory` and every
 * other catalog stay usable.
 *
 * `single` keeps the single-catalog behaviour existing server redirects rely
 * on: a recoverable auth error redirects the whole page to sign in, and a
 * failed ATTACH opens the error panel at once. With several catalogs nothing
 * redirects by itself (each catalog gets a Sign in button) and the panel opens
 * from the sidebar.
 *
 * Kept free of xterm: the shell logs through `log`, and CatalogApp's Retry
 * calls `attachCatalog` directly once the engine is up.
 */
import * as Sentry from "@sentry/astro";
import { engine, setCatalogStatus, setDefaultCatalogState, type CatalogStatus } from "../shell-bridge";
import { decodeArrowBuffer, quoteIdent, quoteLiteral } from "../duckdb-query";
import { buildAttachSql, buildCliScript, partitionSecrets, redactValues, type AttachSpec } from "./options";
import { evaluateLegacyEntries, validateOptionValues, type AttachEngine } from "./prepare";
import type { LegacyEntry, OptionProblem } from "./legacy-options";
import type { AttachErrorDetail } from "./error-detail";
import { registerSecretValues, scrubSecretOptions } from "../sentry-scrub";
import { extensionInstallSql, getEngineInfo, hasExtension, shellExtensionsForVgiVersion } from "../duckdb-engine";
import { isRecoverableAuthError, isUnrecoverableAuthError } from "../auth-errors";
import { getAuthTokenForService, getOAuthMeta, redirectToAuth } from "../auth";
import { startLoginFlow } from "../oauth-client";
import { getIrohState } from "../iroh";
import { getVgiExtensionVersionSetting, grainliftHttpUrl } from "../url-params";

/** One catalog as the engine attaches it. Credentials are looked up per
 *  catalog at attach time (`getAuthTokenForService`), never carried here. */
export interface ShellCatalog extends Omit<AttachSpec, "auth"> {
  /** Raw expressions still to evaluate (legacy text the user agreed to). */
  pending: LegacyEntry[];
  /** The server's implementation version, for the error panel. */
  serverVersion?: string | null;
  /** The server's default schema, used for `USE` when this is the default. */
  defaultSchema?: string | null;
}

export interface AttachCallbacks {
  /** Exactly one catalog in the set (see the module comment). */
  single: boolean;
  log?: (message: string, color?: string) => void;
  /** An identity provider rejected the credentials outright. */
  onAuthError?: (title: string, message: string) => void;
  /** A failed (or refused) ATTACH; with `single` the panel opens at once. */
  onAttachError?: (alias: string, detail: AttachErrorDetail) => void;
  /** Pending expressions were evaluated: store `values`, report `problems`. */
  onOptionsEvaluated?: (alias: string, values: Record<string, string>, problems: OptionProblem[]) => void;
}

export interface DefaultRequest {
  /** The alias the workspace names as default. */
  alias: string | null;
  /** `USE "alias"."schema"`; else the catalog's own default schema. */
  schema: string | null;
}

/** The engine, as attach-option evaluation and validation need it. */
function attachEngine(): AttachEngine {
  const first = (result: { ok: boolean; arrowBuffers?: ArrayBuffer[]; error?: string }): unknown => {
    if (!result.ok) throw new Error(result.error ?? "query failed");
    const buf = result.arrowBuffers?.[0];
    if (!buf) return null;
    const table = decodeArrowBuffer(buf);
    return table.numRows ? table.getChildAt(0)?.get(0) ?? null : null;
  };
  return {
    canParse: hasExtension("json"),
    scalar: async (sql) => first(await engine.query!(sql)),
    scalarPrepared: async (sql, params) => {
      if (!engine.queryPrepared) throw new Error("prepared statements unavailable");
      return first(await engine.queryPrepared(sql, params));
    },
  };
}

function statusBase(catalog: ShellCatalog): Pick<CatalogStatus, "alias" | "url" | "catalogName"> {
  return { alias: catalog.alias, url: catalog.url, catalogName: catalog.catalogName };
}

/** Redact every secret this catalog knows of from text bound for the screen,
 *  a log or Sentry. */
function redact(text: string, spec: AttachSpec): string {
  const secrets = Object.values(partitionSecrets(spec.options, spec.specs).secret);
  const auth = [spec.auth?.bearerToken, spec.auth?.refreshToken].filter((v): v is string => Boolean(v));
  return scrubSecretOptions(redactValues(text, [...secrets, ...auth]));
}

/** The error panel's payload for one catalog. */
export async function attachErrorDetail(
  title: string,
  message: string,
  spec: AttachSpec,
  { ran, problems, serverVersion }: { ran: boolean; problems?: OptionProblem[]; serverVersion?: string | null },
): Promise<AttachErrorDetail> {
  const setting = getVgiExtensionVersionSetting();
  const ext = shellExtensionsForVgiVersion(setting.error ? undefined : setting.value).find((e) => e.name === spec.kind);
  let extensionVersion: string | null = null;
  if (engine.query) {
    try {
      const v = await attachEngine().scalar(`SELECT extension_version FROM duckdb_extensions() WHERE extension_name = ${quoteLiteral(spec.kind)}`);
      extensionVersion = v == null ? null : String(v);
    } catch { /* engine gone */ }
  }
  return {
    title,
    message: redact(message, spec),
    serviceUrl: spec.url,
    problems,
    ran,
    sql: buildAttachSql(spec, "redacted"),
    cliScript: ext ? buildCliScript(spec, extensionInstallSql(ext)) : undefined,
    versions: {
      cupola: typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : "dev",
      duckdb: getEngineInfo().duckdbVersion || undefined,
      vgiExtension: extensionVersion,
      server: serverVersion ?? null,
    },
  };
}

/**
 * Attach one catalog and record its status. Resolves with the final status;
 * never throws for a failed ATTACH.
 *
 * Auth routing:
 * - unrecoverable IdP rejection (token exchange failed, invalid_grant):
 *   failed, and with `single` the auth modal. Re-running the same flow would
 *   hit the same wall.
 * - recoverable (no token yet, bare 401/403): with `single`, redirect the page
 *   to sign in, as before; otherwise sign-in-required.
 * - anything else: failed, with the error panel's payload.
 */
export async function attachCatalog(catalog: ShellCatalog, cb: AttachCallbacks): Promise<CatalogStatus> {
  const base = statusBase(catalog);
  const log = cb.log ?? (() => {});
  setCatalogStatus({ ...base, state: "connecting" });
  log(`Connecting to ${catalog.alias}...`, "33");

  // Evaluate pending expressions and check every value before ATTACH.
  const options = { ...catalog.options };
  registerSecretValues(Object.values(partitionSecrets(options, catalog.specs).secret));
  if (catalog.pending.length) {
    const evaluated = await evaluateLegacyEntries(catalog.pending, attachEngine());
    Object.assign(options, evaluated.values);
    registerSecretValues(Object.values(partitionSecrets(evaluated.values, catalog.specs).secret));
    cb.onOptionsEvaluated?.(catalog.alias, evaluated.values, evaluated.problems);
  }
  // Grainlift publishes no specs; its options go to the extension as given.
  const problems = catalog.kind === "vgi" ? await validateOptionValues(options, catalog.specs, attachEngine()) : [];

  // Credentials per catalog: each service's own SPA tokens; the legacy
  // `#token=` fragment only for the `?service=` catalog (auth.ts).
  const token = await getAuthTokenForService(catalog.url);
  const oauthMeta = getOAuthMeta(catalog.url);
  const spec: AttachSpec = {
    kind: catalog.kind,
    url: catalog.url,
    catalogName: catalog.catalogName,
    alias: catalog.alias,
    options,
    specs: catalog.specs,
    auth: { bearerToken: token, refreshToken: oauthMeta?.refreshToken ?? null },
  };
  const redactedSql = buildAttachSql(spec, "redacted");

  if (problems.length) {
    // Report a missing or mistyped option before ATTACH, not as the server's
    // (or the cast's) error after it.
    const lines = problems.map((p) => `${p.name ?? p.text}: ${p.reason}`);
    console.warn(`[attach] ${catalog.alias}: ATTACH not run; option problems:`, lines);
    log(`Not connecting to ${catalog.alias}: check its connection options.`, "31");
    for (const line of lines) log(`  ${line}`, "31");
    const detail = await attachErrorDetail("Connection options need attention", lines.join("\n"), spec, { ran: false, problems, serverVersion: catalog.serverVersion });
    if (cb.single) cb.onAttachError?.(catalog.alias, detail);
    return record({ ...base, state: "failed", error: `Connection options need attention: ${lines.join("; ")}`, sql: redactedSql, detail });
  }

  console.log(`[shell] ATTACH SQL:`, redactedSql);
  console.log(`[shell] ATTACH auth (${catalog.alias}):`, {
    refreshToken: spec.auth?.refreshToken ? "<present>" : "missing",
    bearerToken: spec.auth?.bearerToken && !spec.auth?.refreshToken ? `<present (${spec.auth.bearerToken.length} chars)>` : "skipped",
  });
  const result = await engine.query!(buildAttachSql(spec));
  if (result.ok) {
    log(`Connected to ${catalog.alias}`, "32");
    return record({ ...base, state: "attached", sql: redactedSql });
  }

  const errStr = result.error ?? "";
  const message = redact(errStr, spec) || `Could not connect to ${catalog.alias}.`;
  console.log(`[shell] ATTACH failed (${catalog.alias}):`, message);

  if (isUnrecoverableAuthError(errStr)) {
    Sentry.captureException(new Error(message), {
      tags: { component: "shell", path: "attach", auth_kind: "unrecoverable" },
      extra: { serviceUrl: catalog.url },
    });
    if (cb.single) cb.onAuthError?.("Attach failed", message);
    log(`Attach failed: ${message}`, "31");
    return record({ ...base, state: "failed", error: message, sql: redactedSql });
  }

  if (isRecoverableAuthError(errStr)) {
    if (catalog.kind === "grainlift") return grainliftAuth(catalog, message, Boolean(token), cb, redactedSql);
    if (cb.single) {
      console.log("[shell] Recoverable auth error, redirecting. token:", token ? `${token.substring(0, 20)}...` : "NONE");
      redirectToAuth(catalog.url);
    } else {
      log(`${catalog.alias} needs sign-in.`, "33");
    }
    return record({ ...base, state: "sign-in-required", error: message, sql: redactedSql });
  }

  // Non-auth ATTACH failure (typically a malformed option, or the server is
  // down). The terminal gets it too, for whoever has the shell open.
  Sentry.captureException(new Error(message), {
    tags: { component: "shell", path: "attach", auth_kind: "non-auth" },
    extra: { serviceUrl: catalog.url },
  });
  log(`Attach failed (${catalog.alias}): ${message}`, "31");
  const detail = await attachErrorDetail(`Could not attach ${catalog.alias}`, errStr, spec, { ran: true, serverVersion: catalog.serverVersion });
  if (cb.single) cb.onAttachError?.(catalog.alias, detail);
  return record({ ...base, state: "failed", error: message, sql: redactedSql, detail });
}

function record(status: CatalogStatus): CatalogStatus {
  setCatalogStatus(status);
  return status;
}

/** A Grainlift gateway refused us. Over HTTP without a token, sign in
 *  (Cupola's own PKCE flow against the gateway's OAuth metadata) when it is
 *  the only catalog, else ask; with a token, or over Iroh, explain. */
function grainliftAuth(catalog: ShellCatalog, message: string, hadToken: boolean, cb: AttachCallbacks, sql: string): CatalogStatus {
  const base = statusBase(catalog);
  if (grainliftHttpUrl(catalog.url) && !hadToken) {
    if (cb.single) {
      startLoginFlow(catalog.url).catch((err) => {
        cb.onAuthError?.("Attach failed", `${message}\n\nSign-in could not start: ${err instanceof Error ? err.message : String(err)}`);
      });
    }
    return record({ ...base, state: "sign-in-required", error: message, sql });
  }
  const endpointId = getIrohState().endpointId;
  const hint = grainliftHttpUrl(catalog.url)
    ? "The gateway rejected this account. Check that it is allowed on the gateway."
    : endpointId
      ? `This browser's Iroh endpoint ID is ${endpointId}. Authorize it on the gateway (iroh.principals) and reload.`
      : "The gateway did not authorize this browser's Iroh endpoint.";
  if (cb.single) cb.onAuthError?.("Attach failed", `${message}\n\n${hint}`);
  return record({ ...base, state: "failed", error: `${message}\n\n${hint}`, sql });
}

/**
 * `USE` the default catalog, quoted: `USE "alias"."schema"`. When the
 * requested default did not attach, the next attached catalog in order gets
 * it and the state records the fallback. A schema that is not there falls
 * back to the catalog's own default schema rather than failing the USE.
 */
export async function applyDefaultCatalog(
  attached: readonly ShellCatalog[],
  request: DefaultRequest,
): Promise<{ alias: string | null; schema: string | null; fellBack: boolean }> {
  const requested = request.alias ? attached.find((c) => c.alias === request.alias) : undefined;
  const chosen = requested ?? attached[0];
  if (!chosen) {
    setDefaultCatalogState({ alias: null, schema: null, requested: request.alias, fellBack: false });
    return { alias: null, schema: null, fellBack: false };
  }
  const fellBack = Boolean(request.alias && chosen.alias !== request.alias);
  if (fellBack) console.warn(`[attach] default catalog ${request.alias} did not attach; using ${chosen.alias}`);
  const schema = (requested ? request.schema : null) ?? chosen.defaultSchema ?? null;
  let used: string | null = null;
  if (schema) {
    const r = await engine.query!(`USE ${quoteIdent(chosen.alias)}.${quoteIdent(schema)}`);
    if (r.ok) used = schema;
    else console.warn(`[attach] USE ${chosen.alias}.${schema} failed:`, r.error);
  }
  if (!used) {
    const r = await engine.query!(`USE ${quoteIdent(chosen.alias)}`);
    if (!r.ok) console.warn(`[attach] USE ${chosen.alias} failed:`, r.error);
  }
  setDefaultCatalogState({ alias: chosen.alias, schema: used, requested: request.alias, fellBack });
  return { alias: chosen.alias, schema: used, fellBack };
}

/** Attach every catalog in order, then `USE` the default. Resolves when all
 *  have settled. */
export async function attachAll(
  catalogs: readonly ShellCatalog[],
  request: DefaultRequest,
  cb: AttachCallbacks,
): Promise<CatalogStatus[]> {
  const statuses: CatalogStatus[] = [];
  for (const catalog of catalogs) {
    try {
      statuses.push(await attachCatalog(catalog, cb));
    } catch (error) {
      // An engine fault mid-attach: record it against this catalog and move on.
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[attach] ${catalog.alias} threw:`, error);
      statuses.push(record({ ...statusBase(catalog), state: "failed", error: message }));
    }
  }
  const attached = catalogs.filter((_, i) => statuses[i].state === "attached");
  const chosen = await applyDefaultCatalog(attached, request);
  if (chosen.fellBack && chosen.alias) cb.log?.(`The default catalog ${request.alias} is not attached; using ${chosen.alias}.`, "33");
  return statuses;
}
