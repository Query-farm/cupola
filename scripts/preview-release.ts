/** Local preview of production Worker routing against an already-built dist/. */
import { resolve, sep } from "node:path";
import { handler } from "../worker/index";
import pkg from "../package.json";
const root = resolve("dist");
Object.defineProperty(globalThis, "caches", { value: { default: {
  match: async () => undefined, put: async () => {}, delete: async () => true,
} } });
const bucket = { get: async (key: string) => {
  if (key === "_latest") return { body: new Response(pkg.version).body!, text: async () => pkg.version };
  if (!key.startsWith(`v${pkg.version}/`)) return null;
  const path = resolve(root, key.slice(`v${pkg.version}/`.length));
  if (!path.startsWith(root + sep)) return null;
  const file = Bun.file(path);
  if (!await file.exists() || file.type === "inode/directory") return null;
  return { body: file.stream(), text: () => file.text() };
} };
Bun.serve({ port: 4333, fetch: request => handler.fetch(request, { ASSETS_BUCKET: bucket }, {
  waitUntil: () => {}, passThroughOnException: () => {},
}) });
console.log("Release preview listening on http://localhost:4333");
