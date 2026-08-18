#!/usr/bin/env bash
# Smoke-test the static image contract required by DuckDB-WASM.
set -euo pipefail

IMAGE=${1:?Usage: scripts/test-container.sh <image>}
CONTAINER_NAME="cupola-smoke-${RANDOM}-$$"
PORT=${CUPOLA_SMOKE_PORT:-18080}
BASE_URL="http://127.0.0.1:${PORT}"
HAYBARN_VERSION=$(node -p "require('./package.json').dependencies['@haybarn/haybarn-wasm']")
HAYBARN_EXT_VERSION="v${HAYBARN_VERSION%%-*}"

cleanup() {
  docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
}
trap cleanup EXIT

docker run --detach --name "$CONTAINER_NAME" --publish "${PORT}:80" "$IMAGE" >/dev/null

for _ in $(seq 1 30); do
  if curl -fsS -o /dev/null "${BASE_URL}/"; then
    break
  fi
  sleep 1
done

root_headers=$(curl -fsSI "${BASE_URL}/")
grep -qi '^Cross-Origin-Opener-Policy: same-origin' <<<"$root_headers"
grep -qi '^Cross-Origin-Embedder-Policy: require-corp' <<<"$root_headers"
grep -qi '^Cross-Origin-Resource-Policy: cross-origin' <<<"$root_headers"

curl -fsS -o /dev/null "${BASE_URL}/sign-out"
wasm_headers=$(curl -fsSI "${BASE_URL}/haybarn/duckdb-coi.wasm")
grep -qi '^Content-Type: application/wasm' <<<"$wasm_headers"
curl -fsSI "${BASE_URL}/haybarn/extensions/${HAYBARN_EXT_VERSION}/wasm_threads/vgi.duckdb_extension.wasm" >/dev/null

echo "Container smoke test passed for ${IMAGE}."
