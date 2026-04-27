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
echo "==> Building..."
bun run build

echo "==> dist/ size: $(du -sh dist/ | cut -f1)"

# ---- Upload versioned files to R2 ----
R2_PREFIX="v${VERSION}"

content_type() {
  local f="$1"
  case "${f##*.}" in
    html)  echo "text/html; charset=utf-8" ;;
    css)   echo "text/css; charset=utf-8" ;;
    js)    echo "application/javascript; charset=utf-8" ;;
    mjs)   echo "application/javascript; charset=utf-8" ;;
    json)  echo "application/json; charset=utf-8" ;;
    svg)   echo "image/svg+xml" ;;
    png)   echo "image/png" ;;
    jpg|jpeg) echo "image/jpeg" ;;
    gif)   echo "image/gif" ;;
    ico)   echo "image/x-icon" ;;
    wasm)  echo "application/wasm" ;;
    woff)  echo "font/woff" ;;
    woff2) echo "font/woff2" ;;
    ttf)   echo "font/ttf" ;;
    map)   echo "application/json" ;;
    txt)   echo "text/plain; charset=utf-8" ;;
    xml)   echo "application/xml" ;;
    *)     echo "application/octet-stream" ;;
  esac
}

# Per-file wrangler upload worker — invoked in parallel by xargs -P.
# Each call still spawns an `npx wrangler` (~2-3s cold start), but running
# 16 at a time drops ~64 files × 3s = 3 min → ~12-15s wall time.
upload_one() {
  local f="$1"
  local key_prefix="$2"   # "" for root keys, "v0.3.10/" for versioned
  local key="${key_prefix}${f#dist/}"
  local ct
  ct=$(content_type "$f")
  npx wrangler r2 object put "${R2_BUCKET}/${key}" \
    --file "$f" --content-type "$ct" --remote 2>/dev/null
}
export -f content_type upload_one
export R2_BUCKET

# Astro's `base: /v${VERSION}/` versions the URLs emitted in HTML/JS but does
# NOT change the dist/ output directory layout — files still live at dist/_astro,
# dist/shell, etc. We add the v${VERSION}/ prefix during upload.

# Upload oversized files (>25MB) to root-level R2 keys (shared across versions).
# These are typically WASM files that rarely change between versions.
#
# We use GNU parallel with `--delay` to space job *starts* (not duration) so
# bursts don't trip Cloudflare's R2 API rate limits (HTTP 429). xargs has no
# equivalent throttle and previously caused 429 storms when several uploads
# kicked off in the same instant.
OVERSIZED=$(find dist/ -type f -size +25M 2>/dev/null || true)
if [ -n "$OVERSIZED" ]; then
  echo "==> Uploading shared large assets to R2 root..."
  printf '%s\n' "$OVERSIZED" | parallel --will-cite -j 4 --delay 0.25 \
    bash -c 'upload_one "$1" ""' _ {}
fi

# Upload all normal-sized files to R2 under the version prefix. Concurrency
# capped at 8 with a 0.1s start-delay between jobs to stay under Cloudflare's
# rate limits. Wrangler cold-start (~2-3s) is still amortized across workers.
echo "==> Uploading dist/ to R2 under ${R2_PREFIX}/..."
find dist/ -type f -not -size +25M -print0 | \
  parallel --will-cite -0 -j 8 --delay 0.1 --halt soon,fail=1 \
    bash -c 'upload_one "$1" "'"${R2_PREFIX}/"'"' _ {}
echo "==> Uploaded files to R2 prefix ${R2_PREFIX}/"

# Write _latest marker (temp file approach for portability)
LATEST_TMP=$(mktemp)
echo -n "${VERSION}" > "$LATEST_TMP"
npx wrangler r2 object put "${R2_BUCKET}/_latest" --file "$LATEST_TMP" --content-type "text/plain" --remote 2>/dev/null
rm -f "$LATEST_TMP"
echo "==> Updated _latest marker to ${VERSION}"

# ---- Deploy Worker (R2 binding routes all content) ----
# All static content lives in R2; the Worker (worker/index.ts) handles
# version-aware routing, redirects, and edge-cache writes. Wrangler reads
# the bindings + entrypoint from wrangler.jsonc.
echo "==> Deploying Worker..."
npx wrangler deploy

echo ""
echo "==> Published v${VERSION}"
echo "    latest:  https://cupola.query-farm.services/latest/"
echo "    pinned:  https://cupola.query-farm.services/v${VERSION}/"
