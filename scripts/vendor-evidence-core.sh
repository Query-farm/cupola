#!/usr/bin/env bash
# Packs Evidence's core/ at an upstream commit into vendor/evidence-core-<sha>.tgz.
#
#   scripts/vendor-evidence-core.sh <evidence-checkout> [commit]   # commit defaults to HEAD
#
# Source is unchanged. Tests and fixtures (*.test.*, *.spec.*, *.fixture.*) are
# dropped, package.json loses its devDependencies, gains "license": "MIT" and a
# 0.0.1-cupola.<sha> version, and the upstream LICENSE is added. Afterwards, point
# package.json at the new archive, update vendor/README.md and run `bun install`.
set -euo pipefail

checkout=${1:?usage: $0 <evidence-checkout> [commit]}
commit=$(git -C "$checkout" rev-parse --verify "${2:-HEAD}^{commit}")
short=${commit:0:7}
out="$(cd "$(dirname "$0")/.." && pwd)/vendor/evidence-core-$short.tgz"

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

git -C "$checkout" archive "$commit" core | tar -x -C "$work"
rsync -a --exclude='*.test.*' --exclude='*.spec.*' --exclude='*.fixture.*' --prune-empty-dirs \
  "$work/core/" "$work/package/"
git -C "$checkout" show "$commit:LICENSE" > "$work/package/LICENSE"

VERSION="0.0.1-cupola.$short" bun -e '
  const file = process.argv[1];
  const pkg = await Bun.file(file).json();
  delete pkg.devDependencies;
  pkg.version = process.env.VERSION;
  pkg.license = "MIT";
  await Bun.write(file, JSON.stringify(pkg, null, 2) + "\n");
' "$work/package/package.json"

# Byte-reproducible: sorted entries, the commit's time on every file, no owner or
# extended attributes, and no timestamp in the gzip header.
stamp=$(TZ=UTC git -C "$checkout" log -1 --format=%cd --date=format-local:%Y%m%d%H%M.%S "$commit")
find "$work/package" -exec env TZ=UTC touch -h -t "$stamp" {} +
(cd "$work" && find package | LC_ALL=C sort) > "$work/files"
if tar --version 2>/dev/null | grep -q 'GNU tar'; then
  tar -cf - -C "$work" --no-recursion --owner=0 --group=0 --numeric-owner -T "$work/files"
else
  tar -cf - -C "$work" -n --uid 0 --gid 0 --uname '' --gname '' --no-xattrs --no-mac-metadata -T "$work/files"
fi | gzip -9 -n > "$out"
echo "$out"
