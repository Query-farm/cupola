#!/usr/bin/env bash
set -euo pipefail

# Publish: commit, push, build, and deploy to Cloudflare Pages
# Deploys both a versioned branch (pinnable) and production (latest).
#
# Usage:
#   ./publish.sh                  # prompt for commit message
#   ./publish.sh "fix: whatever"  # use provided message
#   ./publish.sh --skip-commit    # deploy only, no git
#
# Versioned URLs (from package.json version):
#   latest:  https://cupola.query-farm.services
#   pinned:  https://v0-1-0.cupola.pages.dev

PROJECT="cupola"
R2_BUCKET="cupola-assets"
VERSION=$(node -e "console.log(require('./package.json').version)")
# Cloudflare branch names use hyphens, not dots
BRANCH="v${VERSION//./-}"

echo "==> Version: ${VERSION} (branch: ${BRANCH})"

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

if [ ! -f dist/shell/wasm/duckdb-eh.wasm ]; then
  echo "ERROR: dist/shell/wasm/duckdb-eh.wasm not found."
  echo "Make sure public/shell/wasm/ symlinks point to actual WASM files."
  exit 1
fi

echo "==> dist/ size: $(du -sh dist/ | cut -f1)"

# ---- Offload oversized files (>25MB) to R2 ----
OVERSIZED=$(find dist/ -type f -size +25M 2>/dev/null || true)

if [ -n "$OVERSIZED" ]; then
  npx wrangler r2 bucket create "$R2_BUCKET" 2>/dev/null || true

  for f in $OVERSIZED; do
    KEY="${f#dist/}"
    SIZE_MB=$(echo "scale=1; $(wc -c < "$f" | tr -d ' ') / 1048576" | bc)
    echo "  ${KEY} (${SIZE_MB}MB) -> R2"

    CT="application/octet-stream"
    [[ "$f" == *.wasm ]] && CT="application/wasm"
    [[ "$f" == *.js ]] && CT="application/javascript"

    npx wrangler r2 object put "${R2_BUCKET}/${KEY}" --file "$f" --content-type "$CT" --remote
    rm "$f"
  done
fi

echo "==> dist/ size for Pages: $(du -sh dist/ | cut -f1)"

# ---- Deploy versioned branch ----
echo "==> Deploying versioned branch '${BRANCH}'..."
npx wrangler pages deploy dist/ --project-name "$PROJECT" --branch "$BRANCH" --commit-dirty=true

# ---- Deploy production (latest) ----
echo "==> Deploying production (latest)..."
npx wrangler pages deploy dist/ --project-name "$PROJECT" --commit-dirty=true

echo ""
echo "==> Published v${VERSION}"
echo "    latest:  https://cupola.query-farm.services"
echo "    pinned:  https://${BRANCH}.cupola.pages.dev"
