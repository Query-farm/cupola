import { useMemo } from "react";
import { format } from "sql-formatter";
import hljs from "highlight.js/lib/core";
import sql from "highlight.js/lib/languages/sql";

hljs.registerLanguage("sql", sql);

interface Props {
  query: string;
}

export function SqlCodeBlock({ query }: Props) {
  const { formatted, highlighted } = useMemo(() => {
    let fmt: string;
    try {
      fmt = format(query, {
        language: "sql",
        keywordCase: "upper",
        tabWidth: 2,
        useTabs: false,
      });
    } catch {
      fmt = query;
    }

    const result = hljs.highlight(fmt, { language: "sql" });
    return { formatted: fmt, highlighted: result.value };
  }, [query]);

  return (
    <pre className="overflow-x-auto text-xs font-mono leading-relaxed">
      <code
        className="hljs language-sql"
        dangerouslySetInnerHTML={{ __html: highlighted }}
      />
      <style>{`
        .hljs { background: transparent; color: inherit; }
        .hljs-keyword { color: #2d5016; font-weight: 600; }
        .hljs-built_in { color: #4a7c23; }
        .hljs-string { color: #9a6700; }
        .hljs-number { color: #1a4a6b; }
        .hljs-comment { color: #6b6b5a; font-style: italic; }
        .hljs-operator { color: #6b6b5a; }
        .hljs-punctuation { color: #6b6b5a; }
      `}</style>
    </pre>
  );
}
