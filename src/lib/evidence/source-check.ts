import Markdoc, { type Node } from '@markdoc/markdoc';
import { evidenceRegistry, validationIssues, type EvidenceIssue } from './editor-support';

/**
 * Evidence's own Markdoc validation of a report source, run headlessly, so an agent proposal
 * is checked before the user ever applies it. There is no render context here (no filters,
 * query registry or metadata), so this is the structural half of what the preview checks:
 * syntax, unknown tags and attributes, attribute types and enums, parent/child rules and
 * duplicate query names. Data references and query errors still surface only in the preview.
 */
export async function sourceValidationIssues(source: string): Promise<EvidenceIssue[]> {
  // Load in the renderer's order: the tag registry cycles through the Markdoc processor.
  await evidenceRegistry();
  const { parse, validate } = await import('@evidence/core/user-components/Renderer/MarkdocProcessor/process-markdoc');
  return [...validationIssues(validate(parse(source))), ...unclosedTagIssues(source)];
}

/**
 * A `{%` that never reaches `%}` isn't a tag to Markdoc, just text, so validation passes and
 * the component silently prints as literal text.
 */
export function unclosedTagIssues(source: string): EvidenceIssue[] {
  const issues: EvidenceIssue[] = [];
  const visit = (node: Node) => {
    // A fence carries its body as a child text node too.
    if (node.type === 'fence') return;
    if (node.type === 'text' && String(node.attributes.content ?? '').includes('{%')) {
      issues.push({ message: 'Unclosed tag: "{%" without a matching "%}", so it would print as text.', severity: 'error', line: node.lines[0] === undefined ? undefined : node.lines[0] + 1, target: 'document' });
    }
    node.children.forEach(visit);
  };
  visit(Markdoc.parse(source));
  return issues;
}

/**
 * Issues in `after` that `before` did not have. Matched by message and counted, not by line,
 * since an edit above an existing problem moves it. A report that was already broken can
 * still be edited; only what the edit itself breaks is held against it.
 */
export function introducedIssues(before: EvidenceIssue[], after: EvidenceIssue[]): EvidenceIssue[] {
  const existing = new Map<string, number>();
  const key = (issue: EvidenceIssue) => `${issue.severity}\u0000${issue.message}`;
  for (const issue of before) existing.set(key(issue), (existing.get(key(issue)) ?? 0) + 1);
  return after.filter(issue => {
    const left = existing.get(key(issue)) ?? 0;
    if (left) existing.set(key(issue), left - 1);
    return !left;
  });
}

export function describeIssues(issues: EvidenceIssue[]): string {
  return issues.map(issue => `- ${issue.line ? `line ${issue.line}: ` : ''}${issue.message}`).join('\n');
}
