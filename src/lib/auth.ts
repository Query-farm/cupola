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

/** Cached token from URL fragment (persists in memory for the session). */
let _cachedToken: string | null = null;
let _cachedOAuthMeta: OAuthMeta | null = null;

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

/** Get the raw JWT token — checks URL fragment first, then cookie. */
export function getAuthToken(): string | null {
  const fragmentToken = _extractFragmentToken();
  if (fragmentToken) {
    console.log("[auth] Using fragment token");
    return fragmentToken;
  }
  if (typeof document === "undefined") return null;
  const match = document.cookie.match(
    new RegExp(`(^|;)\\s*${AUTH_COOKIE_NAME}=([^;]+)`)
  );
  if (match) {
    console.log("[auth] Using cookie token:", match[2].substring(0, 20) + "...");
    return match[2];
  }
  console.log("[auth] No token found (checked fragment and cookie)");
  return null;
}

/** Get OAuth metadata from the fragment redirect (for DuckDB secret creation). */
export function getOAuthMeta(): OAuthMeta | null {
  _extractFragmentToken(); // ensure parsed
  return _cachedOAuthMeta;
}

/** Decode JWT payload to extract user info (no signature verification). */
export function getUserInfo(): UserInfo | null {
  const token = getAuthToken();
  if (!token) return null;
  try {
    const parts = token.split(".");
    if (parts.length < 2) return null;
    const payload = JSON.parse(
      atob(parts[1].replace(/-/g, "+").replace(/_/g, "/"))
    );
    return {
      email: payload.email,
      name: payload.name,
      picture: payload.picture,
      sub: payload.sub,
    };
  } catch {
    return null;
  }
}
