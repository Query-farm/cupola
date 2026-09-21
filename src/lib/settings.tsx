import { createContext, useContext, useState, type ReactNode } from "react";
import { consumeAiKey } from "./url-params";
import { DEFAULT_AI_MAX_TOKENS } from "./ai/model-limits";
import { DEFAULT_AI_QUERY_MODE, normalizeAIQueryMode, type AIQueryMode } from "./ai/query-mode";
import { DEFAULT_AI_EFFORT, normalizeEffort, type AIEffort } from "./ai/model-features";

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
  /** Remembered rows-per-page for the data preview grid (editor results +
   *  catalog Preview Data tab). One of the PAGE_SIZES in DataPreview. */
  previewRowsPerPage: number;
  /** Render geometry columns as WKT text instead of a clickable map preview. */
  geometryAsText: boolean;
  /** Group digits in numeric cells using the browser's locale separator
   *  (1234567 -> 1,234,567). Display only: the grids opt in, while CSV/XLSX
   *  export, clipboard copy, the AI agent's view of results, and the terminal
   *  deliberately do not — see `formatCellValue`'s `grouping` option. */
  numberGrouping: boolean;
  anthropicApiKey: string;
  /** Optional for workspace-scoped keys; required for identity-linked keys
   *  that can act in more than one Anthropic workspace. */
  anthropicWorkspaceId: string;
  aiModel: string;
  /** Thinking depth / token spend for models that support adaptive thinking
   *  (see ai/model-features). Ignored — and not shown — for models that don't,
   *  where sending `output_config.effort` is a 400. */
  aiEffort: AIEffort;
  /** Governs which database-query tools AI surfaces may use. This never
   * restricts SQL entered manually by the user. */
  aiQueryMode: AIQueryMode;
  aiMaxToolRounds: number;
  /** Max output tokens per AI request. Clamped to the selected model's own
   *  ceiling before the request goes out (over it is a 400). The old
   *  hardcoded 4096 truncated long tool_use blocks — notably large Vega specs
   *  from render_chart — mid-JSON. */
  aiMaxTokens: number;
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
export const DEFAULT_AI_MODEL = "claude-sonnet-5";

/** Map of superseded Claude model IDs → the current model in their tier.
 *  Applied on load (migrateModel), so a persisted value always names something
 *  the picker still offers — otherwise the Select renders blank and the model
 *  silently falls through every per-model table (pricing, output ceiling,
 *  thinking support), each of which degrades quietly rather than erroring.
 *
 *  Two kinds of entry, both single-hop on purpose — a chain would need the
 *  intermediate IDs kept here forever:
 *   - Retired by Anthropic (claude-sonnet-4-20250514 / claude-opus-4-20250514,
 *     both removed 2026-06-15 with no grace period), where staying put is an
 *     API error.
 *   - Superseded but still served (Sonnet 4.6, Opus 4.8), where staying put
 *     works and just costs more: Sonnet 5 is $2/$10 against 4.6's $3/$15, and
 *     Opus 5 matches 4.8's $5/$25. */
const SUPERSEDED_MODEL_REPLACEMENTS: Record<string, string> = {
  "claude-sonnet-4-20250514": "claude-sonnet-5",
  "claude-opus-4-20250514": "claude-opus-5",
  "claude-sonnet-4-6": "claude-sonnet-5",
  "claude-opus-4-8": "claude-opus-5",
};

function migrateModel(model: string): string {
  return SUPERSEDED_MODEL_REPLACEMENTS[model] ?? model;
}

const defaultSettings: Settings = {
  showDuckDBTypes: true,
  hideTableBackingFunctions: true,
  hideDollarTables: true,
  shellFontSize: 13,
  shellThreads: 0,
  editorFontSize: 13,
  editorAutocomplete: true,
  previewRowsPerPage: 50,
  geometryAsText: false,
  numberGrouping: false,
  anthropicApiKey: "",
  anthropicWorkspaceId: "",
  aiModel: DEFAULT_AI_MODEL,
  aiEffort: DEFAULT_AI_EFFORT,
  aiQueryMode: DEFAULT_AI_QUERY_MODE,
  aiMaxToolRounds: 20,
  aiMaxTokens: DEFAULT_AI_MAX_TOKENS,
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
  stored = {
    ...stored,
    aiQueryMode: normalizeAIQueryMode(stored.aiQueryMode),
    aiEffort: normalizeEffort(stored.aiEffort),
  };
  // Heal a persisted superseded model ID → current replacement, and persist so
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
