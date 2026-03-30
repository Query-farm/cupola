/** JWT auth helper — reads token from URL fragment (#token=...) or cookie. */

const AUTH_COOKIE_NAME = "_vgi_auth";

export interface UserInfo {
  email?: string;
  name?: string;
  picture?: string;
  sub?: string;
}

/** Cached token from URL fragment (persists in memory for the session). */
let _cachedToken: string | null = null;

/** Extract and cache the token from the URL fragment, then clean the URL. */
function _extractFragmentToken(): string | null {
  if (typeof window === "undefined") return null;
  if (_cachedToken) return _cachedToken;
  const hash = window.location.hash;
  if (hash) {
    const match = hash.match(/token=([^&]+)/);
    if (match) {
      _cachedToken = decodeURIComponent(match[1]);
      // Remove the token from the hash but preserve any other hash content
      const cleanHash = hash.replace(/[#&]?token=[^&]+/, "").replace(/^#?&/, "#");
      const cleanUrl = window.location.pathname + window.location.search + (cleanHash === "#" ? "" : cleanHash);
      history.replaceState(null, "", cleanUrl);
      return _cachedToken;
    }
  }
  return null;
}

/** Get the raw JWT token — checks URL fragment first, then cookie. */
export function getAuthToken(): string | null {
  const fragmentToken = _extractFragmentToken();
  if (fragmentToken) return fragmentToken;
  if (typeof document === "undefined") return null;
  const match = document.cookie.match(
    new RegExp(`(^|;)\\s*${AUTH_COOKIE_NAME}=([^;]+)`)
  );
  return match ? match[2] : null;
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
