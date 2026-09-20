import { readdir, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const assetDir = fileURLToPath(new URL("../dist/_astro/", import.meta.url));
const maxChunkBytes = 1_500_000;
// Measured production payload: 4,773,015 bytes; retain only a small margin.
//
// This jumped ~253 kB at 0.4.160, moving to vgi@0.34 / vgi-rpc@0.25, and the
// jump is structural rather than something Cupola imports. 160 kB of it is a
// chunk that did not exist before, the vgi-rpc package ROOT: `vgi/client`
// imports it (it always did), but the root's graph used to tree-shake away.
// It no longer can, because reflection became an ordinary co-hosted protocol —
// the client's `introspect.js` imports `reflection.js`, which imports
// `binding.js` and `protocol.js`, the same machinery the server side uses. So
// a browser now ships framework code it never calls, including `RpcServer`.
//
// Dead weight, not a correctness problem, and not fixable from this side:
// `vgi/client` would have to import the client submodules rather than the
// package root. Worth pushing upstream rather than absorbing again.
const maxTotalBytes = 4_790_000;

const files = (await readdir(assetDir)).filter((name) => name.endsWith(".js"));
if (files.length === 0) throw new Error("No JavaScript bundles found; run the production build first");

const sizes = await Promise.all(files.map(async (name) => ({
  name,
  bytes: (await stat(join(assetDir, name))).size,
})));
const totalBytes = sizes.reduce((sum, file) => sum + file.bytes, 0);
const largest = sizes.toSorted((a, b) => b.bytes - a.bytes)[0];

console.log(`Bundle budget: ${files.length} chunks, ${(totalBytes / 1_000_000).toFixed(2)} MB total; largest ${largest.name} at ${(largest.bytes / 1_000_000).toFixed(2)} MB`);

const failures = [];
if (largest.bytes > maxChunkBytes) failures.push(`largest chunk exceeds ${(maxChunkBytes / 1_000_000).toFixed(2)} MB`);
if (totalBytes > maxTotalBytes) failures.push(`total JavaScript exceeds ${(maxTotalBytes / 1_000_000).toFixed(2)} MB`);
if (failures.length) throw new Error(`Bundle budget exceeded: ${failures.join("; ")}`);
