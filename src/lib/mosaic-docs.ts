/* ── Mosaic spec authoring guide (LLM-targeted) ──
 *
 * Bundles the comprehensive Mosaic vgplot spec reference at build time as a
 * single ~43KB markdown string. Returned verbatim by the `read_chart_docs`
 * tool so Claude can read it once per conversation and use it as in-context
 * reference material when authoring chart specs.
 *
 * Source: ~/Development/mosaic/MOSAIC_SPEC_LLM.md. The doc is *pinned* to
 * the Mosaic version we depend on — re-copy when bumping @uwdata/mosaic-core.
 *
 * Vite's `?raw` query inlines the file as a string at build time, so the
 * tool's response is instant (no network round-trip) and the doc lives in
 * whichever chunk imports this module (currently the AskAIChat chunk).
 */
import mosaicSpecGuide from "./mosaic-spec.md?raw";

export function getChartDocs(): string {
  return mosaicSpecGuide;
}
