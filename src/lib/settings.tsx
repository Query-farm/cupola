import { createContext, useContext, useState, type ReactNode } from "react";
import { consumeAiKey } from "./url-params";

export interface Settings {
  showDuckDBTypes: boolean;
  hideTableBackingFunctions: boolean;
  hideDollarTables: boolean;
  shellFontSize: number;
  /** DuckDB WASM thread count. 0 = auto (1 for Safari, hardwareConcurrency for others). */
  shellThreads: number;
  /** Font size for the DBeaver-style SQL query editor (CodeMirror). */
  editorFontSize: number;
  /** Enable schema-aware autocomplete (CALL sql_auto_complete) in the editor. */
  editorAutocomplete: boolean;
  anthropicApiKey: string;
  aiModel: string;
  aiMaxToolRounds: number;
  /** Send the rendered chart PNG back to the AI agent as part of
   *  render_chart's tool_result, so it can SEE its output and iterate on
   *  visual issues (overlapping labels, bad scales). Adds ~1500 input
   *  tokens per chart; disable for long sessions if cost is a concern. */
  aiChartFeedback: boolean;
  /** Send AI conversation analytics — prompts, responses, tool calls, and
   *  token usage — to Sentry for monitoring. Read fresh from localStorage by
   *  isAiTelemetryEnabled() in ai-telemetry.ts; keep the key name in sync. */
  aiTelemetry: boolean;
}

/** Current default model for the AI agent. Imported by surfaces that need a
 *  fallback when no model is configured — keep this the single source of truth. */
export const DEFAULT_AI_MODEL = "claude-sonnet-4-6";

/** Map of retired Claude model IDs → their current replacement. Applied on
 *  load (migrateModel) so users who persisted a now-retired model in
 *  localStorage are silently upgraded instead of hitting API errors.
 *  Anthropic retired claude-sonnet-4-20250514 and claude-opus-4-20250514 on
 *  2026-06-15 (no grace period). */
const RETIRED_MODEL_REPLACEMENTS: Record<string, string> = {
  "claude-sonnet-4-20250514": "claude-sonnet-4-6",
  "claude-opus-4-20250514": "claude-opus-4-8",
};

function migrateModel(model: string): string {
  return RETIRED_MODEL_REPLACEMENTS[model] ?? model;
}

const defaultSettings: Settings = {
  showDuckDBTypes: true,
  hideTableBackingFunctions: true,
  hideDollarTables: true,
  shellFontSize: 13,
  shellThreads: 0,
  editorFontSize: 13,
  editorAutocomplete: true,
  anthropicApiKey: "",
  aiModel: DEFAULT_AI_MODEL,
  aiMaxToolRounds: 20,
  aiChartFeedback: true,
  aiTelemetry: true,
};

const STORAGE_KEY = "vgi-frontend-settings";

function loadSettings(): Settings {
  if (typeof localStorage === "undefined") return defaultSettings;
  let stored: Settings = defaultSettings;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) stored = { ...defaultSettings, ...JSON.parse(raw) };
  } catch {}
  // Heal a persisted retired model ID → current replacement, and persist so
  // the upgrade sticks even if the user never opens Settings.
  const migrated = migrateModel(stored.aiModel);
  if (migrated !== stored.aiModel) {
    stored = { ...stored, aiModel: migrated };
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(stored)); } catch {}
  }
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
