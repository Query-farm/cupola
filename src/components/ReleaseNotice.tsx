import { useEffect, useState } from "react";
import { X } from "lucide-react";
import { hostedReleases } from "../lib/app-base";

declare const __APP_VERSION__: string;

export function ReleaseNotice() {
  const [availableVersion, setAvailableVersion] = useState<string | null>(null);
  const [dismissedVersion, setDismissedVersion] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  useEffect(() => {
    if (!hostedReleases) return;
    let stopped = false;
    let pending = false;
    let lastCheck = 0;
    const check = async () => {
      if (document.hidden || pending || Date.now() - lastCheck < 30_000) return;
      pending = true;
      lastCheck = Date.now();
      try {
        const response = await fetch("/release.json", { cache: "no-store", signal: AbortSignal.timeout(10_000) });
        if (!response.ok) return;
        const release = await response.json();
        if (!stopped && typeof release.version === "string") {
          setAvailableVersion(release.version !== __APP_VERSION__ ? release.version : null);
        }
      } catch { /* Offline/update checks never interrupt the app. */ }
      finally { pending = false; }
    };
    void check();
    const interval = window.setInterval(check, 5 * 60_000);
    document.addEventListener("visibilitychange", check);
    window.addEventListener("pageshow", check);
    return () => {
      stopped = true;
      clearInterval(interval);
      document.removeEventListener("visibilitychange", check);
      window.removeEventListener("pageshow", check);
    };
  }, []);
  if (!availableVersion || availableVersion === dismissedVersion) return null;
  return <aside aria-label="Cupola update" className="fixed bottom-4 right-4 z-[100] max-w-sm rounded-lg border bg-background p-4 text-sm text-foreground shadow-lg">
    <div className="flex items-start gap-3">
      <p role="status">A new version of Cupola is available.</p>
      <button
        type="button"
        aria-label="Dismiss update notification"
        className="-m-1 ml-auto shrink-0 rounded p-1 text-muted-foreground hover:text-foreground"
        onClick={() => {
          setDismissedVersion(availableVersion);
          setConfirming(false);
        }}
      >
        <X className="h-4 w-4" aria-hidden="true" />
      </button>
    </div>
    {confirming ? <>
      <p className="mt-2 text-muted-foreground">Save your work and wait for running queries to finish. Reloading closes this session and clears in-memory results.</p>
      <div className="mt-3 flex gap-4">
        <button className="font-medium text-primary underline" onClick={() => window.location.reload()}>Reload now</button>
        <button className="text-muted-foreground underline" onClick={() => setConfirming(false)}>Keep working</button>
      </div>
    </> : <button className="mt-2 font-medium text-primary underline" onClick={() => setConfirming(true)}>Reload to update</button>}
  </aside>;
}
