/**
 * Where is the cursor, relative to function calls? A forward scan over the
 * text before the cursor (strings, quoted identifiers and comments skipped)
 * that keeps a stack of open calls, so `f(a, g(b, |` is inside `g`, argument 1.
 */

export interface CallContext {
  /** Identifier chain naming the function, unquoted (`["cat", "schema", "fn"]`). */
  nameParts: string[];
  /** Offset of the call's `(`. */
  openParen: number;
  /** Zero-based argument the cursor is in, counting every comma. */
  argIndex: number;
  /** Zero-based index among positional arguments (those not written `name := …`). */
  positionalIndex: number;
  /** Set when the current argument is written `name := …` / `name => …`. */
  namedArg?: string;
}

interface Frame extends CallContext {
  /** Positional arguments completed before the current one. */
  positionalDone: number;
  /** Tokens seen in the current argument so far (for spotting `name :=`). */
  argTokens: number;
  lastIdent?: string;
}

// Words that open a parenthesis without being a call: `x IN (…)`, `OVER (…)`.
const NOT_CALLS = new Set([
  "all", "and", "any", "as", "exists", "filter", "from", "in", "join", "not", "on", "or", "over",
  "select", "table", "using", "values", "where", "with", "within",
]);

// How far back to look. A call open further back than this is not one the
// author is typing in.
const MAX_SCAN = 20_000;

/** The innermost call the position is inside, or null. */
export function findCallAtPos(doc: string, pos: number): CallContext | null {
  const start = Math.max(0, pos - MAX_SCAN);
  const stack: (Frame | null)[] = [];
  // Identifier chain directly before the current token, e.g. a.b.c.
  let chain: string[] = [];
  let chainOpen = false; // last token was "." and the chain continues
  let i = start;
  const top = () => stack[stack.length - 1];
  const bumpTokens = () => { const f = top(); if (f) f.argTokens++; };

  while (i < pos) {
    const ch = doc[i];
    const next = doc[i + 1];
    if (ch === "-" && next === "-") {
      const nl = doc.indexOf("\n", i);
      if (nl < 0 || nl >= pos) return null; // cursor inside a comment
      i = nl + 1;
      continue;
    }
    if (ch === "/" && next === "*") {
      const end = doc.indexOf("*/", i + 2);
      if (end < 0 || end + 2 > pos) return null;
      i = end + 2;
      continue;
    }
    if (ch === "'") {
      let j = i + 1;
      for (;;) {
        const q = doc.indexOf("'", j);
        if (q < 0 || q >= pos) return null; // cursor inside a string
        if (doc[q + 1] === "'") { j = q + 2; continue; }
        i = q + 1;
        break;
      }
      chain = []; chainOpen = false; bumpTokens();
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let name = "";
      for (;;) {
        const q = doc.indexOf('"', j);
        if (q < 0 || q >= pos) return null;
        name += doc.slice(j, q);
        if (doc[q + 1] === '"') { name += '"'; j = q + 2; continue; }
        i = q + 1;
        break;
      }
      chain = chainOpen ? [...chain, name] : [name];
      chainOpen = false;
      const f = top(); if (f) { f.argTokens++; f.lastIdent = name; }
      continue;
    }
    if (/[A-Za-z_\u0080-￿]/.test(ch)) {
      let j = i + 1;
      while (j < pos && /[A-Za-z0-9_$\u0080-￿]/.test(doc[j])) j++;
      const word = doc.slice(i, j);
      chain = chainOpen ? [...chain, word] : [word];
      chainOpen = false;
      const f = top(); if (f) { f.argTokens++; f.lastIdent = word; }
      i = j;
      continue;
    }
    if (/\s/.test(ch)) { i++; continue; }
    if (ch === ".") {
      chainOpen = chain.length > 0;
      i++;
      continue;
    }
    if (ch === "(") {
      if (chain.length > 0 && !(chain.length === 1 && NOT_CALLS.has(chain[0].toLowerCase()))) {
        stack.push({ nameParts: chain, openParen: i, argIndex: 0, positionalIndex: 0, positionalDone: 0, argTokens: 0 });
      } else {
        bumpTokens();
        stack.push(null); // a grouping paren or subquery
      }
      chain = []; chainOpen = false;
      i++;
      continue;
    }
    if (ch === ")") {
      stack.pop();
      chain = []; chainOpen = false;
      bumpTokens();
      i++;
      continue;
    }
    if (ch === ",") {
      const f = top();
      if (f) {
        if (!f.namedArg) f.positionalDone++;
        f.argIndex++;
        f.namedArg = undefined;
        f.argTokens = 0;
        f.lastIdent = undefined;
      }
      chain = []; chainOpen = false;
      i++;
      continue;
    }
    if ((ch === ":" && next === "=") || (ch === "=" && next === ">")) {
      const f = top();
      if (f && f.argTokens === 1 && f.lastIdent) f.namedArg = f.lastIdent;
      chain = []; chainOpen = false;
      i += 2;
      continue;
    }
    if (ch === ";") {
      stack.length = 0;
    }
    chain = []; chainOpen = false;
    bumpTokens();
    i++;
  }

  for (let k = stack.length - 1; k >= 0; k--) {
    const f = stack[k];
    if (f === null) return null; // inside a subquery/grouping, not a call's argument list
    const { nameParts, openParen, argIndex, namedArg } = f;
    return { nameParts, openParen, argIndex, positionalIndex: f.positionalDone, ...(namedArg ? { namedArg } : {}) };
  }
  return null;
}

/** The identifier chain under `pos` when it names a call (`chain(`), with its
 *  extent. Used for hover. */
export function callNameAt(doc: string, pos: number): { nameParts: string[]; from: number; to: number } | null {
  const IDENT = /"(?:[^"]|"")*"|[A-Za-z_\u0080-￿][A-Za-z0-9_$\u0080-￿]*/y;
  const lineStart = doc.lastIndexOf("\n", pos - 1) + 1;
  let lineEnd = doc.indexOf("\n", pos);
  if (lineEnd < 0) lineEnd = doc.length;
  const line = doc.slice(lineStart, lineEnd);
  const CHAIN = /(?:"(?:[^"]|"")*"|[A-Za-z_\u0080-￿][A-Za-z0-9_$\u0080-￿]*)(?:\s*\.\s*(?:"(?:[^"]|"")*"|[A-Za-z_\u0080-￿][A-Za-z0-9_$\u0080-￿]*))*/g;
  for (const m of line.matchAll(CHAIN)) {
    const from = lineStart + m.index!;
    const to = from + m[0].length;
    if (pos < from || pos > to) continue;
    if (!/^\s*\(/.test(doc.slice(to, to + 64))) return null;
    const parts: string[] = [];
    let k = 0;
    const text = m[0];
    while (k < text.length) {
      if (text[k] === "." || /\s/.test(text[k])) { k++; continue; }
      IDENT.lastIndex = k;
      const id = IDENT.exec(text);
      if (!id) break;
      parts.push(id[0].startsWith('"') ? id[0].slice(1, -1).replace(/""/g, '"') : id[0]);
      k = IDENT.lastIndex;
    }
    return { nameParts: parts, from, to };
  }
  return null;
}
