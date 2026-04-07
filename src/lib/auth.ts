/** JWT auth helper — reads token from URL fragment (#token=...) or cookie. */

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

/** Get the raw JWT token — checks URL fragment first, then cookie. Returns null if expired. */
export function getAuthToken(): string | null {
  const fragmentToken = _extractFragmentToken();
  if (fragmentToken) {
    if (isTokenExpired(fragmentToken)) {
      console.warn("[auth] Fragment token is expired, clearing");
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
      console.warn("[auth] Cookie token is expired, clearing");
      clearAuth();
      return null;
    }
    _hadToken = true;
    return match[2];
  }
  return null;
}

/** Returns true if we previously had a valid auth token (i.e. this service requires auth). */
export function hadAuthToken(): boolean {
  return _hadToken;
}

/** Redirect to the VGI server to re-authenticate. */
export function redirectToAuth(serviceUrl: string): void {
  if (typeof window === "undefined") return;
  window.location.href =
    `${serviceUrl}${serviceUrl.includes("?") ? "&" : "?"}` +
    `_vgi_return_to=${encodeURIComponent(window.location.href)}`;
}

/** Get OAuth metadata from the fragment redirect (for DuckDB secret creation). */
export function getOAuthMeta(): OAuthMeta | null {
  _extractFragmentToken(); // ensure parsed
  return _cachedOAuthMeta;
}

/** Clear all cached auth state (in-memory token and cookie). */
export function clearAuth(): void {
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
