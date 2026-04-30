// @ts-check
import { defineConfig } from 'astro/config';
import { resolve } from 'node:path';
import { readFileSync, existsSync, realpathSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { createRequire } from 'node:module';

import react from '@astrojs/react';
import sentry from '@sentry/astro';

import tailwindcss from '@tailwindcss/vite';

const require = createRequire(import.meta.url);
const pkg = require('./package.json');
const gitHash = execSync('git rev-parse --short HEAD').toString().trim();

const sentryAuthToken = process.env.SENTRY_AUTH_TOKEN;

// https://astro.build/config
export default defineConfig({
  // Version-prefix every emitted asset path so each release is content-isolated
  // in R2 and the browser cache. Without this, /_astro/*, /shell/*, and public/
  // assets resolve at the root and a stale browser cache from a prior version
  // can ship a broken worker.js into a fixed release.
  base: `/v${pkg.version}/`,
  trailingSlash: 'ignore',

  integrations: [
    react(),
    sentry({
      // Init lives in sentry.client.config.ts so the runtime DSN/release/scrubbing
      // stay co-located. The integration here exists to inject the SDK into the
      // client bundle and (optionally) upload source maps.
      sourceMapsUploadOptions: sentryAuthToken
        ? {
            org: process.env.SENTRY_ORG || 'query-farm-llc',
            project: process.env.SENTRY_PROJECT || 'cupola',
            authToken: sentryAuthToken,
            telemetry: false,
            release: {
              name: `cupola@${pkg.version}+${gitHash}`,
              dist: gitHash,
            },
          }
        : { enabled: false },
    }),
  ],

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
        enforce: 'pre',
        configureServer(server) {
          const handler = (req, res, next) => {
            // COOP/COEP required for SharedArrayBuffer (DuckDB-WASM COI/threads build)
            res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
            res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
            res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');

            // Serve shell/wasm/ files directly to avoid transform pipeline hangs.
            // With Astro's base set, dev requests are version-prefixed
            // (/v0.3.4/shell/wasm/...) — strip the prefix to find the file
            // under public/.
            const base = `/v${pkg.version}`;
            const stripped = req.url?.startsWith(base + '/') ? req.url.slice(base.length) : req.url;
            if (stripped?.startsWith('/shell/wasm/') || stripped?.startsWith('/shell/extensions/')) {
              const relPath = stripped.split('?')[0];
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

            // Serve version-free public files at their root path. In production
            // these live at dist/ root (outside the version prefix), so OAuth
            // redirect URIs like /oauth-callback.html stay stable across
            // releases. Must run BEFORE Astro's baseMiddleware (which 404s any
            // unversioned request that happens to match a file in public/).
            const rootPublicFiles = ['/oauth-callback.html', '/logo-hero.png', '/favicon.svg'];
            const reqPath = req.url?.split('?')[0];
            if (reqPath && rootPublicFiles.includes(reqPath)) {
              const filePath = resolve('public' + reqPath);
              if (existsSync(filePath)) {
                const ext = filePath.split('.').pop();
                const types = {
                  html: 'text/html; charset=utf-8',
                  png: 'image/png',
                  svg: 'image/svg+xml',
                };
                res.setHeader('Content-Type', types[ext] || 'application/octet-stream');
                res.end(readFileSync(filePath));
                return;
              }
            }
            next();
          };
          // Splice into the front of the Connect stack. A plain `.use()`
          // appends, which places this handler AFTER Astro's baseMiddleware —
          // too late to intercept unversioned /oauth-callback.html requests.
          // Defer until the HTTP server is actually listening so Astro's own
          // middlewares (registered via a separate hook chain) are already in
          // place and we can reliably insert ahead of them.
          const install = () => {
            server.middlewares.stack.unshift({ route: '', handle: handler });
          };
          if (server.httpServer) {
            server.httpServer.once('listening', install);
          } else {
            process.nextTick(install);
          }
        },
      },
    ],
    server: {
      fs: {
        // Allow serving symlinked files from wasm-upgrades build
        allow: ['..'],
      },
      proxy: {
        // ESM CDN transitive deps resolve against the page origin
        '/npm': {
          target: 'https://cdn.jsdelivr.net',
          changeOrigin: true,
        },
      },
    },
    optimizeDeps: {
      include: ['leaflet', 'cli-table3'],
      exclude: ['astro'],
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
        'node:module': resolve('src/lib/node-stubs.ts'),
      },
    },
    // Node.js built-ins are handled by resolve.alias above — they point to
    // browser-safe stubs in src/lib/node-stubs.ts. No need to externalize.
  },
});