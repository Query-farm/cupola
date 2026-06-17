/**
 * Browser-side OAuth 2.0 PKCE client for cupola.
 *
 * Cupola is the OAuth client (public / SPA type), the VGI service is the
 * resource server, and the IdP (Entra, Google, Okta, etc.) is the
 * authorization server. Tokens are minted by a SPA flow so that
 * cross-origin refresh works — this is the standard fix for
 * Entra's AADSTS9002326 ("cross-origin token redemption is permitted only
 * for the 'Single-Page Application' client-type").
 *
 * Flow shape:
 *
 *   1. `startLoginFlow(serviceUrl)` — called when cupola gets a 401 from a
 *      VGI service. Fetches the service's
 *      `/.well-known/oauth-protected-resource` → reads `authorization_servers[0]`
 *      → fetches that issuer's `/.well-known/openid-configuration` → gets
 *      `authorization_endpoint` + `token_endpoint`. Stashes
 *      `{code_verifier, state, service_url, return_to}` in sessionStorage
 *      under a key tied to the `state` nonce. Redirects the whole page to
 *      the authorization endpoint.
 *
 *   2. Entra/Google/Okta authenticates the user and redirects back to
 *      cupola's registered SPA redirect URI (`/oauth-callback.html`).
 *      `oauth-callback.html` is just a static page that posts the `code`
 *      into `BroadcastChannel("vgi-oauth")`.
 *
 *   3. `bootstrap()` — mounted by `CatalogApp` on every page load. Opens a
 *      BroadcastChannel listener, waits up to a few seconds for the
 *      callback message, then calls `completeLoginFlow(code, state)`.
 *      That looks up the pending flow by `state`, exchanges the code for
 *      tokens at the IdP's `token_endpoint`, stores the tokens keyed by
 *      service origin, and navigates back to the original page.
 *
 *   4. `getToken(serviceUrl)` — returns a currently-valid access_token for
 *      the given service, refreshing in the background if it's within a
 *      grace window of expiry. Returns null if no tokens are stored or the
 *      refresh fails (caller should start a new login flow).
 *
 *   5. `clearTokens(serviceUrl)` — drops all cached state for a service.
 *
 * Storage layout (sessionStorage):
 *
 *   vgi.oauth.pending.<state>         → { code_verifier, service_url, return_to, token_endpoint, client_id, scope, created_at }
 *   vgi.oauth.tokens.<service_origin> → { access_token, refresh_token, expires_at, token_endpoint, client_id, scope, id_token? }
 *
 * We intentionally use sessionStorage (not localStorage) so tokens die with
 * the tab. Cupola is a tool you open, use, and close — persistent
 * credentials across sessions would outlive their usefulness.
 */

import * as Sentry from "@sentry/astro";

const PENDING_KEY_PREFIX = "vgi.oauth.pending.";
const TOKENS_KEY_PREFIX = "vgi.oauth.tokens.";

/** Seconds before `exp` that we treat a token as "about to expire". */
const EXPIRY_GRACE_SECONDS = 60;

/** Add a token-lifecycle breadcrumb. These cost nothing until an event is
 *  captured, then they ride along to make a 401 diagnosable as "token issued
 *  N min ago → refresh fired → refresh failed". */
function authCrumb(message: string, data?: Record<string, unknown>): void {
  Sentry.addBreadcrumb({ category: "auth", level: "info", message, data });
}

/** OAuth protected-resource metadata (RFC 9728). Subset we care about. */
interface ResourceMetadata {
  resource?: string;
  authorization_servers: string[];
  scopes_supported?: string[];
  client_id?: string;
  resource_name?: string;
  use_id_token_as_bearer?: boolean;
  /** Non-standard extension: when present, vgi-rpc is advertising its own
   *  PKCE token-exchange proxy URL. The proxy injects the server-side
   *  client_secret before forwarding to the IdP, which is required for
   *  Google OAuth (where "Web application" clients can't do PKCE without
   *  a secret). When set, we use this instead of the IdP's token_endpoint
   *  from OIDC discovery. */
  token_endpoint?: string;
}

/** OIDC discovery document. Subset we care about. */
interface AuthServerMetadata {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  end_session_endpoint?: string;
  scopes_supported?: string[];
}

