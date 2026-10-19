#!/bin/bash
# Serve cupola_test behind real Entra ID sign-in, the way Lighthouse is set up
# (v2 access tokens for an exposed `access` scope, audience = the client id),
# to reproduce token expiry against Entra itself rather than fake_idp.py.
#
#   ./run-entra.sh                          # worker :9015, tokens "expire" after 300 s
#   CUPOLA_TEST_MAX_TOKEN_AGE=120 ./run-entra.sh
#
# Then open http://localhost:4391/?service=http://localhost:9015 (the app
# registration's only SPA redirect is http://localhost:4391/oauth-callback.html)
# and sign in as cupola-oauth-test@query.farm; the password is in the keychain:
#
#   security find-generic-password -s cupola-oauth-test -w
#
# CUPOLA_TEST_MAX_TOKEN_AGE makes the worker refuse a token older than that,
# with the 401 an expired one gets, so the hour-long access token "expires" in
# minutes. Entra's 24-hour cap on SPA refresh tokens is reproduced by revoking
# the test user's sessions (that user only; never your own):
#
#   TOKEN=$(az account get-access-token --resource-type ms-graph --query accessToken -o tsv \
#     --subscription "$(az account list --all --query "[?tenantId=='bf30a0bb-8485-42d4-b41e-b961acdea52c'].id | [0]" -o tsv)")
#   curl -s -XPOST -H "Authorization: Bearer $TOKEN" -H "Content-Length: 0" \
#     https://graph.microsoft.com/v1.0/users/cupola-oauth-test@query.farm/revokeSignInSessions
#
# That leaves the browser's Entra session alive, so the next sign-in is silent.
#
# Query.Farm tenant, app "Cupola OAuth harness (test)": test-only, safe to delete.
set -e
cd "$(dirname "$0")"

PORT="${PORT:-9015}"
TENANT_ID="${ENTRA_TENANT_ID:-bf30a0bb-8485-42d4-b41e-b961acdea52c}"
CLIENT_ID="${ENTRA_CLIENT_ID:-2a5d20bd-42e3-4c0c-bd54-d3a9621ca711}"
ISSUER="https://login.microsoftonline.com/$TENANT_ID/v2.0"

export VGI_JWT_ISSUER="$ISSUER"
export VGI_JWT_AUDIENCE="$CLIENT_ID"
export VGI_JWT_JWKS_URI="https://login.microsoftonline.com/$TENANT_ID/discovery/v2.0/keys"
export VGI_OAUTH_RESOURCE="http://localhost:$PORT"
export VGI_OAUTH_AUTH_SERVERS="$ISSUER"
export VGI_OAUTH_CLIENT_ID="$CLIENT_ID"
export VGI_OAUTH_SCOPES="api://$CLIENT_ID/access,openid,profile,offline_access"
export CUPOLA_TEST_MAX_TOKEN_AGE="${CUPOLA_TEST_MAX_TOKEN_AGE:-300}"

PORT="$PORT" ./run.sh "$@"
