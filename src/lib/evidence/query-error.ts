/** SQL context travels beside the original error, never parsed back out of its text. */
export interface ReportQueryFailure {
  phase: 'setup' | 'render';
  message: string;
  sql: string;
  /** Parameterized SQL actually sent to the engine, when different from the source. */
  executedSql?: string;
  statementIndex?: number;
  statementCount?: number;
  startLine?: number;
  endLine?: number;
  name?: string;
}

export function queryFailureTitle(failure: ReportQueryFailure): string {
  const parts = [failure.phase === 'setup' ? 'Setup SQL failed' : 'Report query failed'];
  if (failure.statementIndex !== undefined) parts.push(`statement ${failure.statementIndex} of ${failure.statementCount}`);
  if (failure.name) parts.push(failure.name);
  if (failure.startLine !== undefined) parts.push(failure.endLine && failure.endLine !== failure.startLine
    ? `lines ${failure.startLine}–${failure.endLine}` : `line ${failure.startLine}`);
  return parts.join(' · ');
}

/** Long validation errors and tracebacks stay intact in details, not in the headline. */
export function queryErrorSummary(message: string): string {
  const firstLine = message.split(/\r?\n/).find(line => line.trim())?.trim() || 'Query failed';
  return firstLine.length > 300 ? `${firstLine.slice(0, 300)}…` : firstLine;
}

export function queryFailureText(failure: ReportQueryFailure): string {
  return [queryFailureTitle(failure), `Failed SQL:\n${failure.sql}`,
    ...(failure.executedSql && failure.executedSql !== failure.sql ? [`Executed SQL (parameters bound separately):\n${failure.executedSql}`] : []),
    `Full error details:\n${failure.message}`].join('\n\n');
}
