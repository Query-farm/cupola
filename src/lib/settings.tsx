import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

export interface Settings {
  showDuckDBTypes: boolean;
  hideTableBackingFunctions: boolean;
  hideDollarTables: boolean;
  shellFontSize: number;
  autoRestoreSession: boolean;
  /** DuckDB WASM thread count. 0 = auto (1 for Safari, hardwareConcurrency for others). */
  shellThreads: number;
  anthropicApiKey: string;
  aiModel: string;
  aiMaxToolRounds: number;
  /** Enable the Kepler.gl map tab. Disabled by default — pulls a large chunk
   *  and emits React 19 dev warnings from kepler internals. Can also be
   *  forced on per-session with `?kepler=1`. */
  enableKeplerMap: boolean;
}

const defaultSettings: Settings = {
  showDuckDBTypes: true,
  hideTableBackingFunctions: true,
  hideDollarTables: true,
  shellFontSize: 13,
  autoRestoreSession: false,
  shellThreads: 0,
  anthropicApiKey: "",
  aiModel: "claude-sonnet-4-20250514",
  aiMaxToolRounds: 20,
  enableKeplerMap: false,
};

const STORAGE_KEY = "vgi-frontend-settings";

/** Read `ai_key` from either the query string (`?ai_key=`) or the URL fragment
 *  (`#ai_key=...&token=...`). The fragment form is preferred for redirector
 *  use because fragments aren't sent to servers or stored in most logs. The
 *  query-string form takes precedence if both are present.
 *
 *  API keys leak into browser history regardless, so the param is consumed
 *  once: merged into persisted settings and stripped from the URL via
 *  replaceState (see SettingsProvider). */
function getApiKeyFromUrl(): string | null {
  if (typeof window === "undefined") return null;
  const search = new URLSearchParams(window.location.search);
  if (search.has("ai_key")) return search.get("ai_key") ?? "";
  // Only treat the fragment as key=value pairs when it actually contains
  // `ai_key=` — selection-routing fragments like `#/schema/foo` would
  // otherwise be misparsed by URLSearchParams.
  const hash = window.location.hash;
  if (hash.includes("ai_key=")) {
    const frag = new URLSearchParams(hash.replace(/^#/, ""));
    if (frag.has("ai_key")) return frag.get("ai_key") ?? "";
  }
  return null;
}

function loadSettings(): Settings {
  if (typeof localStorage === "undefined") return defaultSettings;
  let stored: Settings = defaultSettings;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) stored = { ...defaultSettings, ...JSON.parse(raw) };
  } catch {}
  const fromUrl = getApiKeyFromUrl();
  if (fromUrl !== null) return { ...stored, anthropicApiKey: fromUrl };
  return stored;
}

interface SettingsContextValue {
  settings: Settings;
  updateSettings: (partial: Partial<Settings>) => void;
}

const SettingsContext = createContext<SettingsContextValue>({
  settings: defaultSettings,
  updateSettings: () => {},
});

export function SettingsProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<Settings>(loadSettings);

  // If the API key came from `?ai_key=` or `#ai_key=`, persist it and strip
  // just that key from the URL so it doesn't linger in browser history or
  // get sent as a referrer. Other query/fragment keys are preserved.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const search = new URLSearchParams(window.location.search);
    const hash = window.location.hash;
    const inSearch = search.has("ai_key");
    const inHash = hash.includes("ai_key=");
    if (!inSearch && !inHash) return;
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(settings)); } catch {}

    let qs = window.location.search;
    if (inSearch) {
      search.delete("ai_key");
      const s = search.toString();
      qs = s ? `?${s}` : "";
    }

    let frag = hash;
    if (inHash) {
      const f = new URLSearchParams(hash.replace(/^#/, ""));
      f.delete("ai_key");
      const s = f.toString();
      frag = s ? `#${s}` : "";
    }

    const cleaned = window.location.pathname + qs + frag;
    try { window.history.replaceState(null, "", cleaned); } catch {}
  }, []);

  function updateSettings(partial: Partial<Settings>) {
    setSettings((prev) => {
      const next = { ...prev, ...partial };
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify(next)); } catch {}
      return next;
    });
  }

  return (
    <SettingsContext.Provider value={{ settings, updateSettings }}>
      {children}
    </SettingsContext.Provider>
  );
}

export function useSettings() {
  return useContext(SettingsContext);
}
