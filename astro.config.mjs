// @ts-check
import { defineConfig } from 'astro/config';
import { resolve } from 'node:path';

import react from '@astrojs/react';

import tailwindcss from '@tailwindcss/vite';

// https://astro.build/config
export default defineConfig({
  integrations: [react()],

  vite: {
    plugins: [tailwindcss()],
    resolve: {
      alias: {
        // Use the client-only connect module directly to avoid bundling
        // Node.js server-side code (node:crypto, node:zlib, etc.)
        '@query-farm/vgi-rpc/connect': resolve('../vgi-rpc-typescript/src/client/connect.ts'),
        // Stub Node.js built-ins for browser — Apache Arrow imports these
        // but only uses them in Node.js code paths, never in the browser.
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