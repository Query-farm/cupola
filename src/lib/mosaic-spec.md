# Mosaic Visualization Spec — LLM Authoring Guide

This document is a complete reference for generating **Mosaic** visualization
specifications as JSON. Mosaic specs are declarative: a single JSON object
describes data sources, reactive parameters, plots, marks, interactions, and
layout. The runtime compiles the spec against a **DuckDB** database (local or
WebAssembly) and renders interactive, scalable visualizations.

Your job, as an agent, is to **emit one JSON object** that conforms to this
format. This guide enumerates everything that is possible and shows the exact
field names and value types to use.

---

## 0. Cupola deployment guidance (READ FIRST)

You are authoring specs that will run inside Cupola, a browser-based catalog
browser with a live DuckDB-WASM instance and the user's VGI catalog already
attached. **Three rules override anything else in this guide that conflicts:**

### Rule 1 — Always use SQL for data, never inline literals

Cupola has a live DuckDB instance. Reference real catalog tables via SQL — do
NOT dump rows as `{ "data": [{...}, {...}] }` inline JSON arrays. Inline data
blows up the spec size, makes the chat unreadable, and can't be re-queried
when the underlying data changes.

```json
// ✅ Correct — SQL query as the data source:
"data": {
  "by_district": "SELECT district, COUNT(*) AS cnt FROM albemarle_gis.property.parcels GROUP BY 1"
}

// ✅ Also correct — wrapped table form for advanced options:
"data": {
  "by_district": {
    "type": "table",
    "query": "SELECT district, COUNT(*) AS cnt FROM albemarle_gis.property.parcels GROUP BY 1"
  }
}

// ❌ Wrong — don't paste rows inline. The user already has the data in DuckDB;
//    fetch it via SQL instead. Inline form should only be used when there
//    truly is no SQL alternative (e.g. a tiny static lookup the AI invented).
"data": {
  "cities": { "data": [{ "name": "Amsterdam", "lat": 52.3, "lng": 4.9 }, ...] }
}
```

For overlays (e.g. plotting "major cities" alongside computed data), check if
the catalog has a table for it before falling back to inline literals. If you
must use inline data, keep it under 20 rows.

### Rule 2 — Cupola injects `temp: true` and `replace: true` for you

You don't need to set `temp` or `replace` on data definitions. Cupola wraps
every spec before rendering and adds those flags automatically so tables land
in `temp.main` and survive re-renders. Don't waste tokens on them.

### Rule 3 — Don't include `$schema`

The `$schema` URL is documented elsewhere in this guide but Cupola strips it
before parsing. Omit it from your spec.

### Rule 4 — `filterBy` requires a Selection, not a SQL string

A common mistake when adding widgets:

```json
// ❌ Wrong — filterBy expects a Selection reference, not a SQL fragment:
"data": { "from": "d", "filterBy": { "sql": "x < $cutoff" } }

// ✅ Correct — embed the param in a channel's SQL expression instead:
"data": { "from": "d" },
"opacity": { "sql": "CASE WHEN x < $cutoff THEN 1.0 ELSE 0.2 END" }

// ✅ Or — for true cross-filtering, define a selection and use a brush interactor:
"params": {
  "brush": { "select": "intersect" }
}
// ... then in a plot:
"data": { "from": "d", "filterBy": "$brush" },
"plot": [
  { "mark": "dot", "data": { "from": "d" }, "x": "x", "y": "y" },
  { "select": "intervalXY", "as": "$brush" }
]
```

### Rule 5 — Refer to catalog tables by full path

Use `catalog.schema.table` (three-part) in SQL, just like the user does in
the SQL Shell. The default catalog/schema may not be what you expect.

### Rule 6 — Pick the interactor that matches the axis type

`intervalX` / `intervalY` / `intervalXY` are **continuous brushes** — they
call `scale.invert(pixel)` to translate the drag region back to data
values. They only work on continuous scales (numeric, temporal,
logarithmic). Putting them on a categorical axis (string keys, band/ordinal
scale) crashes at brush-drag time with `TypeError: scale.invert is not a function`.

Use the right selector per axis type:

| Axis type           | Mark example          | Use                        |
|---------------------|----------------------|----------------------------|
| Numeric / temporal  | line, area, dot, rect | `intervalX` / `intervalY`  |
| Categorical (bar)   | `barX` / `barY`       | `toggleX` / `toggleY`      |
| Both categorical    | `cell`                | `toggle` (with `channels`) |

If the user asks for "interactive bar chart by category," choose `toggleX`
(or `toggleY` if the categories run along Y). The Mosaic schema's
`Interactor` allows any combination, so the JSON-schema validator can't
catch this — you have to choose correctly from the data shape.

```json
// ✅ bar chart by category, click-toggle selection
{
  "data": { "byCat": "SELECT cat, COUNT(*) AS n FROM t GROUP BY 1" },
  "params": { "sel": { "select": "single" } },
  "plot": [
    { "mark": "barY", "data": { "from": "byCat" }, "x": "cat", "y": "n" },
    { "select": "toggleX", "as": "$sel" }
  ]
}
```

---

## Table of contents

