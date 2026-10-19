/**
 * Refresh failures in src/lib/oauth-client.ts. A refresh token the IdP refuses
 * with `invalid_grant` (Entra's 24-hour cap on SPA refresh tokens, a revoked
 * session) is dropped, so the pollers that call getAccessToken every few
 * seconds stop sending it back; any other failure keeps it for a retry.
 */
import { test, expect, describe, beforeEach, afterAll } from "bun:test";

const store = new Map<string, string>();
const fakeSessionStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => { store.set(k, v); },
  removeItem: (k: string) => { store.delete(k); },
  key: (i: number) => [...store.keys()][i] ?? null,
  get length() { return store.size; },
};

// Bun runs every test file in one global scope: put back what was there.
const realSessionStorage = (globalThis as any).sessionStorage;
const realFetch = globalThis.fetch;
afterAll(() => {
  if (realSessionStorage === undefined) delete (globalThis as any).sessionStorage;
  else (globalThis as any).sessionStorage = realSessionStorage;
  globalThis.fetch = realFetch;
});
(globalThis as any).sessionStorage = fakeSessionStorage;

const { getAccessToken, getRefreshToken } = await import("../../src/lib/oauth-client");

const SERVICE = "http://localhost:9015";
const KEY = `vgi.oauth.tokens.${SERVICE}`;

let calls = 0;
function tokenEndpointAnswers(status: number, body: unknown): void {
  globalThis.fetch = (async () => {
    calls++;
    return new Response(JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  store.clear();
  calls = 0;
  store.set(KEY, JSON.stringify({
    access_token: "expired-access",
    refresh_token: "dead-refresh",
    expires_at: Math.floor(Date.now() / 1000) - 10,
    token_endpoint: "https://idp.example/token",
    client_id: "client",
    scope: "openid offline_access",
    end_session_endpoint: "https://idp.example/logout",
  }));
});

describe("refresh failures", () => {
  test("invalid_grant drops the refresh token, so it is not sent again", async () => {
    tokenEndpointAnswers(400, { error: "invalid_grant", error_description: "AADSTS700084: The refresh token has expired" });
    expect(await getAccessToken(SERVICE)).toBeNull();
    expect(await getAccessToken(SERVICE)).toBeNull();
    expect(calls).toBe(1);
    expect(getRefreshToken(SERVICE)).toBeNull();
    // Kept for sign-out.
    expect(JSON.parse(store.get(KEY)!).end_session_endpoint).toBe("https://idp.example/logout");
  });

  test("any other failure keeps the refresh token for a retry", async () => {
    tokenEndpointAnswers(503, { error: "temporarily_unavailable" });
    expect(await getAccessToken(SERVICE)).toBeNull();
    expect(await getAccessToken(SERVICE)).toBeNull();
    expect(calls).toBe(2);
    expect(getRefreshToken(SERVICE)).toBe("dead-refresh");
  });
});
