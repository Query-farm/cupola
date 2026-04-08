// @ts-check
import { defineConfig } from 'astro/config';
import { resolve } from 'node:path';
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
      // COOP/COEP headers required for SharedArrayBuffer (DuckDB-WASM shell)
      {
        name: 'coop-coep-headers',
        configureServer(server) {
          server.middlewares.use((_req, res, next) => {
            res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
            res.setHeader('Cross-Origin-Embedder-Policy', 'credentialless');
            // Allow cross-origin resources (CDN scripts, WASM files)
            res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
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