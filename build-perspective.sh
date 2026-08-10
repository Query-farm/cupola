#!/usr/bin/env bash
#
# Rebuild the vendored Perspective artifacts in public/perspective/.
#
# Cupola does not consume @perspective-dev/* from npm. It loads a locally built
# Perspective that carries our DuckDB Arrow type-coercion patches (hugeint,
# uuid, timetz, interval, bignum, bit, dictionary key widths, Int64
# preservation) plus the view_collapse/view_expand handler methods that
# ViewTraversal in src/lib/perspective-duckdb-handler.ts depends on. None of
# that exists upstream, so the artifacts must be built from the fork.
#
# Usage:  ./build-perspective.sh [--stage-only] [path-to-perspective-checkout]
#
#   --stage-only   Skip the build and just re-copy the existing dist/ output.
#                  Useful when iterating on the staging layout.
#
# The fork lives on branch `duckdb-type-support-v5`, rebased onto upstream
# v5.1.0. To move to a newer upstream, rebase that branch and re-run this.
#
set -euo pipefail

STAGE_ONLY=0
if [ "${1:-}" = "--stage-only" ]; then
    STAGE_ONLY=1
    shift
fi

PSP_SRC="${1:-$HOME/Development/perspective}"
DEST="$(cd "$(dirname "$0")" && pwd)/public/perspective"

if [ ! -d "$PSP_SRC/rust/perspective-js" ]; then
    echo "error: '$PSP_SRC' is not a perspective checkout" >&2
    exit 1
fi

# --- Prerequisites -----------------------------------------------------------
#
# Two of these fail with errors that point somewhere else entirely, which is why
# they are spelled out rather than left to discovery:
#
#  * PROTOC — rust/perspective-client/src/rust/proto.rs is GITIGNORED and
#    generated. A checkout carries whatever proto.rs the last build left behind,
#    so after an upstream bump it is stale and you get ~56 "struct X has no
#    field named Y" errors in files you never touched. The `generate-proto`
#    feature regenerates it and needs protoc.
#
#  * PACKAGE must include `metadata`. It runs `cargo run` with
#    TS_RS_IMPORT_EXTENSION=js to emit the ts-rs bindings into
#    rust/perspective-js/src/ts/ts-rs/. The wasm-generated .d.ts re-exports
#    Features from there. Omit it and the Rust builds fine, then tsc fails with
#    "Cannot find module '.../ts-rs/ColumnType.d.ts'" and "has no exported
#    member 'Features'" — neither of which mentions the real cause.
#
echo "==> Perspective source: $PSP_SRC"
echo "    branch: $(git -C "$PSP_SRC" rev-parse --abbrev-ref HEAD)"
echo "    head:   $(git -C "$PSP_SRC" rev-parse --short HEAD)"

if [ "$STAGE_ONLY" -eq 0 ]; then
    if ! command -v protoc >/dev/null 2>&1; then
        echo "error: protoc not found (brew install protobuf)" >&2
        exit 1
    fi
    export PROTOC="$(command -v protoc)"

    # `metadata` must come first — the client build depends on its output.
    export PACKAGE="metadata,server,client,viewer,viewer-datagrid,viewer-charts"

    echo "==> Building"
    (
        cd "$PSP_SRC"
        pnpm install --frozen-lockfile
        # Regenerate proto.rs against the current .proto before the main build.
        cargo check -p perspective-client --lib --features generate-proto
        node tools/scripts/build.mjs
    )
else
    echo "==> Skipping build (--stage-only)"
fi

# --- Stage -------------------------------------------------------------------
#
# public/perspective is entirely generated, so it is rebuilt from scratch. A
# merge-in-place would leave stale wasm-bindgen snippet directories behind:
# their names are content hashes, so an upstream bump produces *new* directories
# rather than overwriting the old ones, and the viewer would keep loading
# whichever stale copy still matched an old hash.
# The layout below MIRRORS THE NPM PACKAGE LAYOUT (<pkg>/dist/cdn +
# <pkg>/dist/wasm) and must not be flattened. Every loader derives its sibling
# assets from its own import.meta.url, and v5 tightened how:
#
#   perspective.js      rewrites `.../client/dist/cdn/<f>` -> `.../server/dist/wasm/<f>`
#                       to find the server wasm, falling back to `../../../server/...`.
#                       Flat, that fallback climbs past public/perspective and
#                       requests /server/dist/wasm/... at the ORIGIN ROOT.
#   perspective-viewer.js  fetches `../wasm/perspective-viewer.wasm`, so it needs
#                       a cdn/ with a sibling wasm/. Flat, it 404s and surfaces as
#                       "WebAssembly.compile(): BufferSource argument is empty".
#
# Both failures point at the wrong thing, so keep the real layout.
echo "==> Staging into $DEST"
rm -rf "$DEST"
mkdir -p "$DEST"/{client/dist/cdn,client/dist/wasm,server/dist/wasm,viewer/dist/cdn,viewer-datagrid/dist/cdn,viewer-charts/dist/cdn}

# @perspective-dev/client
cp "$PSP_SRC/rust/perspective-js/dist/cdn/perspective.js"                 "$DEST/client/dist/cdn/"
cp "$PSP_SRC/rust/perspective-js/dist/cdn/perspective-server.worker.js"   "$DEST/client/dist/cdn/"
cp "$PSP_SRC/rust/perspective-js/dist/wasm/perspective-js.wasm"           "$DEST/client/dist/wasm/"

# @perspective-dev/server — reached via the cdn->wasm rewrite above.
cp "$PSP_SRC/rust/perspective-server/dist/wasm/perspective-server.wasm"   "$DEST/server/dist/wasm/"

# @perspective-dev/viewer — cdn/ + wasm/ (incl. wasm-bindgen snippets).
cp "$PSP_SRC/rust/perspective-viewer/dist/cdn/perspective-viewer.js"      "$DEST/viewer/dist/cdn/"
cp -R "$PSP_SRC/rust/perspective-viewer/dist/wasm"                        "$DEST/viewer/dist/wasm"

# Plugins. viewer-charts REPLACES viewer-d3fc, which along with
# viewer-openlayers and workspace was deleted upstream in v5.x — those packages
# no longer exist, so loading perspective-viewer-d3fc.js 404s and rejects
# ensurePerspectiveLoaded(), taking out both Perspective code paths.
cp "$PSP_SRC/packages/viewer-datagrid/dist/cdn/perspective-viewer-datagrid.js" "$DEST/viewer-datagrid/dist/cdn/"
cp "$PSP_SRC/packages/viewer-charts/dist/cdn/perspective-viewer-charts.js"     "$DEST/viewer-charts/dist/cdn/"

# Themes. src/components/DuckDBShell.tsx loads exactly these two.
cp "$PSP_SRC/rust/perspective-viewer/dist/css/themes.css"                 "$DEST/"
cp "$PSP_SRC/rust/perspective-viewer/dist/css/pro.css"                    "$DEST/"

find "$DEST" -name '*.d.ts' -delete

# Source maps are large and never referenced by the app; publish.sh strips
# client maps before the R2 sync anyway.
find "$DEST" -name '*.map' -delete

echo "==> Done. $(find "$DEST" -type f | wc -l | tr -d ' ') files, $(du -sh "$DEST" | cut -f1)"
find "$DEST" -type f -name '*.js' -o -type f -name '*.wasm' -o -type f -name '*.css' | sort | sed "s|$DEST|  public/perspective|"
