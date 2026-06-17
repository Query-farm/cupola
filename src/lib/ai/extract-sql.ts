/**
 * Pull SQL out of an assistant's markdown reply. The agent is steered to put
 * its final query in a ```sql fenced block; this extracts the LAST fenced
 * block (sql-tagged or bare) so "apply to editor" affordances can act on it.
 */
export function extractSql(text: string): string | null {
  const fences = [...text.matchAll(/```(?:sql)?\s*\n([\s\S]*?)```/gi)];
  if (fences.length > 0) return fences[fences.length - 1][1].trim();
  return null;
}
