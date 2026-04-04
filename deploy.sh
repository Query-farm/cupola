#!/usr/bin/env bash
set -euo pipefail

PROJECT="cupola"
R2_BUCKET="cupola-assets"
MAX_SIZE=$((25 * 1024 * 1024))  # 25MB in bytes (Cloudflare Pages limit)

echo "==> Building..."
bun run build

# Verify WASM assets were resolved (symlinks dereferenced by Astro)
if [ ! -f dist/shell/wasm/duckdb-eh.wasm ]; then
  echo "ERROR: dist/shell/wasm/duckdb-eh.wasm not found."
  echo "Make sure public/shell/wasm/ symlinks point to actual WASM files."
  exit 1
fi

echo "==> dist/ size: $(du -sh dist/ | cut -f1)"

# ---- Offload oversized files to R2 ----
echo "==> Checking for files exceeding 25MB Cloudflare Pages limit..."
OVERSIZED=$(find dist/ -type f -size +25M 2>/dev/null || true)

if [ -n "$OVERSIZED" ]; then
  # Create R2 bucket if needed (ignore error if exists)
  npx wrangler r2 bucket create "$R2_BUCKET" 2>/dev/null || true

  for f in $OVERSIZED; do
    KEY="${f#dist/}"
    SIZE=$(wc -c < "$f" | tr -d ' ')
    SIZE_MB=$(echo "scale=1; $SIZE / 1048576" | bc)
    echo "  ${KEY} (${SIZE_MB}MB) -> R2"

    # Determine content type
    CT="application/octet-stream"
    [[ "$f" == *.wasm ]] && CT="application/wasm"
    [[ "$f" == *.js ]] && CT="application/javascript"

    npx wrangler r2 object put "${R2_BUCKET}/${KEY}" --file "$f" --content-type "$CT" --remote
    rm "$f"
  done

  echo ""
  echo "  Oversized files uploaded to R2 bucket '${R2_BUCKET}'."
  echo "  The _redirects file proxies these paths to the R2 custom domain."
  echo ""
  echo "  If not already done, enable public access on the R2 bucket:"
  echo "    R2 > ${R2_BUCKET} > Settings > Public Access > Custom Domain"
  echo "    Add: assets.cupola.query-farm.services"
fi

echo "==> dist/ size for Pages deploy: $(du -sh dist/ | cut -f1)"

# ---- Deploy to Cloudflare Pages ----
echo "==> Deploying to Cloudflare Pages..."
npx wrangler pages deploy dist/ --project-name "$PROJECT" --commit-dirty=true

echo ""
echo "==> Deployed!"
echo "    Custom domain: Pages > ${PROJECT} > Custom Domains > cupola.query-farm.services"
