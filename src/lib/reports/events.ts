export interface SqlReportPromotion {
  kind?: "sql";
  sql: string;
  title?: string;
  chartSpec?: Record<string, any>;
  markdown?: string;
}

export interface SemanticReportPromotion {
  kind: "semantic";
  query: Record<string, any>;
  title?: string;
  markdown?: string;
}

export type ReportPromotion = SqlReportPromotion | SemanticReportPromotion;

let pending: ReportPromotion | null = null;

export function promoteToReport(item: ReportPromotion): void {
  pending = item;
  window.dispatchEvent(new CustomEvent("cupola:promote-report"));
}

export function consumeReportPromotion(): ReportPromotion | null {
  const item = pending;
  pending = null;
  return item;
}
