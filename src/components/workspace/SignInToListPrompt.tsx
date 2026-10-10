/**
 * "Sign in to see this server's catalogs": shown by the welcome page's connect
 * form and the picker's "Attach a catalog…" when a service refuses to list its
 * catalogs until signed in. Signing in is optional (Connect / Attach still
 * work), so the prompt is neutral, says so, and its button is an outline one
 * that never competes with the form's own primary action.
 */
import { useState } from "react";
import { Loader2, LogIn } from "lucide-react";
import { Button } from "../ui/button";
import { cn } from "@/lib/utils";

export function SignInToListPrompt({ url, hint, onSignIn, layout = "row", className }: {
  url: string;
  /** The other way forward, e.g. "Or press Connect to open its first catalog." */
  hint: string;
  /** Starts the sign-in redirect; omitted where signing in here isn't possible.
   *  A rejected promise (the redirect never started) re-enables the button. */
  onSignIn?: (url: string) => Promise<unknown> | void;
  /** `row` puts the button beside the text; `stacked` (narrow forms) below it, full width. */
  layout?: "row" | "stacked";
  className?: string;
}) {
  // The redirect takes a moment; a second click would start a second sign-in.
  const [pending, setPending] = useState(false);
  let host = url;
  try { host = new URL(url).host; } catch { /* keep the text as typed */ }
  const stacked = layout === "stacked";
  return (
    <div
      role="status"
      className={cn(
        "flex gap-3 rounded-md border border-border bg-muted/40 px-3 py-2.5",
        stacked ? "flex-col" : "flex-col items-start sm:flex-row sm:items-center",
        className,
      )}
      data-testid="sign-in-to-list"
    >
      <div className="flex min-w-0 flex-1 items-start gap-2.5">
        <LogIn className="size-4 mt-0.5 shrink-0 text-muted-foreground" aria-hidden="true" />
        <div className="min-w-0">
          <p className="text-sm font-medium text-foreground">Sign in to see this server's catalogs</p>
          <p className="text-xs text-muted-foreground">{onSignIn ? `Optional. ${hint}` : hint}</p>
        </div>
      </div>
      {onSignIn && (
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={pending}
          className={stacked ? "w-full" : "shrink-0 sm:ml-auto"}
          aria-label={pending ? "Opening sign-in" : `Sign in to ${host} to list its catalogs`}
          onClick={() => {
            setPending(true);
            void Promise.resolve(onSignIn(url)).catch(() => setPending(false));
          }}
          data-testid="sign-in-to-list-button"
        >
          {pending
            ? <><Loader2 className="animate-spin" data-icon="inline-start" aria-hidden="true" />Opening sign-in…</>
            : <><LogIn data-icon="inline-start" aria-hidden="true" />Sign in</>}
        </Button>
      )}
    </div>
  );
}

/** The `role="status"` line under a just-listed catalog choice: how many
 *  (unless the form already says), and who is signed in when the service has
 *  an identity for this browser. Renders nothing when there's nothing to add. */
export function CatalogListStatus({ count, user }: { count?: number; user: { name?: string; email?: string } | null }) {
  const who = user?.email || user?.name;
  const parts = [
    count === undefined ? null : `${count} ${count === 1 ? "catalog" : "catalogs"} on this server`,
    who ? `Signed in as ${who}` : null,
  ].filter(Boolean);
  if (!parts.length) return null;
  return (
    <p role="status" className="text-xs text-muted-foreground" data-testid="catalog-list-status">
      {parts.join(" · ")}
    </p>
  );
}
