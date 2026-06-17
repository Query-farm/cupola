/**
 * CodeMirror 6 extension bundle for the SQL editor. Kept separate from the
 * React wrapper so the editor configuration is in one place and unit-reachable.
 */
import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, drawSelection, rectangularSelection, crosshairCursor } from "@codemirror/view";
import { EditorState, type Extension } from "@codemirror/state";
import { history, defaultKeymap, historyKeymap, indentWithTab } from "@codemirror/commands";
import { sql, PostgreSQL } from "@codemirror/lang-sql";
import {
  autocompletion,
  completionKeymap,
  closeBrackets,
  closeBracketsKeymap,
  type CompletionSource,
} from "@codemirror/autocomplete";
import { bracketMatching, indentOnInput, syntaxHighlighting, defaultHighlightStyle } from "@codemirror/language";

export interface SqlSetupOptions {
  /** Called when Mod-Enter (Cmd/Ctrl+Enter) is pressed — run statement at cursor. */
  onRunStatement: () => boolean;
  /** Completion source for autocomplete, or null to disable. */
  completionSource?: CompletionSource | null;
  fontSize?: number;
}

/** A light theme that inherits the app's CSS variables so the editor matches
 *  the surrounding chrome (and dark mode) without a separate theme file. */
function cupolaTheme(fontSize: number): Extension {
  return EditorView.theme({
    "&": {
      fontSize: `${fontSize}px`,
      height: "100%",
      backgroundColor: "var(--color-card, #fff)",
      color: "var(--color-foreground, #1a1a1a)",
    },
    ".cm-content": {
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
      caretColor: "var(--color-foreground, #1a1a1a)",
    },
    ".cm-scroller": { overflow: "auto" },
    ".cm-gutters": {
      backgroundColor: "transparent",
      color: "var(--color-muted-foreground, #888)",
      border: "none",
    },
    ".cm-activeLine": { backgroundColor: "color-mix(in srgb, var(--color-accent, #4a7c23) 8%, transparent)" },
    ".cm-activeLineGutter": { backgroundColor: "transparent" },
    "&.cm-focused": { outline: "none" },
    ".cm-selectionBackground, ::selection": {
      backgroundColor: "color-mix(in srgb, var(--color-accent, #4a7c23) 25%, transparent)",
    },
    "&.cm-focused .cm-selectionBackground": {
      backgroundColor: "color-mix(in srgb, var(--color-accent, #4a7c23) 30%, transparent)",
    },
  });
}

export function buildSqlExtensions(opts: SqlSetupOptions): Extension[] {
  const exts: Extension[] = [
    lineNumbers(),
    highlightActiveLineGutter(),
    highlightActiveLine(),
    history(),
    drawSelection(),
    rectangularSelection(),
    crosshairCursor(),
    indentOnInput(),
    bracketMatching(),
    closeBrackets(),
    syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
    sql({ dialect: PostgreSQL, upperCaseKeywords: false }),
    cupolaTheme(opts.fontSize ?? 13),
    EditorView.lineWrapping,
    keymap.of([
      // Mod-Enter runs the statement at the cursor. Returning the handler's
      // value lets CodeMirror know the key was consumed.
      { key: "Mod-Enter", preventDefault: true, run: () => opts.onRunStatement() },
      ...closeBracketsKeymap,
      ...defaultKeymap,
      ...historyKeymap,
      ...completionKeymap,
      indentWithTab,
    ]),
  ];

  if (opts.completionSource) {
    exts.push(
      autocompletion({
        override: [opts.completionSource],
        activateOnTyping: true,
      }),
    );
  }

  return exts;
}

export { EditorState, EditorView };