/** Per-service authentication context, discovered from the VGI server. */
export interface AuthContext {
  serviceOrigin: string;
  resourceUrl: string;
  clientId: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  endSessionEndpoint?: string;
  scope: string;
  useIdTokenAsBearer: boolean;
}

/** Tokens stored per service after a successful exchange or refresh. */
interface StoredTokens {
  access_token: string;
  refresh_token?: string;
  /** Absolute unix seconds when the access token expires. */
  expires_at: number;
  token_endpoint: string;
  client_id: string;
  scope: string;
  use_id_token: boolean;
  /** Present on Entra/Google when scope includes `openid` — we fall back
   *  to this for services configured with `use_id_token_as_bearer`. */
  id_token?: string;
  /** OIDC RP-Initiated Logout endpoint, captured from the IdP's discovery
   *  document so we can redirect to it during sign-out. */
  end_session_endpoint?: string;
}

/** Pending-flow record stashed while the user is at the IdP login page. */
interface PendingFlow {
  code_verifier: string;
  state: string;
  service_origin: string;
  service_url: string;
  return_to: string;
  token_endpoint: string;
  end_session_endpoint?: string;
  client_id: string;
  scope: string;
  use_id_token: boolean;
  created_at: number;
}

// ---------------------------------------------------------------------------
// Origin helpers
// ---------------------------------------------------------------------------

/** scheme://host[:port] with no path, trailing slash, or query. Keyed like
 *  vgi_rpc's `ExtractOrigin` in vgi_oauth.cpp so the frontend and extension
 *  agree on the cache key for a service. */
export function extractOrigin(serviceUrl: string): string {
  try {
    const u = new URL(serviceUrl);
    return `${u.protocol}//${u.host}`;
  } catch {
    return serviceUrl.replace(/\/+$/, "");
  }
}

// ---------------------------------------------------------------------------
// PKCE primitives
// ---------------------------------------------------------------------------

/** 43-char base64url random string (RFC 7636 §4.1). */
function generateCodeVerifier(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return base64UrlEncode(bytes);
}

/** SHA-256 of the verifier, base64url-encoded (RFC 7636 §4.2). */
async function generateCodeChallenge(verifier: string): Promise<string> {
  const data = new TextEncoder().encode(verifier);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return base64UrlEncode(new Uint8Array(hash));
}

function generateStateNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return base64UrlEncode(bytes);
}

function base64UrlEncode(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) {
    throw new Error(`${url} returned HTTP ${res.status}`);
  }
  return (await res.json()) as T;
}

/** Fetch VGI service resource metadata + IdP discovery → AuthContext. */
export async function discoverAuthContext(serviceUrl: string): Promise<AuthContext> {
  const serviceOrigin = extractOrigin(serviceUrl);
  const metadataUrl = `${serviceOrigin}/.well-known/oauth-protected-resource`;
  const metadata = await fetchJson<ResourceMetadata>(metadataUrl);

  if (!metadata.authorization_servers || metadata.authorization_servers.length === 0) {
    throw new Error(`VGI service ${serviceOrigin} advertised no authorization_servers`);
  }
  if (!metadata.client_id) {
    throw new Error(`VGI service ${serviceOrigin} advertised no client_id`);
  }

  const issuer = metadata.authorization_servers[0].replace(/\/+$/, "");
  const discoveryUrl = `${issuer}/.well-known/openid-configuration`;
  const server = await fetchJson<AuthServerMetadata>(discoveryUrl);

  if (!server.authorization_endpoint || !server.token_endpoint) {
    throw new Error(`Authorization server ${issuer} is missing authorization_endpoint or token_endpoint`);
  }

  const advertised = metadata.scopes_supported ?? [];
  const scope = advertised.join(" ");

  // If the VGI server advertises its own PKCE token-exchange proxy, route
  // token requests through it instead of hitting the IdP directly. The proxy
  // injects the server-side client_secret, which Google requires even for
  // PKCE clients registered as "Web application".
  const tokenEndpoint = metadata.token_endpoint ?? server.token_endpoint;

  return {
    serviceOrigin,
    resourceUrl: metadata.resource ?? serviceOrigin,
    clientId: metadata.client_id,
    authorizationEndpoint: server.authorization_endpoint,
    tokenEndpoint,
    endSessionEndpoint: server.end_session_endpoint,
    scope,
    useIdTokenAsBearer: !!metadata.use_id_token_as_bearer,
  };
}

