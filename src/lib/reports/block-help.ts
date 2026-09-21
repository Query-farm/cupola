import type { ReportBlock } from "./types";

type BlockType = ReportBlock["type"];

/**
 * Plain-language help for every setting in the block editor, keyed by the
 * block property it edits (dotted for nested ones). A per-type entry wins
 * over the shared one, because the same label means different things on
 * different blocks — a KPI's "Value" is one headline number, a bullet
 * chart's is one bar per row.
 */
const SHARED_HELP: Record<string, string> = {
  title: "The heading at the top of the block. Report parameters such as $city are replaced with their current value.",
  caption: "A short note under the block that helps readers interpret it, such as “Excludes returns.”",
  source: "Where the data comes from, shown under the block — for example a table or agency name.",
  datasetId: "The query whose results this block shows. The column choices below come from this dataset; if they are empty, run the dataset first.",
  format: "How numbers are shown. Automatic uses the unit from governed metrics when there is one. Number adds thousands separators, Currency shows US dollars, Percent expects a fraction (0.25 shows as 25%), and Text shows the value unchanged.",
  color: "Any CSS color, such as #2563eb or teal. Leave blank for the default.",
  showValues: "Print the numbers on the chart. Automatic shows them when there are six or fewer rows, where they stay readable.",
  "layout.w": "Width in twelfths of the report: 12 is full width, 6 is half, 4 is a third, and 3 is a quarter.",
  "layout.h": "Height in grid rows, about 70 pixels each. You can also drag the block's lower-right corner in the report.",
  groupId: "Place the block inside one of the report's labeled sections.",
  "appearance.tone": "A background color that signals meaning: info, success, warning, or danger. Neutral is a plain card.",
  "appearance.emphasis": "Subtle tints the background lightly. Prominent uses a stronger fill, for status boxes that should stand out.",
  "appearance.label": "Short status text shown with the tone, such as “On track”, so the meaning is not carried by color alone.",
  "appearance.rules": "Set the tone from the data. A JSON list of rules checked in order; the first match wins, so put the most severe first. Example: [{\"column\": \"pct_full\", \"operator\": \"greater_than\", \"value\": 90, \"tone\": \"danger\", \"label\": \"Over capacity\"}]. Operators: less_than, less_than_or_equal, greater_than, greater_than_or_equal, equal, not_equal, and between (add value2 as the upper bound).",
};

