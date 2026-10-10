import { ShieldAlert } from "lucide-react";
import { localHttpBlockedHost } from "@/lib/connection-errors";
import { cn } from "@/lib/utils";

/**
 * A connection error message. The HTTPS-page → loopback-HTTP guidance from
 * `connectionErrorMessage` is laid out as a titled callout with its fixes as a
 * list; any other message renders as plain text.
 *
 * `compact` is for one-line status rows (sidebar, workspace picker): a short
 * summary with the full guidance in the tooltip.
 */
export function ConnectionErrorText({ message, compact = false, className }: { message: string; compact?: boolean; className?: string }) {
  const host = localHttpBlockedHost(message);
  if (!host) return <span className={className}>{message}</span>;

  if (compact) {
    return (
      <span className={cn("inline-flex items-start gap-1", className)} title={message}>
        <ShieldAlert className="size-3 mt-px shrink-0" aria-hidden="true" />
        <span>Browser blocked HTTP server at {host}</span>
      </span>
    );
  }

  return (
    <div className={cn("flex items-start gap-2.5 text-left", className)} data-testid="local-http-blocked">
      <ShieldAlert className="size-5 mt-0.5 shrink-0" aria-hidden="true" />
      <div className="min-w-0 space-y-1.5">
        <p className="font-semibold">Could not reach the local server at <span className="font-mono break-all">{host}</span></p>
        <p className="opacity-90">Cupola is served over HTTPS, but this server uses plain HTTP. Safari can block that connection.</p>
        <ul className="list-disc pl-4 space-y-0.5 opacity-90">
          <li>Open this page in desktop Chrome, or serve the catalog over HTTPS.</li>
          <li>Check that the local server is running.</li>
          <li>Allow local-network access if your browser asks.</li>
        </ul>
      </div>
    </div>
  );
}
