/**
 * Shareable query links.
 *
 * A share link carries the SQL for one editor tab plus enough connection
 * context that the recipient attaches to the same catalog the author was
 * looking at (`service`, `attach_options`, `data_version_spec` — the same
 * params `CatalogApp` already reads to build its ATTACH statement).
 *
 * Two encodings:
 *   `sql`   — percent-encoded plain text. The default: readable, editable by
 *             hand, greppable in a support ticket.
 *   `sql_z` — raw-deflate + base64url. Used automatically past
 *             AUTO_COMPRESS_THRESHOLD, since the plain form of a long query
 *             risks a URL-length limit.
 *
 * The Share button emits them in the **fragment** (`#sql=`), following the
 * same reasoning as `ai_key`: fragments are never transmitted, so the SQL
 * stays out of the worker's request log, the redirect chain's Location
 * headers, and outbound Referer headers. That matters because share links
 * routinely carry literals a user wouldn't knowingly put in a URL — a table
 * function's `api_key :=` argument, an email in a WHERE clause.
 *
 * The query-string form (`?sql=`) is still accepted on read, for links a VGI
 * server or a human composes server-side where assembling a fragment is
 * awkward. When a link carries both, the query string wins.
 *
 * Note the fragment is NOT a Sentry hiding place — the browser SDK captures
 * `location.href` hash included, which is why `sentry-scrub.ts` scrubs both
 * halves of the URL.
 */

export const SQL_PARAM = "sql";
export const SQL_Z_PARAM = "sql_z";

/** Compress when the percent-encoded plain form would exceed this many chars.
 *  Well under every browser/proxy limit; only very long SQL trips it. */
export const AUTO_COMPRESS_THRESHOLD = 1500;

// ---------------------------------------------------------------------------
// base64url <-> bytes
// ---------------------------------------------------------------------------

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(token: string): Uint8Array {
  const b64 = token.replace(/-/g, "+").replace(/_/g, "/");
  const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function streamBytes(bytes: Uint8Array, stream: ReadableWritablePair): Promise<Uint8Array> {
  const source = new Blob([bytes as BlobPart]).stream();
  const buf = await new Response(source.pipeThrough(stream as any)).arrayBuffer();
  return new Uint8Array(buf);
}

// ---------------------------------------------------------------------------
// sql_z codec
// ---------------------------------------------------------------------------

/** Raw-deflate `sql` and base64url the result. Throws if CompressionStream is
 *  unavailable — callers should fall back to the plain form. */
export async function compressSql(sql: string): Promise<string> {
  const bytes = await streamBytes(new TextEncoder().encode(sql), new CompressionStream("deflate-raw"));
  return toBase64Url(bytes);
}

/** Inverse of `compressSql`. Throws on a corrupt or truncated token. */
export async function decompressSql(token: string): Promise<string> {
  const bytes = await streamBytes(fromBase64Url(token), new DecompressionStream("deflate-raw"));
  return new TextDecoder().decode(bytes);
}

// ---------------------------------------------------------------------------
// Building a link
// ---------------------------------------------------------------------------

export interface ShareQueryLinkOptions {
  sql: string;
  /** VGI service URL. Omitted from the link when absent. */
  serviceUrl?: string;
  /** Raw ATTACH options fragment, so the recipient attaches identically. */
  attachOptions?: string;
  /** Pinned catalog data version, if the author had one. */
  dataVersionSpec?: string;
  /** `true` forces `sql_z`, `false` forces `sql`. Default: compress only when
   *  the plain encoding exceeds AUTO_COMPRESS_THRESHOLD. */
  compress?: boolean;
  /** Link base (origin + path). Defaults to the current page minus its query
   *  string and fragment, with a `/v{version}/` base repointed at `/latest/`.
   *  An explicit value is used verbatim. */
  baseUrl?: string;
}

/** Matches the `/v{version}/` base path that `astro.config.mjs` bakes into
 *  every emitted asset URL. Anchored to the start of the path so a `/v1.2.3/`
 *  deeper in the path (or a service URL that happens to look like one) is left
 *  alone. Tolerates a prerelease/build suffix (`0.5.0-rc.1`). */
const VERSIONED_BASE_PATH = /^\/v\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?(?=\/|$)/;

/** Repoint a versioned base path at `/latest/`.
 *
 *  A share link outlives the release that produced it. Pinning it to
 *  `/v0.4.96/` means the recipient — possibly months later — runs that exact
 *  build, missing every fix since, and keeps an old version alive in R2 long
 *  after it should have aged out. `/latest/` 302s to the current version, and
 *  the worker preserves the query string across the hop.
 *
 *  Leaves a flat base (`/`, the Docker/Azure `BASE_PATH=/` deployment) alone. */
export function toLatestBaseUrl(baseUrl: string): string {
  try {
    const u = new URL(baseUrl);
    u.pathname = u.pathname.replace(VERSIONED_BASE_PATH, "/latest");
    return u.toString();
  } catch {
    return baseUrl;
  }
}

function currentBaseUrl(): string {
  if (typeof window === "undefined") return "";
  return toLatestBaseUrl(window.location.origin + window.location.pathname);
}

/** Build a shareable URL that opens `sql` in a new, unexecuted editor tab.
 *
 *  Connection context goes in the query string (`service` etc. — the app and
 *  the worker both already read it there); the SQL goes in the fragment, so it
 *  never leaves the recipient's browser. */
export async function buildShareQueryUrl(opts: ShareQueryLinkOptions): Promise<string> {
  const { sql, serviceUrl, attachOptions, dataVersionSpec } = opts;
  const query = new URLSearchParams();
  if (serviceUrl) query.set("service", serviceUrl);
  if (attachOptions) query.set("attach_options", attachOptions);
  if (dataVersionSpec) query.set("data_version_spec", dataVersionSpec);

  const wantCompress = opts.compress ?? encodeURIComponent(sql).length > AUTO_COMPRESS_THRESHOLD;
  let compressed: string | null = null;
  if (wantCompress) {
    // A missing CompressionStream (or a hostile input) must not cost the user
    // their share link — degrade to the plain encoding.
    try { compressed = await compressSql(sql); } catch { compressed = null; }
  }
  const fragment = new URLSearchParams();
  if (compressed !== null) fragment.set(SQL_Z_PARAM, compressed);
  else fragment.set(SQL_PARAM, sql);

  const base = opts.baseUrl ?? currentBaseUrl();
  const qs = query.toString();
  return `${base}${qs ? `?${qs}` : ""}#${fragment.toString()}`;
}

// ---------------------------------------------------------------------------
// Reading a link
// ---------------------------------------------------------------------------

/** Decode whichever SQL param is present in `params`. Returns null when
 *  neither is set, or when `sql_z` is present but undecodable. */
export async function decodeSqlParams(params: URLSearchParams): Promise<string | null> {
  const plain = params.get(SQL_PARAM);
  if (plain) return plain;
  const packed = params.get(SQL_Z_PARAM);
  if (!packed) return null;
  try { return await decompressSql(packed); } catch { return null; }
}
