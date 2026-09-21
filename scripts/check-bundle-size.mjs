import { readdir, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const assetDir = fileURLToPath(new URL("../dist/_astro/", import.meta.url));
// Loose on purpose since 0.4.163: these catch runaway growth (a dependency
// pulled in whole, a duplicated library), not the steady cost of features.
// 0.4.163 measured 4,797,825 bytes total, largest chunk CatalogApp at
// 1,499,886; its report work (+19 kB, mostly block-setting help text) sits
// in the lazily loaded ReportsWorkspace chunk.
const maxChunkBytes = 1_600_000;
// Measured production payload at 0.4.160: 4,772,574 bytes.
//
// This jumped ~253 kB at 0.4.160, moving to vgi@0.34 / vgi-rpc@0.25, and the
// jump is structural rather than something Cupola imports. 160 kB of it is one
// chunk, the vgi-rpc package ROOT, which re-exports the whole framework —
// protocol, dispatch, access log, `RpcServer`. It appeared because reflection
// became an ordinary co-hosted protocol: the client's `introspect.js` imports
// `reflection.js`, which imports the same `binding`/`protocol` machinery the
// server uses, so the root's graph stopped tree-shaking away.
//
// **That chunk is lazy, and this budget counts it anyway.** `VgiClient.fromIroh`
// does `await import("@query-farm/vgi-rpc")` to pick a native iroh:// connector,
// so Rollup code-splits it and nothing fetches it unless that method is called
// without a connector — which Cupola never does. This number is every emitted
// byte, not the startup download, and the two differ by this chunk.
//
// vgi@0.35 removed the *static* import of the root (`RpcError` now comes from
// the `/connect` subpath). That is the right shape and helps consumers whose
// bundler does not split the same way, but it moved ~400 bytes here, not 160 kB:
// the dynamic import alone was already enough to create the chunk.
const maxTotalBytes = 5_000_000;

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
