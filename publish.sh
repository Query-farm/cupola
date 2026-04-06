#!/usr/bin/env bash
set -euo pipefail

# Publish: commit, push, build, and deploy to Cloudflare Pages
PROJECT="cupola"
R2_BUCKET="cupola-assets"

# ---- Git: commit and push ----
if [ -n "$(git status --porcelain)" ]; then
  echo "==> Staging changes..."
  git add -A
  git status --short

  MSG="${1:-$(git log -1 --pretty=%B | head -1)}"
  read -r -p "Commit message [${MSG}]: " INPUT
  MSG="${INPUT:-$MSG}"

  git commit -m "$MSG"
  echo "==> Pushing to origin..."
  git push
else
  echo "==> Working tree clean, skipping commit."
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

# ---- Deploy to Cloudflare Pages ----
echo "==> Deploying to Cloudflare Pages..."
npx wrangler pages deploy dist/ --project-name "$PROJECT" --commit-dirty=true

echo ""
echo "==> Published to https://cupola.query-farm.services"
