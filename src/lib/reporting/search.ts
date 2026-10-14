/** Search names and descriptions only; bodies and SQL are never searched or executed. */
export function matchesReport(title: string, metadata: { description?: string } | null | undefined, query: string): boolean {
  const text = [title, metadata?.description ?? ''].join('\n').normalize('NFC').toLowerCase();
  return text.includes(query.trim().normalize('NFC').toLowerCase());
}
