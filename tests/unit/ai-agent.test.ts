/**
 * Unit tests for the AI agent's retry policy in fetchWithRetry.
 *
 * Stage 1 finding #4: collapsing the duplicate retry loops means
 * fetchWithRetry is the single source of truth. These tests lock in:
 *   - 4xx auth errors do NOT retry (would burn attempts on a bad key)
 *   - 429 honors retry-after
 *   - Network errors back off and cap at maxRetries+1 attempts
 *   - Abort during the backoff sleep exits promptly (no extra fetch)
 *
 * fetchWithRetry lives in src/lib/ai-fetch.ts (pure HTTP, no service imports)
 * specifically so it can be tested without dragging in the VGI/RPC chain.
 */
import { test, expect, describe, afterEach } from "bun:test";
import { fetchWithRetry, type RetryCallbacks } from "../../src/lib/ai-fetch";

const realFetch = globalThis.fetch;

function noopCallbacks(): RetryCallbacks {
  return { onRetry: () => {} };
}

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("fetchWithRetry", () => {
  test("4xx auth errors do not retry", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return jsonResponse(401, { error: { message: "bad key" } });
    }) as typeof fetch;

    await expect(fetchWithRetry("https://x", {}, noopCallbacks(), 3)).rejects.toThrow(/api key/i);
    expect(calls).toBe(1);
  });

  test("404 does not retry", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return jsonResponse(404, { error: { message: "not found" } });
    }) as typeof fetch;

    await expect(fetchWithRetry("https://x", {}, noopCallbacks(), 3)).rejects.toThrow(/404/);
    expect(calls).toBe(1);
  });

  test("429 with retry-after: 1 succeeds on second attempt", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      if (calls === 1) return jsonResponse(429, { error: { message: "slow down" } }, { "retry-after": "1" });
      return new Response("ok", { status: 200 });
    }) as typeof fetch;

    const res = await fetchWithRetry("https://x", {}, noopCallbacks(), 3);
    expect(res.status).toBe(200);
    expect(calls).toBe(2);
  });

  test("network error: caps at maxRetries+1 attempts, not double-counted", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      throw new TypeError("Failed to fetch");
    }) as typeof fetch;

    // maxRetries=1 means up to 2 attempts total (1 initial + 1 retry).
    // Previously the outer loop in runAgentTurn would multiply this — that
    // wrapper is gone, so we expect exactly 2 calls.
    await expect(fetchWithRetry("https://x", {}, noopCallbacks(), 1)).rejects.toThrow(/network/i);
    expect(calls).toBe(2);
  });

  test("abort during retry-after wait exits without runaway retries", async () => {
    let calls = 0;
    const controller = new AbortController();
    globalThis.fetch = (async (_url, init?: RequestInit) => {
      calls++;
      if (init?.signal?.aborted) throw new DOMException("Aborted", "AbortError");
      // Long retry-after so we have time to abort during the countdown.
      return jsonResponse(429, { error: { message: "slow" } }, { "retry-after": "5" });
    }) as typeof fetch;

    const promise = fetchWithRetry("https://x", { signal: controller.signal }, noopCallbacks(), 3);
    setTimeout(() => controller.abort(), 50);

    // After abort during wait, the next fetch sees the aborted signal and
    // throws Cancelled. The key invariant: we don't keep retrying.
    await expect(promise).rejects.toThrow();
    expect(calls).toBeLessThanOrEqual(2);
  });
});
