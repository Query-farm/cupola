/** JWT auth helper — reads token from the SPA OAuth client (sessionStorage),
 *  falling back to the legacy URL fragment (#token=...) or cookie for
 *  backward compatibility with services still using the server-side flow.
 *
 *  Call sites pass a `serviceUrl` when they know it so we can look up
 *  per-service tokens stored by `oauth-client.ts`. Callers that don't have a
 *  service URL in scope still get the legacy fragment/cookie behavior. */

import {
  getAccessToken as spaGetAccessToken,
  getOAuthMeta as spaGetOAuthMeta,
  hasTokens as spaHasTokens,
  clearTokens as spaClearTokens,
  extractOrigin,
} from "./oauth-client";

const AUTH_COOKIE_NAME = "_vgi_auth";

export interface UserInfo {
  email?: string;
  name?: string;
  picture?: string;
  sub?: string;
}

/** OAuth metadata extracted from the fragment (for creating DuckDB secrets). */
export interface OAuthMeta {
  refreshToken?: string;
  tokenEndpoint?: string;
  clientId?: string;
  clientSecret?: string;
  useIdToken?: boolean;
}

/** Grace period (seconds) — treat token as expired slightly early to avoid race conditions. */
const EXPIRY_GRACE_SECONDS = 30;

/** Cached token from URL fragment (persists in memory for the session). */
let _cachedToken: string | null = null;
let _cachedOAuthMeta: OAuthMeta | null = null;
/** True once we've seen a valid token — means this service requires auth. */
let _hadToken = false;