// ---------------------------------------------------------------------------
// Storage helpers
// ---------------------------------------------------------------------------

function readPending(state: string): PendingFlow | null {
  try {
    const raw = sessionStorage.getItem(PENDING_KEY_PREFIX + state);
    return raw ? (JSON.parse(raw) as PendingFlow) : null;
  } catch {
    return null;
  }
}

function writePending(pending: PendingFlow): void {
  sessionStorage.setItem(PENDING_KEY_PREFIX + pending.state, JSON.stringify(pending));
}

function deletePending(state: string): void {
  sessionStorage.removeItem(PENDING_KEY_PREFIX + state);
}

function tokensKey(serviceOrigin: string): string {
  return TOKENS_KEY_PREFIX + serviceOrigin;
}

function readTokens(serviceOrigin: string): StoredTokens | null {
  try {
    const raw = sessionStorage.getItem(tokensKey(serviceOrigin));
    return raw ? (JSON.parse(raw) as StoredTokens) : null;
  } catch {
    return null;
  }
}

function writeTokens(serviceOrigin: string, tokens: StoredTokens): void {
  sessionStorage.setItem(tokensKey(serviceOrigin), JSON.stringify(tokens));
}

/** Drop all cached tokens for a given service. Called on logout or when a
 *  refresh fails permanently. */
export function clearTokens(serviceUrl: string): void {
  sessionStorage.removeItem(tokensKey(extractOrigin(serviceUrl)));
}

/** Get the IdP logout URL for a service (OIDC RP-Initiated Logout).
 *  Returns null if no stored tokens or no end_session_endpoint. */
export function getLogoutInfo(serviceUrl: string): { endSessionEndpoint: string; idToken?: string } | null {
  const stored = readTokens(extractOrigin(serviceUrl));
  if (!stored?.end_session_endpoint) return null;
  return {
    endSessionEndpoint: stored.end_session_endpoint,
    idToken: stored.id_token,
  };
}

/** Drop ALL stored OAuth tokens and pending state across every service.
 *  Used by the sign-out page to fully clear the Cupola session. */
export function clearAllTokens(): void {
  if (typeof sessionStorage === "undefined") return;
  const toRemove: string[] = [];
  for (let i = 0; i < sessionStorage.length; i++) {
    const key = sessionStorage.key(i);
    if (key && (key.startsWith(TOKENS_KEY_PREFIX) || key.startsWith(PENDING_KEY_PREFIX))) {
      toRemove.push(key);
    }
  }
  for (const key of toRemove) {
    sessionStorage.removeItem(key);
  }
}

// ---------------------------------------------------------------------------
// Token exchange / refresh
// ---------------------------------------------------------------------------

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  id_token?: string;
  token_type?: string;
  expires_in?: number;
  scope?: string;
}

