---
paths:
  - "scripts/build-sandbox-runtimes.ts"
  - "astro.config.mjs"
  - "src/lib/evidence/typst/snapshot.ts"
  - "src/components/evidence/**"
  - "tests/evidence-sandbox.spec.ts"
---

# Evidence sandboxed components

`html`, `custom_map` and JS-mode `custom_echart` run author code in an opaque-origin iframe — the security boundary (no access to API key, tokens, engine, saved reports).

- **Runtimes built by Cupola**: `bun run build:sandbox` (`scripts/build-sandbox-runtimes.ts`, run by `dev`/`build`, output gitignored `public/sandbox/`). Core's build plus `PATCHES` (core stays unmodified; each patch throws if its target is gone): request timeout 5 min; `custom_map` proxies a copy of the MapLibre namespace; `Map` wrapper sets `canvasContextAttributes.preserveDrawingBuffer`; classic MapLibre worker (`maplibre-gl-worker.js`, URL ending `#classic.cjs`, `importScripts` from app origin) because Chromium won't start a module blob worker in an opaque origin.
- **Served from the release's base**: `evidence-sandbox-runtime-base` plugin (`astro.config.mjs`) rewrites `SANDBOX_RUNTIME_PATH`s to `BASE_URL + 'sandbox/…'` (match allows Vite's `?v=`).
- **Dev server**: `evidence-sandbox-runtime-dev` serves `sandbox/*.js` ahead of Astro's sec-fetch 403 guard, inserted once listening (`enforce` doesn't work). Responses need `Cross-Origin-Resource-Policy: cross-origin` (Worker, Caddy, dev handler).
- **`Tooltip.Provider` wraps the report** (`EvidenceDocument.svelte`); without it `SamplingIndicator` throws and any sampled component vanishes.
- **Popups stay in the shadow root**: `BitsConfig defaultPortalTo` (`EvidenceDocument.svelte`) sends core's select, popover, tooltip and dialog content to `evidence-portals` instead of `document.body`, where they have no report styles. `bits-ui` is imported hoisted, not a direct dep, so it stays core's copy; a second copy would silently undo this (guard: `tests/evidence-portals.spec.ts`). `returnPopupFocus` (`popup-focus.ts`) gives focus back to a dropdown when its search box closes; bits-ui never does, and the button stays disabled while the options query reruns.
- **Reports can't leave Cupola through `goto`** (`src/lib/evidence/navigation.ts`, `link-refusal.ts`): html-block links and `evidence.navigate` to a same-origin path outside the app's base are refused with a report notice, since reports have no sibling pages. Guard: `tests/evidence-html-links.spec.ts`.
- **PDF**: `snapshot.ts` gets a PNG from each sandbox via `getSandboxFrameCapture` (`capture-png`, retried until rendered) and draws it onto the finished capture, never into the DOM html-to-image rasterizes (an image in its SVG decodes on its own time, so it printed blank or mid-paint at random); not reflowed. JS-mode `custom_echart` is snapshotted (no page ECharts instance).
- Tests: `tests/evidence-sandbox.spec.ts`. `custom_map` without a Mapbox token needs an explicit `style`. `BROKEN_UPSTREAM` in `scripts/evidence-catalog.ts` skips examples that fail in Evidence itself.
