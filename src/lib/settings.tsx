import { createContext, useContext, useState, type ReactNode } from "react";
import { consumeAiKey } from "./url-params";

export interface Settings {
  showDuckDBTypes: boolean;
  hideTableBackingFunctions: boolean;
  hideDollarTables: boolean;
  shellFontSize: number;
  /** DuckDB WASM thread count. 0 = auto (1 for Safari, hardwareConcurrency for others). */
  shellThreads: number;
  anthropicApiKey: string;
  aiModel: string;
  aiMaxToolRounds: number;
  /** Send the rendered chart PNG back to the AI agent as part of
   *  render_chart's tool_result, so it can SEE its output and iterate on
   *  visual issues (overlapping labels, bad scales). Adds ~1500 input
   *  tokens per chart; disable for long sessions if cost is a concern. */
  aiChartFeedback: boolean;
}

const defaultSettings: Settings = {
  showDuckDBTypes: true,
  hideTableBackingFunctions: true,
  hideDollarTables: true,
  shellFontSize: 13,
  shellThreads: 0,
  anthropicApiKey: "",
  aiModel: "claude-sonnet-4-20250514",
  aiMaxToolRounds: 20,
  aiChartFeedback: true,
};

const STORAGE_KEY = "vgi-frontend-settings";

function loadSettings(): Settings {
  if (typeof localStorage === "undefined") return defaultSettings;
  let stored: Settings = defaultSettings;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) stored = { ...defaultSettings, ...JSON.parse(raw) };
  } catch {}
  // consumeAiKey strips the param from the URL on read. If it returned a
  // value, merge + persist immediately so a reload (now without the URL
  // param) still has the key.
  const fromUrl = consumeAiKey();
  if (fromUrl !== null) {
    const next = { ...stored, anthropicApiKey: fromUrl };
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(next)); } catch {}
    return next;
  }
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
