/**
 * Structured ATTACH options: the one builder for every ATTACH statement Cupola
 * writes, whether it runs in the engine, lands in a log line, or is copied into
 * a snippet for the duckdb CLI.
 *
 * An option VALUE is stored as its DuckDB text form (`'2024-01-01'`, `[1, 2]`,
 * `{'a': 1}`) and always emitted as a string literal through `quoteLiteral`:
 * the VGI extension casts each declared option to its type with
 * `DefaultTryCastAs`, and DuckDB's VARCHAR text form round-trips every type
 * (STRUCT, MAP, LIST, INTERVAL, DECIMAL, TIMESTAMPTZ, BLOB, HUGEINT). Option
 * NAMES are restricted to plain identifiers. Nothing from a URL or a text box
 * is ever spliced into the SQL; raw text goes through `legacy-options.ts`
 * first.
 *
 * Pure: no engine, no storage, no React, so it is unit-tested directly and is
 * the per-catalog piece the multi-catalog engine (phase 1) builds on.
 */
import { quoteIdent, quoteLiteral } from "../duckdb-query";

/** An option name the ATTACH grammar takes unquoted. */
export const OPTION_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Names treated as credentials when the server does not say (servers that
 *  predate the spec's `secret` flag, the extension's built-ins, Grainlift). */
export const SECRET_NAME_RE = /(key|token|secret|password|passwd|credential|auth)/i;

/** Placeholder written in place of a secret in a redacted statement. */
export const REDACTED = "***";

/** One attach option a catalog declares (`catalogsInfo().attach_option_specs`),
 *  reduced to plain data so it can be passed to the shell and the UI. */
export interface OptionSpecInfo {
  name: string;
  description: string;
  /** DuckDB type for display, e.g. `INTEGER`, `STRUCT<{a: BIGINT}>`. */
  duckdbType: string;
  /** The same type in DuckDB's CAST syntax (`STRUCT(a BIGINT)`), or null
   *  when it has none; the value is then left to the extension's own cast. */
  castType: string | null;
  /** The declared Arrow type, for display. */
  arrowType: string;
  required: boolean;
  secret: boolean;
  /** The server's default as display text, when it has one. */
  defaultText?: string | null;
}

export type CatalogKind = "vgi" | "grainlift";

/** Everything needed to ATTACH one catalog. */
export interface AttachSpec {
  kind: CatalogKind;
  /** VGI: the LOCATION. Grainlift: the gateway URI, which is the ATTACH path. */
  url: string;
  /** The catalog's name on the server (VGI `catalogs()[i]`). */
  catalogName: string;
  /** The DuckDB database name. */
  alias: string;
  /** Option name → DuckDB text form of the value. Secrets included. */
  options: Record<string, string>;
  /** Declared options, when the server publishes them. */
  specs?: OptionSpecInfo[];
  /** Credentials from the sign-in flow. Never shown, always redacted. */
  auth?: { bearerToken?: string | null; refreshToken?: string | null };
}

/** How `buildAttachSql` treats secrets and credentials:
 *  - `execute`: inline, for the engine.
 *  - `redacted`: `'***'`, for logs and the error panel.
 *  - `cli`: `getenv('<ALIAS>_<OPTION>')`, for snippets a person runs. Sign-in
 *    credentials are left out: the CLI extension signs in by itself. */
export type AttachSqlMode = "execute" | "redacted" | "cli";

export function isValidOptionName(name: string): boolean {
  return OPTION_NAME_RE.test(name);
}

/** Whether `name` carries a credential. The spec's flag decides when the
 *  catalog declares the option; otherwise the name does. A name that merely
 *  looks like a credential is masked even when declared non-secret: hiding a
 *  value costs a retype, leaking one cannot be undone. */
export function isSecretOption(name: string, specs?: readonly OptionSpecInfo[]): boolean {
  const spec = specs?.find((s) => s.name.toLowerCase() === name.toLowerCase());
  if (spec?.secret) return true;
  return SECRET_NAME_RE.test(name);
}

/** Split options into what may be stored or shared and what is secret. */
export function partitionSecrets(
  options: Record<string, string>,
  specs?: readonly OptionSpecInfo[],
): { plain: Record<string, string>; secret: Record<string, string> } {
  const plain: Record<string, string> = {};
  const secret: Record<string, string> = {};
  for (const [name, value] of Object.entries(options)) {
    (isSecretOption(name, specs) ? secret : plain)[name] = value;
  }
  return { plain, secret };
}

/** The environment variable a CLI snippet reads a secret from:
 *  `sales` + `api_key` → `SALES_API_KEY`. */
