/**
 * Pure SQL statement parsing for the query editor.
 *
 * Splits a multi-statement SQL document on top-level semicolons while
 * respecting single-quoted strings ('' escaping), double-quoted identifiers
 * ("" escaping), dollar-quoted strings ($tag$...$tag$), line comments (--)
 * and block comments (/* *​/). DuckDB-flavoured but deliberately conservative:
 * when in doubt it keeps text together rather than splitting inside a literal.
 *
 * No CodeMirror dependency — operates on a plain string + cursor offset so it
 * is trivially unit-testable.
 */

export interface SqlStatement {
  /** Trimmed statement text, ready to execute. */
  text: string;
  /** Absolute offset of the first non-whitespace character in the source. */
  from: number;
  /** Absolute offset just past the last non-whitespace character. */
  to: number;
}

/**
 * Split `sql` into top-level statements. Segments with no executable code —
 * blank, or nothing but comments — are dropped. Offsets are into the original
 * string.
 */
export function splitStatements(sql: string): SqlStatement[] {
  const segments = rawSegments(sql);
  const out: SqlStatement[] = [];
  for (const seg of segments) {
    const trimmed = runnableRange(sql, seg.from, seg.to);
    if (trimmed) out.push(trimmed);
  }
  return out;
}

/**
 * Return the statement the cursor at `pos` belongs to. Semicolons attach to
 * the statement they terminate. If the cursor sits in a segment with nothing
 * to run — trailing whitespace, or a block of commented-out SQL below the last
 * semicolon — the nearest runnable statement (preferring the one before the
 * cursor) is returned. Returns null if the document has no runnable statement.
 */
export function statementAtCursor(sql: string, pos: number): SqlStatement | null {
  const segments = rawSegments(sql);
  if (segments.length === 0) return null;

  // Find the raw segment whose [from, to] range contains pos (semicolon
  // inclusive). Segments tile the document, so exactly one matches.
  let idx = segments.findIndex((s) => pos >= s.from && pos <= s.to);
  if (idx === -1) idx = segments.length - 1;

  const containing = runnableRange(sql, segments[idx].from, segments[idx].to);
  if (containing) return containing;

  // Nothing to run here — scan backward then forward for a real statement.
  for (let i = idx - 1; i >= 0; i--) {
    const s = runnableRange(sql, segments[i].from, segments[i].to);
    if (s) return s;
  }
  for (let i = idx + 1; i < segments.length; i++) {
    const s = runnableRange(sql, segments[i].from, segments[i].to);
    if (s) return s;
  }
  return null;
}

interface RawSegment {
  from: number;
  /** Index of the terminating semicolon, or sql.length for the last segment. */
  to: number;
}

/** Tile the document into raw segments at top-level semicolons. */
function rawSegments(sql: string): RawSegment[] {
  const segments: RawSegment[] = [];
  let start = 0;
  let i = 0;
  const n = sql.length;

  while (i < n) {
    const ch = sql[i];

    // Line comment
    if (ch === "-" && sql[i + 1] === "-") {
      i += 2;
      while (i < n && sql[i] !== "\n") i++;
      continue;
    }
    // Block comment (non-nesting, matching DuckDB)
    if (ch === "/" && sql[i + 1] === "*") {
      i += 2;
      while (i < n && !(sql[i] === "*" && sql[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    // Single-quoted string ('' escapes a quote)
    if (ch === "'") {
      i++;
      while (i < n) {
        if (sql[i] === "'" && sql[i + 1] === "'") { i += 2; continue; }
        if (sql[i] === "'") { i++; break; }
        i++;
      }
      continue;
    }
    // Double-quoted identifier ("" escapes a quote)
    if (ch === '"') {
      i++;
      while (i < n) {
        if (sql[i] === '"' && sql[i + 1] === '"') { i += 2; continue; }
        if (sql[i] === '"') { i++; break; }
        i++;
      }
      continue;
    }
    // Dollar-quoted string: $tag$ ... $tag$ (tag may be empty: $$)
    if (ch === "$") {
      const tag = matchDollarTag(sql, i);
      if (tag !== null) {
        const close = sql.indexOf(tag, i + tag.length);
        i = close === -1 ? n : close + tag.length;
        continue;
      }
    }
    // Top-level statement terminator
    if (ch === ";") {
      segments.push({ from: start, to: i });
      start = i + 1;
      i++;
      continue;
    }
    i++;
  }
  // Trailing segment after the last semicolon (or the whole doc if none).
  segments.push({ from: start, to: n });
  return segments;
}

/** If a dollar-quote opening tag starts at `i`, return it (e.g. "$$", "$foo$"); else null. */
function matchDollarTag(sql: string, i: number): string | null {
  if (sql[i] !== "$") return null;
  let j = i + 1;
  while (j < sql.length && /[A-Za-z0-9_]/.test(sql[j])) j++;
  if (sql[j] === "$") return sql.slice(i, j + 1);
  return null;
}

/**
 * Trim whitespace from a [from, to) range, returning trimmed text + offsets —
 * or null when the range holds nothing DuckDB would execute.
 *
 * "Nothing to execute" means blank OR comments only. Sending a comment-only
 * string to DuckDB is not an error; it just yields no result, so a document
 * that parks commented-out variants below the live query would answer
 * Ctrl+Enter with an empty grid. Leading comments are kept in the returned
 * text — a header above a statement belongs to it, and DuckDB ignores them.
 */
function runnableRange(sql: string, from: number, to: number): SqlStatement | null {
  let s = from;
  let e = to;
  while (s < e && /\s/.test(sql[s])) s++;
  while (e > s && /\s/.test(sql[e - 1])) e--;
  if (s >= e) return null;
  if (!hasCode(sql, s, e)) return null;
  return { text: sql.slice(s, e), from: s, to: e };
}

/** Whether [from, to) contains any character outside whitespace and comments. */
function hasCode(sql: string, from: number, to: number): boolean {
  let i = from;
  while (i < to) {
    const ch = sql[i];
    if (ch === "-" && sql[i + 1] === "-") {
      i += 2;
      while (i < to && sql[i] !== "\n") i++;
      continue;
    }
    if (ch === "/" && sql[i + 1] === "*") {
      i += 2;
      while (i < to && !(sql[i] === "*" && sql[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    if (!/\s/.test(ch)) return true;
    i++;
  }
  return false;
}
