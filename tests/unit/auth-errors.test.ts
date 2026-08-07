/**
 * Tests for auth error classification.
 *
 * These two predicates decide whether the user is sent on a full-page redirect
 * to the identity provider. A false positive is a redirect loop on an error
 * that signing in cannot fix; a false negative strands the user on an error
 * screen when a fresh login would have worked. Both directions are pinned here.
 *
 * The rule previously matched the bare substring "auth", which is why the
 * "does not match incidental" block exists.
 */
import { test, expect, describe } from "bun:test";
import { isRecoverableAuthError, isUnrecoverableAuthError } from "../../src/lib/auth-errors";

describe("isRecoverableAuthError — real messages that MUST redirect", () => {
  // These are what the VGI client actually raises.
  const recoverable = [
    "Authentication required",                    // RpcError("AuthenticationError", ...)
    "AuthenticationError: Authentication required",
    "HTTP 401: Unauthorized",
    "Request failed with status 401",
    "403 Forbidden",
    "unauthorized",
    "Unauthorised",                               // en-GB spelling
    "unauthenticated request",
    "invalid_token",
    "invalid token supplied",
    "the token has expired",
    "expired token",
    "OAuth flow did not complete",
  ];
  for (const msg of recoverable) {
    test(`redirects: ${msg}`, () => {
      expect(isRecoverableAuthError(msg)).toBe(true);
    });
  }
});

describe("isRecoverableAuthError — does not match incidental 'auth'", () => {
  // Every one of these matched the old `message.includes("auth")` rule and
  // sent the user to the IdP, which could not fix any of them.
  const notAuth = [
    "could not reach auth.example.com",           // hostname
    "connect ECONNREFUSED auth-service:8080",     // hostname
    "column \"author\" not found in FROM clause", // author
    "Binder Error: Referenced column \"authority\" not found",
    "failed to parse authoritative record",
    "Catalog Error: Table with name authors does not exist",
    "Network request failed",
    "",
  ];
  for (const msg of notAuth) {
    test(`does not redirect: ${msg || "(empty)"}`, () => {
      expect(isRecoverableAuthError(msg)).toBe(false);
    });
  }
});

describe("isUnrecoverableAuthError", () => {
  const unrecoverable = [
    "token exchange failed",
    "Token refresh failed: bad request",
    "invalid_grant",
    "AADSTS50076: due to a configuration change",
  ];
  for (const msg of unrecoverable) {
    test(`surfaces rather than retries: ${msg}`, () => {
      expect(isUnrecoverableAuthError(msg)).toBe(true);
    });
  }

  test("an unrecoverable IdP rejection is NOT also treated as recoverable", () => {
    // invalid_grant responses routinely mention oauth; without the explicit
    // precedence in isRecoverableAuthError they would match both and the user
    // would be redirected into the same failure indefinitely.
    const msg = "OAuth token exchange failed: invalid_grant";
    expect(isUnrecoverableAuthError(msg)).toBe(true);
    expect(isRecoverableAuthError(msg)).toBe(false);
  });

  test("ordinary auth failures are not unrecoverable", () => {
    expect(isUnrecoverableAuthError("Authentication required")).toBe(false);
    expect(isUnrecoverableAuthError("HTTP 401")).toBe(false);
  });
});
