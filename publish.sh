#!/usr/bin/env bash
set -euo pipefail

# Publish: commit, push, build, upload versioned assets to R2, deploy Pages.
#
# URL scheme (all served by the Pages Function from R2):
#   /                → 302 → /latest/
#   /latest/         → 302 → /v{current}/
#   /v0.1.0/*        → versioned install from R2
#
# Usage:
#   ./publish.sh                  # prompt for commit message
#   ./publish.sh "fix: whatever"  # use provided message
#   ./publish.sh --skip-commit    # deploy only, no git

PROJECT="cupola"
R2_BUCKET="cupola-assets"
VERSION=$(node -e "console.log(require('./package.json').version)")

echo "==> Version: ${VERSION}"

# ---- Sentry: source map upload ----
# SENTRY_AUTH_TOKEN unlocks browser source map upload during `astro build`.
# Without it, the build still succeeds but stack traces in Sentry stay minified.
# Tokens come from .env (gitignored); load if present so callers don't need to
# `source` it manually.
if [ -z "${SENTRY_AUTH_TOKEN:-}" ] && [ -f ".env" ]; then
  set -a; . ./.env; set +a
fi
if [ -z "${SENTRY_AUTH_TOKEN:-}" ]; then
  echo "==> SENTRY_AUTH_TOKEN not set — skipping Sentry source map upload."
fi
export SENTRY_AUTH_TOKEN
export SENTRY_ORG="${SENTRY_ORG:-query-farm-llc}"
export SENTRY_PROJECT="${SENTRY_PROJECT:-cupola}"

# ---- Git: commit and push ----
if [ "${1:-}" != "--skip-commit" ]; then
  if [ -n "$(git status --porcelain)" ]; then
    echo "==> Staging changes..."
    git add -A
    git status --short

    MSG="${1:-}"
    if [ -z "$MSG" ]; then
      DEFAULT=$(git log -1 --pretty=%B | head -1)
      read -r -p "Commit message [${DEFAULT}]: " INPUT
      MSG="${INPUT:-$DEFAULT}"
    fi

    git commit -m "$MSG"
    echo "==> Pushing to origin..."
    git push
  else
    echo "==> Working tree clean, skipping commit."
  fi

  # Tag this version if not already tagged
  TAG="v${VERSION}"
  if ! git tag -l "$TAG" | grep -q "$TAG"; then
    echo "==> Tagging ${TAG}..."
    git tag "$TAG"
    git push origin "$TAG"
  fi
fi

# Capture the git hash AFTER any commit above so it matches the hash that
# astro.config.mjs computes at build time (`git rev-parse --short HEAD`). Both
# the browser source maps (uploaded by @sentry/astro during the build) and the
# worker maps (uploaded below) must land under the same release slug
# `cupola@${VERSION}+${GIT_HASH}`; capturing this before the commit put them
# under different releases.
GIT_HASH=$(git rev-parse --short HEAD)

# ---- Build ----
echo "==> Building..."
# 8 GiB of old-space heap. With source maps enabled, the perspective +
# duckdb-wasm chunks push past Node's 4 GiB default and crash with
# "Ineffective mark-compacts near heap limit".
# Tee the output so the source-map sanity check below can grep for the
# sentry-vite-plugin success line (set -o pipefail preserves the exit code).
BUILD_LOG=$(mktemp)
NODE_OPTIONS="--max-old-space-size=8192" bun run build 2>&1 | tee "$BUILD_LOG"

echo "==> dist/ size: $(du -sh dist/ | cut -f1)"

