import { MarkdownContent, type MarkdownContentProps } from '../content/MarkdownContent';

/** Compact headings for conversational replies; documents use semantic headings. */
export function ChatMarkdown(props: Omit<MarkdownContentProps, 'document'>) {
  return <MarkdownContent {...props} />;
}
