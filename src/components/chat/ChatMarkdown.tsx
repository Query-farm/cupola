import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Check, Copy } from "lucide-react";
import { SqlCodeBlock } from "../content/SqlCodeBlock";
import { buildTableClipboard, writeGridClipboard } from "@/lib/grid-clipboard";

interface Props {
  content: string;
  /** Show a copy action on GFM tables. Intended for agent responses. */
  copyTables?: boolean;
}

function CopyableMarkdownTable({ children }: { children: React.ReactNode }) {
  const tableRef = useRef<HTMLTableElement>(null);
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => () => {
    if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
  }, []);

  const copyTable = async () => {
    const table = tableRef.current;
    if (!table) return;

    const rows = Array.from(table.rows, (row) =>
      Array.from(row.cells, (cell) => (cell.textContent ?? "").trim()),
    );
    const headerRowCount = table.querySelectorAll(":scope > thead > tr").length;
    await writeGridClipboard(buildTableClipboard(rows, headerRowCount));
    setCopied(true);
    if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
    copiedTimerRef.current = setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="border rounded-md overflow-hidden my-2 bg-card shadow-sm">
      <div className="flex justify-end border-b border-border bg-muted/20 px-2 py-1">
        <button
          type="button"
          className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          onClick={() => void copyTable()}
          aria-label={copied ? "Table copied" : "Copy table"}
          title="Copy table for email or spreadsheets"
        >
          {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
          {copied ? "Copied" : "Copy table"}
        </button>
      </div>
      <div className="overflow-auto">
        <table ref={tableRef} className="w-full text-xs">{children}</table>
      </div>
    </div>
  );
}

export function ChatMarkdown({ content, copyTables = false }: Props) {
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
          img: ({ src, alt, title }) => (
            <img
              src={src}
              alt={alt ?? ""}
              title={title}
              loading="lazy"
              decoding="async"
              className="my-2 h-auto max-h-full max-w-full rounded-md object-contain"
            />
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
          table: ({ children }) => copyTables ? (
            <CopyableMarkdownTable>{children}</CopyableMarkdownTable>
          ) : (
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