/** Extract and cache the token + OAuth metadata from the URL fragment, then clean the URL. */
function _extractFragmentToken(): string | null {
  if (typeof window === "undefined") return null;
  if (_cachedToken) return _cachedToken;
  const hash = window.location.hash;
  if (hash) {
    // Parse all fragment params
    const params = new URLSearchParams(hash.replace(/^#/, ""));
    const token = params.get("token");
    if (token) {
      _cachedToken = token;
      console.log("[auth] Extracted token from URL fragment:", _cachedToken.substring(0, 20) + "...");

      // Extract OAuth metadata if present
      const refreshToken = params.get("refresh_token") || undefined;
      const tokenEndpoint = params.get("token_endpoint") || undefined;
      const clientId = params.get("client_id") || undefined;
      const clientSecret = params.get("client_secret") || undefined;
      const useIdToken = params.get("use_id_token") === "true" || undefined;
      if (refreshToken || tokenEndpoint) {
        _cachedOAuthMeta = { refreshToken, tokenEndpoint, clientId, clientSecret, useIdToken };
        console.log("[auth] Extracted OAuth metadata:", {
          hasRefreshToken: !!refreshToken,
          tokenEndpoint,
          clientId: clientId?.substring(0, 20) + "...",
          useIdToken,
        });
      }

      // Clean the URL — remove all auth fragment params
      const cleanUrl = window.location.pathname + window.location.search;
      history.replaceState(null, "", cleanUrl);
      return _cachedToken;
    }
  }
  return null;
}

/** Decode a JWT payload without verification. Returns null on failure. */
function decodeJwtPayload(token: string): Record<string, any> | null {
  try {
    const parts = token.split(".");
    if (parts.length < 2) return null;
    return JSON.parse(atob(parts[1].replace(/-/g, "+").replace(/_/g, "/")));
  } catch {
    return null;
  }
}

/** Check whether a JWT token is expired (or will expire within the grace window). */
function isTokenExpired(token: string): boolean {
  const payload = decodeJwtPayload(token);
  if (!payload || typeof payload.exp !== "number") return false; // no exp claim — assume valid
  const nowSeconds = Math.floor(Date.now() / 1000);
  return nowSeconds >= payload.exp - EXPIRY_GRACE_SECONDS;
}

/** Synchronous JWT lookup. Checks legacy URL fragment + cookie only. Prefer
 *  `getAuthTokenForService(serviceUrl)` at call sites that know which service
 *  they're authenticating to — that version also checks the SPA OAuth
 *  client's sessionStorage and transparently refreshes expired tokens. */
export function getAuthToken(): string | null {
  const fragmentToken = _extractFragmentToken();
  if (fragmentToken) {
    if (isTokenExpired(fragmentToken)) {
      console.warn("[auth] Fragment token is expired, clearing.");
      clearAuth();
      return null;
    }
    _hadToken = true;
    return fragmentToken;
  }
  if (typeof document === "undefined") return null;
  const match = document.cookie.match(
    new RegExp(`(^|;)\\s*${AUTH_COOKIE_NAME}=([^;]+)`)
  );
  if (match) {
    if (isTokenExpired(match[2])) {
      console.warn("[auth] Cookie token is expired, clearing.");
      clearAuth();
      return null;
    }
    _hadToken = true;
    return match[2];
  }
  return null;
}

/** Get a bearer token for a specific VGI service. Checks the SPA OAuth
 *  client first (refreshing if expired), then falls back to the legacy
 *  fragment/cookie path for backward compat. Returns null if no valid token
 *  is available. */
export async function getAuthTokenForService(serviceUrl: string): Promise<string | null> {
  const spaToken = await spaGetAccessToken(serviceUrl);
  if (spaToken) {
    _hadToken = true;
    return spaToken;
  }
  return getAuthToken();
}

/** Synchronous peek: is a SPA-issued token stored for this service? Used by
 *  CatalogApp to decide whether to trigger a login flow. */
export function hasAuthTokenForService(serviceUrl: string): boolean {
  if (spaHasTokens(serviceUrl)) {
    _hadToken = true;
    return true;
  }
  return !!getAuthToken();
}

/** Returns true if we previously had a valid auth token (i.e. this service requires auth). */
export function hadAuthToken(): boolean {
  return _hadToken;
}

/** Redirect to the VGI server to re-authenticate. */
export function redirectToAuth(serviceUrl: string): void {
  if (typeof window === "undefined") return;
  const redirectUrl = `${serviceUrl}${serviceUrl.includes("?") ? "&" : "?"}` +
    `_vgi_return_to=${encodeURIComponent(window.location.href)}`;
  console.log("[auth] redirectToAuth: redirecting to:", redirectUrl);
  console.trace("[auth] redirectToAuth call stack");
  window.location.href = redirectUrl;
}

/** Get OAuth metadata for a specific service — prefers the SPA OAuth
 *  client's sessionStorage, falls back to the legacy fragment redirect for
 *  services still using the server-side flow. Used by DuckDBShell to
 *  populate the `oauth_refresh_token` option on ATTACH. */
export function getOAuthMeta(serviceUrl?: string): OAuthMeta | null {
  if (serviceUrl) {
    const spa = spaGetOAuthMeta(serviceUrl);
    if (spa) {
      return {
        refreshToken: spa.refreshToken,
        tokenEndpoint: spa.tokenEndpoint,
        clientId: spa.clientId,
        useIdToken: spa.useIdToken,
      };
    }
  }
  _extractFragmentToken(); // ensure parsed
  return _cachedOAuthMeta;
}

/** Clear all cached auth state (in-memory token and cookie). */
export function clearAuth(): void {
  console.log("[auth] clearAuth: clearing cached token and cookie");
  _cachedToken = null;
  _cachedOAuthMeta = null;
  if (typeof document !== "undefined") {
    document.cookie = `${AUTH_COOKIE_NAME}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/`;
  }
}

/** Decode JWT payload to extract user info (no signature verification). */
export function getUserInfo(): UserInfo | null {
  const token = getAuthToken();
  if (!token) return null;
  const payload = decodeJwtPayload(token);
  if (!payload) return null;
  return {
    email: payload.email,
    name: payload.name,
    picture: payload.picture,
    sub: payload.sub,
  };
}
