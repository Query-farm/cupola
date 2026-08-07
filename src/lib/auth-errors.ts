/**
 * Classification of auth-related error messages.
 *
 * Three call sites used to each carry their own inline rule, and all three
 * keyed off the bare substring `"auth"`:
 *
 *   CatalogApp.isRecoverableAuthMessage  message.includes("auth") || "401"
 *   CatalogApp render branch             (a second, separate copy of the above)
 *   shell-init.handleAttachError         /oauth|auth|401|403|token.*expired/i
 *
 * A bare `auth` substring is far too broad for what these decide — a match
 * sends the user on a full-page redirect to the IdP. It fires on an ordinary
 * message that merely mentions a host (`could not reach auth.example.com`), a
 * column or table called `author`, or a permissions error about data rather
 * than identity. None of those are fixed by re-authenticating, so the user is
 * bounced to the IdP and back to the same failure.
 *
 * The patterns below match on auth *semantics* instead. They deliberately
 * still cover everything the VGI client actually raises:
 *
 *   RpcError("AuthenticationError", "Authentication required")   → /authenticat/
 *   HTTP 401 / 403 surfaced in a message                         → /\b401\b/
 *
 * Kept free of imports so it stays unit-testable in isolation.
 */

/** Token-exchange / IdP rejections. Re-running the auth flow hits the same
 *  wall, so callers surface these instead of redirecting. */
const UNRECOVERABLE = /token exchange failed|token refresh failed|invalid_grant|AADSTS\d+/i;

/** Auth states a fresh login can plausibly fix: no credential yet, expired
 *  credential, or the server explicitly rejecting the one we sent. */
const RECOVERABLE = [
  /\b401\b/,
  /\b403\b/,
  /unauthori[sz]/i,      // unauthorized / unauthorised
  /unauthenticated/i,
  /authenticat/i,        // "Authentication required", "AuthenticationError"
  /\boauth\b/i,
  /invalid[_ ]token/i,
  /(token[^.]{0,20}expired|expired[^.]{0,20}token)/i,
];

/** True for IdP rejections that retrying cannot fix. Check this BEFORE
 *  `isRecoverableAuthError` — the two intentionally overlap (an invalid_grant
 *  response also mentions oauth). */
export function isUnrecoverableAuthError(message: string): boolean {
  return UNRECOVERABLE.test(message);
}

/** True for auth failures a fresh sign-in can plausibly resolve.
 *
 *  Returns false for messages that merely contain the letters "auth" — see
 *  the module comment. Callers use this to decide whether to send the user
 *  through a full-page IdP redirect, so a false positive is a redirect loop
 *  and a false negative is a stuck error screen. */
export function isRecoverableAuthError(message: string): boolean {
  if (!message) return false;
  if (isUnrecoverableAuthError(message)) return false;
  return RECOVERABLE.some((re) => re.test(message));
}
