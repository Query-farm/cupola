import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

export interface Settings {
  showDuckDBTypes: boolean;
  hideTableBackingFunctions: boolean;
  shellFontSize: number;
}

const defaultSettings: Settings = {
  showDuckDBTypes: true,
  hideTableBackingFunctions: true,
  shellFontSize: 13,
};

const STORAGE_KEY = "vgi-frontend-settings";

function loadSettings(): Settings {
  if (typeof localStorage === "undefined") return defaultSettings;
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) return { ...defaultSettings, ...JSON.parse(stored) };
  } catch {}
  return defaultSettings;
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
