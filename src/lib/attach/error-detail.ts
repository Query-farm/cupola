/**
 * What the attach-error panel shows: the statement that ran (secrets
 * redacted), a script that reproduces it in the duckdb CLI (secrets as
 * `getenv()`), the server's HTTP status and VGI headers, and the versions
 * involved.
 */
import type { OptionProblem } from "./legacy-options";

export interface AttachErrorDetail {
  title: string;
  /** The error, with secret values redacted. */
  message: string;
  serviceUrl: string;
  /** Problems found before ATTACH ran (missing or mistyped options). When set,
   *  `ran` is false and `sql` is what would have run. */
  problems?: OptionProblem[];
  ran: boolean;
  /** The ATTACH statement, secrets redacted. */
  sql?: string;
  /** INSTALL/LOAD + ATTACH for the duckdb CLI, secrets as getenv(). */
  cliScript?: string;
  versions: {
    cupola: string;
    duckdb?: string;
    vgiExtension?: string | null;
    server?: string | null;
  };
}

export interface ServiceProbe {
  status: number | null;
  /** `VGI-*`, `X-Request-ID` and `WWW-Authenticate`, as far as CORS exposes them. */
  headers: [string, string][];
  error?: string;
}

/** The HTTP status DuckDB quoted in its error, if any ("HTTP 401", "status
 *  code 503", "HTTP status 403"). */
export function statusFromError(message: string): number | null {
  const m = /\b(?:HTTP(?:\s+status)?|status(?:\s+code)?)[\s:]+([1-5]\d\d)\b/i.exec(message);
  return m ? Number(m[1]) : null;
}

const INTERESTING_HEADER = /^(?:vgi-|x-vgi-|x-request-id$|www-authenticate$)/i;

/** Ask the service for its headers. A VGI HTTP server answers its landing page
 *  with the `VGI-*` capability headers the extension checks at ATTACH. */
export async function probeService(serviceUrl: string, fetchImpl: typeof fetch = fetch): Promise<ServiceProbe> {
  if (!/^https?:\/\//i.test(serviceUrl)) return { status: null, headers: [], error: "Not an HTTP service." };
  try {
    // GET, not HEAD: a vgi-rpc HTTP server answers HEAD with 405. Only the
    // headers are wanted, so the landing page body is cancelled unread.
    const res = await fetchImpl(serviceUrl, { method: "GET", cache: "no-store", credentials: "omit" });
    void res.body?.cancel().catch(() => {});
    const headers: [string, string][] = [];
    res.headers.forEach((value, name) => {
      if (INTERESTING_HEADER.test(name)) headers.push([name, value]);
    });
    headers.sort(([a], [b]) => a.localeCompare(b));
    return { status: res.status, headers };
  } catch (error) {
    return { status: null, headers: [], error: error instanceof Error ? error.message : String(error) };
  }
}
