#!/usr/bin/env bash
#
# Build the flat single-version Cupola Docker image (Docker / Azure Container
# Apps). Run on a machine that has the sibling repos (../vgi-typescript,
# ../vgi-rpc-typescript) linked, same as a normal Cloudflare publish.
#
#   ./build-image.sh                 # -> image tagged cupola:flat
#   ./build-image.sh myregistry/cupola:1.2.3
#
# This mirrors the asset-staging that publish.sh does for the Cloudflare/R2
# path (the DuckDB wasm engine + the VGI extension), but emits a flat bundle
# (BASE_PATH=/) and bakes it into a Caddy image instead of syncing to R2.
set -euo pipefail
cd "$(dirname "$0")"

IMAGE_TAG="${1:-cupola:flat}"

# Keep this pinned to the @haybarn/haybarn-wasm major in package.json.
HAYBARN_SRC="node_modules/@haybarn/haybarn-wasm/dist"
HAYBARN_EXT_VERSION="v1.5.3"

echo "==> Building flat bundle (BASE_PATH=/)..."
BASE_PATH=/ bun run build

# --- Stage the DuckDB-WASM engine into dist/haybarn/ ----------------------
# astro build does NOT emit these; the AsyncDuckDB sub-worker fetches them from
# ${BASE_URL}haybarn/... at runtime. Sourced from the installed npm package so
# the versions match what the frontend was built against. (Mirrors publish.sh.)
echo "==> Staging haybarn artifacts from ${HAYBARN_SRC}..."
mkdir -p dist/haybarn
for f in \
  duckdb-coi.wasm duckdb-eh.wasm duckdb-mvp.wasm \
  duckdb-browser-coi.worker.js \
  duckdb-browser-coi.worker.js.map \
  duckdb-browser-coi.pthread.worker.js \
  duckdb-browser-coi.pthread.worker.js.map \
  duckdb-browser-eh.worker.js \
  duckdb-browser-eh.worker.js.map \
  duckdb-browser-mvp.worker.js \
  duckdb-browser-mvp.worker.js.map; do
  if [ -e "${HAYBARN_SRC}/${f}" ]; then
    cp "${HAYBARN_SRC}/${f}" "dist/haybarn/${f}"
  elif [[ "$f" != *.map ]]; then
    echo "ERROR: required haybarn artifact missing: ${HAYBARN_SRC}/${f}" >&2
    exit 1
  fi
done

# --- Mirror the VGI extension (3 wasm variants) ---------------------------
# The shell sets custom_extension_repository = '${origin}/haybarn/extensions'
# before INSTALL vgi, so DuckDB fetches from this bundled mirror rather than
# depending on haybarn-extensions.query.farm at runtime.
echo "==> Fetching vgi extension wasm variants (${HAYBARN_EXT_VERSION})..."
for variant in wasm_mvp wasm_eh wasm_threads; do
  mkdir -p "dist/haybarn/extensions/${HAYBARN_EXT_VERSION}/${variant}"
  curl -fsSL \
    -o "dist/haybarn/extensions/${HAYBARN_EXT_VERSION}/${variant}/vgi.duckdb_extension.wasm" \
    "https://haybarn-extensions.query.farm/community/${HAYBARN_EXT_VERSION}/${variant}/vgi.duckdb_extension.wasm"
done

echo "==> docker build -t ${IMAGE_TAG} ..."
docker build -t "${IMAGE_TAG}" .

echo "==> Done. Run with: docker run -p 8080:80 ${IMAGE_TAG}"
