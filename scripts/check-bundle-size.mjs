import { readdir, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const assetDir = fileURLToPath(new URL("../dist/_astro/", import.meta.url));
// Evidence adds a lazily loaded reporting renderer and component library.
// v0.4.170 baseline: ~10.97 MB across all emitted JS, largest chunk ~4.39 MB.
// This includes optional reports and is not the initial page download.
// Keep a regression guard with headroom for the approved reporting feature.
const maxChunkBytes = 5_000_000;
const maxTotalBytes = 12_000_000;

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
