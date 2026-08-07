declare const __APP_VERSION__: string;
declare const __GIT_HASH__: string;
declare const __BUILD_TIME__: string;

// ---------------------------------------------------------------------------
// Ambient shims for packages that ship JS without per-subpath declarations.
// ---------------------------------------------------------------------------

// highlight.js publishes types at `types/index.d.ts` for the package root only.
// SqlCodeBlock imports the deep `lib/core` + `lib/languages/sql` entry points
// (the whole point being to avoid pulling in all ~190 languages), which carry
// no declarations. Borrow the root package's own types so these stay checked
// rather than silently `any`.
declare module "highlight.js/lib/core" {
  import type { HLJSApi } from "highlight.js";
  const hljs: HLJSApi;
  export default hljs;
}

declare module "highlight.js/lib/languages/sql" {
  import type { LanguageFn } from "highlight.js";
  const sql: LanguageFn;
  export default sql;
}
