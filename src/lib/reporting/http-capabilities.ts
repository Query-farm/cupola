interface CapabilityEntry { response?: Response; expiresAt: number; budget?: string | null }
const caches = new WeakMap<typeof fetch, Map<string, CapabilityEntry>>();
const supportHeader = 'VGI-Accept-Max-Response-Bytes-Support';
const maxAgeMs = 5 * 60_000;

/** Reuse only verified HEAD responses, never RPC bodies or in-flight requests.
 * Fresh SDK clients keep their own cancellation while sharing transport discovery.
 * Credentials remain in memory and custom transports have independent caches. */
export async function fetchWithCachedCapabilities(
  transport: typeof fetch, serviceUrl: string, input: RequestInfo | URL, init: RequestInit,
): Promise<Response> {
  const headers = new Headers(init.headers);
  const key = JSON.stringify([serviceUrl, headers.get('Authorization')]);
  const budget = headers.get('VGI-Accept-Max-Response-Bytes');
  let cache = caches.get(transport);
  if (!cache) caches.set(transport, cache = new Map());
  let entry = cache.get(key);
  if (!entry) {
    // Bound retained credentials and endpoints even in long-lived tabs.
    if (cache.size >= 128) cache.delete(cache.keys().next().value!);
    cache.set(key, entry = { expiresAt: 0 });
  }
  const url = input instanceof Request ? input.url : String(input);
  const probe = init.method === 'HEAD' && url === `${serviceUrl}/health`;
  init.signal?.throwIfAborted();
  if (probe && entry.response && entry.budget === budget && entry.expiresAt > Date.now()) return entry.response.clone();
  try {
    const response = await transport(input, init);
    init.signal?.throwIfAborted();
    // An older request must not repopulate a cache invalidated by a failure.
    if (cache.get(key) === entry) {
      if (!response.ok || response.headers.get(supportHeader) !== 'true') {
        cache.delete(key);
      } else if (probe) {
        // Do not retain malformed limits that the SDK will reject after fetch.
        const valid = ['Max-Request-Bytes', 'Max-Upload-Bytes', 'Max-Response-Bytes', 'Max-Externalized-Response-Bytes', 'Sticky-Default-TTL'].every(name => {
          const value = response.headers.get(`VGI-${name}`);
          return value === null || /^[1-9][0-9]*$/.test(value) && Number.isSafeInteger(Number(value)) && (!name.endsWith('Response-Bytes') || Number(value) >= 65536);
        });
        const control = response.headers.get('Cache-Control') ?? '';
        const seconds = /(?:^|,)\s*max-age\s*=\s*"?(\d+)/i.exec(control)?.[1];
        const age = Math.max(0, Number(response.headers.get('Age')) || 0);
        const ttl = Math.min(maxAgeMs, seconds === undefined ? maxAgeMs : Math.max(0, Number(seconds) - age) * 1000);
        if (!valid || /(?:^|,)\s*(?:no-store|no-cache)\b/i.test(control) || response.headers.get('Vary')?.trim() === '*' || !ttl) {
          cache.delete(key);
        } else {
          entry.response = response.clone();
          entry.expiresAt = Date.now() + ttl;
          entry.budget = budget;
        }
      }
    }
    return response;
  } catch (error) {
    if (!init.signal?.aborted && cache.get(key) === entry) cache.delete(key);
    throw error;
  }
}