1. [How to use this guide](#1-how-to-use-this-guide)
2. [Quick start](#2-quick-start)
3. [Top-level structure](#3-top-level-structure)
4. [Data sources (DuckDB)](#4-data-sources-duckdb)
5. [Params & Selections](#5-params--selections)
6. [Input widgets](#6-input-widgets)
7. [Plots & layout](#7-plots--layout)
8. [Mark catalog](#8-mark-catalog)
9. [Mark data & channels](#9-mark-data--channels)
10. [Shared mark options](#10-shared-mark-options)
11. [Plot attributes & scales](#11-plot-attributes--scales)
12. [Enumerations](#12-enumerations)
13. [Interactors](#13-interactors)
14. [Legends](#14-legends)
15. [Transforms, aggregates & SQL](#15-transforms-aggregates--sql)
16. [Complete worked examples](#16-complete-worked-examples)
17. [Authoring checklist & pitfalls](#17-authoring-checklist--pitfalls)

---

## 1. How to use this guide

- **Output a single JSON object.** No surrounding prose, no comments (JSON has no
  comments).
- **Start every spec with `$schema`** pointing at the published schema:
  `"$schema": "https://uwdata.github.io/mosaic/schema/latest.json"`. This enables
  validation and editor autocomplete. (Pin a version like `.../schema/v0.26.0.json`
  if you need stability.)
- A spec is an **optional header** (`meta`, `config`, `data`, `params`,
  `plotDefaults`) **merged with exactly one root component** — usually a `plot`,
  a `vconcat`/`hconcat` layout, an `input`, or a `legend`. The header keys and the
  component keys live on the same top-level object.
- **Field naming uses camelCase** (`xDomain`, `marginLeft`, `colorScheme`).
- **Reference parameters** anywhere a value is expected using the `"$name"` string
  syntax, where `name` is a key defined in `params`.

---

## 2. Quick start

The smallest useful spec: one dataset, one plot, one mark.

```json
{
  "$schema": "https://uwdata.github.io/mosaic/schema/latest.json",
  "data": {
    "aapl": { "type": "parquet", "file": "data/stocks.parquet", "where": "Symbol = 'AAPL'" }
  },
  "plot": [
    { "mark": "lineY", "data": { "from": "aapl" }, "x": "Date", "y": "Close" }
  ],
  "width": 680,
  "height": 200
}
```

Mental model:

```
spec = header(meta?, config?, data?, params?, plotDefaults?)  +  one component

component =
  | { "plot": [ marks / interactors / legends ], ...plotAttributes }
  | { "vconcat": [ component, ... ] }
  | { "hconcat": [ component, ... ] }
  | { "hspace": number|string } | { "vspace": number|string }
  | { "input": "menu"|"search"|"slider"|"table", ... }
  | { "legend": "color"|"opacity"|"symbol", "for": "<plotName>", ... }
```

---

## 3. Top-level structure

| Key | Type | Description |
|---|---|---|
| `$schema` | string | URL of the JSON schema. Always include it. |
| `meta` | object | Metadata: `title`, `description`, `credit` (all optional strings). Free-form extra keys allowed. |
| `config` | object | `{ "extensions": string \| string[] }` — DuckDB extensions to load (e.g. `"spatial"`). |
| `data` | object | Map of dataset name → data definition. See §4. |
| `params` | object | Map of param/selection name → definition. See §5. |
| `plotDefaults` | object | Plot attributes applied to **every** plot (see §11). |
| *(component)* | — | Exactly one of `plot`, `vconcat`, `hconcat`, `input`, `legend`, `hspace`, `vspace`. |

Example header:

```json
{
  "$schema": "https://uwdata.github.io/mosaic/schema/latest.json",
  "meta": { "title": "Olympic Athletes", "description": "An interactive dashboard." },
  "config": { "extensions": "spatial" },
  "data": { "athletes": { "type": "parquet", "file": "data/athletes.parquet" } },
  "params": { "query": { "select": "intersect" } },
  "plotDefaults": { "width": 400, "height": 250 },
  "vconcat": [ ... ]
}
```

---

## 4. Data sources (DuckDB)

`data` maps a **table name** (used later in mark `data.from`, inputs, etc.) to a
definition. Mosaic loads each definition into the DuckDB instance as a table or
view, then references it by name. There are nine forms.

### 4.1 The nine data definition forms

**1. Raw SQL string** — the value is a SQL query; the result becomes the table.
```json
"data": { "summary": "SELECT region, SUM(sales) AS sales FROM orders GROUP BY region" }
```

**2. Inline array of objects** — embed data directly (not filterable by selections).
```json
"data": { "points": [ { "x": 1, "y": 2 }, { "x": 3, "y": 4 } ] }
```

**3. File with extension auto-detection** — `.parquet`, `.csv`, or `.json`.
```json
"data": { "trips": { "file": "data/trips.parquet" } }
```

**4. `type: "table"`** — a SQL query defining the table (use for CTEs, joins, transforms).
```json
"data": {
  "gaia": {
    "type": "table",
    "query": "SELECT u, v, parallax FROM 'https://host/gaia-5m.parquet' WHERE parallax BETWEEN -5 AND 20"
  }
}
```

**5. `type: "parquet"`** — explicit Parquet file (local path or URL).
```json
"data": { "flights": { "type": "parquet", "file": "data/flights-200k.parquet" } }
```

**6. `type: "csv"`** — CSV file. Extra: `delimiter` (string), `sample_size` (number of rows for type inference).
```json
"data": { "weather": { "type": "csv", "file": "data/weather.csv", "delimiter": "," } }
```

**7. `type: "spatial"`** — GIS formats via DuckDB `spatial` (`ST_Read`). Extra: `layer` (named layer/sheet/object).
```json
"data": { "counties": { "type": "spatial", "file": "data/us-counties.json", "layer": "counties" } }
```

**8. `type: "json"`** — a JSON file path.
```json
"data": { "config": { "type": "json", "file": "data/config.json" } }
```

**9. Inline JSON objects with options** — `{ "type": "json", "data": [...] }` (optional `type`).
```json
"data": { "points": { "data": [ { "x": 1 }, { "x": 2 } ] } }
```

### 4.2 Shared load options (`DataBaseOptions`)

Available on forms 3–9 (everything except a raw SQL string and a bare inline array):

| Option | Type | Meaning |
|---|---|---|
| `select` | string[] | Columns to extract on load. |
| `where` | string \| string[] | A SQL `WHERE` filter applied on load (array entries are AND-ed). |
| `view` | boolean | Create a **view** instead of a table (default `false`). |
| `temp` | boolean | Create a temporary view/table (default `true`). |
| `replace` | boolean | Replace an existing table of the same name (default `true`). |

```json
"data": {
  "aapl": { "type": "parquet", "file": "data/stocks.parquet", "where": "Symbol = 'AAPL'" }
}
```

### 4.3 DuckDB notes

- File paths may be **local** (relative to the app/data dir) or **remote URLs**
  (DuckDB reads `https://…` Parquet/CSV directly).
- The **spatial** extension is required for `type: "spatial"` and for the
  `centroid`/`centroidX`/`centroidY`/`geojson` transforms. Load it via
  `"config": { "extensions": "spatial" }` if not auto-loaded.
- Once defined, reference a dataset by name everywhere: `"data": { "from": "aapl" }`,
  inputs `"from": "aapl"`, etc.
- Use `type: "table"` with a `query` whenever you need to precompute columns,
  joins, CTEs, or coordinate transforms before plotting.

---

## 5. Params & Selections

`params` maps a name to one of: a **Param** (a reactive scalar/array value), a
**ParamDate** (a date-valued param), or a **Selection** (a reactive set of filter
clauses driven by interactions). Reference any of them as `"$name"`.

### 5.1 Params (reactive values)

| Form | JSON | Notes |
|---|---|---|
| Literal value | `"point": 0` | A bare value (string/number/boolean/null/array) is a Param. |
| Explicit value | `"point": { "value": 0 }` | Same, with `value` key. Array allowed. |
| Date param | `"day": { "date": "2010-01-01" }` | Parsed from an ISO date/time string. |

```json
"params": {
  "frame": [-6, 0],
  "bandwidth": 20,
  "scaleType": "sqrt",
  "startDate": { "date": "2013-01-01" }
}
```

Param references appear in SQL expressions (`{ "sql": "v + $point" }`), attributes
(`"colorScale": "$scaleType"`), transform window frames (`"rows": "$frame"`), input
`value`, etc.

### 5.2 Selections (reactive filters)

A Selection accumulates **clauses** published by interactors/inputs and resolves
them into a predicate used to filter marks (`filterBy`) and other clients.

```json
"params": {
  "brush": { "select": "crossfilter" },
  "category": { "select": "intersect" },
  "query": { "select": "intersect", "include": ["$category"] },
  "hover": { "select": "intersect", "empty": true }
}
```

| Field | Type | Meaning |
|---|---|---|
| `select` | `"single"` \| `"intersect"` \| `"union"` \| `"crossfilter"` | Resolution strategy (required). |
| `cross` | boolean | Cross-filtering: a plot's own selection does not filter itself. Default `false` (but `true` for `crossfilter`). |
| `empty` | boolean | If `true`, an empty selection matches **no** rows; if `false` (default), it matches **all** rows. |
| `include` | `"$ref"` \| `"$ref"[]` | Upstream selections whose clauses are merged into this one. |

Selection types:

- **`single`** — keep only the most recent clause (one active filter at a time).
- **`intersect`** — AND all clauses together (logical "and").
- **`union`** — OR all clauses (logical "or").
- **`crossfilter`** — intersect, but each source view is filtered by all *other*
  views' clauses, not its own. The standard choice for cross-filter dashboards.

Choosing:
- Cross-filter dashboard (histograms that filter each other) → `crossfilter`.
- Inputs/menus that progressively narrow data → `intersect` (often with `include`).
- A highlight that emphasizes a brushed subset → `intersect` (often `empty: true`).

---

## 6. Input widgets

Inputs are components with an `input` discriminator. Each can write to a Selection
(`as`) and/or be populated from / filtered by data (`from`, `column`, `filterBy`).

### 6.1 `menu`

| Field | Type | Description |
|---|---|---|
| `input` | `"menu"` | Required. |
| `as` | `"$ref"` | Output selection; a clause for the chosen option. |
| `from` | string | Source table for options. |
| `column` | string | Column whose distinct values become options. |
| `field` | string | Column used in the clause predicate (defaults to `column`). |
| `options` | array | Explicit options: literals or `{ "value": any, "label"?: string }`. |
| `value` | any | Initial selected value. |
| `label` | string | Text label. |
| `filterBy` | `"$ref"` | Selection that filters the options source. |
| `listMatch` | `"any"` \| `"all"` | For list-typed columns: how to match. |

```json
{ "input": "menu", "label": "Sport", "as": "$category", "from": "athletes", "column": "sport" }
```

### 6.2 `search`

| Field | Type | Description |
|---|---|---|
| `input` | `"search"` | Required. |
| `as` | `"$ref"` | Output selection. |
| `type` | `"contains"` \| `"prefix"` \| `"suffix"` \| `"regexp"` | Query mode (default `contains`). |
| `from`, `column`, `field` | string | Autocomplete source / predicate column. |
| `filterBy` | `"$ref"` | Filter the autocomplete source. |
| `label` | string | Text label. |

```json
{ "input": "search", "label": "Name", "as": "$query", "filterBy": "$category", "from": "athletes", "column": "name", "type": "contains" }
```

### 6.3 `slider`

| Field | Type | Description |
|---|---|---|
| `input` | `"slider"` | Required. |
| `as` | `"$ref"` | Output param/selection. |
| `select` | `"point"` \| `"interval"` | If `as` is a Selection: equality (`point`, default) or `min..value` interval. |
| `from`, `column`, `field` | string | Derive `min`/`max` from a column. |
| `min`, `max`, `step` | number | Explicit range and increment. |
| `value` | number | Initial value. |
| `width` | number | Pixel width. |
| `label` | string | Text label. |
| `filterBy` | `"$ref"` | Filter the source table. |

```json
{ "input": "slider", "label": "Bandwidth", "as": "$bandwidth", "min": 0, "max": 100, "step": 1, "value": 20 }
```

### 6.4 `table`

A sortable, infinite-scroll grid. Can be the **root** component or live inside a layout.

| Field | Type | Description |
|---|---|---|
| `input` | `"table"` | Required. |
| `from` | string \| `"$ref"` | Source table (required). |
| `as` | `"$ref"` | Output selection of selected rows. |
| `columns` | string[] | Columns to show (default: all). |
| `align` | object | Per-column alignment: `"left"`\|`"right"`\|`"center"`\|`"justify"`. |
| `width` | number \| object | Total width, or per-column widths `{ col: px }`. |
| `maxWidth` | number | Max width in pixels. |
| `height` | number | Height in pixels. |
| `rowBatch` | number | Rows fetched per scroll batch. |
| `filterBy` | `"$ref"` | Selection that filters rows. |

```json
{ "input": "table", "from": "athletes", "height": 250, "filterBy": "$query", "as": "$hover",
  "columns": ["name", "nationality", "sex", "height", "weight", "sport"],
  "width": { "name": 180, "nationality": 100 } }
```

---

## 7. Plots & layout

### 7.1 `plot`

A plot is `{ "plot": [ ... ], ...plotAttributes }`. The array holds **marks**,
**interactors**, and **legends**, layered in order. Plot attributes (width, scales,
margins, etc. — see §11) are sibling keys on the same object.

```json
{
  "plot": [
    { "mark": "dot", "data": { "from": "penguins" }, "x": "bill_length", "y": "bill_depth", "fill": "species" },
    { "select": "intervalXY", "as": "$brush" },
    { "select": "highlight", "by": "$brush" }
  ],
  "grid": true,
  "width": 500,
  "height": 400
}
```

> **Important:** an interactor uses the **nearest preceding mark** to infer the
> data fields it selects over. Place interactors *after* the mark(s) they read.

### 7.2 Layout: `vconcat`, `hconcat`, `hspace`, `vspace`

Compose components into rows and columns. They nest arbitrarily.

```json
{
  "vconcat": [
    { "hconcat": [ { "input": "menu", "as": "$c", "from": "t", "column": "sport" }, { "hspace": 10 }, { "input": "search", "as": "$q", "from": "t", "column": "name" } ] },
    { "vspace": 10 },
    { "plot": [ ... ] }
  ]
}
```

- `hspace` / `vspace` accept a number (pixels) or CSS length string (`"1em"`).
- Give a plot a `name` so external legends can reference it via `for`.
- `plotDefaults` (top-level) sets defaults inherited by all plots.

---

## 8. Mark catalog

Every mark is an object `{ "mark": "<type>", "data": {...}, <channels/options> }`.
Below is the full set of mark type strings, grouped by family. Channels and options
are covered in §9–§10; `X`/`Y` suffixed variants assume the other axis is the
identity/aggregate.

### Basic
| `mark` | Purpose | Typical channels |
|---|---|---|
| `dot` | Scatter points / symbols | `x`, `y`, `r`, `fill`, `stroke`, `symbol`, `rotate` |
| `dotX` / `dotY` | Dots with one identity axis | `x` or `y` + `interval` |
| `circle` | `dot` fixed to circle symbol | `x`, `y`, `r`, `fill` |
| `hexagon` | `dot` fixed to hexagon symbol | `x`, `y`, `r`, `fill` |
| `line` | Connected line | `x`, `y`, `z`, `stroke`, `curve` |
| `lineX` / `lineY` | Line with identity axis | `x`/`y`, `curve` |
| `area` | Filled area band | `x1`/`x2`, `y1`/`y2`, `fill`, `curve` |
| `areaX` / `areaY` | Area against a baseline | `x`/`y`, `fill` |
| `barX` / `barY` | Bars; one band axis, one quantitative | `x`/`y` (+ optional band axis), `fill`, stacking |
| `rect` | Rectangles in x/y intervals | `x1`,`x2`,`y1`,`y2`, `fill` |
| `rectX` / `rectY` | Rect with one quantitative interval (histograms) | `x`/`y` (+ `bin`), `fill` |
| `cell` | Heatmap grid cell (both axes ordinal) | `x`, `y`, `fill` |
| `cellX` / `cellY` | Cell with one ordinal axis | `x`/`y`, `fill` |
| `tickX` / `tickY` | Single-axis ticks | `x`/`y`, optional band axis |
| `ruleX` / `ruleY` | Vertical/horizontal reference lines | `x`/`y`, `y1`/`y2` or `x1`/`x2` |
| `text` | Text labels | `x`, `y`, `text`, `fontSize`, `rotate` |
| `textX` / `textY` | Text with identity axis | `x`/`y`, `text` |
| `image` | Images | `x`, `y`, `src`, `width`, `height` |
| `frame` | Plot border / background | `stroke`, `fill` |

### Statistical / density
| `mark` | Purpose |
|---|---|
| `density` | 2D density (auto orientation) |
| `densityX` / `densityY` | 1D kernel density along an axis |
| `denseLine` | Density of many lines (M4-style) |
| `regressionY` | Linear regression line + optional confidence band (`x`, `y`, `stroke`) |
| `errorBarX` / `errorBarY` | Error bars from summary stats |
| `contour` | Density contours (`x`, `y`, `fill`/`stroke`) |
| `hexbin` | Hexagonal binning aggregation (`x`, `y`, `fill`/`r`) |
| `hexgrid` | Hex grid guide overlay |

### Raster / spatial / geo
| `mark` | Purpose |
|---|---|
| `raster` | Rasterized density/heatmap image (`x`, `y`, `fill`, `bandwidth`, `pixelSize`) |
| `heatmap` | `raster` preset with smoothing |
| `rasterTile` | Tiled raster for very large data / panning |
| `geo` | GeoJSON geometries (`geometry`, `fill`, `stroke`) |
| `sphere` | Outline of the globe (with a projection) |
| `graticule` | Lat/long grid lines |
| `voronoi` | Voronoi cell polygons (`x`, `y`, `fill`/`stroke`) |
| `voronoiMesh` | Voronoi cell borders |
| `delaunayLink` | Delaunay triangulation edges |
| `delaunayMesh` | Delaunay mesh |
| `hull` | Convex hull polygon |

### Vectors / connectors
| `mark` | Purpose |
|---|---|
| `vector` | Oriented vectors/glyphs (`x`, `y`, `length`, `rotate`) |
| `vectorX` / `vectorY` | Vector with identity axis |
| `spike` | Spike map vectors (length from value) |
| `arrow` | Arrows between two points (`x1`,`y1`,`x2`,`y2`) |
| `link` | Straight/curved connectors (`x1`,`y1`,`x2`,`y2`) |

### Misc
| `mark` | Purpose |
|---|---|
| `waffleX` / `waffleY` | Waffle (unit) charts |

### Guides (axes & grids)
| `mark` | Purpose |
|---|---|
| `axisX` / `axisY` | Explicit position axes (when you need control beyond plot attributes) |
| `axisFx` / `axisFy` | Facet axes |
| `gridX` / `gridY` | Grid lines for x/y |
| `gridFx` / `gridFy` | Grid lines for facet scales |

Most plots get axes/grids automatically from plot attributes (`grid`, `axis`,
`xGrid`, …); use the explicit guide marks only for fine control.

---

## 9. Mark data & channels

### 9.1 Mark data

```json
"data": { "from": "tableName", "filterBy": "$selection", "optimize": true }
```

| Field | Type | Description |
|---|---|---|
| `from` | string \| `"$ref"` | Backing table name. |
| `filterBy` | `"$ref"` | Selection that filters this mark's data. |
| `optimize` | boolean | Enable mark-specific query optimization (default `true`; set `false` only to debug). |

Or an **inline array** (not filterable by selections): `"data": [ {...}, {...} ]`.

### 9.2 Channels

A channel maps data to a visual property. The full set of channel names:

`ariaLabel`, `fill`, `fillOpacity`, `fontSize`, `fx`, `fy`, `geometry`, `height`,
`href`, `length`, `opacity`, `path`, `r`, `rotate`, `src`, `stroke`,
`strokeOpacity`, `strokeWidth`, `symbol`, `text`, `title`, `weight`, `width`,
`x`, `x1`, `x2`, `y`, `y1`, `y2`, `z`.

Position: `x`, `y`, `x1`, `x2`, `y1`, `y2`; facets `fx`, `fy`; series grouping `z`.

### 9.3 Channel value forms

A channel value may be any of:

| Form | Example | Meaning |
|---|---|---|
| Field name (string) | `"x": "weight"` | Column reference. |
| Literal constant | `"fill": "steelblue"`, `"r": 2`, `"opacity": 0.1` | Constant color/number/bool. |
| `null` | `"sort": null` | No value / disable. |
| Aggregate transform | `"y": { "count": "" }`, `"x": { "sum": "gold" }` | See §15. |
| Column transform | `"x": { "bin": "delay" }` | See §15. |
| SQL expression | `"y": { "sql": "day + 0.5" }` | Non-aggregate SQL (supports `$param`). |
| Aggregate SQL | `"x": { "agg": "SUM(amount)" }` | Aggregate SQL (supports `$param`). |
| Inline array | `"x": [1, 2, 3]` | Literal column of values. |
| Scale override | `"fill": { "value": "category", "scale": "color" }` | `{ value, scale?, label? }`. |
| Interval override | `"x": { "value": "date", "interval": "day" }` | `{ value, interval }` (some marks). |

`scale` in the override may be a scale name (`"x"`,`"y"`,`"color"`,`"opacity"`,
`"r"`,`"symbol"`,`"length"`,`"fx"`,`"fy"`), `"auto"`, `true`, `false`, or `null`.

---

## 10. Shared mark options

All marks accept these (`MarkOptions`). Channel-valued options may take any §9.3 form.

### Appearance
| Option | Type | Notes |
|---|---|---|
| `fill` | channel | CSS color or color-scale channel. |
| `stroke` | channel | CSS color or color-scale channel. |
| `fillOpacity`, `strokeOpacity`, `opacity` | channel | 0–1 or opacity-scale channel. |
| `strokeWidth` | channel | Pixels. |
| `strokeDasharray`, `strokeDashoffset` | string\|number | Dash pattern. |
| `strokeLinecap`, `strokeLinejoin`, `strokeMiterlimit` | string\|number | SVG stroke styling. |
| `mixBlendMode`, `imageFilter`, `paintOrder`, `shapeRendering` | string | SVG/CSS rendering. |
| `dx`, `dy` | number | Pixel offsets. |
| `clip` | `"frame"`\|`"sphere"`\|bool\|null | Clipping. |

### Data handling
| Option | Type | Notes |
|---|---|---|
| `filter` | channel | Keep rows where value is truthy (does not affect scales). |
| `select` | enum | Mark-internal filter: `first`, `last`, `maxX`, `maxY`, `minX`, `minY`, `nearest`, `nearestX`, `nearestY`. |
| `reverse` | bool | Reverse index order. |
| `sort` | SortOrder \| domain-sort | Sort the index, or impute ordinal scale domains. See below. |

`sort` as an ordinal-domain imputation: `"sort": { "y": "-x", "limit": 10 }` (sort
the `y` domain by descending `x`, top 10). As index sort: `"sort": "weight"` or
`{ "value": "-x" }` or `{ "channel": "y", "order": "descending" }`.

### Faceting
| Option | Type | Notes |
|---|---|---|
| `fx`, `fy` | channel | Mark-level facet position. |
| `facet` | `"auto"`\|`"include"`\|`"exclude"`\|`"super"`\|bool\|null | Facet mode. |
| `facetAnchor` | enum | `top`,`right`,`bottom`,`left`, corners, `*-empty`, `empty`, null. |

### Margins & a11y
`margin`, `marginTop`, `marginRight`, `marginBottom`, `marginLeft` (numbers);
`ariaLabel` (channel), `ariaDescription`, `ariaHidden` (strings), `pointerEvents`.

### Tooltips & links
| Option | Type | Notes |
|---|---|---|
| `title` | channel | Tooltip/title text. |
| `tip` | bool \| `"x"`\|`"y"`\|`"xy"` \| object | Interactive tooltip. Object form supports `format`, `anchor`, `frameAnchor`, `pointerSize`, text styles. |
| `channels` | object | Extra named channels for tooltips: `{ name: "field" }`. |
| `href`, `target` | channel/string | Clickable links. |

### Insets (rect-like marks)
`inset`, `insetTop`, `insetRight`, `insetBottom`, `insetLeft` (numbers). Histograms
commonly use `"insetLeft": 0.5, "insetRight": 0.5`.

### Curves (line/area/link)
`curve` — one of: `basis`, `basis-open`, `basis-closed`, `bundle`, `bump-x`,
`bump-y`, `cardinal`, `cardinal-open`, `cardinal-closed`, `catmull-rom`,
`catmull-rom-open`, `catmull-rom-closed`, `linear`, `linear-closed`, `monotone-x`,
`monotone-y`, `natural`, `step`, `step-after`, `step-before` (and `auto` for
projected curves). `tension` (number) tunes bundle/cardinal/catmull-rom.

### Stacking (bar/area)
`offset` — `null` | `center` | `normalize` | `wiggle`. `order` — `null`, a stack
order name (`value`,`x`,`y`,`z`,`sum`,`appearance`,`inside-out`), a field, or an
array. `reverse` (bool), `z` (series channel). Setting `interval` or explicit
`x1`/`x2` (or `y1`/`y2`) on a bar disables implicit stacking.

### Markers (line/link)
`marker`, `markerStart`, `markerMid`, `markerEnd` — `arrow`, `arrow-reverse`,
`dot`, `circle`, `circle-fill`, `circle-stroke`, `tick`, `tick-x`, `tick-y`,
`none`, or boolean.

### Text styling (text marks, tips)
`textAnchor` (`start`|`middle`|`end`), `lineHeight`, `lineWidth`, `textOverflow`
(`clip*`/`ellipsis*`), `monospace`, `fontFamily`, `fontSize`, `fontStyle`,
`fontVariant`, `fontWeight`.

### Notable per-mark extras
- **dot/circle/hexagon**: `r` (radius, channel/number), `symbol`, `rotate`, `frameAnchor`, `z`.
- **barX/barY, rectX/rectY**: `interval` (bin numeric/temporal into intervals); rect corner radii (`rx`,`ry`, and corner-specific radii).
- **raster/heatmap**: `bandwidth`, `pixelSize`, `interpolate`, `imageRendering`.
- **text**: `text` channel, `rotate`, `frameAnchor`.
- **vector/spike**: `length`, `rotate`, `anchor`, `shape`.

---

## 11. Plot attributes & scales

Plot attributes are sibling keys on a `{ "plot": [...] }` object (or in
`plotDefaults`). Most accept a `ParamRef` (`"$name"`) in place of a literal.

### 11.1 Layout & frame
| Attribute | Type | Notes |
|---|---|---|
| `name` | string | Needed for external legends (`for`). |
| `width`, `height` | number | Outer pixels (incl. margins). Width default 640. |
| `aspectRatio` | number\|bool\|null | Desired x/y unit ratio. |
| `margin` / `marginTop`/`Right`/`Bottom`/`Left` | number | Margins. |
| `margins` | object | `{ top, right, bottom, left }`. |
| `inset` | number | Shorthand inset for all sides. |
| `style` | string \| object | CSS string or property object. |
| `axis` | `top`\|`right`\|`bottom`\|`left`\|`both`\|bool\|null | Implicit axis placement. |
| `grid` | bool \| string | Show gridlines (color string allowed). |
| `ariaLabel`, `ariaDescription` | string | A11y for the SVG root. |
| `clip` | `frame`\|`sphere`\|bool\|null | Default mark clipping. |
| `align`, `padding` | number | Ordinal scale spacing (0–1). |

### 11.2 Per-scale attributes

Scales: **x**, **y**, **fx**, **fy** (position/facet), **color**, **opacity**,
**r**, **symbol**, **length**. Each scale `S` exposes a consistent family of
attributes named `S` + property:

Common to most scales:
`SScale` (type), `SDomain`, `SRange`, `SReverse`, `SLabel`, `SNice`, `SZero`,
`SClamp`, `SPercent`, `STickFormat`, and for math scales `SExponent` (pow),
`SBase` (log), `SConstant` (symlog).

Position scales (x/y/fx/fy) additionally: `SInset`, `SInsetTop/Bottom/Left/Right`,
`SRound`, `SAlign`, `SPadding`, `SPaddingInner`, `SPaddingOuter`, `SAxis`,
`STicks`, `STickSize`, `STickSpacing`, `STickPadding`, `STickRotate`, `SGrid`,
`SLine`, `SLabelAnchor`, `SLabelArrow`, `SLabelOffset`, `SFontVariant`,
`SAriaLabel`, `SAriaDescription`.

Examples: `xScale`, `xDomain`, `xLabel`, `xTickFormat`, `yGrid`, `yReverse`,
`fxPadding`, `colorScheme`.

Convenience: `xyDomain` sets both x and y domains at once.

Facet helpers: `facetMargin*`, `facetGrid`, `facetLabel`.

### 11.3 Color scale extras
| Attribute | Type | Notes |
|---|---|---|
| `colorScheme` | scheme name | See §12. Shorthand for range/interpolate. |
| `colorInterpolate` | `number`\|`rgb`\|`hsl`\|`hcl`\|`lab` | Interpolation space. |
| `colorPivot` | any | Center value for diverging scales. |
| `colorSymmetric` | bool | Symmetric diverging domain (default true). |
| `colorN` | number | Number of quantile/quantize thresholds. |

### 11.4 The `"Fixed"` domain sentinel
Any `*Domain` (e.g. `xDomain`, `yDomain`, `colorDomain`, `xyDomain`) may be the
string `"Fixed"`. The domain is computed from data once, then frozen so it does
**not** rescale during interactive filtering — essential for stable comparisons
in cross-filtered/overview-detail views.

```json
{ "plot": [ ... ], "yDomain": "Fixed", "xDomain": "Fixed" }
```

### 11.5 Projection attributes (geo)
`projectionType` (see §12), `projectionDomain` (GeoJSON), `projectionRotate`
(`[λ, φ, γ?]`), `projectionParallels` (`[y1, y2]`, conic), `projectionPrecision`,
`projectionClip` (`frame`\|number\|null), `projectionInset` and per-edge insets.

```json
{ "plot": [ { "mark": "geo", "data": { "from": "states" }, "stroke": "black" } ],
  "projectionType": "albers-usa" }
```

---

## 12. Enumerations

**Position scale types** (`xScale`, `yScale`, `fxScale`, `fyScale`):
`linear`, `pow`, `sqrt`, `log`, `symlog`, `utc`, `time`, `point`, `band`,
`threshold`, `quantile`, `quantize`, `identity`.

**Color scale types** (`colorScale`):
`linear`, `pow`, `sqrt`, `log`, `symlog`, `utc`, `time`, `point`, `band`,
`ordinal`, `sequential`, `cyclical`, `diverging`, `diverging-log`,
`diverging-pow`, `diverging-sqrt`, `diverging-symlog`, `categorical`, `threshold`,
`quantile`, `quantize`, `identity`.

**Continuous scale types** (`opacityScale`, `rScale`, `lengthScale`):
`linear`, `pow`, `sqrt`, `log`, `symlog`, `utc`, `time`, `identity`.

**Discrete scale types** (`symbolScale`): `ordinal`, `identity`.

**Color schemes** (`colorScheme`, case-insensitive):
- Categorical: `Accent`, `Category10`, `Dark2`, `Observable10`, `Paired`,
  `Pastel1`, `Pastel2`, `Set1`, `Set2`, `Set3`, `Tableau10`.
- Diverging: `BrBG`, `PRGn`, `PiYG`, `PuOr`, `RdBu`, `RdGy`, `RdYlBu`, `RdYlGn`,
  `Spectral`, `BuRd`, `BuYlRd`.
- Sequential (single/multi-hue): `Blues`, `Greens`, `Greys`, `Oranges`, `Purples`,
  `Reds`, `Turbo`, `Viridis`, `Magma`, `Inferno`, `Plasma`, `Cividis`, `Cubehelix`,
  `Warm`, `Cool`, `BuGn`, `BuPu`, `GnBu`, `OrRd`, `PuBu`, `PuBuGn`, `PuRd`, `RdPu`,
  `YlGn`, `YlGnBu`, `YlOrBr`, `YlOrRd`.
- Cyclical: `Rainbow`, `Sinebow`.

**Projections** (`projectionType`): `albers-usa`, `albers`, `azimuthal-equal-area`,
`azimuthal-equidistant`, `conic-conformal`, `conic-equal-area`, `conic-equidistant`,
`equal-earth`, `equirectangular`, `gnomonic`, `identity`, `reflect-y`, `mercator`,
`orthographic`, `stereographic`, `transverse-mercator`.

**Symbol types** (`symbol`): `circle`, `cross`, `diamond`, `square`, `star`,
`triangle`, `wye` (fill); `plus`, `times`, `triangle2`, `asterisk`, `square2`,
`diamond2` (stroke); `hexagon`.

**Frame anchors** (`frameAnchor`): `middle`, `top`, `right`, `bottom`, `left`,
`top-left`, `top-right`, `bottom-right`, `bottom-left`.

**Curves**: see §10.

**Interpolation** (`colorInterpolate`): `number`, `rgb`, `hsl`, `hcl`, `lab`.

**Intervals** (`interval`, `bin.interval`, `*Nice`, `*Ticks`): numbers (numeric
step), or time intervals — `second`, `minute`, `hour`, `day`, `week`, `month`,
`quarter`, `half`, `year`, weekday names (`monday`…`sunday`), and multiples like
`"3 months"`, `"10 years"`. Bin-specific units also include `date`, `number`,
`millisecond`.

**Reducers** (domain-sort `reduce`, some channel reducers): `first`, `last`,
`count`, `distinct`, `sum`, `proportion`, `proportion-facet`, `deviation`, `min`,
`min-index`, `max`, `max-index`, `mean`, `median`, `variance`, `mode`, `pXX`
(percentile, e.g. `p25`), `identity`.

---

## 13. Interactors

An interactor is an object with a `select` discriminator placed in a plot's array,
**after** the mark it reads from. It typically writes clauses to an output
selection (`as`) or reads one (`by`). The 17 interactor types:

### Interval (brush) selections
`intervalX`, `intervalY` (1D), `intervalXY` (2D box).

| Field | Type | Notes |
|---|---|---|
| `as` | `"$ref"` | Output selection (required). |
| `field` | string | Column for 1D (`xfield`/`yfield` for 2D). Defaults to the mark's channel field. |
| `pixelSize` | number | Brush resolution (default 1). |
| `peers` | bool | Exclude sibling marks when cross-filtering (default true). |
| `brush` | object | CSS brush styles: `fill`, `stroke`, `opacity`, `fillOpacity`, `strokeOpacity`, `strokeDasharray`. |

```json
{ "select": "intervalX", "as": "$brush" }
```
```json
{ "select": "intervalXY", "as": "$query", "brush": { "fillOpacity": 0, "stroke": "black" } }
```

### Toggle (click) selections
`toggle` (requires `channels: string[]`), `toggleX`, `toggleY`, `toggleColor`.
Options: `as` (required), `peers`. Produces `field = v1 OR field = v2 ...`.

```json
{ "select": "toggleY", "as": "$selected" }
```

### Nearest-point selections
`nearestX`, `nearestY` (and `nearest`).
Options: `as` (required), `channels` (string[]), `fields` (string[]), `maxRadius`
(default 40).

```json
{ "select": "nearestX", "as": "$hover" }
```

### Pan & zoom
`pan`, `panX`, `panY`, `panZoom`, `panZoomX`, `panZoomY`.
Options: `x` / `y` (output selections for the domains), `xfield` / `yfield`.

```json
{ "select": "panZoom", "x": "$xdom", "y": "$ydom" }
```

### Highlight
`highlight` — deemphasizes marks not matching an input selection.
Options: `by` (`"$ref"`, required), `opacity` (default 0.2), `fillOpacity`,
`strokeOpacity`, `fill`, `stroke`.

```json
{ "select": "highlight", "by": "$brush", "opacity": 0.2 }
```

### Region
`region` — select aspects of individual marks within a 2D box.
Options: `as` (required), `channels` (required), `peers`, `brush`.

### Linking pattern
The canonical cross-filter idiom: an interval interactor writes `$brush`, and
every other plot filters by it.

```json
{ "plot": [
    { "mark": "rectY", "data": { "from": "flights", "filterBy": "$brush" }, "x": { "bin": "delay" }, "y": { "count": "" } },
    { "select": "intervalX", "as": "$brush" }
] }
```

---

## 14. Legends

Two placements:

**In-plot legend** — an entry inside a plot's array:
```json
{ "plot": [ { "legend": "color", "label": "Species", "as": "$selected" } ], "colorDomain": ["a","b","c"] }
```

**External legend** — a top-level component referencing a named plot via `for`:
```json
{ "legend": "color", "for": "myPlot", "label": "Species", "as": "$selected" }
```

| Field | Type | Notes |
|---|---|---|
| `legend` | `"color"`\|`"opacity"`\|`"symbol"` | Legend type (required). |
| `for` | string | Name of the target plot (external legends only). |
| `as` | `"$ref"` | Makes the legend interactive (toggle for discrete, intervalX for continuous). |
| `field` | string | Data field for output clauses. |
| `label` | string | Legend label. |
| `tickSize` | number | Continuous legend tick size. |
| `marginTop`/`Right`/`Bottom`/`Left` | number | Margins. |
| `width`, `height` | number | Continuous legend dimensions. |
| `columns` | number | Columns for a discrete legend layout. |

---

## 15. Transforms, aggregates & SQL

Transforms appear as **channel values** (objects). They compile to DuckDB SQL.

### 15.1 Aggregates
Each is `{ "<name>": <arg(s)> }`. Single-column aggregates take a column name (or
`[col]`); two-column ones take `[a, b]`; `count` takes `""`/`null`/`[]` (count all)
or a column.

`count`, `sum`, `avg`, `min`, `max`, `median`, `mode`, `first`, `last`, `argmax`
(`[a,b]`), `argmin` (`[a,b]`), `quantile` (`[col, p]`), `stddev`, `stddevPop`,
`variance`, `varPop`, `product`, `covariance` (`[a,b]`), `covarPop` (`[a,b]`),
`geomean`.

```json
"y": { "count": "" }
"x": { "sum": "gold" }
"y": { "quantile": ["value", 0.5] }
```

Aggregate option: `"distinct": true` (e.g. `{ "count": "user", "distinct": true }`).

### 15.2 Window functions
Aggregates **and** the following accept `WindowOptions` to become window
computations: `orderby`, `partitionby` (field or field[]), `rows` / `range` /
`groups` (`[lo, hi]` frame, where `null` = unbounded), `exclude`.

Window-only transforms: `row_number`, `rank`, `dense_rank`, `percent_rank`,
`cume_dist`, `ntile` (`n`), `lag` (`[col, offset?, default?]`), `lead`,
`first_value`, `last_value`, `nth_value` (`[col, n]`).

Moving average example (7-row trailing window driven by a param):
```json
"y": { "avg": "cases", "orderby": "day", "rows": "$frame" }
```
with `"params": { "frame": [-6, 0] }`.

### 15.3 Column transforms
| Transform | Form | Notes |
|---|---|---|
| `bin` | `{ "bin": "col", "interval"?, "step"?, "steps"?, "minstep"?, "nice"?, "offset"? }` | Bin numeric/temporal into intervals. |
| `column` | `{ "column": "name" }` | Treat a string/param as a column reference. |
| `dateMonth` | `{ "dateMonth": "col" }` | Collapse to month (cyclic). |
| `dateMonthDay` | `{ "dateMonthDay": "col" }` | Collapse to month+day. |
| `dateDay` | `{ "dateDay": "col" }` | Collapse to day-of-month. |
| `centroid` | `{ "centroid": "geom" }` | 2D centroid (needs spatial ext). |
| `centroidX` / `centroidY` | `{ "centroidX": "geom" }` | Centroid coordinate. |
| `geojson` | `{ "geojson": "geom" }` | GeoJSON string from geometry. |

`bin.interval` units: `date`, `number`, `millisecond`, `second`, `minute`, `hour`,
`day`, `month`, `year`.

```json
"x": { "bin": "delay" }
"x": { "bin": "time", "interval": "hour" }
```

### 15.4 Raw SQL escape hatches
When transforms aren't enough, write SQL directly. Both support `$param`
interpolation and an optional `label`.

| Form | Use for |
|---|---|
| `{ "sql": "<expr>", "label"?: "..." }` | **Non-aggregate** column expressions. |
| `{ "agg": "<expr>", "label"?: "..." }` | **Aggregate** expressions. |

```json
"x": { "sql": "day + 0.5" }
"y": { "sql": "v + $point" }
"x": { "agg": "SUM(amount) FILTER (WHERE status = 'paid')" }
```

---

## 16. Complete worked examples

### 16.1 Simple line chart

```json
{
  "$schema": "https://uwdata.github.io/mosaic/schema/latest.json",
  "data": {
    "aapl": { "type": "parquet", "file": "data/stocks.parquet", "where": "Symbol = 'AAPL'" }
  },
  "plot": [
    { "mark": "lineY", "data": { "from": "aapl" }, "x": "Date", "y": "Close" }
  ],
  "width": 680,
  "height": 200
}
```

### 16.2 Cross-filtered histograms

```json
{
  "$schema": "https://uwdata.github.io/mosaic/schema/latest.json",
  "data": {
    "flights": { "type": "parquet", "file": "data/flights-200k.parquet" }
  },
  "params": { "brush": { "select": "crossfilter" } },
  "vconcat": [
    {
      "plot": [
        { "mark": "rectY", "data": { "from": "flights", "filterBy": "$brush" },
          "x": { "bin": "delay" }, "y": { "count": "" }, "fill": "steelblue",
          "insetLeft": 0.5, "insetRight": 0.5 },
        { "select": "intervalX", "as": "$brush" }
      ],
      "xDomain": "Fixed", "xLabel": "Arrival Delay (min)", "yTickFormat": "s", "height": 200
    },
    {
      "plot": [
        { "mark": "rectY", "data": { "from": "flights", "filterBy": "$brush" },
          "x": { "bin": "time" }, "y": { "count": "" }, "fill": "steelblue",
          "insetLeft": 0.5, "insetRight": 0.5 },
        { "select": "intervalX", "as": "$brush" }
      ],
      "xDomain": "Fixed", "xLabel": "Departure Time (hour)", "yTickFormat": "s", "height": 200
    }
  ]
}
```

### 16.3 Overview + detail (linked zoom)

```json
{
  "$schema": "https://uwdata.github.io/mosaic/schema/latest.json",
  "data": { "walk": { "type": "parquet", "file": "data/random-walk.parquet" } },
  "params": { "brush": { "select": "intersect" } },
  "vconcat": [
    {
      "plot": [
        { "mark": "areaY", "data": { "from": "walk" }, "x": "t", "y": "v", "fill": "steelblue" },
        { "select": "intervalX", "as": "$brush" }
      ],
      "width": 680, "height": 200
    },
    {
      "plot": [
        { "mark": "areaY", "data": { "from": "walk", "filterBy": "$brush" }, "x": "t", "y": "v", "fill": "steelblue" }
      ],
      "yDomain": "Fixed", "width": 680, "height": 200
    }
  ]
}
```

### 16.4 Full dashboard (inputs + brush + regression + linked selections)

```json
{
  "$schema": "https://uwdata.github.io/mosaic/schema/latest.json",
  "meta": { "title": "Olympic Athletes", "description": "An interactive dashboard of athlete statistics." },
  "data": { "athletes": { "type": "parquet", "file": "data/athletes.parquet" } },
  "params": {
    "category": { "select": "intersect" },
    "query": { "select": "intersect", "include": ["$category"] },
    "hover": { "select": "intersect", "empty": true }
  },
  "vconcat": [
    {
      "hconcat": [
        { "input": "menu", "label": "Sport", "as": "$category", "from": "athletes", "column": "sport" },
        { "input": "menu", "label": "Sex", "as": "$category", "from": "athletes", "column": "sex" },
        { "input": "search", "label": "Name", "filterBy": "$category", "as": "$query", "from": "athletes", "column": "name", "type": "contains" }
      ]
    },
    { "vspace": 10 },
    {
      "plot": [
        { "mark": "dot", "data": { "from": "athletes", "filterBy": "$query" }, "x": "weight", "y": "height", "fill": "sex", "r": 2, "opacity": 0.1 },
        { "mark": "regressionY", "data": { "from": "athletes", "filterBy": "$query" }, "x": "weight", "y": "height", "stroke": "sex" },
        { "select": "intervalXY", "as": "$query", "brush": { "fillOpacity": 0, "stroke": "black" } },
        { "mark": "dot", "data": { "from": "athletes", "filterBy": "$hover" }, "x": "weight", "y": "height", "fill": "sex", "stroke": "currentColor", "strokeWidth": 1, "r": 3 }
      ],
      "xyDomain": "Fixed", "colorDomain": "Fixed", "width": 570, "height": 350
    },
    { "vspace": 5 },
    {
      "input": "table", "from": "athletes", "maxWidth": 570, "height": 250,
      "filterBy": "$query", "as": "$hover",
      "columns": ["name", "nationality", "sex", "height", "weight", "sport"]
    }
  ]
}
```

### 16.5 Choropleth map (projection + spatial)

```json
{
  "$schema": "https://uwdata.github.io/mosaic/schema/latest.json",
  "config": { "extensions": "spatial" },
  "data": {
    "states": { "type": "spatial", "file": "data/us-states.json" }
  },
  "plot": [
    { "mark": "geo", "data": { "from": "states" }, "fill": "steelblue", "stroke": "white" }
  ],
  "projectionType": "albers-usa",
  "width": 720,
  "height": 450
}
```

### 16.6 Density raster with adjustable smoothing

```json
{
  "$schema": "https://uwdata.github.io/mosaic/schema/latest.json",
  "data": { "gaia": { "type": "parquet", "file": "data/gaia-sample.parquet" } },
  "params": { "brush": { "select": "crossfilter" }, "bandwidth": 0, "pixelSize": 2 },
  "plot": [
    { "mark": "raster", "data": { "from": "gaia", "filterBy": "$brush" }, "x": "u", "y": "v",
      "fill": "density", "bandwidth": "$bandwidth", "pixelSize": "$pixelSize" },
    { "select": "intervalXY", "as": "$brush" }
  ],
  "colorScale": "sqrt",
  "colorScheme": "viridis",
  "width": 440,
  "height": 440
}
```

---

## 17. Authoring checklist & pitfalls

- **Always** set `$schema` to `https://uwdata.github.io/mosaic/schema/latest.json`.
- **Output valid JSON only** — no comments, no trailing commas, double-quoted keys.
- Every mark `data.from` must name a dataset defined in `data` (or a query result).
- Every `"$name"` must be defined in `params`.
- **Aggregates** use transform objects (`{ "count": "" }`, `{ "sum": "gold" }`),
  not raw SQL — unless you need `{ "agg": "..." }`.
- **Count** is `{ "count": "" }` (empty string), not `{ "count": null }` in most cases (both work; prefer `""`).
- **Histograms**: `rectY` + `{ "bin": "col" }` on `x`, `{ "count": "" }` on `y`.
  Bars (`barX`/`barY`) are for an **ordinal** category axis + a quantitative axis;
  use `rect` for two continuous/binned axes and `cell` for two ordinal axes.
- **Interactors come after their mark** in the `plot` array (they bind to the
  nearest preceding mark for field inference).
- Use **`"Fixed"`** on `*Domain` when filtering should not rescale axes
  (overview-detail, cross-filter). Apply to the *filtered* view's domain.
- For **cross-filter dashboards**, use a `crossfilter` selection and put
  `"filterBy": "$brush"` on every mark, including the brushed plot itself.
- For **highlighting** rather than filtering, use a `highlight` interactor with
  `by`, and pair the brush with an `intersect` (often `empty: true`) selection.
- **Stacking** is implicit for `barY`/`areaY` when only `y` is given and there is a
  series (`fill`/`z`); setting `y1`/`y2` or `interval` disables it.
- Geographic marks need a projection: set `projectionType` on the plot.
- Spatial data/transforms need the **spatial** extension via `config.extensions`.
- Prefer `type: "table"` with a `query` to precompute derived columns/joins rather
  than stuffing complex SQL into many channel `{ "sql": ... }` expressions.
- Reference a plot by `name` to attach an **external** `legend` (`for`).
```
