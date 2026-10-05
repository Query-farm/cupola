/**
 * Line diff for showing what changed between two versions of a text: report
 * revisions and the query editor's per-tab run history.
 */
/** A line diff (longest common subsequence), for showing what a revision changed. Past
 *  `maxCells` comparisons it gives up and returns null, so the caller shows before and after. */
export type DiffLine = { kind: 'same' | 'added' | 'removed'; text: string };
export function lineDiff(before: string, after: string, maxCells = 4_000_000): DiffLine[] | null {
  const a = before.split('\n'), b = after.split('\n');
  // Common head and tail cost nothing to compare.
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const x = a.slice(head, a.length - tail), y = b.slice(head, b.length - tail);
  if (x.length * y.length > maxCells) return null;
  const table = Array.from({ length: x.length + 1 }, () => new Uint32Array(y.length + 1));
  for (let i = x.length - 1; i >= 0; i--) for (let j = y.length - 1; j >= 0; j--) {
    table[i][j] = x[i] === y[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
  }
  const out: DiffLine[] = a.slice(0, head).map(text => ({ kind: 'same', text }));
  let i = 0, j = 0;
  while (i < x.length && j < y.length) {
    if (x[i] === y[j]) { out.push({ kind: 'same', text: x[i] }); i++; j++; }
    else if (table[i + 1][j] >= table[i][j + 1]) out.push({ kind: 'removed', text: x[i++] });
    else out.push({ kind: 'added', text: y[j++] });
  }
  while (i < x.length) out.push({ kind: 'removed', text: x[i++] });
  while (j < y.length) out.push({ kind: 'added', text: y[j++] });
  out.push(...a.slice(a.length - tail).map(text => ({ kind: 'same' as const, text })));
  return out;
}

/** Changed lines with `context` unchanged lines around each; `null` marks a
 *  run of lines left out. */
export function diffWithContext(lines: DiffLine[], context = 2): (DiffLine | null)[] {
  const keep = lines.map(() => false);
  lines.forEach((line, i) => {
    if (line.kind === 'same') return;
    for (let j = Math.max(0, i - context); j <= Math.min(lines.length - 1, i + context); j++) keep[j] = true;
  });
  const out: (DiffLine | null)[] = [];
  lines.forEach((line, i) => {
    if (keep[i]) out.push(line);
    else if (out.at(-1) !== null) out.push(null);
  });
  return out;
}
