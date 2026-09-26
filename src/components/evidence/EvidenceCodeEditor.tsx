import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import { EditorState } from '@codemirror/state';
import { EditorView, keymap, lineNumbers, highlightActiveLine, Decoration, ViewPlugin, type DecorationSet } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { markdown } from '@codemirror/lang-markdown';
import { PostgreSQL, sql } from '@codemirror/lang-sql';
import { syntaxHighlighting, defaultHighlightStyle, bracketMatching } from '@codemirror/language';
import { autocompletion, completionKeymap } from '@codemirror/autocomplete';
import { lintGutter, setDiagnostics } from '@codemirror/lint';
import { evidenceCompletion, type EvidenceIssue } from '../../lib/evidence/editor-support';

export interface EvidenceCodeHandle { insert: (text: string) => void; goToLine: (line: number) => void }
interface Props { value: string; onChange: (value: string) => void; language: 'document' | 'data'; parameters: string[]; issues: EvidenceIssue[]; ariaLabel?: string }
const markdocTags = ViewPlugin.fromClass(class {
  decorations: DecorationSet;
  constructor(view: EditorView) { this.decorations = this.highlight(view); }
  update(update: { docChanged: boolean; view: EditorView }) { if (update.docChanged) this.decorations = this.highlight(update.view); }
  highlight(view: EditorView) {
    return Decoration.set([...view.state.doc.toString().matchAll(/\{%[\s\S]*?%\}/g)].map(match =>
      Decoration.mark({ class: 'cm-evidence-tag' }).range(match.index!, match.index! + match[0].length)));
  }
}, { decorations: instance => instance.decorations });

export const EvidenceCodeEditor = forwardRef<EvidenceCodeHandle, Props>(function EvidenceCodeEditor({ value, onChange, language, parameters, issues, ariaLabel }, ref) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const latest = useRef({ onChange, parameters }); latest.current = { onChange, parameters };
  useEffect(() => {
    const sqlSupport = sql({ dialect: PostgreSQL });
    const complete = (context: Parameters<typeof evidenceCompletion>[0]) => evidenceCompletion(context, latest.current.parameters);
    const editor = new EditorView({ parent: host.current!, state: EditorState.create({ doc: value, extensions: [
      lineNumbers(), history(), highlightActiveLine(), bracketMatching(), lintGutter(),
      syntaxHighlighting(defaultHighlightStyle),
      language === 'data' ? sqlSupport : [markdown({ codeLanguages: info => /^sql\b/i.test(info) ? PostgreSQL.language : null }), sqlSupport.support, markdocTags],
      EditorState.languageData.of(() => [{ autocomplete: complete }]),
      autocompletion(), keymap.of([...completionKeymap, ...defaultKeymap, ...historyKeymap]),
      EditorView.lineWrapping,
      EditorView.contentAttributes.of({ 'aria-label': ariaLabel ?? (language === 'document' ? 'Evidence source' : 'Dataset SQL'), 'aria-multiline': 'true', spellcheck: 'false' }),
      EditorView.theme({
        '&': { height: '100%', fontSize: '13px', backgroundColor: 'var(--background)', color: 'var(--foreground)' },
        '.cm-scroller': { overflow: 'auto', fontFamily: 'ui-monospace, monospace' },
        '.cm-content': { padding: '12px 0', caretColor: 'var(--foreground)' },
        '.cm-gutters': { backgroundColor: 'var(--muted)', color: 'var(--muted-foreground)', border: 'none' },
        '.cm-activeLine': { backgroundColor: 'color-mix(in srgb, var(--primary) 6%, transparent)' },
        '.cm-evidence-tag': { color: 'var(--primary)', fontWeight: '600' },
        '.cm-tooltip': { backgroundColor: 'var(--popover)', color: 'var(--popover-foreground)', borderColor: 'var(--border)' },
        '.cm-tooltip-autocomplete ul li[aria-selected]': { backgroundColor: 'var(--accent)', color: 'var(--accent-foreground)' },
        '&.cm-focused': { outline: '2px solid var(--ring)', outlineOffset: '-2px' },
      }),
      EditorView.updateListener.of(update => { if (update.docChanged) latest.current.onChange(update.state.doc.toString()); }),
    ] }) });
    view.current = editor;
    return () => { editor.destroy(); view.current = null; };
  }, [language]);
  useEffect(() => {
    const editor = view.current;
    if (editor && editor.state.doc.toString() !== value) editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: value } });
  }, [value]);
  useEffect(() => {
    const editor = view.current;
    if (!editor) return;
    editor.dispatch(setDiagnostics(editor.state, issues.filter(issue => issue.target === language && issue.line).map(issue => {
      const line = editor.state.doc.line(Math.min(Math.max(1, issue.line!), editor.state.doc.lines));
      return { from: line.from, to: line.to, severity: issue.severity, message: issue.message };
    })));
  }, [issues, language]);
  useImperativeHandle(ref, () => ({
    insert(text) { const editor = view.current; if (editor) { editor.dispatch({ ...editor.state.replaceSelection(text), scrollIntoView: true }); editor.focus(); } },
    goToLine(number) { const editor = view.current; if (editor) { const line = editor.state.doc.line(Math.min(Math.max(1, number), editor.state.doc.lines)); editor.dispatch({ selection: { anchor: line.from }, effects: EditorView.scrollIntoView(line.from, { y: 'center' }) }); editor.focus(); } },
  }), []);
  return <div ref={host} className="min-h-48 flex-1 overflow-hidden rounded-lg border border-input" />;
});
