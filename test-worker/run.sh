#!/bin/bash
# Serve the cupola_test catalog over HTTP, no auth, for local development and
# the Playwright suite.
#
#   ./run.sh                 # :9009 — the suite's default VGI_SERVICE_URL
#   PORT=9010 ./run.sh       # another port (then set VGI_SERVICE_URL to match)
#   HTTP_THREADS=16 ./run.sh # larger request pool (default 8)
#   ./run.sh --latest        # newest vgi-python; pair with ?vgi_version=latest
set -e
cd "$(dirname "$0")"

PORT="${PORT:-9009}"
# waitress defaults to 4 request threads, and a VGI request holds its thread for
# the whole scan rather than the milliseconds a web request takes — so the fifth
# concurrent client queues behind a scan instead of overlapping with it. One
# browser is one such client. Raising this is NOT a way to absorb more parallel
# browsers: the worker is one GIL-bound process, and at 32 threads a 10-worker
# suite run was no better than at 4. Size it to the browsers you point at it.
HTTP_THREADS="${HTTP_THREADS:-8}"
export VGI_SIGNING_KEY=dev
export VGI_HTTP_PREFIX=
export VGI_HTTP_CORS_ORIGINS="*"

if [ "$1" = "--latest" ]; then
  shift
  # stress_worker.py's inline metadata pins the releases that speak the wire
  # protocol of Cupola's pinned VGI extension. Running it through `python`
  # rather than as the uv script target skips that metadata, so this resolves
  # the newest worker — which only a newer extension build can talk to.
  exec uv run --no-project --python 3.13 --with "vgi-python[http]" --with numpy --with pyarrow \
    python stress_worker.py --http --host 127.0.0.1 --port "$PORT" --http-threads "$HTTP_THREADS" "$@"
fi

exec uv run --python 3.13 stress_worker.py --http --host 127.0.0.1 --port "$PORT" --http-threads "$HTTP_THREADS" "$@"