async function postTokenRequest(tokenEndpoint: string, body: URLSearchParams): Promise<TokenResponse> {
  const res = await fetch(tokenEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  const text = await res.text();
  let parsed: any;
  try { parsed = JSON.parse(text); } catch { parsed = { raw: text }; }
  if (!res.ok) {
    const err = parsed?.error ?? "unknown";
    const desc = parsed?.error_description ?? text.slice(0, 500);
    throw new Error(`Token endpoint ${tokenEndpoint} returned HTTP ${res.status} (${err}): ${desc}`);
  }
  return parsed as TokenResponse;
}

function storeTokenResponse(ctx: AuthContext, resp: TokenResponse, fallbackRefreshToken?: string, fallbackEndSessionEndpoint?: string): StoredTokens {
  const now = Math.floor(Date.now() / 1000);
  const expires_in = typeof resp.expires_in === "number" ? resp.expires_in : 3600;
  const stored: StoredTokens = {
    access_token: resp.access_token,
    refresh_token: resp.refresh_token ?? fallbackRefreshToken,
    expires_at: now + expires_in,
    token_endpoint: ctx.tokenEndpoint,
    client_id: ctx.clientId,
    scope: ctx.scope,
    use_id_token: ctx.useIdTokenAsBearer,
    id_token: resp.id_token,
    end_session_endpoint: ctx.endSessionEndpoint ?? fallbackEndSessionEndpoint,
  };
  writeTokens(ctx.serviceOrigin, stored);
  authCrumb("token stored", {
    expires_in,
    expires_at: stored.expires_at,
    hasRefreshToken: !!stored.refresh_token,
    useIdToken: stored.use_id_token,
  });
  return stored;
}

// ---------------------------------------------------------------------------
// Flow: authorize
// ---------------------------------------------------------------------------

/** SPA redirect URI registered with the IdP. Must match the exact value in
 *  the app registration for Entra; for Google it's one of the "authorized
 *  redirect URIs". */
export function redirectUri(): string {
  return `${window.location.origin}/oauth-callback.html`;
}

/** Kick off the OAuth flow for a VGI service by redirecting the browser to
 *  the IdP's authorize endpoint. This replaces the current
 *  `redirectToAuth(serviceUrl)` that sent users through the VGI server's
 *  legacy `/_oauth/callback` route.
 *
 *  On successful authentication the user is redirected to
 *  `${origin}/oauth-callback.html?code=...` → cupola bootstrap → exchange →
 *  navigate back to `returnTo`. */
export async function startLoginFlow(serviceUrl: string, returnTo?: string): Promise<never> {
  const ctx = await discoverAuthContext(serviceUrl);
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = await generateCodeChallenge(codeVerifier);
  const state = generateStateNonce();

  const pending: PendingFlow = {
    code_verifier: codeVerifier,
    state,
    service_origin: ctx.serviceOrigin,
    service_url: serviceUrl,
    return_to: returnTo ?? window.location.href,
    token_endpoint: ctx.tokenEndpoint,
    end_session_endpoint: ctx.endSessionEndpoint,
    client_id: ctx.clientId,
    scope: ctx.scope,
    use_id_token: ctx.useIdTokenAsBearer,
    created_at: Date.now(),
  };
  writePending(pending);

  const params = new URLSearchParams({
    response_type: "code",
    client_id: ctx.clientId,
    redirect_uri: redirectUri(),
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    state,
    scope: ctx.scope,
  });
  const authorizeUrl = `${ctx.authorizationEndpoint}?${params.toString()}`;
  console.log("[oauth] startLoginFlow → redirect", ctx.authorizationEndpoint, "scope=", ctx.scope);
  window.location.href = authorizeUrl;
  // Never actually returns because we navigated away. Typed as `never` so
  // callers don't try to use a return value.
  return await new Promise<never>(() => {});
}

// ---------------------------------------------------------------------------
// Flow: complete (callback side)
// ---------------------------------------------------------------------------

/** Called when `oauth-callback.html` BroadcastChannels a `{code, state}`
 *  message back to the main window. Exchanges the code for tokens and
 *  navigates back to the original `returnTo` URL. */
export async function completeLoginFlow(code: string, state: string): Promise<{ serviceUrl: string; returnTo: string }> {
  const pending = readPending(state);
  if (!pending) {
    throw new Error(`No pending OAuth flow for state=${state}. The browser session may have restarted.`);
  }
  deletePending(state);

  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri(),
    code_verifier: pending.code_verifier,
    client_id: pending.client_id,
  });
  const resp = await postTokenRequest(pending.token_endpoint, body);
  storeTokenResponse(
    {
      serviceOrigin: pending.service_origin,
      resourceUrl: pending.service_url,
      clientId: pending.client_id,
      authorizationEndpoint: "", // not needed after initial authorize
      tokenEndpoint: pending.token_endpoint,
      endSessionEndpoint: pending.end_session_endpoint,
      scope: pending.scope,
      useIdTokenAsBearer: pending.use_id_token,
    },
    resp,
  );
  return { serviceUrl: pending.service_url, returnTo: pending.return_to };
}

// ---------------------------------------------------------------------------
// Refresh
// ---------------------------------------------------------------------------