# ---- Source-map sanity check + strip ----
# With SENTRY_AUTH_TOKEN set, the @sentry/astro integration uploads the maps
# during `astro build` and its `sourcemaps.filesToDeleteAfterUpload` glob
# removes them afterwards, so zero remaining maps is the healthy state. If the
# token is set but the integration's hooks never saw any maps (e.g. the
# vite sourcemap setting regressed), Sentry would show minified stack traces —
# fail loudly here instead of finding out at the next production error.
MAP_COUNT=$(find dist/_astro -name "*.js.map" 2>/dev/null | wc -l | tr -d ' ')
JS_COUNT=$(find dist/_astro -name "*.js" 2>/dev/null | wc -l | tr -d ' ')
echo "==> Client maps post-build: ${MAP_COUNT} maps remain for ${JS_COUNT} JS files (0 means uploaded+deleted)"
if [ -n "${SENTRY_AUTH_TOKEN:-}" ] && [ "$JS_COUNT" -gt 0 ]; then
  if [ "$MAP_COUNT" -gt 0 ]; then
    echo "ERROR: SENTRY_AUTH_TOKEN is set but ${MAP_COUNT} .js.map files survived the build." >&2
    echo "       The Sentry integration's filesToDeleteAfterUpload glob did not run —" >&2
    echo "       check the sentry() option shape in astro.config.mjs (options must be" >&2
    echo "       top-level, NOT nested under sourceMapsUploadOptions)." >&2
    exit 1
  fi
  if ! grep -q "Successfully uploaded source maps to Sentry" "$BUILD_LOG"; then
    echo "ERROR: SENTRY_AUTH_TOKEN is set but the build log has no sentry-vite-plugin" >&2
    echo "       upload-success line. The build likely emitted no .js.map files —" >&2
    echo "       check vite.environments.client.build.sourcemap in astro.config.mjs." >&2
    echo "       Sentry would show minified stack traces if this shipped." >&2
    exit 1
  fi
fi
rm -f "$BUILD_LOG"
# Defense-in-depth for the no-token path (and any future option-shape drift —
# the old nested config silently shipped maps to R2 through v0.4.81): client
# maps must never reach R2. Haybarn worker maps under dist/haybarn/ are
# intentionally shipped (staged below) for the DuckDB worker bundles.
find dist/_astro -name "*.js.map" -delete 2>/dev/null || true

# ---- Upload versioned files to R2 (S3-compatible API via aws CLI) ----
#
# R2 exposes an S3-compatible API. `aws s3 sync` is dramatically faster than
# fanning out `wrangler r2 object put` (single connection-pooled process vs.
# one node cold-start per file) and avoids the rate-limit / auth-lockout
# storms wrangler bulk uploads triggered.
#
# Defaults — override via env if needed.
#   AWS_PROFILE=cupola references the R2 token in ~/.aws/credentials (local
#   runs). In CI, pass AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY directly —
#   defaulting AWS_PROFILE there would make the CLI demand a profile that
#   doesn't exist, so only set it when no explicit credentials are present.
#   CF_ACCOUNT_ID is the Cloudflare account ID; not secret.
if [ -z "${AWS_ACCESS_KEY_ID:-}" ]; then
  export AWS_PROFILE="${AWS_PROFILE:-cupola}"
fi
export CF_ACCOUNT_ID="${CF_ACCOUNT_ID:-bb68a133a66d26a310231495b13479a1}"
R2_PREFIX="v${VERSION}"
R2_ENDPOINT="https://${CF_ACCOUNT_ID}.r2.cloudflarestorage.com"

# AWS CLI guesses Content-Type from extension via mimetypes, but misses .wasm,
# .mjs, and .map. We pre-upload those types with explicit content-types, then
# let `sync` skip them (size-only match) on the broad pass.
upload_with_ct() {
  local pattern="$1" ct="$2" prefix="$3"
  aws s3 cp dist/ "s3://${R2_BUCKET}/${prefix}" \
    --endpoint-url "$R2_ENDPOINT" \
    --recursive --exclude "*" --include "$pattern" \
    --content-type "$ct" \
    --no-progress
}

# Astro's `base: /v${VERSION}/` versions URLs in HTML/JS but does NOT change
# the dist/ output directory layout. We add v${VERSION}/ during upload.

# 1) Haybarn-wasm artifacts at /haybarn/ — shared across versions. The
#    AsyncDuckDB sub-worker fetches duckdb-{coi,eh,mvp}.wasm + the worker.js
#    bundles from these URLs. Sourced from the installed npm package so the
#    versions match what the frontend was built against.
HAYBARN_SRC="node_modules/@haybarn/haybarn-wasm/dist"
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
  # Source maps may not ship for every worker variant — tolerate missing files
  # rather than failing the publish. The non-map worker files are required.
  if [ -e "${HAYBARN_SRC}/${f}" ]; then
    cp "${HAYBARN_SRC}/${f}" "dist/haybarn/${f}"
  elif [[ "$f" != *.map ]]; then
    echo "ERROR: required haybarn artifact missing: ${HAYBARN_SRC}/${f}" >&2
    exit 1
  fi
done

