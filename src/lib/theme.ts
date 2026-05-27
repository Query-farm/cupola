/**
 * Theme support — load branding and CSS variable overrides from a `?theme=<url>` parameter.
 *
 * Structured format:
 *   {
 *     "name": "My Catalog",
 *     "logo": "https://example.com/logo.png",
 *     "colors": { "primary": "#8b0000", "accent": "#c0392b", ... },
 *     "terminal": { "background": "#1a1a0e", "foreground": "#f5f0e0", "cursor": "#6ba034", "selection": "#3a3a28" }
 *   }
 *
 * Legacy flat format is also supported (treated as colors-only):
 *   { "primary": "#8b0000", "accent": "#c0392b" }
 *
 * Fetched themes are cached in localStorage keyed by URL so subsequent page loads
 * can apply the theme synchronously before first paint (via the inline script in Layout.astro).
 */

const THEME_CACHE_KEY = "vgi-theme-cache";

/** Allowed CSS variable names that a theme can override. */
const ALLOWED_VARS = new Set([
  "background",
  "foreground",
  "card",
  "card-foreground",
  "popover",
  "popover-foreground",
  "primary",
  "primary-foreground",
  "secondary",
  "secondary-foreground",
  "muted",
  "muted-foreground",
  "accent",
  "accent-foreground",
  "destructive",
  "border",
  "input",
  "ring",
  "chart-1",
  "chart-2",
  "chart-3",
  "chart-4",
  "chart-5",
  "radius",
  "sidebar",
  "sidebar-foreground",
  "sidebar-primary",
  "sidebar-primary-foreground",
  "sidebar-accent",
  "sidebar-accent-foreground",
  "sidebar-border",
  "sidebar-ring",
  "terminal-bg",
  "terminal-fg",
  "terminal-accent",
  "terminal-muted",
]);

/** Terminal color scheme. */
export interface TerminalTheme {
  background: string;
  foreground: string;
  cursor: string;
  selection: string;
}

/** Full structured theme configuration. */
export interface ThemeConfig {
  /** Optional display name (not currently used in UI, reserved for future). */
  name?: string;
  /** URL to a logo image — replaces the default VGI logo in header and error screens. */
  logo?: string;
  /** CSS variable overrides applied to :root. */
  colors: Record<string, string>;
  /** Terminal (xterm.js) color overrides. */
  terminal?: Partial<TerminalTheme>;
}

/** Default terminal colors (VGI green-on-dark). */
export const DEFAULT_TERMINAL_THEME: TerminalTheme = {
  background: "#1a1a0e",
  foreground: "#f5f0e0",
  cursor: "#6ba034",
  selection: "#3a3a28",
};

/** Default logo URL — served from our own origin so COEP require-corp lets it through. */
export const DEFAULT_LOGO = `${import.meta.env.BASE_URL}logo-hero.png`;

interface ThemeCacheEntry {
  url: string;
  config: ThemeConfig;
}

/** Module-level loaded theme — available synchronously after loadTheme() resolves. */
let _loadedTheme: ThemeConfig | null = null;

/** Get the currently loaded theme (or null if none). */
export function getLoadedTheme(): ThemeConfig | null {
  return _loadedTheme;
}

/** Get the active logo URL (from loaded theme or default). */
export function getLogoUrl(): string {
  return _loadedTheme?.logo || DEFAULT_LOGO;
}

/** Get the active terminal theme (merged with defaults).
 *  Priority: structured `terminal` section > `colors.terminal-*` > defaults. */
export function getTerminalTheme(): TerminalTheme {
  const fromColors = _loadedTheme?.colors ?? {};
  const colorOverrides: Partial<TerminalTheme> = {};
  if (fromColors["terminal-bg"]) colorOverrides.background = fromColors["terminal-bg"];
  if (fromColors["terminal-fg"]) colorOverrides.foreground = fromColors["terminal-fg"];
  if (fromColors["terminal-accent"]) colorOverrides.cursor = fromColors["terminal-accent"];
  if (fromColors["terminal-muted"]) colorOverrides.selection = fromColors["terminal-muted"];
  return { ...DEFAULT_TERMINAL_THEME, ...colorOverrides, ...(_loadedTheme?.terminal ?? {}) };
}

/**
 * Normalize raw JSON into a ThemeConfig.
 * Supports both the structured format and the legacy flat color-only format.
 */
function normalizeTheme(raw: any): ThemeConfig {
  if (raw && typeof raw === "object" && (raw.colors || raw.logo || raw.terminal || raw.name)) {
    // Structured format
    return {
      name: typeof raw.name === "string" ? raw.name : undefined,
      logo: typeof raw.logo === "string" ? raw.logo : undefined,
      colors: raw.colors && typeof raw.colors === "object" ? raw.colors : {},
      terminal: raw.terminal && typeof raw.terminal === "object" ? raw.terminal : undefined,
    };
  }
  // Legacy flat format — entire object is colors
  return { colors: raw };
}

/** Read the cached theme from localStorage. */
function getCachedTheme(): ThemeCacheEntry | null {
  try {
    const raw = localStorage.getItem(THEME_CACHE_KEY);
    if (raw) return JSON.parse(raw);
  } catch {}
  return null;
}

/** Apply color overrides to the document root. */
function applyColors(colors: Record<string, string>): void {
  const root = document.documentElement;
  for (const [key, value] of Object.entries(colors)) {
    if (ALLOWED_VARS.has(key) && typeof value === "string") {
      root.style.setProperty(`--${key}`, value);
    }
  }
}

/** Remove any applied CSS variable overrides (restore defaults). */
export function clearTheme(): void {
  const root = document.documentElement;
  for (const key of ALLOWED_VARS) {
    root.style.removeProperty(`--${key}`);
  }
  _loadedTheme = null;
  try {
    localStorage.removeItem(THEME_CACHE_KEY);
  } catch {}
}

// Theme URL accessor is now in lib/url-params.ts; re-exported so callers that
// reach for it via `theme` continue to compile during the consolidation.
import { getThemeUrl } from "./url-params";
export { getThemeUrl };

/**
 * Load and apply theme from the `?theme=` URL parameter.
 *
 * Returns the loaded ThemeConfig, or null if no theme was specified.
 *
 * 1. If no `?theme=` param, clears any previously cached theme and returns null.
 * 2. If the URL matches the cache, uses the cached config (inline script already applied colors).
 * 3. Otherwise fetches the JSON, normalizes, applies colors, and caches for next load.
 */
export async function loadTheme(): Promise<ThemeConfig | null> {
  const themeUrl = getThemeUrl();

  if (!themeUrl) {
    // No theme param — clear any stale cache so default CSS takes over
    const cached = getCachedTheme();
    if (cached) clearTheme();
    return null;
  }

  const cached = getCachedTheme();
  if (cached && cached.url === themeUrl) {
    // Already applied by the inline script; just store in module state.
    _loadedTheme = cached.config;
    return cached.config;
  }

  try {
    const resp = await fetch(themeUrl);
    if (!resp.ok) {
      console.warn(`[theme] Failed to fetch theme from ${themeUrl}: ${resp.status}`);
      return null;
    }
    const raw = await resp.json();
    const config = normalizeTheme(raw);
    _loadedTheme = config;
    applyColors(config.colors);

    // Cache for flash-free next load
    try {
      localStorage.setItem(THEME_CACHE_KEY, JSON.stringify({ url: themeUrl, config }));
    } catch {}

    return config;
  } catch (err) {
    console.warn("[theme] Error loading theme:", err);
    return null;
  }
}
