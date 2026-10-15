---
paths:
  - "sentry.client.config.ts"
  - "src/lib/sentry-scrub.ts"
  - "src/lib/ai-telemetry.ts"
  - "worker/**"
  - "astro.config.mjs"
  - "publish.sh"
---

# Observability (Sentry)

Both runtimes report to one Sentry project (`query-farm-llc/cupola`) under the shared release slug `cupola@{version}+{gitHash}`.

- **Browser** (`sentry.client.config.ts`): `@sentry/astro`, initialized only in PROD builds. `environment` is `window.location.hostname` so each installation (Cloudflare, self-hosted, localhost preview) is distinguishable. `beforeSend`/`beforeSendTransaction`/`beforeBreadcrumb` scrub the `Authorization` header, `_vgi_auth` cookie, and secret URL params via `src/lib/sentry-scrub.ts`.
- **Worker** (`worker/index.ts`): `@sentry/cloudflare` `withSentry`; version/hash injected at deploy via wrangler `--define`. Same scrubbing.
- **AI agent monitoring**: manual gen_ai instrumentation in `ai-agent.ts` (the agent uses raw fetch, so no Sentry auto-instrumentation). Span tree: `gen_ai.invoke_agent` root per turn (via `startNewTrace`) → `gen_ai.chat` per API request → `gen_ai.execute_tool` per tool call. Attribute mapping lives in `ai-telemetry.ts`; key rule: `gen_ai.usage.input_tokens` must INCLUDE Anthropic's separately-reported cache tokens (`.cached`/`.cache_write` are subsets) or Sentry computes negative costs. Conversations are grouped via `Sentry.setConversationId` (UUID per chat-panel or `.ai` session). Users opt out via the `aiTelemetry` setting.
- **Sampling**: `tracesSampler` keeps AI agent traces at 100%, everything else at 10%. `sendDefaultPii: true` + `streamGenAiSpans: true` power the Conversations view.
- **Source maps**: vite emits `'hidden'` maps (must be set under `vite.environments.client.build` — Astro 6 ignores the top-level setting). With `SENTRY_AUTH_TOKEN` set, `@sentry/astro` uploads them during build and deletes them from `dist/` afterwards. **Gotcha**: the `sentry()` integration options must be top-level — the deprecated `sourceMapsUploadOptions` wrapper silently ignores nested `release`/`sourcemaps` objects (this shipped maps to R2 for ~45 releases before being caught). `publish.sh` fails the publish if maps survive the build or the upload-success log line is missing, and strips client maps before the R2 sync regardless. Worker maps are uploaded by `publish.sh` via `sentry-cli` under the same release.