# Mirror the VGI extension (3 wasm variants) to our R2 so the shell stays
# bootable if haybarn-extensions.query.farm has an outage. The frontend sets
# `SET custom_extension_repository = '${origin}/haybarn/extensions'` before
# `INSTALL vgi FROM community;` so DuckDB fetches from our mirror.
HAYBARN_EXT_VERSION="v1.5.4"
mkdir -p "dist/haybarn/extensions/${HAYBARN_EXT_VERSION}"
for variant in wasm_mvp wasm_eh wasm_threads; do
  mkdir -p "dist/haybarn/extensions/${HAYBARN_EXT_VERSION}/${variant}"
  echo "==> Fetching vgi extension for ${variant}..."
  curl -fsSL \
    -o "dist/haybarn/extensions/${HAYBARN_EXT_VERSION}/${variant}/vgi.duckdb_extension.wasm" \
    "https://haybarn-extensions.query.farm/community/${HAYBARN_EXT_VERSION}/${variant}/vgi.duckdb_extension.wasm"
done

# The dist/haybarn/ directory is staged above and picked up by the versioned
# sync below — the worker fetches `${BASE_URL}haybarn/...` which resolves to
# the per-version R2 prefix, so no separate shared-path upload is needed.

# 2) Versioned files: explicit content-type pre-passes for types the AWS CLI
#    misidentifies, then a broad sync for everything else. The haybarn
#    artifacts staged in dist/haybarn above ride along with this sync so a
#    pinned URL serves a consistent set.
echo "==> Syncing dist/ to R2 under ${R2_PREFIX}/..."
upload_with_ct "*.wasm"  "application/wasm"                     "${R2_PREFIX}/"
upload_with_ct "*.mjs"   "application/javascript; charset=utf-8" "${R2_PREFIX}/"
upload_with_ct "*.map"   "application/json"                     "${R2_PREFIX}/"
aws s3 sync dist/ "s3://${R2_BUCKET}/${R2_PREFIX}/" \
  --endpoint-url "$R2_ENDPOINT" \
  --size-only --no-progress
echo "==> Synced files to R2 prefix ${R2_PREFIX}/"

# Write _latest marker. Read on every request by the Worker — must reflect the
# new version immediately. `aws s3 cp -` streams stdin so no temp file needed.
echo -n "${VERSION}" | aws s3 cp - "s3://${R2_BUCKET}/_latest" \
  --endpoint-url "$R2_ENDPOINT" \
  --content-type "text/plain" --no-progress
echo "==> Updated _latest marker to ${VERSION}"

# ---- Deploy Worker (R2 binding routes all content) ----
# All static content lives in R2; the Worker (worker/index.ts) handles
# version-aware routing, redirects, and edge-cache writes. Wrangler reads
# the bindings + entrypoint from wrangler.jsonc.
echo "==> Deploying Worker..."
# --define injects build-time constants used by Sentry release tagging in the
# worker (worker/index.ts reads __APP_VERSION__ / __GIT_HASH__ via typeof so
# unreplaced symbols stay safe under `wrangler dev`).
# --outdir lets us hand the bundled worker + source map to sentry-cli after
# deploy. --upload-source-maps also pushes the map to Cloudflare so their
# dashboard symbolicates errors.
WORKER_OUTDIR=".worker-build"
rm -rf "$WORKER_OUTDIR"
npx wrangler deploy \
  --outdir "$WORKER_OUTDIR" \
  --upload-source-maps \
  --define "__APP_VERSION__:\"${VERSION}\"" \
  --define "__GIT_HASH__:\"${GIT_HASH}\""

# ---- Sentry: upload worker source maps under the same release as the browser ----
# Browser maps are uploaded by @sentry/astro during `bun run build` above; this
# block handles the worker side. The release slug must match exactly what the
# worker's withSentry() reports at runtime (cupola@VERSION+HASH).
RELEASE="cupola@${VERSION}+${GIT_HASH}"
if [ -n "${SENTRY_AUTH_TOKEN:-}" ]; then
  echo "==> Uploading worker source maps to Sentry (release ${RELEASE})..."
  npx @sentry/cli sourcemaps upload \
    --org "$SENTRY_ORG" \
    --project "$SENTRY_PROJECT" \
    --release "$RELEASE" \
    --dist "$GIT_HASH" \
    "$WORKER_OUTDIR"
else
  echo "==> SENTRY_AUTH_TOKEN not set — skipping worker source map upload."
fi

echo ""
echo "==> Published v${VERSION}"
echo "    latest:  https://cupola.query-farm.services/latest/"
echo "    pinned:  https://cupola.query-farm.services/v${VERSION}/"
