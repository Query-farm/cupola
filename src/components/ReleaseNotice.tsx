import { useEffect, useState } from "react";
import { hostedReleases } from "../lib/app-base";

declare const __APP_VERSION__: string;

export function ReleaseNotice() {
  const [available, setAvailable] = useState(false);
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
        if (!stopped && typeof release.version === "string") setAvailable(release.version !== __APP_VERSION__);
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
  if (!available) return null;
  return <aside aria-label="Cupola update" className="fixed bottom-4 right-4 z-[100] max-w-sm rounded-lg border bg-background p-4 text-sm text-foreground shadow-lg">
    <p role="status">A new version of Cupola is available.</p>
    {confirming ? <>
      <p className="mt-2 text-muted-foreground">Save your work and wait for running queries to finish. Reloading closes this session and clears in-memory results.</p>
      <div className="mt-3 flex gap-4">
        <button className="font-medium text-primary underline" onClick={() => window.location.reload()}>Reload now</button>
        <button className="text-muted-foreground underline" onClick={() => setConfirming(false)}>Keep working</button>
      </div>
    </> : <button className="mt-2 font-medium text-primary underline" onClick={() => setConfirming(true)}>Reload to update</button>}
  </aside>;
}
