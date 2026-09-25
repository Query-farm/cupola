import type { CompletionContext, CompletionResult } from '@codemirror/autocomplete';
import type { ValidateError } from '@markdoc/markdoc';

export interface EvidenceIssue {
  message: string;
  severity: 'error' | 'warning';
  line?: number;
  target: 'document' | 'data';
  sql?: string;
}
export function validationIssues(errors: ValidateError[]): EvidenceIssue[] {
  return errors.map(item => ({
    message: item.error.message,
    severity: item.error.level === 'warning' ? 'warning' : 'error',
    line: (item.location?.start?.line ?? item.lines?.[0]) === undefined ? undefined : (item.location?.start?.line ?? item.lines![0]) + 1,
    target: 'document',
  }));
}

// Use the installed renderer's schema registry, rather than a second list of tags.
let registry: Promise<typeof import('@evidence/core')['tags']> | undefined;
export function evidenceRegistry() {
  // Core's eager tag registry cycles through the Markdoc processor. Use the same
  // entry order as the renderer so completion also works before the first preview.
  return registry ??= import('@evidence/core/user-components/Renderer/MarkdocProcessor/process-markdoc')
    .then(() => import('@evidence/core')).then(module => module.tags)
    .catch(error => { registry = undefined; throw error; });
}
export async function evidenceCompletion(context: CompletionContext, parameters: string[]): Promise<CompletionResult | null> {
  const word = context.matchBefore(/[\w$]*/);
  const before = context.state.sliceDoc(0, context.pos);
  if (word?.text.startsWith('$')) return {
    from: word.from,
    options: parameters.map(key => ({ label: `$${key}`, type: 'variable', detail: 'Bound report parameter' })),
  };
  const open = before.lastIndexOf('{%');
  if (open < 0 || before.lastIndexOf('%}') > open) return null;
  const fragment = before.slice(open);
  const tags = await evidenceRegistry();
  if (/^\{%\s*\/?\w*$/.test(fragment)) return {
    from: context.pos - (fragment.match(/\w*$/)?.[0].length ?? 0),
    options: Object.entries(tags).map(([name, component]) => ({ label: name, type: 'keyword', info: component.schema.description })),
  };
  const dataValue = fragment.match(/\bdata\s*=\s*"([^"\n]*)$/);
  if (dataValue) return {
    from: context.pos - dataValue[1].length,
    options: [...new Set([...context.state.doc.toString().matchAll(/^\s*```sql\s+([\w]+)/gm)].map(match => match[1]))]
      .map(name => ({ label: name, type: 'variable', detail: 'Document SQL query' })),
  };
  // Do not offer attribute names inside a quoted value.
  if ((fragment.match(/(?<!\\)"/g)?.length ?? 0) % 2) return null;
  const name = fragment.match(/^\{%\s*(\w+)/)?.[1];
  if (!name || !tags[name] || !word || (!word.text && !context.explicit)) return null;
  return {
    from: word.from,
    options: Object.entries(tags[name].schema.attributes).filter(([key]) => !new RegExp(`\\b${key}\\s*=`).test(fragment)).map(([key, attribute]) => ({
      label: key, type: 'property', apply: `${key}=`, detail: attribute.required ? 'Required' : undefined,
      info: attribute.description,
    })),
  };
}
