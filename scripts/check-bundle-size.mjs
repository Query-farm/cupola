import { readdir, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const assetDir = fileURLToPath(new URL("../dist/_astro/", import.meta.url));
const maxChunkBytes = 1_500_000;
const maxTotalBytes = 4_500_000;

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
