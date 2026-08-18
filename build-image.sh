#!/usr/bin/env bash
#
# Build the flat single-version Cupola Docker image (Docker / Azure Container
# Apps). Run on a machine that has the vgi-rpc-typescript sibling linked,
# same as a normal Cloudflare publish.
#
#   ./build-image.sh                 # -> image tagged cupola:flat
#   ./build-image.sh myregistry/cupola:1.2.3
#
# This emits a flat bundle (BASE_PATH=/), stages the shared Haybarn assets, and
# bakes it into a Caddy image instead of syncing to R2.
set -euo pipefail
cd "$(dirname "$0")"

IMAGE_TAG="${1:-cupola:flat}"

echo "==> Building flat bundle (BASE_PATH=/)..."
BASE_PATH=/ bun run build

./scripts/stage-haybarn-assets.sh

echo "==> docker build -t ${IMAGE_TAG} ..."
docker build -t "${IMAGE_TAG}" .

echo "==> Done. Run with: docker run -p 8080:80 ${IMAGE_TAG}"
