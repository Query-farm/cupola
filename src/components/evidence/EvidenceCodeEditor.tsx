import { forwardRef, useMemo, useRef } from 'react';
import { EditorState } from '@codemirror/state';
import { EditorView, Decoration, ViewPlugin, type DecorationSet } from '@codemirror/view';
import { PostgreSQL, sql } from '@codemirror/lang-sql';
import { evidenceCompletion, type EvidenceIssue } from '../../lib/evidence/editor-support';
import { DocumentCodeEditor, markdownSupport, type DocumentCodeHandle } from '../content/DocumentCodeEditor';
export type EvidenceCodeHandle = DocumentCodeHandle;
interface Props {
  value: string;
  onChange: (value: string) => void;
  language: 'document' | 'data';
  parameters: string[];
  issues: EvidenceIssue[];
  ariaLabel?: string;
}
const markdocTags = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = this.highlight(view);
    }
    update(update: { docChanged: boolean; view: EditorView }) {
      if (update.docChanged) this.decorations = this.highlight(update.view);
    }
    highlight(view: EditorView) {
      return Decoration.set(
        [...view.state.doc.toString().matchAll(/\{%[\s\S]*?%\}/g)].map((match) =>
          Decoration.mark({ class: 'cm-evidence-tag' }).range(match.index!, match.index! + match[0].length),
        ),
      );
    }
  },
  { decorations: (instance) => instance.decorations },
);

export const EvidenceCodeEditor = forwardRef<EvidenceCodeHandle, Props>(function EvidenceCodeEditor(
  { value, onChange, language, parameters, issues, ariaLabel },
  ref,
) {
  const latest = useRef(parameters);
  latest.current = parameters;
  const extensions = useMemo(() => {
    // CodeMirror tracks completion sources by identity, including across async requests.
    const complete = (context: Parameters<typeof evidenceCompletion>[0]) =>
      evidenceCompletion(context, latest.current);
    return [
      language === 'data' ? sql({ dialect: PostgreSQL }) : [markdownSupport(), markdocTags],
      EditorState.languageData.of(() => [{ autocomplete: complete }]),
      EditorView.theme({ '.cm-evidence-tag': { color: 'var(--primary)', fontWeight: '600' } }),
    ];
  }, [language]);
  const diagnostics = useMemo(() => issues.filter((issue) => issue.target === language), [issues, language]);
  return (
    <DocumentCodeEditor
      ref={ref}
      value={value}
      onChange={onChange}
      extensions={extensions}
      issues={diagnostics}
      ariaLabel={ariaLabel ?? (language === 'document' ? 'Evidence source' : 'Dataset SQL')}
    />
  );
});
