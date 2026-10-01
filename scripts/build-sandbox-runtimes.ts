/**
 * Builds Evidence's sandbox iframe runtimes (html, custom_map, JS-mode custom_echart) into
 * public/sandbox/, which Cupola serves at each release's base. Run by `bun run build:sandbox`,
 * which `dev` and `build` both run first.
 *
 * The core ships its own build script (scripts/build-sandbox-runtimes.js), and this is that
 * script with source patches (`PATCHES`) and one extra bundle. The first is the sandbox's request timeout. A sandboxed component reads its data
 * by asking the page for a named query (`evidence.query(name)`), and the core gives every
 * request from the iframe 10 seconds. In Cupola a page query has no limit anywhere else: the
 * first one of a cold load waits for the engine to boot and the VGI catalog to attach, and a
 * query against a remote VGI table can simply take longer. A timed-out one-shot script leaves
 * its block blank for good. The query requests are the only requests the iframe makes, so the
 * default is raised in the runtime build only. The page's own capture-png request to the iframe
 * passes its own timeout and is unaffected.
 *
 * It also fixes custom_map, which fails in every host: its runtime wraps the map library in a
 * Proxy whose `get` swaps in a `Map` that keeps the WebGL drawing buffer (so the map can be
 * captured), but MapLibre arrives as a module namespace (`import * as maplibregl`), whose
 * properties are non-configurable, and a Proxy may not report a different value for one ("'get'
 * on proxy: property 'Map' is a read-only and non-configurable data property"). Over a namespace
 * it proxies a plain copy instead; Mapbox's library object is still proxied directly, so setting
 * its `accessToken` reaches the library.
 *
 * And it gives custom_map a MapLibre worker that can start. MapLibre 6 runs its tile worker as an
 * ES module (`maplibre-gl-worker.mjs`, from a CDN in the core), and Chromium refuses to start a
 * module worker from a blob URL in an opaque-origin document at all, so inside the sandbox the
 * worker died at once and every MapLibre basemap was a flat panel. MapLibre starts a worker URL
 * ending in `.cjs` as a classic worker, so the runtime hands it a classic blob worker that
 * `importScripts` a classic build of MapLibre's worker, built here from the same maplibre-gl the
 * runtime bundles and served beside it (the sandbox's `script-src` allows the app origin).
 * Mapbox GL (with a token) already uses a classic worker. The vendored core stays unmodified.
 */
import path from 'node:path';
import { rm } from 'node:fs/promises';
import { build, type Plugin } from 'vite';
import { SANDBOX_RUNTIMES } from '@evidence/core/user-components/sandbox/sandbox-runtimes.js';

/** How long a sandbox waits for the page to answer a query. Long enough for any page query;
 * it only exists so a reply that can never come doesn't wait forever. */
const SANDBOX_REQUEST_TIMEOUT_MS = 5 * 60_000;

/** The classic build of MapLibre's tile worker, served beside the runtimes. */
const MAPLIBRE_WORKER_FILE = 'maplibre-gl-worker.js';

const CORE_ROOT = path.resolve(import.meta.dir, '../node_modules/@evidence/core');
const OUT_DIR = path.resolve(import.meta.dir, '../public/sandbox');

