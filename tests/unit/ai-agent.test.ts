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
    }) as unknown as typeof fetch;

    await expect(fetchWithRetry("https://x", {}, noopCallbacks(), 3)).rejects.toThrow(/api key/i);
    expect(calls).toBe(1);
  });

  test("404 does not retry", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return jsonResponse(404, { error: { message: "not found" } });
    }) as unknown as typeof fetch;

    await expect(fetchWithRetry("https://x", {}, noopCallbacks(), 3)).rejects.toThrow(/404/);
    expect(calls).toBe(1);
  });

  test("workspace-required errors point to the workspace setting", async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({
      error: {
        message: "anthropic-workspace-id is required when authenticating with an identity-linked API key; send the id of the workspace this request acts in.",
      },
    }), { status: 400, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;

    await expect(fetchWithRetry("https://x", {}, noopCallbacks(), 3)).rejects.toThrow(/workspace ID.*Settings/i);
  });

  test("invalid and inaccessible workspaces stay actionable", async () => {
    const responses = [
      new Response(JSON.stringify({ error: { message: "anthropic-workspace-id header must be a valid workspace ID." } }), { status: 400 }),
      new Response(JSON.stringify({ error: { message: "Workspace `wrkspc_missing` not found." } }), { status: 404 }),
    ];
    globalThis.fetch = (async () => responses.shift()!) as unknown as typeof fetch;

    await expect(fetchWithRetry("https://x", {}, noopCallbacks(), 0)).rejects.toThrow(/Invalid Anthropic workspace ID/i);
    await expect(fetchWithRetry("https://x", {}, noopCallbacks(), 0)).rejects.toThrow(/workspace not found.*does not have access/i);
  });

  test("429 with retry-after: 1 succeeds on second attempt", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      if (calls === 1) return jsonResponse(429, { error: { message: "slow down" } }, { "retry-after": "1" });
      return new Response("ok", { status: 200 });
    }) as unknown as typeof fetch;

    const res = await fetchWithRetry("https://x", {}, noopCallbacks(), 3);
    expect(res.status).toBe(200);
    expect(calls).toBe(2);
  });

  test("onRetry: countdown messages, then null immediately before the retried request", async () => {
    // The null is the "countdown over, going back out now" signal — NOT
    // "nothing is happening". A surface that clears its indicator on null
    // shows a blank panel for the whole retried request, which is the
    // slowest part of a rate-limited turn. Locking the sequence in here so
    // the contract is visible from the callback's own tests.
    const seen: (string | null)[] = [];
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      if (calls === 1) return jsonResponse(429, { error: { message: "slow down" } }, { "retry-after": "1" });
      // Still in flight when the retry goes out: null must already have fired.
      expect(seen[seen.length - 1]).toBeNull();
      return new Response("ok", { status: 200 });
    }) as unknown as typeof fetch;

    const res = await fetchWithRetry("https://x", {}, { onRetry: (m) => seen.push(m) }, 3);
    expect(res.status).toBe(200);
    expect(seen.filter((m) => typeof m === "string" && /rate limited/i.test(m)).length).toBeGreaterThan(0);
    expect(seen[seen.length - 1]).toBeNull();
  });

  test("network error: caps at maxRetries+1 attempts, not double-counted", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch;

    // maxRetries=1 means up to 2 attempts total (1 initial + 1 retry).
    // Previously the outer loop in runAgentTurn would multiply this — that
    // wrapper is gone, so we expect exactly 2 calls.
    await expect(fetchWithRetry("https://x", {}, noopCallbacks(), 1)).rejects.toThrow(/network/i);
    expect(calls).toBe(2);
  });

  test("abort during retry-after wait exits without runaway retries", async () => {
    let calls = 0;
    const controller = new AbortController();
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      calls++;
      if (init?.signal?.aborted) throw new DOMException("Aborted", "AbortError");
      // Long retry-after so we have time to abort during the countdown.
      return jsonResponse(429, { error: { message: "slow" } }, { "retry-after": "5" });
    }) as unknown as typeof fetch;

    const promise = fetchWithRetry("https://x", { signal: controller.signal }, noopCallbacks(), 3);
    setTimeout(() => controller.abort(), 50);

    // After abort during wait, the next fetch sees the aborted signal and
    // throws Cancelled. The key invariant: we don't keep retrying.
    await expect(promise).rejects.toThrow();
    expect(calls).toBeLessThanOrEqual(2);
  });
});
