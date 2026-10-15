---
paths:
  - "src/lib/evidence/typst/**"
  - "scripts/evidence-catalog.ts"
  - "scripts/make-pdf-fonts.py"
  - "public/typst/**"
  - "tests/evidence-pdf*.spec.ts"
  - "tests/evidence-print.spec.ts"
  - "tests/unit/evidence-typst*.test.ts"
  - "tests/fixtures/evidence-catalog*"
---

# Evidence PDF export (Typst) and the component catalog

Pipeline (`src/lib/evidence/typst/`): `extract.ts` (live DOM in the preview's shadow root, `[data-markdoc-content]`) → `model.ts` → `emit.ts` (Typst, template in `template.ts`) → typst.ts compiles in-browser. Charts: live ECharts `getOption` → SSR at print width → vector SVG (`charts.ts`).

## Invariants
- **Extract from the DOM, not the Markdoc tree** (`data-component-id` is not unique).
- **Every report string is a Typst `lit()`, never markup**; structure is emitted in code mode. `color()` is the only other path into source and emits hex only. Guard: `tests/unit/evidence-typst.test.ts`.
- **Colors go through `resolveColor()` (`css-color.ts`)**: Typst paints CSS Color 4 / `oklch()` black with no error. `isChromatic` needs chroma as well as hue ratio (else near-black `#211a12` counts as colored).
- **Keep `template.ts` ASCII**; write other chars as Typst escapes (`\u{b7}`) — Bun rewrites literals in `String.raw`. A unit test enforces it.
- **Fonts are Cupola's, never typst.ts's CDN** (`loadFonts(..., { assets: false })`), static TTFs in `public/typst/fonts/` (no WOFF2/variable). Noto Sans is required for tabular figures (bold too); don't swap in a font without `tnum`. Regenerate: `uv run --with fonttools --with brotli python scripts/make-pdf-fonts.py`. Test resolves every cut with `fallback: false`.
- Compiler wasm loaded lazily via `?url` (`load-compiler.ts`); compiles are serialized (one shadow FS).
- Every registered component is classified in `components.ts` (`native`, `chart`, `container`, `part`, `snapshot`, `input`, `omitted`).
- `html-to-image` (`snapshot.ts`) is a direct dep pinned to the core's version; PDF fonts passed as `fontEmbedCSS`.

## Traps
- A component owns only its own chart/table: `tabs`/`details` contain others' ECharts instances.
- `page_break` / `print_group` have `componentWrapper: false`; extractor follows print CSS (`break-*`, `print:hidden`, `hidden print:block`) from the class list.
- Charts render at `contentWidthPx()` (1px = 0.75pt); a `row` divides it among printable children only (inputs removed first). Disable series-level `animation` too, or line series draw nothing.
- Chart pixel geometry is fitted, not replayed (`chart-geometry.ts`): pixel margins kept, pixel `width`/`height` shrink. Font set in the option before rendering (`withFont`).
- Typst's first layout pass reads a `state`'s initial value: seed the theme state with a real theme (field access on `none` is fatal).
- Collapsed sections print open (`openSections`): click open one at a time, `settleDom` + `settleReport`, read, close; reader's open items never pre-read; budget `OPEN_SECTIONS_BUDGET_MS`. Test visibility not presence (hidden registration div); `aria-expanded` alone isn't a trigger test.
- Errors (`.text-destructive, [role="alert"]`, component's own only) are checked **before** the input skip.
- Tables: column widths from content (`table-layout`, `sizingExpr`, recorded as `<cupola-table-layout>` metadata); shrink to 6pt then halve padding, then an overlap note. Figures never break (`figureUnits` / `textWithFigures`), but box only figures that could break (boxes split PDF text runs). Bold measured bold (`bold-words`). ≤14 rows never split. Cell fill from the cell itself only (not a `viz="bar"` track); keep screen text color on filled cells.
- Paged tables print every row (`collectPagedTables`), then restore the reader's page. Query-paged: position from the "N of M" indicator, rows count only when new, non-blank, stable two frames. Total row printed once. Caps: `MAX_TABLE_ROWS` (2,000), `PAGING_BUDGET_MS` (30s).
- Big values use the rendered title (only explicit titles reach `data-component-title`); keep `text_size`.
- HTML snapshots are reflowed to print width before capture; canvas (maps) captured as is.
- Tooltip triggers skipped only when they hold no text (`Ellipsis` titles are triggers).

## Debug and tests
- `window.__cupolaPdfDebug = true` keeps the last export's Typst source, files and coverage; used by `tests/evidence-pdf.spec.ts`.
- `tests/evidence-pdf-tables.spec.ts` guards paged tables (pdf.js text).

## Component catalog
- `bun scripts/evidence-catalog.ts` regenerates `tests/fixtures/evidence-catalog.json` from the vendored core's schema `examples` (Playwright can't transpile TS in `node_modules`).
- `tests/fixtures/evidence-catalog-reports.ts` builds family reports on the test service's `demo` schema (`demo.daily_orders` / `demo.order_details`). Don't seed a database named `demo` (ambiguous reference). Query names/input ids are prefixed; unrunnable examples marked `skip` with a reason.
- `tests/unit/evidence-typst-catalog.test.ts`: fails on stale fixture, component missing from `components.ts`, or printable component with no runnable example.
- `tests/evidence-pdf-catalog.spec.ts`: invariants (coverage complete, none unclassified, every chart → SVG, errors print as errors).

## maplibre-gl pin
- Pinned to 6.4.1 via `overrides` in `package.json`; must equal the core's `MAPLIBRE_GL_VERSION` (`common/maplibre-cdn.ts`). Mismatch = gray basemaps, only trace `t.codePointAt is not a function`. Update the override whenever `@evidence/core` is upgraded.
- No token needed (MapLibre + OpenFreeMap without `PUBLIC_MAPBOX_TOKEN`). Guard: `tests/evidence-pdf-map.spec.ts` (color variety, with tile-blocked negative control).