export function getenvName(alias: string, option: string): string {
  return `${alias}_${option}`.toUpperCase().replace(/[^A-Z0-9_]/g, "_");
}

/** `name 'text'` pairs, comma-separated, for the option list of an ATTACH.
 *  Invalid names are refused here as a last line of defence: callers validate
 *  first and report, this throws. */
export function formatOptionList(
  options: Record<string, string>,
  valueFor: (name: string, value: string) => string = (_n, v) => quoteLiteral(v),
): string {
  return Object.entries(options)
    .map(([name, value]) => {
      if (!isValidOptionName(name)) throw new Error(`Invalid ATTACH option name: ${JSON.stringify(name)}`);
      return `${name} ${valueFor(name, value)}`;
    })
    .join(", ");
}

/** The ATTACH statement for one catalog. */
export function buildAttachSql(spec: AttachSpec, mode: AttachSqlMode = "execute"): string {
  const parts: string[] = [];
  const head = mode === "cli" ? "ATTACH" : "ATTACH OR REPLACE";
  let sql: string;
  if (spec.kind === "grainlift") {
    sql = `${head} ${quoteLiteral(spec.url)} AS ${quoteIdent(spec.alias)} (TYPE grainlift`;
    if (mode !== "cli") {
      if (spec.auth?.bearerToken) parts.push(`bearer_token ${credential(spec.auth.bearerToken, mode)}`);
      if (spec.auth?.refreshToken) parts.push(`oauth_refresh_token ${credential(spec.auth.refreshToken, mode)}`);
    }
  } else {
    sql = `${head} ${quoteLiteral(spec.catalogName)} AS ${quoteIdent(spec.alias)} (TYPE vgi, LOCATION ${quoteLiteral(spec.url)}`;
    // `bearer_token` and `oauth_refresh_token` are mutually exclusive in the
    // VGI extension; refresh wins, since it lets the extension renew.
    if (mode !== "cli") {
      if (spec.auth?.refreshToken) parts.push(`oauth_refresh_token ${credential(spec.auth.refreshToken, mode)}`);
      else if (spec.auth?.bearerToken) parts.push(`bearer_token ${credential(spec.auth.bearerToken, mode)}`);
    }
  }
  const list = formatOptionList(spec.options, (name, value) => {
    if (mode === "execute" || !isSecretOption(name, spec.specs)) return quoteLiteral(value);
    return mode === "cli" ? `getenv(${quoteLiteral(getenvName(spec.alias, name))})` : quoteLiteral(REDACTED);
  });
  if (list) parts.push(list);
  return parts.length ? `${sql}, ${parts.join(", ")})` : `${sql})`;
}

function credential(value: string, mode: AttachSqlMode): string {
  return quoteLiteral(mode === "execute" ? value : REDACTED);
}

/** A script that reproduces the attach in the duckdb CLI: the extension's
 *  INSTALL/LOAD, the environment variables each secret is read from, then the
 *  ATTACH. */
export function buildCliScript(spec: AttachSpec, installSql: string): string {
  const extension = spec.kind === "grainlift" ? "grainlift" : "vgi";
  const secrets = Object.keys(spec.options).filter((name) => isSecretOption(name, spec.specs));
  const lines = [`${installSql};`, `LOAD ${extension};`];
  if (secrets.length) {
    lines.push("", "-- Set these in the environment first:");
    for (const name of secrets) lines.push(`--   export ${getenvName(spec.alias, name)}=...`);
  }
  lines.push("", `${buildAttachSql(spec, "cli")};`);
  return lines.join("\n");
}

/** The non-secret options, as the legacy `attach_options` text a share link
 *  carries: every value a plain string literal, so the recipient's migration
 *  needs no expression evaluation (and no consent screen). */
export function shareableOptionsText(
  options: Record<string, string>,
  specs?: readonly OptionSpecInfo[],
): string {
  return formatOptionList(partitionSecrets(options, specs).plain);
}

/** Declared `required` options with no value. */
export function missingRequiredOptions(
  options: Record<string, string>,
  specs: readonly OptionSpecInfo[] | undefined,
): OptionSpecInfo[] {
  if (!specs) return [];
  const present = new Set(Object.keys(options).map((n) => n.toLowerCase()));
  return specs.filter((s) => s.required && !present.has(s.name.toLowerCase()));
}

/** Replace every occurrence of a secret value in free text. Used on error
 *  messages before they are shown or logged: DuckDB quotes the offending value
 *  in a cast error ("Could not convert string '<value>' to INT32"). */
export function redactValues(text: string, secrets: Iterable<string>): string {
  let out = text;
  for (const value of secrets) {
    if (value.length >= 3) out = out.split(value).join(REDACTED);
  }
  return out;
}
