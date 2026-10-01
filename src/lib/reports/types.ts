export type ReportParameterType =
  | "text"
  | "number"
  | "boolean"
  | "date"
  | "date_range"
  | "select"
  | "multi_select";

export type ReportParameterValue = string | number | boolean | null | (string | number)[] | { start: string | null; end: string | null };

export interface ReportParameter {
  id: string;
  key: string;
  label: string;
  type: ReportParameterType;
  description?: string;
  required?: boolean;
  defaultValue: ReportParameterValue;
}

interface ReportDatasetBase {
  id: string;
  name: string;
  description?: string;
}

export interface ReportSemanticParameterRef {
  report_parameter: string;
  part?: "start" | "end";
}

/** A semantic compiler request with tagged report-parameter values. The tags
 * are resolved before the public compiler sees the request. */
export type ReportSemanticQueryTemplate = Record<string, any>;

export interface ReportSemanticDataset extends ReportDatasetBase {
  kind: "semantic";
  query: ReportSemanticQueryTemplate;
  sql?: never;
  /** Fingerprint accepted by the author. A mismatch is visible but does not
   * suppress a successful refresh. */
  acceptedModelFingerprint?: string;
}

/** What parameter binding reads from a report: its declared parameters. */
export interface ReportParameterScope {
  parameters: ReportParameter[];
}
