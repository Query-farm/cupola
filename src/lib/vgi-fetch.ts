/**
 * The `fetch` Cupola hands to `httpConnect`, and the one thing it changes.
 *
 * The VGI TypeScript client discovers a server's HTTP capabilities by probing
 * `OPTIONS {prefix}/health` and reading the capability headers off the reply
 * (`discoverHttpCapabilities` in @query-farm/vgi-rpc). That works from Node,
 * and it cannot work from a browser:
 *
 *   - An explicit `OPTIONS` carrying `VGI-Accept-Max-Response-Bytes` is not a
 *     simple request, so the browser preflights it — sending its own OPTIONS
 *     with `Access-Control-Request-Method: OPTIONS`.
 *   - The Python server mounts `/health` as a Falcon resource implementing
 *     `on_get` and `on_head`, and Falcon's CORSMiddleware answers a preflight
 *     with the responders that exist: `Access-Control-Allow-Methods: GET, HEAD`.
 *   - `OPTIONS` is not in that list, so the browser blocks the probe before it
 *     is ever sent, and the connection fails at its first hop with a CORS
 *     error naming a method nobody wrote.
 *
 * `HEAD` is the same probe without the problem: the server implements it for
 * exactly this purpose (its docstring notes the C++ client probes with HEAD),
 * the preflight passes, and the capability headers ride on every response and
 * are named in `Access-Control-Expose-Headers` — so the client's own
 * `parseCapabilitiesFromHeaders` reads an identical answer.
 *
 * This belongs upstream in the client, which should probe with HEAD in a
 * browser; every browser consumer of it hits this. Until then it is one
 * rewrite, applied to one request shape, at the one place Cupola builds a VGI
 * connection.
 */

/** Matches the capability probe and nothing else: the client's own endpoint. */
function isCapabilityProbe(method: string | undefined, url: string): boolean {
  if ((method ?? "GET").toUpperCase() !== "OPTIONS") return false;
  try {
    return new URL(url, window.location.href).pathname.endsWith("/health");
  } catch {
    return false;
  }
}

/**
 * `fetch` with the capability probe rewritten from OPTIONS to HEAD.
 *
 * Everything else — every RPC call, every upload — passes through untouched.
 */
export const vgiFetch: typeof globalThis.fetch = (input, init) => {
  const url =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : input.url;
  const method = init?.method ?? (input instanceof Request ? input.method : undefined);

  if (isCapabilityProbe(method, url)) {
    // Re-issue as HEAD with the probe's own headers; a Request body is not a
    // consideration here, as neither OPTIONS nor HEAD carries one.
    const headers = new Headers(
      init?.headers ?? (input instanceof Request ? input.headers : undefined),
    );
    return fetch(url, { method: "HEAD", headers });
  }

  return fetch(input as RequestInfo, init);
};
