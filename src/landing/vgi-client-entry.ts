// Copyright 2025, 2026 Query Farm LLC - https://query.farm
// Browser entry point bundled into `public/vgi-client.js` and vendored into
// every VGI worker alongside `landing.html`.
//
// The worker serves this file itself rather than the page importing it from a
// CDN: the landing page is same-origin with an authenticated worker and
// carries its session cookie, so third-party script there would run with full
// access to that origin — and a CDN dependency would break air-gapped
// deployments, which today need nothing but the worker.
//
// Rebuild with `bun run build:landing-client`.

export { VgiClient, VgiClientError } from "vgi/client";
// `@query-farm/vgi-rpc/connect` rather than the package root: the root pulls in
// the TCP transport (node:net), which no browser build can carry.
export { httpConnect } from "@query-farm/vgi-rpc/connect";
export {
  deserializeAttachOptionSpecs,
  type AttachOptionSpec,
} from "vgi/client";
export { deserializeSchema } from "vgi/client";
export { schemaToArgumentSpecs } from "vgi/client";
export { FunctionType } from "vgi/client";
// TypeId drives the page's Arrow-type → SQL-type rendering.
export { TypeId } from "vgi/client";
