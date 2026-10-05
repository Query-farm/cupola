import { useMemo } from "react";
import { displaySql } from "@/lib/sql/display-sql";
import hljs from "highlight.js/lib/core";
import sql from "highlight.js/lib/languages/sql";

hljs.registerLanguage("sql", sql);

interface Props {
  query: string;
}

export function SqlCodeBlock({ query }: Props) {
  const { highlighted } = useMemo(() => {
    // Copy/Run buttons beside a code block use displaySql too, so the text
    // they hand on is the text shown here.
    const result = hljs.highlight(displaySql(query), { language: "sql" });
    return { highlighted: result.value };
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
