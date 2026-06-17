import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import { buildSqlExtensions, EditorState, EditorView } from "@/lib/editor/cm-sql-setup";
import type { CompletionSource } from "@codemirror/autocomplete";
import { statementAtCursor, type SqlStatement } from "@/lib/editor/sql-statements";

export interface CodeMirrorSqlHandle {
  getDoc: () => string;
  /** Currently selected text, or "" if the selection is empty. */
  getSelectionText: () => string;
  /** The trimmed statement under the primary cursor (semicolon-aware). */
  getStatementAtCursor: () => SqlStatement | null;
  /** Replace the whole document. */
  setDoc: (text: string) => void;
  /** Insert text at the primary cursor (replacing any selection). */
  insertAtCursor: (text: string) => void;
  /** Move the selection to [from, to] and scroll it into view. */
  selectRange: (from: number, to: number) => void;
  focus: () => void;
}

interface Props {
  /** Initial document — only read on mount. Parent should key the component
   *  by the active document id so switching tabs creates a fresh editor. */
  initialDoc: string;
  /** Fires (debounced upstream) with the full document on every change. */
  onChange?: (doc: string) => void;
  /** Run the statement at the cursor — bound to Cmd/Ctrl+Enter. */
  onRunStatement?: () => void;
  /** Fires when the selection emptiness changes (true = non-empty selection). */
  onSelectionChange?: (hasSelection: boolean) => void;
  completionSource?: CompletionSource | null;
  fontSize?: number;
}

/**
 * Thin React wrapper around a CodeMirror 6 EditorView. The view is created
 * once in an effect (never during render → no SSR/hydration mismatch) and
 * controlled imperatively via the ref handle. Callbacks are read through refs
 * so the keymap/update-listener always see the latest props without
 * recreating the editor.
 */
export const CodeMirrorSql = forwardRef<CodeMirrorSqlHandle, Props>(function CodeMirrorSql(
  { initialDoc, onChange, onRunStatement, onSelectionChange, completionSource, fontSize },
  ref,
) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  const onRunRef = useRef(onRunStatement);
  const onSelRef = useRef(onSelectionChange);
  onChangeRef.current = onChange;
  onRunRef.current = onRunStatement;
  onSelRef.current = onSelectionChange;

  useEffect(() => {
    if (!hostRef.current) return;
    const state = EditorState.create({
      doc: initialDoc,
      extensions: [
        ...buildSqlExtensions({
          onRunStatement: () => {
            onRunRef.current?.();
            return true;
          },
          completionSource: completionSource ?? null,
          fontSize,
        }),
        EditorView.updateListener.of((u) => {
          if (u.docChanged) onChangeRef.current?.(u.state.doc.toString());
          if (u.selectionSet || u.docChanged) {
            onSelRef.current?.(!u.state.selection.main.empty);
          }
        }),
      ],
    });
    const view = new EditorView({ state, parent: hostRef.current });
    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // initialDoc/completionSource/fontSize are intentionally mount-only; the
    // parent re-keys the component to apply a new document.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useImperativeHandle(ref, (): CodeMirrorSqlHandle => ({
    getDoc: () => viewRef.current?.state.doc.toString() ?? "",
    getSelectionText: () => {
      const view = viewRef.current;
      if (!view) return "";
      const sel = view.state.selection.main;
      return sel.empty ? "" : view.state.sliceDoc(sel.from, sel.to);
    },
    getStatementAtCursor: () => {
      const view = viewRef.current;
      if (!view) return null;
      const doc = view.state.doc.toString();
      const pos = view.state.selection.main.head;
      return statementAtCursor(doc, pos);
    },
    setDoc: (text: string) => {
      const view = viewRef.current;
      if (!view) return;
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } });
    },
    insertAtCursor: (text: string) => {
      const view = viewRef.current;
      if (!view) return;
      const sel = view.state.selection.main;
      view.dispatch({
        changes: { from: sel.from, to: sel.to, insert: text },
        selection: { anchor: sel.from + text.length },
      });
      view.focus();
    },
    selectRange: (from: number, to: number) => {
      const view = viewRef.current;
      if (!view) return;
      const max = view.state.doc.length;
      const a = Math.max(0, Math.min(from, max));
      const b = Math.max(0, Math.min(to, max));
      view.dispatch({ selection: { anchor: a, head: b }, scrollIntoView: true });
      view.focus();
    },
    focus: () => viewRef.current?.focus(),
  }), []);

  return <div ref={hostRef} className="h-full w-full overflow-hidden" />;
});
