/** How the PDF export treats every component the Evidence core registers.
 *
 * `tests/unit/evidence-typst-catalog.test.ts` fails when the core registers a
 * component missing from this table, so a new Evidence component cannot fall
 * through to the generic path unnoticed.
 *
 * - `native`: drawn as its own Typst element (tables, metrics, callouts…).
 * - `chart`: an ECharts component, re-rendered as vector SVG.
 * - `container`: prints its visible content (tabs print the selected tab).
 * - `part`: rendered by its parent (a chart's series, a table's columns).
 * - `snapshot`: custom HTML with no Typst equivalent, captured as an image.
 * - `input`: a report control; its effect prints, the control does not.
 * - `omitted`: cannot be printed; a placeholder says so.
 */
export type Handling = 'native' | 'chart' | 'container' | 'part' | 'snapshot' | 'input' | 'omitted';

export const COMPONENT_HANDLING: Record<string, Handling> = {
  // Charts
  area_chart: 'chart', bar_chart: 'chart', bubble_chart: 'chart', calendar_heatmap: 'chart', candlestick: 'chart',
  chord_chart: 'chart', combo_chart: 'chart', custom_echart: 'chart', funnel_chart: 'chart', heatmap: 'chart',
  histogram: 'chart', horizontal_bar_chart: 'chart', line_chart: 'chart', pie_chart: 'chart', polar_chart: 'chart',
  radar_chart: 'chart', sankey_chart: 'chart', scatter_chart: 'chart', treemap: 'chart', waterfall_chart: 'chart',
  // Chart parts
  area: 'part', bar: 'part', bubble: 'part', line: 'part', scatter: 'part', series: 'part',
  reference_area: 'part', reference_line: 'part', reference_point: 'part',
  sparkline: 'native',
  // Tables
  table: 'native', dimension: 'part', measure: 'part', pivot: 'part', html_table: 'native',
  // Values
  big_value: 'native', value: 'native', delta: 'native', heat_grid: 'snapshot', progress_bars: 'snapshot',
  // Logic and structure
  if: 'container', else: 'container', else_if: 'container', repeat: 'container', conditional: 'container',
  partial: 'container', fill: 'container', slot: 'container',
  // Layout and content
  row: 'native', stack: 'container', tabs: 'container', tab: 'container', details: 'container',
  accordion: 'container', accordion_item: 'container', accordion_title: 'part', accordion_body_slot: 'container',
  callout: 'native', commentary: 'container', note: 'native', print_group: 'native', page_break: 'native',
  line_break: 'native', link: 'native', link_button: 'native', icon: 'native', fence: 'native',
  image: 'snapshot', logo: 'snapshot', clock: 'snapshot', html: 'snapshot',
  info: 'input', modal: 'input', download: 'input',
  audio: 'omitted', iframe: 'omitted',
  // Maps draw to WebGL; captured when the canvas allows it.
  map: 'snapshot', custom_map: 'snapshot', area_layer: 'part', heatmap_layer: 'part', point_layer: 'part',
  // Inputs
  benchmark_comparison: 'input', button_group: 'input', comparison_selector: 'input', date_grain_selector: 'input',
  dimension_grid: 'input', dropdown: 'input', dropdown_option: 'input', filter_bar: 'input', input_tabs: 'input',
  option: 'input', range_calendar: 'input', slider: 'input', table_filter: 'input', target_comparison: 'input',
  text_input: 'input', toggle: 'input', workflow_period: 'input',
};

export const handlingOf = (render: string): Handling | undefined => COMPONENT_HANDLING[render];

/** What happened to one rendered component during an export. */
export interface CoverageEntry { render: string; handling: Handling | 'unclassified'; outcome: 'printed' | 'skipped' | 'placeholder' }
