#!/usr/bin/env bash
# Stage the Haybarn runtime and matching VGI extension into an Astro dist/.
# package.json is the single version source used by local, container, and
# Cloudflare builds.
set -euo pipefail

PROJECT_DIR=$(cd "$(dirname "$0")/.." && pwd)
cd "$PROJECT_DIR"

HAYBARN_PACKAGE="@haybarn/haybarn-wasm"
HAYBARN_SRC="node_modules/${HAYBARN_PACKAGE}/dist"
HAYBARN_VERSION=$(node -p "require('./package.json').dependencies['${HAYBARN_PACKAGE}']")

# Ranges would make the extension path depend on an implicit resolution.
# Keep the package exact so releases remain reproducible.
if [[ ! "$HAYBARN_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]]; then
  echo "ERROR: ${HAYBARN_PACKAGE} must be pinned to an exact version; got ${HAYBARN_VERSION}" >&2
  exit 1
fi

INSTALLED_VERSION=$(node -p "require('./node_modules/${HAYBARN_PACKAGE}/package.json').version")
if [ "$INSTALLED_VERSION" != "$HAYBARN_VERSION" ]; then
  echo "ERROR: installed ${HAYBARN_PACKAGE} ${INSTALLED_VERSION} does not match package.json ${HAYBARN_VERSION}" >&2
  exit 1
fi

# npm prereleases such as 1.5.5-rc1 use the stable compatibility directory
# v1.5.5 in the extension repository.
HAYBARN_EXT_VERSION="v${HAYBARN_VERSION%%-*}"

echo "==> Staging Haybarn ${HAYBARN_VERSION} runtime from ${HAYBARN_SRC}..."
mkdir -p dist/haybarn
for file in \
  duckdb-coi.wasm duckdb-eh.wasm duckdb-mvp.wasm \
  duckdb-browser-coi.worker.js \
  duckdb-browser-coi.worker.js.map \
  duckdb-browser-coi.pthread.worker.js \
  duckdb-browser-coi.pthread.worker.js.map \
  duckdb-browser-eh.worker.js \
  duckdb-browser-eh.worker.js.map \
  duckdb-browser-mvp.worker.js \
  duckdb-browser-mvp.worker.js.map; do
  if [ -e "${HAYBARN_SRC}/${file}" ]; then
    cp "${HAYBARN_SRC}/${file}" "dist/haybarn/${file}"
  elif [[ "$file" != *.map ]]; then
    echo "ERROR: required Haybarn artifact missing: ${HAYBARN_SRC}/${file}" >&2
    exit 1
  fi
done

echo "==> Fetching VGI extension variants for ${HAYBARN_EXT_VERSION}..."
for variant in wasm_mvp wasm_eh wasm_threads; do
  destination="dist/haybarn/extensions/${HAYBARN_EXT_VERSION}/${variant}/vgi.duckdb_extension.wasm"
  mkdir -p "$(dirname "$destination")"
  curl --retry 3 --retry-all-errors -fsSL \
    -o "$destination" \
    "https://haybarn-extensions.query.farm/community/${HAYBARN_EXT_VERSION}/${variant}/vgi.duckdb_extension.wasm"
done

echo "==> Haybarn assets staged for extension compatibility ${HAYBARN_EXT_VERSION}."
