import type { ReportDocumentV1, ReportParameterValue } from "./types";
import { compressSql, decompressSql, toLatestBaseUrl } from "@/lib/share-query";
import { importReportJson } from "./store";

export const REPORT_PARAM = "report_z";
export const REPORT_VALUES_PARAM = "report_values";
export const MAX_REPORT_SHARE_CHARS = 100_000;
const PENDING_KEY = "cupola-pending-shared-report";

export async function buildShareReportUrl(
  report: ReportDocumentV1,
  opts: { serviceUrl?: string; values?: Record<string, ReportParameterValue>; baseUrl?: string } = {},
): Promise<string> {
  const packed = await compressSql(JSON.stringify(report));
  const fragment = new URLSearchParams({ [REPORT_PARAM]: packed });
  if (opts.values) fragment.set(REPORT_VALUES_PARAM, await compressSql(JSON.stringify(opts.values)));
  const base = opts.baseUrl ?? toLatestBaseUrl(window.location.origin + window.location.pathname);
  const url = new URL(base);
  if (opts.serviceUrl) url.searchParams.set("service", opts.serviceUrl);
  const result = `${url.toString()}#${fragment.toString()}`;
  if (result.length > MAX_REPORT_SHARE_CHARS) throw new Error("This report is too large for a share link. Export the JSON file instead.");
  return result;
}

export async function consumeSharedReport(): Promise<{ report: ReportDocumentV1; values?: Record<string, ReportParameterValue> } | null> {
  let raw: string | null = null;
  try {
    const hash = new URLSearchParams(window.location.hash.replace(/^#/, ""));
    const packed = hash.get(REPORT_PARAM);
    if (packed) {
      const reportJson = await decompressSql(packed);
      const valuesPacked = hash.get(REPORT_VALUES_PARAM);
      raw = JSON.stringify({ reportJson, valuesJson: valuesPacked ? await decompressSql(valuesPacked) : null });
      sessionStorage.setItem(PENDING_KEY, raw);
      hash.delete(REPORT_PARAM); hash.delete(REPORT_VALUES_PARAM);
      history.replaceState(null, "", `${location.pathname}${location.search}${hash.toString() ? `#${hash}` : ""}`);
    } else raw = sessionStorage.getItem(PENDING_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return { report: importReportJson(parsed.reportJson), values: parsed.valuesJson ? JSON.parse(parsed.valuesJson) : undefined };
  } catch {
    return null;
  }
}

export function clearSharedReport(): void {
  try { sessionStorage.removeItem(PENDING_KEY); } catch {}
}
