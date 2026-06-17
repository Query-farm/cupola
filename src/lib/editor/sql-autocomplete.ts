/**
 * CodeMirror completion source backed by DuckDB's `sql_auto_complete` table
 * function. Mirrors the decode used by the xterm shell (shell-init.ts) so the
 * editor and terminal offer identical suggestions.
 *
 * Robustness rules: never throw into the editor, bail fast when the query
 * bridge is not ready, and only fire on an explicit request or after a word
 * character so we don't issue a worker round-trip on every keystroke.
 */
import type { CompletionContext, CompletionResult } from "@codemirror/autocomplete";
import { tableFromIPC } from "apache-arrow";
import { bridge } from "@/lib/shell-bridge";

export async function sqlAutoCompleteSource(
  context: CompletionContext,
): Promise<CompletionResult | null> {
  const q = bridge.query;
  if (!q) return null;

  // Only complete when explicitly invoked (Ctrl-Space) or while typing a word.
  const word = context.matchBefore(/[\w."]*/);
  if (!context.explicit && (!word || word.from === word.to)) return null;

  const textToCursor = context.state.sliceDoc(0, context.pos);
  if (!textToCursor.trim()) return null;

  let result;
  try {
    result = await q(`CALL sql_auto_complete('${textToCursor.replace(/'/g, "''")}')`);
  } catch {
    return null;
  }
  if (!result.ok || !result.arrowBuffers?.length) return null;

  const options: { label: string; boost: number }[] = [];
  // suggestion_start is a byte offset into the submitted text; DuckDB's
  // suggestions are ASCII keywords/identifiers so this lines up with char
  // offsets in the common case. We clamp and fall back to the matched word
  // start if the value looks wrong.
  let suggestionStart = word ? word.from : context.pos;
  try {
    const table = tableFromIPC(new Uint8Array(result.arrowBuffers[0]));
    const sugCol = table.getChild("suggestion");
    const startCol = table.getChild("suggestion_start");
    const scoreCol = table.getChild("suggestion_score");
    for (let i = 0; i < table.numRows; i++) {
      const label = sugCol ? String(sugCol.get(i)) : "";
      if (!label) continue;
      options.push({ label, boost: scoreCol ? Number(scoreCol.get(i)) : 0 });
      if (i === 0 && startCol) {
        const s = Number(startCol.get(i));
        if (Number.isFinite(s) && s >= 0 && s <= context.pos) suggestionStart = s;
      }
    }
  } catch {
    return null;
  }

  if (options.length === 0) return null;
  return { from: suggestionStart, options, validFor: /[\w."]*$/ };
}
