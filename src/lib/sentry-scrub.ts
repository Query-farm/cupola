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
  return text.replace(/https?:\/\/[^\s)>\]"']+/g, (m) => scrubUrl(m));
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
