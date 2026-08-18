export interface ReportPromotion {
  sql: string;
  title?: string;
  chartSpec?: Record<string, any>;
  markdown?: string;
}

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
