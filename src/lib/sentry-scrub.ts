/**
 * URL scrubbing for Sentry events.
 *
 * The app's URL contract (see CLAUDE.md) carries secrets in both the query
 * string (`?ai_key=`) and the fragment (`#token=…&refresh_token=…&
 * client_secret=…&ai_key=…`). Their consumers strip them from the address bar,
 * but an error captured before that happens — or a navigation breadcrumb
 * recorded in between — would otherwise ship them to Sentry verbatim.
 */

const SENSITIVE_URL_KEYS = new Set([
  "token",
  "refresh_token",
  "client_secret",
  "ai_key",
  // Legacy raw ATTACH options can carry credentials (`api_key '…'`).
  "attach_options",
  // Shared query/report definitions can contain literals and business data.
  "sql",
  "sql_z",
  "report_z",
  "report_values",
]);

/** Replace the values of sensitive keys in a URL's query string and fragment. */
export function scrubUrl(url: string): string {
  const hashIdx = url.indexOf("#");
  let base = hashIdx >= 0 ? url.slice(0, hashIdx) : url;
  const queryIdx = base.indexOf("?");
  if (queryIdx >= 0) {
    base = base.slice(0, queryIdx + 1) + scrubKvString(base.slice(queryIdx + 1));
  }
  if (hashIdx < 0) return base;
  return `${base}#${scrubKvString(url.slice(hashIdx + 1))}`;
}

/** Scrub sensitive params out of any URLs embedded in free text.
 *
 * Exception messages and breadcrumb text can carry URLs verbatim (e.g. an
 * OAuth error like `Token endpoint https://idp/token?...#token=… returned …`).
 * `beforeSend` only scrubs `event.request`, so without this those URLs would
 * ship unscrubbed. We find each `http(s)://…` run and route it through
 * `scrubUrl`. A trailing delimiter (`,` `)` etc.) is left outside the match so
 * it isn't mistaken for part of the URL. */
export function scrubText(text: string): string {
  return scrubSecretOptions(text.replace(/https?:\/\/[^\s)>\]"']+/g, (m) => scrubUrl(m)));
}

// ---------------------------------------------------------------------------
// Secret attach-option values
// ---------------------------------------------------------------------------

/** Secret ATTACH option values seen this page load. The secret store
 *  registers each value it reads or writes, so an error message that quotes one
 *  (DuckDB echoes the value in a cast error) is filtered wherever it lands. */
const secretValues = new Set<string>();

/** Values shorter than this are not scrubbed by value: replacing every `a` in
 *  an event would destroy it, and a 1-2 character credential is no secret. */
const MIN_SECRET_LENGTH = 3;

export function registerSecretValues(values: Iterable<string>): void {
  for (const v of values) if (typeof v === "string" && v.length >= MIN_SECRET_LENGTH) secretValues.add(v);
}

/** Test-only: forget registered values. */
export function clearRegisteredSecretValues(): void {
  secretValues.clear();
}

/** A credential-named option followed by a string literal, as it appears in an
 *  ATTACH statement: `api_key 'abc'`, `bearer_token 'eyJ…'`. Same name rule as
 *  `SECRET_NAME_RE` in lib/attach/options.ts (not imported: this module stays
 *  dependency-free for the Worker). */
const SECRET_OPTION_LITERAL = /\b(\w*(?:key|token|secret|password|passwd|credential|auth)\w*)(\s+)'(?:[^']|'')*'/gi;

/** Filter secret option values out of free text: every registered value, and
 *  the literal after any credential-named option. */
export function scrubSecretOptions(text: string): string {
  let out = text.replace(SECRET_OPTION_LITERAL, (_m, name: string, gap: string) => `${name}${gap}'[Filtered]'`);
  for (const value of secretValues) {
    if (out.includes(value)) out = out.split(value).join("[Filtered]");
  }
  return out;
}

/** Filter sensitive values out of an `a=1&b=2` style key/value string.
 * Non-kv content (e.g. selection-routing fragments like `/schema/x/table/y`)
 * passes through untouched. */
function scrubKvString(kvs: string): string {
  if (!kvs.includes("=")) return kvs;
  return kvs
    .split("&")
    .map((kv) => {
      const eq = kv.indexOf("=");
      if (eq < 0) return kv;
      const key = kv.slice(0, eq);
      return SENSITIVE_URL_KEYS.has(key) ? `${key}=[Filtered]` : kv;
    })
    .join("&");
}
