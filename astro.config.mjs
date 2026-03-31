// @ts-check
import { defineConfig } from 'astro/config';
import { resolve } from 'node:path';

import react from '@astrojs/react';

import tailwindcss from '@tailwindcss/vite';

// https://astro.build/config
export default defineConfig({
  integrations: [react()],

  vite: {
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
      include: ['leaflet'],
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
    build: {
      rollupOptions: {
        // Stub Node.js built-ins that Apache Arrow references but doesn't
        // use in browser code paths. These modules are only imported by
        // Arrow's node-specific I/O adapters which are never called in the browser.
        external: ['node:stream', 'node:zlib', 'node:crypto', 'node:fs'],
        output: {
          globals: {
            'node:stream': '{}',
            'node:zlib': '{}',
            'node:crypto': '{}',
            'node:fs': '{}',
          },
        },
      },
    },
  },
});