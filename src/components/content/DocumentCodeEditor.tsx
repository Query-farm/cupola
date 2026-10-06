import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import { EditorState, Compartment, type Extension } from '@codemirror/state';
import { EditorView, keymap, lineNumbers, highlightActiveLine } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { markdown } from '@codemirror/lang-markdown';
import { PostgreSQL, sql } from '@codemirror/lang-sql';
import { syntaxHighlighting, defaultHighlightStyle, bracketMatching } from '@codemirror/language';
import { autocompletion, completionKeymap } from '@codemirror/autocomplete';
import { lintGutter, setDiagnostics } from '@codemirror/lint';

export interface DocumentCodeHandle {
  insert: (text: string) => void;
  goToLine: (line: number) => void;
}
export interface CodeIssue {
  line?: number;
  severity: 'error' | 'warning' | 'info';
  message: string;
}
interface Props {
  value: string;
  onChange: (value: string) => void;
  extensions: Extension;
  issues?: CodeIssue[];
  ariaLabel: string;
  className?: string;
}
const NO_ISSUES: CodeIssue[] = [];
export function markdownSupport(): Extension {
  const support = sql({ dialect: PostgreSQL });
  return [
    markdown({ codeLanguages: (info) => (/^sql\b/i.test(info) ? PostgreSQL.language : null) }),
    support.support,
  ];
}
export const DocumentCodeEditor = forwardRef<DocumentCodeHandle, Props>(function DocumentCodeEditor(
  { value, onChange, extensions, issues = NO_ISSUES, ariaLabel, className = '' },
  ref,
) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const latest = useRef(onChange);
  latest.current = onChange;
  const syncing = useRef(false);
  const language = useRef(new Compartment());
  useEffect(() => {
    const editor = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: value,
        extensions: [
          lineNumbers(),
          history(),
          highlightActiveLine(),
          bracketMatching(),
          lintGutter(),
          syntaxHighlighting(defaultHighlightStyle),
          language.current.of(extensions),
          autocompletion(),
          keymap.of([...completionKeymap, ...defaultKeymap, ...historyKeymap]),
          EditorView.lineWrapping,
          EditorView.contentAttributes.of({
            'aria-label': ariaLabel,
            'aria-multiline': 'true',
            role: 'textbox',
            spellcheck: 'false',
          }),
          EditorView.theme({
            '&': {
              height: '100%',
              fontSize: '13px',
              backgroundColor: 'var(--background)',
              color: 'var(--foreground)',
            },
            '.cm-scroller': { overflow: 'auto', fontFamily: 'ui-monospace, monospace' },
            '.cm-content': { padding: '12px 0', caretColor: 'var(--foreground)' },
            '.cm-gutters': {
              backgroundColor: 'var(--muted)',
              color: 'var(--muted-foreground)',
              border: 'none',
            },
            '.cm-activeLine': { backgroundColor: 'color-mix(in srgb, var(--primary) 6%, transparent)' },
            '.cm-tooltip': {
              backgroundColor: 'var(--popover)',
              color: 'var(--popover-foreground)',
              borderColor: 'var(--border)',
            },
            '.cm-tooltip-autocomplete ul li[aria-selected]': {
              backgroundColor: 'var(--accent)',
              color: 'var(--accent-foreground)',
            },
            '&.cm-focused': { outline: '2px solid var(--ring)', outlineOffset: '-2px' },
          }),
          EditorView.updateListener.of((update) => {
            if (update.docChanged && !syncing.current) latest.current(update.state.doc.toString());
          }),
        ],
      }),
    });
    view.current = editor;
    return () => {
      editor.destroy();
      view.current = null;
    };
  }, [ariaLabel]);
  useEffect(() => {
    view.current?.dispatch({ effects: language.current.reconfigure(extensions) });
  }, [extensions]);
  useEffect(() => {
    const editor = view.current;
    if (editor && editor.state.doc.toString() !== value) {
      syncing.current = true;
      try {
        editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: value } });
      } finally {
        syncing.current = false;
      }
    }
  }, [value]);
  useEffect(() => {
    const editor = view.current;
    if (editor)
      editor.dispatch(
        setDiagnostics(
          editor.state,
          issues
            .filter((issue) => issue.line)
            .map((issue) => {
              const line = editor.state.doc.line(Math.min(Math.max(1, issue.line!), editor.state.doc.lines));
              return { from: line.from, to: line.to, severity: issue.severity, message: issue.message };
            }),
        ),
      );
  }, [issues, value]);
  useImperativeHandle(
    ref,
    () => ({
      insert(text) {
        const editor = view.current;
        if (editor) {
          editor.dispatch({ ...editor.state.replaceSelection(text), scrollIntoView: true });
          editor.focus();
        }
      },
      goToLine(number) {
        const editor = view.current;
        if (editor) {
          const line = editor.state.doc.line(Math.min(Math.max(1, number), editor.state.doc.lines));
          editor.dispatch({
            selection: { anchor: line.from },
            effects: EditorView.scrollIntoView(line.from, { y: 'center' }),
          });
          editor.focus();
        }
      },
    }),
    [],
  );
  return (
    <div
      ref={host}
      className={`min-h-48 flex-1 overflow-hidden rounded-lg border border-input ${className}`}
    />
  );
});
