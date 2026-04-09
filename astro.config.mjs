// @ts-check
import { defineConfig } from 'astro/config';
import { resolve } from 'node:path';
import { readFileSync, existsSync, realpathSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { createRequire } from 'node:module';

import react from '@astrojs/react';

import tailwindcss from '@tailwindcss/vite';

const require = createRequire(import.meta.url);
const pkg = require('./package.json');
const gitHash = execSync('git rev-parse --short HEAD').toString().trim();

// https://astro.build/config
export default defineConfig({
  integrations: [react()],

  vite: {
    define: {
      __APP_VERSION__: JSON.stringify(pkg.version),
      __GIT_HASH__: JSON.stringify(gitHash),
      __BUILD_TIME__: JSON.stringify(new Date().toISOString()),
    },
    plugins: [
      tailwindcss(),
      // Serve shell/wasm files directly, bypassing Vite's transform pipeline.
      // Without this, pthread sub-worker requests for duckdb-coi.js hang because
      // Vite's middleware holds the connection open for JS transform processing.
      {
        name: 'shell-wasm-direct-serve',
        configureServer(server) {
          server.middlewares.use((req, res, next) => {
            // COOP/COEP headers required for SharedArrayBuffer (DuckDB-WASM shell)
            // COOP/COEP for SharedArrayBuffer — required for production deployments.
            // On localhost, Chrome allows SAB without these headers.
            // Note: COEP can interfere with sub-worker resource loading in dev.
            if (req.headers.host && !req.headers.host.startsWith('localhost')) {
              res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
              res.setHeader('Cross-Origin-Embedder-Policy', 'credentialless');
            }
            res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');

            // Serve shell/wasm/ files directly to avoid transform pipeline hangs
            if (req.url?.startsWith('/shell/wasm/') || req.url?.startsWith('/shell/extensions/')) {
              const relPath = req.url.split('?')[0];
              let filePath = resolve('public' + relPath);
              try { filePath = realpathSync(filePath); } catch {}
              if (existsSync(filePath)) {
                const ext = filePath.split('.').pop();
                const types = { js: 'application/javascript', wasm: 'application/wasm' };
                res.setHeader('Content-Type', types[ext] || 'application/octet-stream');
                res.end(readFileSync(filePath));
                return;
              }
            }
            next();
          });
        },
      },
    ],
    server: {
      fs: {
        // Allow serving symlinked files from wasm-upgrades build
        allow: ['..'],
      },
    },
    optimizeDeps: {
      include: ['leaflet', 'cli-table3'],
    },
    resolve: {
      alias: {
        // Use the client-only connect module directly to avoid bundling
        // Node.js server-side code (node:crypto, node:zlib, etc.)
        '@query-farm/vgi-rpc/connect': resolve('../vgi-rpc-typescript/src/client/connect.ts'),
        // kepler.gl's dataset-utils.ts imports Node.js assert
        'assert': resolve('src/lib/assert-stub.ts'),
        'node:stream': resolve('src/lib/node-stubs.ts'),
        'node:zlib': resolve('src/lib/node-stubs.ts'),
        'node:crypto': resolve('src/lib/node-stubs.ts'),
        'node:fs': resolve('src/lib/node-stubs.ts'),
      },
    },
    // Node.js built-ins are handled by resolve.alias above — they point to
    // browser-safe stubs in src/lib/node-stubs.ts. No need to externalize.
  },
});