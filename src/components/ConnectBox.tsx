import { useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

interface Props {
  catalogName: string;
  serviceUrl: string;
  attachOptions?: string;
}

function normalizeOptions(raw?: string): string {
  return raw ? raw.trim().replace(/^,\s*/, "") : "";
}

export function ConnectBox({ catalogName, serviceUrl, attachOptions }: Props) {
  const [copied, setCopied] = useState(false);
  const opts = normalizeOptions(attachOptions);
  const optsFragment = opts ? `, ${opts}` : "";
  const sql = `ATTACH '${catalogName}' AS ${catalogName} (TYPE vgi, LOCATION '${serviceUrl}'${optsFragment});`;

  function handleCopy() {
    navigator.clipboard.writeText(sql).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }).catch(() => {});
  }

  return (
    <Card variant="featured" className="mb-8">
      <CardContent className="pt-4 pb-4">
        <div className="flex items-center gap-2 mb-2">
          <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Connect with DuckDB
          </span>
          <Button
            variant="outline"
            size="sm"
            onClick={handleCopy}
            className={`h-6 px-2 text-xs ${copied ? "text-accent border-accent" : ""}`}
          >
            {copied ? "Copied" : "Copy"}
          </Button>
        </div>
        <pre className="bg-muted rounded-md px-4 py-3 overflow-x-auto text-sm">
          <code className="font-mono">
            <span className="text-foreground">ATTACH </span>
            <span className="text-accent">'{catalogName}'</span>
            <span className="text-foreground"> AS {catalogName} (TYPE vgi, LOCATION </span>
            <span className="text-accent">'{serviceUrl}'</span>
            {opts && (
              <>
                <span className="text-foreground">, </span>
                <span className="text-accent">{opts}</span>
              </>
            )}
            <span className="text-foreground">);</span>
          </code>
        </pre>
      </CardContent>
    </Card>
  );
}
