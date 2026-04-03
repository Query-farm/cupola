import { useMemo } from "react";
import { SqlCodeBlock } from "../content/SqlCodeBlock";

interface Props {
  content: string;
}

export function ChatMarkdown({ content }: Props) {
  const elements = useMemo(() => parseMarkdown(content), [content]);
  return <div className="text-sm leading-relaxed space-y-2">{elements}</div>;
}

function parseMarkdown(text: string): React.ReactNode[] {
  const lines = text.split("\n");
  const nodes: React.ReactNode[] = [];
  let i = 0;
  let key = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Code block
    if (line.trimStart().startsWith("```")) {
      const lang = line.trim().slice(3).toLowerCase();
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trimStart().startsWith("```")) {
        codeLines.push(lines[i]);
        i++;
      }
      i++; // skip closing ```
      const code = codeLines.join("\n");
      if (lang === "sql") {
        nodes.push(<SqlCodeBlock key={key++} query={code} />);
      } else {
        nodes.push(
          <pre key={key++} className="bg-muted/60 rounded-md p-3 text-xs font-mono overflow-x-auto">
            <code>{code}</code>
          </pre>
        );
      }
      continue;
    }

    // Empty line
    if (line.trim() === "") {
      i++;
      continue;
    }

    // Heading
    const headingMatch = line.match(/^(#{1,4})\s+(.*)$/);
    if (headingMatch) {
      const level = headingMatch[1].length;
      const text = headingMatch[2];
      const cls = level === 1 ? "text-base font-bold text-primary" :
                  level === 2 ? "text-sm font-semibold text-primary" :
                  "text-sm font-semibold text-foreground/80";
      nodes.push(<div key={key++} className={cls}>{inlineFormat(text)}</div>);
      i++;
      continue;
    }

    // Bullet list
    if (line.match(/^\s*[-*]\s+/)) {
      const items: string[] = [];
      while (i < lines.length && lines[i].match(/^\s*[-*]\s+/)) {
        items.push(lines[i].replace(/^\s*[-*]\s+/, ""));
        i++;
      }
      nodes.push(
        <ul key={key++} className="list-disc ml-4 space-y-1">
          {items.map((item, j) => <li key={j}>{inlineFormat(item)}</li>)}
        </ul>
      );
      continue;
    }

    // Numbered list
    if (line.match(/^\s*\d+\.\s+/)) {
      const items: string[] = [];
      while (i < lines.length && lines[i].match(/^\s*\d+\.\s+/)) {
        items.push(lines[i].replace(/^\s*\d+\.\s+/, ""));
        i++;
      }
      nodes.push(
        <ol key={key++} className="list-decimal ml-4 space-y-1">
          {items.map((item, j) => <li key={j}>{inlineFormat(item)}</li>)}
        </ol>
      );
      continue;
    }

    // Markdown table
    if (line.trim().startsWith("|") && line.trim().endsWith("|")) {
      const tableLines: string[] = [];
      while (i < lines.length && lines[i].trim().startsWith("|") && lines[i].trim().endsWith("|")) {
        tableLines.push(lines[i]);
        i++;
      }
      if (tableLines.length >= 2) {
        const parseRow = (row: string) =>
          row.split("|").slice(1, -1).map(cell => cell.trim());
        const headers = parseRow(tableLines[0]);
        // Skip separator row (|---|---|)
        const dataStart = tableLines[1].match(/^\s*\|[\s:-]+\|/) ? 2 : 1;
        const rows = tableLines.slice(dataStart).map(parseRow);
        nodes.push(
          <div key={key++} className="border rounded-md overflow-auto my-2">
            <table className="w-full text-xs">
              <thead className="bg-muted/50">
                <tr>
                  {headers.map((h, j) => (
                    <th key={j} className="text-left px-3 py-1.5 font-semibold text-muted-foreground whitespace-nowrap">{inlineFormat(h)}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((row, ri) => (
                  <tr key={ri} className="border-t border-border">
                    {row.map((cell, ci) => (
                      <td key={ci} className="px-3 py-1.5 whitespace-nowrap">{inlineFormat(cell)}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
        continue;
      }
    }

    // Regular paragraph — collect consecutive non-empty, non-special lines
    const paraLines: string[] = [];
    while (i < lines.length && lines[i].trim() !== "" && !lines[i].trimStart().startsWith("```") && !lines[i].match(/^#{1,4}\s/) && !lines[i].match(/^\s*[-*]\s+/) && !lines[i].match(/^\s*\d+\.\s+/) && !(lines[i].trim().startsWith("|") && lines[i].trim().endsWith("|"))) {
      paraLines.push(lines[i]);
      i++;
    }
    if (paraLines.length > 0) {
      nodes.push(<p key={key++}>{inlineFormat(paraLines.join(" "))}</p>);
    }
  }

  return nodes;
}

function inlineFormat(text: string): React.ReactNode {
  // Process inline markdown: **bold**, *italic*, `code`
  const parts: React.ReactNode[] = [];
  let remaining = text;
  let k = 0;

  while (remaining.length > 0) {
    // Inline code
    const codeMatch = remaining.match(/^(.*?)`([^`]+)`(.*)/s);
    if (codeMatch) {
      if (codeMatch[1]) parts.push(<span key={k++}>{codeMatch[1]}</span>);
      parts.push(<code key={k++} className="bg-muted px-1 py-0.5 rounded text-xs font-mono">{codeMatch[2]}</code>);
      remaining = codeMatch[3];
      continue;
    }

    // Bold
    const boldMatch = remaining.match(/^(.*?)\*\*([^*]+)\*\*(.*)/s);
    if (boldMatch) {
      if (boldMatch[1]) parts.push(<span key={k++}>{boldMatch[1]}</span>);
      parts.push(<strong key={k++} className="font-semibold">{boldMatch[2]}</strong>);
      remaining = boldMatch[3];
      continue;
    }

    // Italic
    const italicMatch = remaining.match(/^(.*?)(?<!\*)\*([^*]+)\*(?!\*)(.*)/s);
    if (italicMatch) {
      if (italicMatch[1]) parts.push(<span key={k++}>{italicMatch[1]}</span>);
      parts.push(<em key={k++}>{italicMatch[2]}</em>);
      remaining = italicMatch[3];
      continue;
    }

    // No more inline formatting
    parts.push(<span key={k++}>{remaining}</span>);
    break;
  }

  return parts.length === 1 ? parts[0] : <>{parts}</>;
}
