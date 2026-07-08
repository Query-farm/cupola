/**
 * Single source of truth for the URL parameters the app consumes.
 *
 * Why this module exists: prior to consolidation, six different files each
 * instantiated their own `URLSearchParams` and called `history.replaceState`
 * with its own strip-but-preserve rules. A missed key in any of those rules
 * leaked the param into browser history. The two consume helpers
 * (`consumeAiKey`, `consumeAuthFragment`) used to live in `settings.tsx` and
 * `auth.ts` respectively, with each rewrite reading + writing the URL — so
 * if both fired on the same load, ordering decided whether the other's keys
 * survived.
 *
 * Coordination rule: every consumer here goes through `rewriteUrl()`. It
 * reads the current `window.location`, deletes ONLY the keys it owns from
 * the query string and fragment, and writes back. Other keys (selection
 * routing, prefill, peer consumer's secrets) are preserved by construction.
 */

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function hasWindow(): boolean {
  return typeof window !== "undefined";
}

/** Parse the current URL fragment as key=value pairs IF it looks like one
 *  (contains `key=`). Selection-routing fragments like `#/schema/foo` are
 *  returned as null so callers don't misparse them as params. */
function parseFragmentParams(): URLSearchParams | null {
  const hash = window.location.hash;
  if (!hash || !/[#&]?[\w_]+=/.test(hash)) return null;
  return new URLSearchParams(hash.replace(/^#/, ""));
}

/** Strip the named query and fragment keys from the URL via replaceState.
 *  Preserves every other key, the pathname, and any non-param fragment
 *  (e.g. selection-routing `#/schema/...`). */
function rewriteUrl(stripQueryKeys: readonly string[], stripFragmentKeys: readonly string[]): void {
  if (!hasWindow()) return;
  const search = new URLSearchParams(window.location.search);
  let queryChanged = false;
  for (const k of stripQueryKeys) {
    if (search.has(k)) { search.delete(k); queryChanged = true; }
  }

  const hash = window.location.hash;
  const fragParams = parseFragmentParams();
  let newHash = hash;
  if (fragParams) {
    let fragChanged = false;
    for (const k of stripFragmentKeys) {
      if (fragParams.has(k)) { fragParams.delete(k); fragChanged = true; }
    }
    if (fragChanged) {
      const s = fragParams.toString();
      newHash = s ? `#${s}` : "";
    }
  }

  if (!queryChanged && newHash === hash) return;
  const qs = search.toString();
  const cleaned = window.location.pathname + (qs ? `?${qs}` : "") + newHash;
  try { window.history.replaceState(null, "", cleaned); } catch {}
}

// ---------------------------------------------------------------------------
// Plain getters — no side effects
// ---------------------------------------------------------------------------

/** VGI service URL from `?service=`. Falls back to current origin. */
export function getServiceUrl(): string {
  if (!hasWindow()) return "";
  const params = new URLSearchParams(window.location.search);
  return params.get("service") || window.location.origin;
}

/** Whether `?service=` was explicitly provided. Drives welcome-page logic. */
export function hasExplicitService(): boolean {
  if (!hasWindow()) return false;
  return new URLSearchParams(window.location.search).has("service");
}

/** Raw `?attach_options=` value. `undefined` = absent (caller falls back to
 *  localStorage); `""` = explicit empty (clear saved options). */
export function getAttachOptionsFromUrl(): string | undefined {
  if (!hasWindow()) return undefined;
  const params = new URLSearchParams(window.location.search);
  if (!params.has("attach_options")) return undefined;
  return params.get("attach_options") ?? "";
}

/** `?data_version_spec=<spec>` — pins the catalog's served data version at
 *  ATTACH time. The VGI DuckDB extension reads a `data_version_spec` ATTACH
 *  option (see vgi_extension.cpp); the worker landing page emits this param
 *  when a user pins a non-latest version. `undefined` = absent. */
export function getDataVersionSpecFromUrl(): string | undefined {
  if (!hasWindow()) return undefined;
  const v = new URLSearchParams(window.location.search).get("data_version_spec");
  return v ? v : undefined;
}

/** `?theme=<url>`. */
export function getThemeUrl(): string | null {
  if (!hasWindow()) return null;
  return new URLSearchParams(window.location.search).get("theme");
}

/** `?fresh` flag to clear a corrupted DuckDB session snapshot. */
export function getFreshFlag(): boolean {
  if (!hasWindow()) return false;
  return new URLSearchParams(window.location.search).has("fresh");
}

/** `#prefill=<url>` for the Edit connection options flow. Plain getter — does
 *  not consume; use consumePrefillFromHash to read+strip. */
export function getPrefillFromHash(): string | null {
  if (!hasWindow()) return null;
  const m = window.location.hash.match(/^#prefill=(.+)$/);
  if (!m) return null;
  try { return decodeURIComponent(m[1]); } catch { return null; }
}

// ---------------------------------------------------------------------------
// Consume helpers — read + strip from URL
// ---------------------------------------------------------------------------

/** Read `?ai_key=` or `#ai_key=` and strip it from the URL. Query-string
 *  form wins when both are present. Returns null if neither is set. */
export function consumeAiKey(): string | null {
  if (!hasWindow()) return null;
  const search = new URLSearchParams(window.location.search);
  const fragParams = parseFragmentParams();
  const inSearch = search.has("ai_key");
  const inHash = fragParams?.has("ai_key") ?? false;
  if (!inSearch && !inHash) return null;
  const value = inSearch ? (search.get("ai_key") ?? "") : (fragParams!.get("ai_key") ?? "");
  rewriteUrl(["ai_key"], ["ai_key"]);
  return value;
}

export interface AuthFragment {
  token: string;
  refreshToken?: string;
  tokenEndpoint?: string;
  clientId?: string;
  clientSecret?: string;
  useIdToken?: boolean;
}

const AUTH_FRAGMENT_KEYS = [
  "token", "refresh_token", "token_endpoint",
  "client_id", "client_secret", "use_id_token",
] as const;

/** Read `#token=...&refresh_token=...&...` from the URL fragment and strip
 *  the auth keys (preserving any other fragment params — `ai_key`, selection
 *  routing, etc.). Returns null if no `token=` is present. */
export function consumeAuthFragment(): AuthFragment | null {
  if (!hasWindow()) return null;
  const fragParams = parseFragmentParams();
  if (!fragParams?.has("token")) return null;
  const token = fragParams.get("token") ?? "";
  if (!token) return null;
  const result: AuthFragment = {
    token,
    refreshToken: fragParams.get("refresh_token") || undefined,
    tokenEndpoint: fragParams.get("token_endpoint") || undefined,
    clientId: fragParams.get("client_id") || undefined,
    clientSecret: fragParams.get("client_secret") || undefined,
    useIdToken: fragParams.get("use_id_token") === "true" || undefined,
  };
  rewriteUrl([], AUTH_FRAGMENT_KEYS);
  return result;
}

/** Read `#prefill=<url>` and clear the hash (preserving query string). */
export function consumePrefillFromHash(): string | null {
  if (!hasWindow()) return null;
  const value = getPrefillFromHash();
  if (value === null) return null;
  try {
    window.history.replaceState(null, "", window.location.pathname + window.location.search);
  } catch {}
  return value;
}
