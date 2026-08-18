import { useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface Props {
  catalogName: string;
  serviceUrl: string;
  attachOptions?: string;
}

function normalizeOptions(raw?: string): string {
  return raw ? raw.trim().replace(/^,\s*/, "") : "";
}

type LangId = "duckdb" | "python" | "typescript";

const LANGS: { id: LangId; label: string }[] = [
  { id: "duckdb", label: "DuckDB" },
  { id: "python", label: "Python" },
  { id: "typescript", label: "TypeScript" },
];

/**
 * The three snippets that connect a client to THIS catalog.
 *
 * Python and TypeScript are not a different protocol — they are the same
 * three statements run through Haybarn's own drivers, which are forks of the
 * DuckDB clients with an identical public API (`pip install haybarn`,
 * `npm install @haybarn/node-api`). That is why all three bodies carry the
 * same INSTALL / LOAD / ATTACH sequence.
 *
 * INSTALL and LOAD are included even though the old SQL-only box omitted
 * them: this app installs the extension for you at boot, so the bare ATTACH
 * worked here but not when pasted into a fresh client, which is exactly where
 * these snippets get pasted.
 */
function buildSnippets(catalogName: string, serviceUrl: string, opts: string) {
  const optsFragment = opts ? `, ${opts}` : "";
  const attach = `ATTACH '${catalogName}' AS ${catalogName} (TYPE vgi, LOCATION '${serviceUrl}'${optsFragment});`;
  // Same statement inside a host-language string literal. The SQL uses single
  // quotes throughout, so double-quoting the host string needs no escaping.
  const attachInline = attach.replace(/;$/, "");

  return {
    duckdb: [
      "INSTALL vgi FROM community;",
      "LOAD vgi;",
      "",
      attach,
      "",
      "SHOW ALL TABLES;",
    ].join("\n"),

    python: [
      "# pip install haybarn",
      "import haybarn",
      "",
      "con = haybarn.connect()",
      'con.execute("INSTALL vgi FROM community")',
      'con.execute("LOAD vgi")',
      `con.execute("${attachInline}")`,
      "",
      'con.sql("SHOW ALL TABLES").show()',
    ].join("\n"),

    typescript: [
      "// npm install @haybarn/node-api",
      'import { DuckDBInstance } from "@haybarn/node-api";',
      "",
      'const instance = await DuckDBInstance.create(":memory:");',
      "const connection = await instance.connect();",
      "",
      'await connection.run("INSTALL vgi FROM community");',
      'await connection.run("LOAD vgi");',
      `await connection.run("${attachInline}");`,
      "",
      'const reader = await connection.runAndReadAll("SHOW ALL TABLES");',
      "console.log(reader.getRows());",
    ].join("\n"),
  } satisfies Record<LangId, string>;
}

/*
  Code colours, copied verbatim from query.farm's Shiki `farmTheme`
  (astro.config.mjs) so a snippet here and a snippet on the marketing site are
  the same system. They are literal hex rather than semantic tokens on
  purpose: this is a code palette on a fixed dark slab, not chrome, so a
  `?theme=<url>` override must NOT repaint it — the slab stays rock-* in every
  theme and these values are measured against it.
*/
const CODE = {
  plain: "#e9e1d3",
  comment: "#8a7f70",
  string: "#9fc48c",
  keyword: "#d9a441",
  fn: "#d3a6e0",
  num: "#e0a44f",
  variable: "#8fc7d8",
  punct: "#a2988a",
} as const;

type TokType = keyof typeof CODE;
interface Tok { t: TokType; s: string }

interface Rule { t: TokType; re: RegExp; call?: true }

/*
  A scanner, not a parser. It runs sticky regexes at the cursor and takes the
  first that matches, falling back to one plain character. That is enough for
  these snippets — three statements and an import — and it stays honest: there
  is no language server here, so anything it cannot classify renders as plain
  text rather than being guessed at.
*/
const RULES: Record<LangId, Rule[]> = {
  duckdb: [
    { t: "string", re: /'[^']*'|"[^"]*"/y },
    { t: "keyword", re: /\b(?:INSTALL|LOAD|ATTACH|AS|TYPE|LOCATION|FROM|SHOW|ALL|TABLES|SELECT|WHERE|LIMIT|ORDER|BY|GROUP)\b/iy },
    { t: "num", re: /\d+(?:\.\d+)?/y },
    { t: "punct", re: /[(){}[\].,;:=]/y },
  ],
  python: [
    { t: "comment", re: /#.*/y },
    { t: "string", re: /'[^']*'|"[^"]*"/y },
    { t: "fn", re: /[A-Za-z_][\w$]*(?:\.[A-Za-z_][\w$]*)*(?=\s*\()/y, call: true },
    { t: "keyword", re: /\b(?:import|from|as|def|return|await|async|with|for|in|if|else|None|True|False)\b/y },
    { t: "num", re: /\d+(?:\.\d+)?/y },
    { t: "punct", re: /[(){}[\].,;:=]/y },
  ],
  typescript: [
    { t: "comment", re: /\/\/.*/y },
    { t: "string", re: /'[^']*'|"[^"]*"|`[^`]*`/y },
    { t: "fn", re: /[A-Za-z_][\w$]*(?:\.[A-Za-z_][\w$]*)*(?=\s*\()/y, call: true },
    { t: "keyword", re: /\b(?:import|from|const|let|var|await|async|new|return|export|default|function|type|interface)\b/y },
    { t: "num", re: /\d+(?:\.\d+)?/y },
    { t: "punct", re: /[(){}[\].,;:=<>]/y },
  ],
};

function tokenize(line: string, lang: LangId): Tok[] {
  const out: Tok[] = [];
  const push = (t: TokType, s: string) => {
    const last = out[out.length - 1];
    if (last && last.t === t) last.s += s;
    else out.push({ t, s });
  };

  let i = 0;
  while (i < line.length) {
    let hit = false;
    for (const rule of RULES[lang]) {
      rule.re.lastIndex = i;
      const m = rule.re.exec(line);
      if (m && m[0].length > 0) {
        if (rule.call) {
          // `con.execute` — the receiver reads as a variable, only the final
          // segment is the call. Colouring the whole dotted path as a function
          // makes every object look like one.
          const dot = m[0].lastIndexOf(".");
          if (dot === -1) push("fn", m[0]);
          else {
            push("variable", m[0].slice(0, dot));
            push("punct", ".");
            push("fn", m[0].slice(dot + 1));
          }
        } else {
          push(rule.t, m[0]);
        }
        i += m[0].length;
        hit = true;
        break;
      }
    }
    if (!hit) {
      push("plain", line[i]);
      i += 1;
    }
  }
  return out;
}

function CodeLine({ line, lang }: { line: string; lang: LangId }) {
  return (
    <>
      {tokenize(line, lang).map((tok, i) => (
        <span
          key={i}
          style={{
            color: CODE[tok.t],
            fontStyle: tok.t === "comment" ? "italic" : undefined,
            fontWeight: tok.t === "keyword" ? 600 : undefined,
          }}
        >
          {tok.s}
        </span>
      ))}
    </>
  );
}

export function ConnectBox({ catalogName, serviceUrl, attachOptions }: Props) {
  const [lang, setLang] = useState<LangId>("duckdb");
  const [copied, setCopied] = useState(false);

  const snippets = buildSnippets(catalogName, serviceUrl, normalizeOptions(attachOptions));
  const source = snippets[lang];

  function handleCopy() {
    navigator.clipboard.writeText(source).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }).catch(() => {});
  }

  return (
    <Card variant="featured" className="mb-8">
      <CardContent className="pt-4 pb-4">
        <div className="flex flex-wrap items-center gap-2 mb-3">
          <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mr-1">
            Connect
          </span>

          <div role="tablist" aria-label="Client language" className="flex items-center gap-1">
            {LANGS.map((l) => {
              const active = l.id === lang;
              return (
                <button
                  key={l.id}
                  role="tab"
                  aria-selected={active}
                  onClick={() => setLang(l.id)}
                  className={cn(
                    "rounded-md border px-2.5 py-1 text-xs transition-colors cursor-pointer",
                    active
                      ? "bg-primary border-primary text-primary-foreground font-semibold"
                      : "bg-card/40 border-border text-muted-foreground hover:bg-card hover:text-foreground",
                  )}
                >
                  {l.label}
                </button>
              );
            })}
          </div>

          <Button
            variant="outline"
            size="sm"
            onClick={handleCopy}
            className={cn("h-6 px-2 text-xs ml-auto", copied && "text-accent border-accent")}
          >
            {copied ? "Copied" : "Copy"}
          </Button>
        </div>

        {/* rock-900 in light, rock-950 in dark: in dark the featured card is
            already near rock-900, so the slab drops a step to keep an edge. */}
        <pre className="bg-rock-900 dark:bg-rock-950 rounded-md px-4 py-3 overflow-x-auto text-sm leading-relaxed">
          <code className="font-mono">
            {source.split("\n").map((line, i) => (
              <span key={i}>
                <CodeLine line={line} lang={lang} />
                {"\n"}
              </span>
            ))}
          </code>
        </pre>
      </CardContent>
    </Card>
  );
}