/** Source fixes applied while bundling, each by the file it patches. Every one must apply. */
const PATCHES: { file: string; from: string | RegExp; to: string }[] = [
  {
    file: '/user-components/sandbox/request-response.ts',
    from: /const DEFAULT_TIMEOUT_MS = [\d_]+;/,
    to: `const DEFAULT_TIMEOUT_MS = ${SANDBOX_REQUEST_TIMEOUT_MS};`,
  },
  {
    file: '/user-components/tags/custom_map/sandbox/runtime-entry.ts',
    from: 'return new Proxy(l as object, {',
    to: "return new Proxy(Object.getOwnPropertyDescriptor(l, 'Map')?.configurable === false ? { ...l } : (l as object), {",
  },
  {
    // MapLibre 5+ takes GL context options under `canvasContextAttributes` and ignores a
    // top-level `preserveDrawingBuffer`, so the map read back blank for the PDF (Evidence's own
    // map component sets both). Mapbox GL ignores the nested form.
    file: '/user-components/tags/custom_map/sandbox/runtime-entry.ts',
    from: 'super({ preserveDrawingBuffer: true, ...options });',
    to: 'super({ preserveDrawingBuffer: true, ...options, canvasContextAttributes: { preserveDrawingBuffer: true, ...(options.canvasContextAttributes as object | undefined) } });',
  },
  {
    file: '/user-components/tags/custom_map/sandbox/runtime-entry.ts',
    from: 'maplibregl.setWorkerUrl(MAPLIBRE_GL_WORKER_URL);',
    // Runs while the runtime script is being evaluated, so `document.currentScript` is it.
    to: "maplibregl.setWorkerUrl(URL.createObjectURL(new Blob([`importScripts(${JSON.stringify(new URL('" + MAPLIBRE_WORKER_FILE + "', (document.currentScript as HTMLScriptElement).src).href)});`], { type: 'text/javascript' })) + '#classic.cjs');",
  },
];

let patched = 0;
const applied = new Set<number>();
const patches: Plugin = {
  name: 'cupola-sandbox-patches',
  enforce: 'pre',
  transform(code, id) {
    const file = id.split('?')[0];
    let out = code;
    for (const [index, patch] of PATCHES.entries()) {
      if (!file.endsWith(patch.file)) continue;
      const next = out.replace(patch.from, patch.to);
      if (next === out) throw new Error(`${id}: the code this build patches has changed in the core; review the patch`);
      out = next;
      applied.add(index);
      if (index === 0) patched++;
    }
    return out === code ? undefined : out;
  },
};

await rm(OUT_DIR, { recursive: true, force: true });
for (const runtime of SANDBOX_RUNTIMES) {
  const before = patched;
  await build({
    // As in the core's script: `root` pins dependency resolution to the core, and
    // `configFile: false` keeps Cupola's own Vite config out of the iframe bundle.
    root: CORE_ROOT,
    configFile: false,
    logLevel: 'warn',
    plugins: [patches],
    define: { 'process.env.NODE_ENV': '"production"' },
    build: {
      outDir: OUT_DIR,
      emptyOutDir: false,
      minify: true,
      target: 'es2020',
      lib: {
        entry: path.resolve(CORE_ROOT, runtime.entry),
        formats: ['iife'],
        name: runtime.globalName,
        fileName: () => runtime.fileName,
      },
      rollupOptions: { output: { entryFileNames: runtime.fileName, inlineDynamicImports: true } },
    },
  });
  if (patched === before) throw new Error(`${runtime.fileName}: the sandbox RPC was not bundled, so its timeout was not raised`);
}
for (const [index, { file }] of PATCHES.entries()) if (!applied.has(index)) throw new Error(`${file} was never bundled, so a patch to it did not apply`);

// MapLibre's worker as a classic script (see above). Same maplibre-gl copy the runtime bundled.
await build({
  root: CORE_ROOT,
  configFile: false,
  logLevel: 'warn',
  define: { 'process.env.NODE_ENV': '"production"' },
  build: {
    outDir: OUT_DIR,
    emptyOutDir: false,
    minify: true,
    target: 'es2020',
    lib: { entry: path.resolve(import.meta.dir, '../node_modules/maplibre-gl/dist/maplibre-gl-worker.mjs'), formats: ['iife'], name: 'MapLibreWorker', fileName: () => MAPLIBRE_WORKER_FILE },
    rollupOptions: { output: { entryFileNames: MAPLIBRE_WORKER_FILE, inlineDynamicImports: true } },
  },
});
console.log(`Built ${SANDBOX_RUNTIMES.length} sandbox runtimes and the MapLibre worker → ${path.relative(process.cwd(), OUT_DIR)}`);
