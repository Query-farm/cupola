/** Context for opaque browser fetch failures. A failed fetch alone cannot tell
 * mixed-content blocking from a stopped server or a CORS refusal.
 * WebKit tracks the loopback restriction at https://bugs.webkit.org/show_bug.cgi?id=171934.
 */
export function connectionErrorMessage(error: unknown, serviceUrl: string, pageProtocol = typeof window === 'undefined' ? '' : window.location.protocol): string {
  const message = error instanceof Error ? error.message : String(error);
  if (pageProtocol !== 'https:' || !/^(?:Load failed|Failed to fetch|NetworkError when attempting to fetch resource\.?|Network request failed)(?:\s+\([^\r\n]*\))?$/i.test(message)) return message;
  // Structured server refusals must not be recast as browser restrictions.
  if (error && typeof error === 'object' && 'errorCode' in error && error.errorCode) return message;
  let url: URL;
  try { url = new URL(serviceUrl); } catch { return message; }
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  const loopback = host === 'localhost' || host.endsWith('.localhost') || host === '[::1]' || /^127\.(?:\d{1,3}\.){2}\d{1,3}$/.test(host);
  if (url.protocol !== 'http:' || !loopback) return message;
  return `Could not connect to the local server at ${url.host}.${LOCAL_HTTP_TAIL}`;
}

const LOCAL_HTTP_TAIL = ' Cupola is using HTTPS, but this server uses HTTP. Safari can block this connection. Try opening this page in desktop Chrome, or connect to the server using HTTPS. Check that the local server is running, and allow local-network access if your browser asks.';

/** The host of a loopback-over-HTTP failure written by `connectionErrorMessage`,
 * or null for any other message. Lets the UI lay that guidance out properly while
 * the message itself stays plain text for logs, tooltips and the AI. */
export function localHttpBlockedHost(message: string | null | undefined): string | null {
  if (!message?.endsWith(LOCAL_HTTP_TAIL)) return null;
  return /^Could not connect to the local server at (\S+)\.$/.exec(message.slice(0, -LOCAL_HTTP_TAIL.length))?.[1] ?? null;
}
