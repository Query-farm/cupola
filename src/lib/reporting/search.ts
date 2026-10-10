/** Match public metadata only; bodies and SQL are never searched or executed. */
export function matchesReport(title: string, metadata: { description?: string; tags?: string[] } | null | undefined, query: string, tag = ''): boolean {
  const text = [title, metadata?.description ?? '', ...(metadata?.tags ?? [])].join('\n').normalize('NFC').toLowerCase();
  return text.includes(query.trim().normalize('NFC').toLowerCase()) && (!tag || Boolean(metadata?.tags?.includes(tag)));
}
export const reportTags = (rows: Array<{ tags?: string[] } | null | undefined>) => [...new Set(rows.flatMap(r => r?.tags ?? []))].sort((a, b) => a.localeCompare(b));