const BLOCK_HELP: Partial<Record<BlockType, Record<string, string>>> = {
  markdown: {
    markdown: "The block's text, in Markdown: # headings, **bold**, - lists, [links](https://…), and images with ![description](https://…). Report parameters such as $city are replaced with their current value.",
  },
  kpi: {
    valueColumn: "The number shown large in the block. It is read from the first row of the dataset, so make sure the query returns the row you want first.",
    labelColumn: "Optional. A column whose first-row value appears in small text under the number, such as a date or region. Without it, the block title appears there.",
    lowColumn: "Optional. Together with a high bound, draws a small bar under the number showing where the value sits in a range — such as a normal range, or last year's minimum and maximum. Read from the first row.",
    highColumn: "Optional. The upper end of the range bar. The bar appears only when both a low and a high bound are set.",
    targetColumn: "Optional. A goal drawn as a tick on the range bar. Shown only when low and high bounds are set.",
    rangeLabel: "Text under the range bar that says what it is, such as “Normal range”. Defaults to “Range”.",
  },
  sparkline: {
    valueColumn: "The numbers drawn as the trend line, one point per row in the order the query returns them — so sort the query, usually by date.",
    headlineValueColumn: "Optional. Show a different column's value as the big number instead of the plotted value. Read from the headline row.",
    labelColumn: "Optional. A column shown with the headline number, such as the date of the headline row.",
    showValue: "Show the headline number above the line. Turn off for a line-only box.",
    splitColumn: "Optional. Divides the line in two, such as observed and forecast. The first row where this column is true (or says forecast, future, yes, after, or 1) starts the second part, marked by a vertical line.",
    headlineRow: "Which row supplies the headline number and label. Automatic uses the last row — or, with a split, the last row before it. First forecast uses the first row after the split.",
    splitLabel: "Text shown when a reader hovers the vertical split line, such as “Now” or “Forecast begins”.",
    color: "Color of the line (before the split, if there is one). Any CSS color, such as #2563eb or teal.",
    splitColor: "Color of the line from the split onward. Any CSS color, such as #94a3b8.",
  },
  table: {
    columns: "The columns to show, in order, separated by commas. Leave empty to show every column. Keep to what readers need so the table fits without scrolling sideways.",
    pageSize: "The most rows to show. The dataset may return more; readers see this many, with a note of the total.",
  },
  ai_narrative: {
    instruction: "What the AI should write about this data, such as “Summarize the week's biggest changes in two sentences.” It sees only this dataset and cannot change the report.",
    columns: "The columns sent to the AI, separated by commas. Leave empty to send all of them; fewer columns keep the writing focused and the request cheaper.",
    maxRows: "The most rows sent to the AI, from 1 to 100. Summarize in the query rather than sending raw detail.",
    refreshPolicy: "Manual keeps the text until you regenerate it. When data changes rewrites it whenever a refresh brings different data, which uses your AI key each time.",
  },
  small_multiples: {
    facetColumn: "Draws one small chart per value of this column, such as one per city, all on matching axes so they are easy to compare.",
    xColumn: "The horizontal axis of each small chart, usually a date.",
    yColumn: "The value on the vertical axis of each small chart.",
    colorColumn: "Optional. Draws a separate colored line for each value of this column inside every small chart.",
    xType: "What the horizontal values are. Temporal (the default) is for dates and times, quantitative for numbers, ordinal for ordered categories, and nominal for unordered labels.",
    mark: "How values are drawn: line (the default), area, bar, or point.",
    facetColumns: "How many small charts per row, from 1 to 6. Defaults to 3.",
    sharedY: "Use the same vertical scale in every chart so their values compare honestly. Turn off only when the charts measure different units or very different sizes.",
    referenceValue: "Optional. Draws a dashed horizontal line at this number in every chart, such as a target or threshold.",
    referenceLabel: "Text shown next to the reference line.",
  },
  bullet: {
    categoryColumn: "One bar per row, labeled with this column — such as each region or product.",
    valueColumn: "The actual value, drawn as the dark bar.",
    targetColumn: "The goal, drawn as a vertical tick across the bar.",
    rangeColumns: "Optional. Up to three columns, separated by commas, giving the upper edge of shaded bands behind the bar — such as poor, fair, and good. List the widest band first.",
    color: "Color of the value bar. Any CSS color, such as #2563eb.",
  },
  slopegraph: {
    categoryColumn: "One line per row, labeled with this column.",
    startColumn: "The value at the left end of each line — the earlier period.",
    endColumn: "The value at the right end of each line — the later period.",
    colorColumn: "Optional. Colors each line by this column's value.",
    startLabel: "Heading over the left side, such as 2023. Defaults to the start column's name.",
    endLabel: "Heading over the right side, such as 2024. Defaults to the end column's name.",
  },
  range_dot: {
    categoryColumn: "One horizontal line per row, labeled with this column.",
    lowColumn: "The left end of each line, such as a minimum or lower estimate.",
    highColumn: "The right end of each line, such as a maximum or upper estimate.",
    valueColumn: "Optional. A highlighted dot on each line marking the current or typical value.",
    color: "Color of the highlighted value dot. Any CSS color, such as #2563eb.",
    showValues: "Print the low, current, and high numbers. Automatic shows them when there are six or fewer rows.",
  },
  map: {
    geometryColumn: "A shape column (WKB or GeoJSON) holding points, lines, or areas. When set, it is used instead of latitude and longitude.",
    latitudeColumn: "Each point's latitude, in degrees. Needed with longitude when there is no geometry column.",
    longitudeColumn: "Each point's longitude, in degrees. Needed with latitude when there is no geometry column.",
    labelColumn: "Optional. A name for each feature, shown in the popup when a reader clicks it.",
    colorColumn: "Optional. Colors features by this column's values and adds a legend.",
    tooltipColumns: "The columns listed in the popup when a reader clicks a feature, separated by commas. Defaults to the label and color columns.",
    palette: "The colors used for the color column's values, in order, separated by commas.",
    basemap: "The background map. OpenStreetMap shows streets and places; None shows only your data.",
    style: "Advanced drawing options as JSON: color, fillColor, opacity and fillOpacity (0 to 1), weight (line width), and radius (point size). Example: {\"radius\": 5, \"fillOpacity\": 0.5}.",
  },
  perspective: {
    config: "Advanced: the saved Perspective view as JSON. It is easier to arrange the pivot table in the block itself — your changes there are saved here automatically.",
  },
  chart: {
    chartMode: "Basic builds the chart from the choices below. Advanced edits the full Vega-Lite definition, for anything Basic cannot express.",
    spec: "The full chart definition in Vega-Lite JSON, without data — Cupola supplies the dataset's rows. See vega.github.io/vega-lite for examples.",
  },
};

/** Help for the basic chart builder, keyed by its `BasicChartConfig` field. */
const CHART_BUILDER_HELP: Record<string, string> = {
  mark: "How values are drawn: bar, line, area, point, or tick.",
  xField: "The column for the horizontal axis.",
  yField: "The column for the vertical axis.",
  xType: "What the axis values are. Quantitative is for numbers, temporal for dates and times, ordinal for ordered categories, and nominal for unordered labels. Automatic uses the governed model's type when there is one; otherwise an unaggregated column is treated as a category.",
  xAggregate: "Combine rows that share a value on the other axis: count, sum, mean (average), median, min, or max. None plots every row as it is.",
  xTitle: "The axis title. Leave blank to use the column name.",
  colorField: "Optional. Splits the data into colored series by this column, with a legend.",
  facetRow: "Optional. Repeats the chart in a stacked row for each value of this column.",
  facetColumn: "Optional. Repeats the chart side by side for each value of this column.",
  fixedColor: "One color for every mark when there is no color/series column. Any CSS color, such as #2563eb.",
  palette: "A named color scheme for the series, such as tableau10, category10, set2, or blues.",
  zero: "Whether the vertical axis starts at zero. Automatic starts number axes at zero; Fit data zooms in on the values' range, which suits lines whose changes are small next to their size.",
  legend: "Show a key explaining the series colors.",
  legendTitle: "The heading over the legend. Leave blank to use the column name.",
};
CHART_BUILDER_HELP.yType = CHART_BUILDER_HELP.xType;
CHART_BUILDER_HELP.yAggregate = CHART_BUILDER_HELP.xAggregate;
CHART_BUILDER_HELP.yTitle = CHART_BUILDER_HELP.xTitle;

export function reportBlockFieldHelp(type: BlockType, field: string): string | undefined {
  return BLOCK_HELP[type]?.[field] ?? SHARED_HELP[field];
}

export function reportChartBuilderHelp(field: string): string | undefined {
  return CHART_BUILDER_HELP[field];
}
