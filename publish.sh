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
OVERSIZED=$(find dist/ -type f -size +25M 2>/dev/null || true)
if [ -n "$OVERSIZED" ]; then
  echo "==> Uploading shared large assets to R2 root..."
  printf '%s\n' "$OVERSIZED" | xargs -n 1 -P 8 -I{} bash -c 'upload_one "$1" ""' _ {}
fi

# Upload all normal-sized files to R2 under the version prefix. Parallelize
# with xargs -P 16 so wrangler cold-start cost is amortized across workers.
echo "==> Uploading dist/ to R2 under ${R2_PREFIX}/..."
find dist/ -type f -not -size +25M -print0 | \
  xargs -0 -n 1 -P 16 -I{} bash -c 'upload_one "$1" "'"${R2_PREFIX}/"'"' _ {}
echo "==> Uploaded files to R2 prefix ${R2_PREFIX}/"

# Write _latest marker (temp file approach for portability)
LATEST_TMP=$(mktemp)
echo -n "${VERSION}" > "$LATEST_TMP"
npx wrangler r2 object put "${R2_BUCKET}/_latest" --file "$LATEST_TMP" --content-type "text/plain" --remote 2>/dev/null
rm -f "$LATEST_TMP"
echo "==> Updated _latest marker to ${VERSION}"

# ---- Deploy Pages (function only — all content served from R2) ----
# We deploy an almost-empty directory so the Pages Function handles all routes.
# Static files in dist/ would bypass the function, which we don't want.
PAGES_DIR=$(mktemp -d)
# Keep an empty _headers just so the deployment isn't truly empty
touch "${PAGES_DIR}/.nojekyll"

echo "==> Deploying Pages (function + R2 binding)..."
npx wrangler pages deploy "${PAGES_DIR}" --project-name "$PROJECT" --commit-dirty=true
rm -rf "${PAGES_DIR}"

echo ""
echo "==> Published v${VERSION}"
echo "    latest:  https://cupola.query-farm.services/latest/"
echo "    pinned:  https://cupola.query-farm.services/v${VERSION}/"
