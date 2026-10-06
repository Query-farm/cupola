#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
if [ -f .env ]; then
  set -a
  source .env
  set +a
fi
source ./scripts/publish-credentials.sh
configure_publish_credentials
exec python3 scripts/releases.py "$@"
