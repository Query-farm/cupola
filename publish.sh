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
GIT_HASH=$(git rev-parse --short HEAD)

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

# ---- Build ----
# Note: `bun run build` first runs `build:worker-sentry`, which produces
# public/shell/sentry-bootstrap.js (importScripts'd by the classic shell
# worker). astro build then copies it to dist/.
echo "==> Building..."
bun run build

echo "==> dist/ size: $(du -sh dist/ | cut -f1)"

# ---- Upload versioned files to R2 (S3-compatible API via aws CLI) ----
#
# R2 exposes an S3-compatible API. `aws s3 sync` is dramatically faster than
# fanning out `wrangler r2 object put` (single connection-pooled process vs.
# one node cold-start per file) and avoids the rate-limit / auth-lockout
# storms wrangler bulk uploads triggered.
#
# Defaults — override via env if needed.
#   AWS_PROFILE=cupola references the R2 token in ~/.aws/credentials.
#   CF_ACCOUNT_ID is the Cloudflare account ID; not secret.
export AWS_PROFILE="${AWS_PROFILE:-cupola}"
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

# 1) Oversized shared assets (>25MB WASMs) at the root — shared across versions.
echo "==> Syncing oversized shared assets to R2 root..."
aws s3 sync dist/shell/wasm/ "s3://${R2_BUCKET}/shell/wasm/" \
  --endpoint-url "$R2_ENDPOINT" \
  --content-type "application/wasm" \
  --size-only --no-progress
if [ -d "dist/shell/extensions" ]; then
  aws s3 sync dist/shell/extensions/ "s3://${R2_BUCKET}/shell/extensions/" \
    --endpoint-url "$R2_ENDPOINT" \
    --content-type "application/wasm" \
    --size-only --no-progress
fi

# 2) Versioned files: explicit content-type pre-passes for types the AWS CLI
#    misidentifies, then a broad sync for everything else.
echo "==> Syncing dist/ to R2 under ${R2_PREFIX}/..."
upload_with_ct "*.wasm"  "application/wasm"                     "${R2_PREFIX}/"
upload_with_ct "*.mjs"   "application/javascript; charset=utf-8" "${R2_PREFIX}/"
upload_with_ct "*.map"   "application/json"                     "${R2_PREFIX}/"
aws s3 sync dist/ "s3://${R2_BUCKET}/${R2_PREFIX}/" \
  --endpoint-url "$R2_ENDPOINT" \
  --exclude "shell/wasm/*" \
  --exclude "shell/extensions/*" \
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