async function refreshAccessToken(serviceOrigin: string): Promise<StoredTokens | null> {
  const stored = readTokens(serviceOrigin);
  if (!stored || !stored.refresh_token) return null;

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: stored.refresh_token,
    client_id: stored.client_id,
    scope: stored.scope,
  });
  try {
    const resp = await postTokenRequest(stored.token_endpoint, body);
    const ctx: AuthContext = {
      serviceOrigin,
      resourceUrl: serviceOrigin,
      clientId: stored.client_id,
      authorizationEndpoint: "",
      tokenEndpoint: stored.token_endpoint,
      endSessionEndpoint: stored.end_session_endpoint,
      scope: stored.scope,
      useIdTokenAsBearer: stored.use_id_token,
    };
    return storeTokenResponse(ctx, resp, stored.refresh_token, stored.end_session_endpoint);
  } catch (err) {
    console.warn("[oauth] refresh failed for", serviceOrigin, err);
    // A swallowed refresh failure is the silent root cause of many user-facing
    // "Authentication Error"s: the caller goes tokenless and the server 401s.
    // Surface it (warning level — the token store isn't cleared, so a fresh
    // login can still recover) so token-expiration spikes are visible.
    Sentry.captureException(err instanceof Error ? err : new Error(String(err)), {
      level: "warning",
      tags: { component: "auth", path: "token-refresh" },
      extra: { serviceOrigin },
    });
    // Don't clear tokens on a transient failure — the caller can decide
    // whether to force a fresh login.
    return null;
  }
}

// ---------------------------------------------------------------------------
// Public accessors
// ---------------------------------------------------------------------------

/** Get a currently-valid bearer token for a service, refreshing in the
 *  background if it's within the grace window of expiry. Returns null if
 *  there are no tokens stored or the refresh failed. */
export async function getAccessToken(serviceUrl: string): Promise<string | null> {
  const serviceOrigin = extractOrigin(serviceUrl);
  let stored = readTokens(serviceOrigin);
  if (!stored) {
    authCrumb("no stored tokens for service", { serviceOrigin });
    return null;
  }

  const now = Math.floor(Date.now() / 1000);
  if (stored.expires_at - EXPIRY_GRACE_SECONDS <= now) {
    authCrumb("access token near/at expiry, refreshing", {
      serviceOrigin,
      expiresAt: stored.expires_at,
      secondsPastGrace: now - (stored.expires_at - EXPIRY_GRACE_SECONDS),
      hasRefreshToken: !!stored.refresh_token,
    });
    const refreshed = await refreshAccessToken(serviceOrigin);
    if (refreshed) stored = refreshed;
    else {
      authCrumb(
        "no valid access token after refresh attempt — request will be unauthenticated",
        { serviceOrigin },
      );
      return null;
    }
  }

  return stored.use_id_token && stored.id_token ? stored.id_token : stored.access_token;
}

/** Get the current refresh_token for a service (used by the DuckDB
 *  extension's ATTACH option). Returns null if unknown. */
export function getRefreshToken(serviceUrl: string): string | null {
  const stored = readTokens(extractOrigin(serviceUrl));
  return stored?.refresh_token ?? null;
}

/** Pull the resource metadata + IdP config needed to inject into ATTACH
 *  (the extension stores these in its refresh_ctx so it can refresh on
 *  401). Returns null if no tokens are stored yet. */
export function getOAuthMeta(serviceUrl: string): {
  refreshToken: string;
  tokenEndpoint: string;
  clientId: string;
  useIdToken: boolean;
} | null {
  const stored = readTokens(extractOrigin(serviceUrl));
  if (!stored?.refresh_token) return null;
  return {
    refreshToken: stored.refresh_token,
    tokenEndpoint: stored.token_endpoint,
    clientId: stored.client_id,
    useIdToken: stored.use_id_token,
  };
}

/** Returns true if cupola has ever had valid tokens for this service in the
 *  current tab. Used by CatalogApp to decide whether a 401 means "first
 *  login" vs "tokens got revoked, redirect to re-auth". */
export function hasTokens(serviceUrl: string): boolean {
  return readTokens(extractOrigin(serviceUrl)) !== null;
}

/** Read the raw stored token bundle for a service. Used by auth.getUserInfo
 *  to decode the id_token / access_token for the header user widget. */
