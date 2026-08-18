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

/**
 * Minimal highlighting, deliberately not a parser: whole-line comments go
 * muted, quoted strings take the accent, everything else is foreground. It
 * covers the only two things worth picking out of these snippets — which bits
 * are prose and which bits are the catalog name and URL you might edit.
 */
function CodeLine({ line }: { line: string }) {
  if (line.trim().startsWith("#") || line.trim().startsWith("//")) {
    return <span className="text-muted-foreground">{line}</span>;
  }
  // Split on single- or double-quoted runs, keeping the delimiters.
  const parts = line.split(/('[^']*'|"[^"]*")/g);
  return (
    <>
      {parts.map((part, i) =>
        /^['"]/.test(part) ? (
          <span key={i} className="text-accent">{part}</span>
        ) : (
          <span key={i} className="text-foreground">{part}</span>
        ),
      )}
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

        <pre className="bg-muted rounded-md px-4 py-3 overflow-x-auto text-sm">
          <code className="font-mono">
            {source.split("\n").map((line, i) => (
              <span key={i}>
                <CodeLine line={line} />
                {"\n"}
              </span>
            ))}
          </code>
        </pre>
      </CardContent>
    </Card>
  );
}
