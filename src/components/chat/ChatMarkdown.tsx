import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { SqlCodeBlock } from "../content/SqlCodeBlock";

interface Props {
  content: string;
}

export function ChatMarkdown({ content }: Props) {
  return (
    <div className="text-sm leading-relaxed space-y-2">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          h1: ({ children }) => <div className="text-base font-bold text-primary">{children}</div>,
          h2: ({ children }) => <div className="text-sm font-semibold text-primary">{children}</div>,
          h3: ({ children }) => <div className="text-sm font-semibold text-foreground/80">{children}</div>,
          h4: ({ children }) => <div className="text-sm font-semibold text-foreground/80">{children}</div>,
          p: ({ children }) => <p>{children}</p>,
          ul: ({ children }) => <ul className="list-disc ml-4 space-y-1">{children}</ul>,
          ol: ({ children }) => <ol className="list-decimal ml-4 space-y-1">{children}</ol>,
          li: ({ children }) => <li>{children}</li>,
          a: ({ href, children }) => (
            <a href={href} target="_blank" rel="noopener noreferrer" className="text-primary underline underline-offset-2 hover:text-primary/80 transition-colors">
              {children}
            </a>
          ),
          strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
          em: ({ children }) => <em>{children}</em>,
          code: ({ className, children }) => {
            const match = className?.match(/language-(\w+)/);
            const lang = match?.[1];
            const codeStr = String(children).replace(/\n$/, "");
            if (lang === "sql") {
              return <SqlCodeBlock query={codeStr} />;
            }
            // Inline code (no language class)
            if (!className) {
              return <code className="bg-muted px-1 py-0.5 rounded text-xs font-mono">{children}</code>;
            }
            return (
              <pre className="bg-muted/60 rounded-md p-3 text-xs font-mono overflow-x-auto">
                <code>{children}</code>
              </pre>
            );
          },
          pre: ({ children }) => <>{children}</>,
          table: ({ children }) => (
            <div className="border rounded-md overflow-auto my-2 bg-card shadow-sm">
              <table className="w-full text-xs">{children}</table>
            </div>
          ),
          thead: ({ children }) => <thead className="bg-muted/50">{children}</thead>,
          th: ({ children }) => <th className="text-left px-3 py-1.5 font-semibold text-muted-foreground whitespace-nowrap">{children}</th>,
          tr: ({ children }) => <tr className="border-t border-border">{children}</tr>,
          td: ({ children }) => <td className="px-3 py-1.5 whitespace-nowrap">{children}</td>,
          blockquote: ({ children }) => (
            <blockquote className="border-l-2 border-primary/30 pl-3 text-muted-foreground italic">{children}</blockquote>
          ),
          hr: () => <hr className="border-border my-3" />,
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