export function getStoredTokens(serviceUrl: string): {
  access_token: string;
  refresh_token?: string;
  id_token?: string;
  expires_at: number;
  use_id_token: boolean;
} | null {
  const stored = readTokens(extractOrigin(serviceUrl));
  if (!stored) return null;
  return {
    access_token: stored.access_token,
    refresh_token: stored.refresh_token,
    id_token: stored.id_token,
    expires_at: stored.expires_at,
    use_id_token: stored.use_id_token,
  };
}

// ---------------------------------------------------------------------------
// Bootstrap: run on every page load to catch returning OAuth callbacks
// ---------------------------------------------------------------------------

let bootstrapped = false;
let pendingCallbackPromise: Promise<{ serviceUrl: string; returnTo: string } | null> | null = null;

const CALLBACK_STASH_KEY = "vgi.oauth.callback";

/** Check sessionStorage for a callback stash left by oauth-callback.html
 *  and, if present, exchange the code for tokens. Returns the flow result
 *  or null if there was nothing to process. Safe to call multiple times —
 *  the first call consumes the stash, subsequent calls return the cached
 *  promise from that first call. Callers should `await` this before any
 *  code that reads tokens (e.g. fetchCatalog's getAuthTokenForService). */
export function consumePendingCallback(): Promise<{ serviceUrl: string; returnTo: string } | null> {
  if (pendingCallbackPromise) return pendingCallbackPromise;
  if (typeof window === "undefined") return Promise.resolve(null);

  pendingCallbackPromise = (async () => {
    let raw: string | null = null;
    try {
      raw = sessionStorage.getItem(CALLBACK_STASH_KEY);
    } catch {
      return null;
    }
    if (!raw) return null;
    try {
      sessionStorage.removeItem(CALLBACK_STASH_KEY);
    } catch { /* ignore */ }
    let parsed: any;
    try {
      parsed = JSON.parse(raw);
    } catch {
      console.warn("[oauth] consumePendingCallback: could not parse stash");
      return null;
    }
    if (!parsed || parsed.type !== "oauth-callback") return null;
    if (parsed.error) {
      console.error("[oauth] consumePendingCallback: callback carried error",
                    parsed.error, parsed.errorDescription);
      throw new Error(parsed.errorDescription || parsed.error);
    }
    if (!parsed.code || !parsed.state) {
      console.warn("[oauth] consumePendingCallback: stash missing code/state", parsed);
      return null;
    }
    try {
      const result = await completeLoginFlow(parsed.code, parsed.state);
      console.log("[oauth] consumePendingCallback: login complete, return_to=", result.returnTo);
      return result;
    } catch (err) {
      console.error("[oauth] consumePendingCallback: completeLoginFlow failed", err);
      return null;
    }
  })();
  return pendingCallbackPromise;
}

/** Subscribes to `BroadcastChannel("vgi-oauth")` for the *rare* case where
 *  a popup oauth-callback.html message lands on cupola's main tab instead
 *  of on DuckDBShell.tsx's own listener (i.e. the cupola main thread
 *  opened the popup). For the top-level redirect flow, callers should
 *  `await consumePendingCallback()` before their first auth-dependent
 *  fetch — bootstrap() does NOT handle that path because React effects
 *  run after the initial render, which is too late for the initial
 *  fetchCatalog call. */
export function bootstrap(onLoginComplete: (result: { serviceUrl: string; returnTo: string }) => void): void {
  if (bootstrapped || typeof window === "undefined") return;
  bootstrapped = true;

  const bc = new BroadcastChannel("vgi-oauth");
  bc.onmessage = async (ev: MessageEvent) => {
    const m = ev.data;
    if (!m || m.type !== "oauth-callback") return;
    if (!m.code || !m.state) return;
    // BroadcastChannel is shared with the DuckDB shell's own OAuth popup
    // listener. Ignore messages whose state we never started — those belong
    // to a shell ATTACH flow and will be handled by DuckDBShell.tsx.
    if (!readPending(m.state)) return;
    try {
      const result = await completeLoginFlow(m.code, m.state);
      console.log("[oauth] bootstrap: login complete via broadcast, return_to=", result.returnTo);
      onLoginComplete(result);
    } catch (err) {
      console.error("[oauth] bootstrap: completeLoginFlow (broadcast) failed", err);
    }
  };
}
