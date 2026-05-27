/**
 * HTTP retry policy for the Anthropic API.
 *
 * Lives in its own module — pure fetch logic, no service / catalog imports —
 * so it can be unit-tested without the VGI/RPC dependency chain.
 *
 * Retry rules:
 *   - 401 / 403 / 404: no retry, surface as user-actionable error.
 *   - 429 / 529: retry honoring `retry-after` (verbatim, capped at 30s).
 *     Fallback (no header): jittered exponential backoff capped at 15s.
 *   - Network errors (offline, DNS, CORS, reset): jittered exponential
 *     backoff capped at 10s, up to `maxRetries` retries.
 *   - Abort signal short-circuits the wait loop on every tick.
 */

export interface RetryCallbacks {
  /** Called during retry countdowns with a status message, or null when the countdown ends. */
  onRetry?: (message: string | null) => void;
}

export async function fetchWithRetry(
  url: string,
  init: RequestInit,
  callbacks: RetryCallbacks,
  maxRetries = 3
): Promise<Response> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    let response: Response;
    try {
      response = await fetch(url, init);
    } catch (err: any) {
      // Network error (offline, DNS failure, CORS, connection reset)
      if (init.signal?.aborted) throw new Error("Cancelled.");
      if (attempt < maxRetries) {
        // Jittered exponential backoff: prevents concurrent agents from
        // lockstep-retrying after a shared outage.
        const base = Math.min(2 ** attempt * 2, 10);
        const waitSec = Math.max(1, Math.round(base * (0.5 + Math.random())));
        let interrupted = false;
        for (let remaining = waitSec; remaining > 0; remaining--) {
          if (init.signal?.aborted) { interrupted = true; break; }
          callbacks.onRetry?.(`Network error, retrying in ${remaining}s...`);
          await new Promise((r) => setTimeout(r, 1000));
        }
        callbacks.onRetry?.(null);
        if (interrupted) continue; // abort during wait → skip to next attempt (will abort on fetch)
        continue;
      }
      throw new Error("Network error. Check your connection.");
    }

    if (response.ok) return response;

    const status = response.status;
    let errorMsg: string;
    try {
      const body = await response.json();
      errorMsg = body.error?.message || JSON.stringify(body);
    } catch {
      errorMsg = response.statusText;
    }

    // Don't retry auth or not-found errors
    if (status === 401 || status === 403) throw new Error("Invalid API key. Check Settings.");
    if (status === 404) throw new Error(`API endpoint not found (404). Check your API configuration.`);

    // Retry on rate limit (429) and overloaded (529)
    if ((status === 429 || status === 529) && attempt < maxRetries) {
      const retryAfter = response.headers.get("retry-after");
      // Honor server's retry-after verbatim; only jitter the fallback path.
      const waitSec = retryAfter
        ? Math.min(parseInt(retryAfter, 10) || 5, 30)
        : Math.max(1, Math.round(Math.min(2 ** attempt * 2, 15) * (0.5 + Math.random())));
      let interrupted = false;
      for (let remaining = waitSec; remaining > 0; remaining--) {
        if (init.signal?.aborted) { interrupted = true; break; }
        callbacks.onRetry?.(`Rate limited, retrying in ${remaining}s...`);
        await new Promise((r) => setTimeout(r, 1000));
      }
      callbacks.onRetry?.(null);
      if (interrupted) continue; // abort during wait → skip retry, re-enter loop (will abort on next fetch)
      continue;
    }

    if (status === 429) throw new Error("Rate limited. Try again shortly.");
    if (status === 529) throw new Error("Claude is busy. Try again shortly.");
    throw new Error(`API error (${status}): ${errorMsg}`);
  }

  throw new Error("Max retries exceeded.");
}
