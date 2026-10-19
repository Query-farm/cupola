#!/bin/bash
# Serve cupola_test behind OAuth, with fake_idp.py as the identity provider, to
# test sign-in, refresh and expiry end to end (Cupola's PKCE client and the VGI
# extension's own flow) without Entra.
#
#   ./run-oauth.sh                       # worker :9013, IdP :9019
#   PORT=9014 IDP_PORT=9020 ./run-oauth.sh
#   VGI_OAUTH_USE_ID_TOKEN=1 ./run-oauth.sh   # bearer is the id_token, as for Entra
#
# Then open http://localhost:<dev port>/?service=http://localhost:9013 and use
# the IdP's control endpoints to move time along (see fake_idp.py), e.g.
#
#   curl -s -XPOST localhost:9019/_test/config -d '{"access_ttl":180,"refresh_lifetime":600}'
#   curl -s -XPOST localhost:9019/_test/expire-all     # "24 hours later"
#   curl -s localhost:9019/_test/state | jq .events
#
# and SELECT * FROM cupola_test.auth.whoami() to see which token the extension sent.
set -e
cd "$(dirname "$0")"

PORT="${PORT:-9013}"
IDP_PORT="${IDP_PORT:-9019}"
CLIENT_ID="${CLIENT_ID:-cupola-test-client}"
# localhost, not 127.0.0.1: the issuer is compared as a string, and both the
# browser and the extension reach the IdP and the worker by these URLs.
ISSUER="http://localhost:$IDP_PORT"

uv run --quiet fake_idp.py --port "$IDP_PORT" --client-id "$CLIENT_ID" &
IDP_PID=$!
trap 'kill $IDP_PID 2>/dev/null' EXIT INT TERM

for _ in $(seq 1 100); do
  curl -sf "$ISSUER/.well-known/openid-configuration" >/dev/null && break
  sleep 0.1
done

export VGI_JWT_ISSUER="$ISSUER"
export VGI_JWT_AUDIENCE="$CLIENT_ID"
export VGI_JWT_JWKS_URI="$ISSUER/jwks"
export VGI_OAUTH_RESOURCE="http://localhost:$PORT"
export VGI_OAUTH_AUTH_SERVERS="$ISSUER"
export VGI_OAUTH_CLIENT_ID="$CLIENT_ID"
export VGI_OAUTH_SCOPES="openid,profile,email,offline_access"
# Lets the IdP's revoke-access / expire-all end tokens the worker already holds.
export CUPOLA_TEST_IDP_URL="$ISSUER"

PORT="$PORT" ./run.sh "$@"
