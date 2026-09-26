import type { CSSProperties } from 'react';
import { DEFAULT_THEME } from '@evidence/core/constants/default-theme';
import { buildThemes } from '@evidence/core/theme/build-themes';
import { generateThemeCSS } from '@evidence/core/theme/theme-css-helper';
import type { ThemeConfig } from '@evidence/core/types/theme';
import { DEFAULT_APPEARANCE, type ReportAppearance } from './appearance';

const palettes = {
  ocean: ['#2563eb', '#0891b2', '#7c3aed', '#d97706', '#db2777', '#059669'],
  earth: ['#557c45', '#b66a36', '#7463a6', '#168b91', '#b74362', '#887a39'],
  accessible: ['#0072b2', '#e69f00', '#009e73', '#cc79a7', '#d55e00', '#56b4e9'],
};
const fonts = {
  'sans-serif': "'Noto Sans', ui-sans-serif, system-ui, sans-serif",
  serif: "'Petrona', Georgia, serif",
  mono: "'JetBrains Mono', ui-monospace, monospace",
};
const presets = {
  cupola: { light: '#fffdf7', dark: '#242321', lightAccent: '#685442', darkAccent: '#ebc275', palette: 'earth', heading: 'serif', density: 'default' },
  paper: { light: '#ffffff', dark: '#18181b', lightAccent: '#334155', darkAccent: '#b6c5dc', palette: 'accessible', heading: 'serif', density: 'compact' },
  ocean: { light: '#f8fbff', dark: '#102033', lightAccent: '#1d4ed8', darkAccent: '#93c5fd', palette: 'ocean', heading: 'sans-serif', density: 'default' },
  forest: { light: '#fafbf6', dark: '#17231b', lightAccent: '#356047', darkAccent: '#a3d4ad', palette: 'earth', heading: 'serif', density: 'comfortable' },
} as const;
export const APP_THEME_TOKENS = ['background', 'foreground', 'card', 'card-foreground', 'popover', 'popover-foreground', 'primary', 'primary-foreground', 'secondary', 'secondary-foreground', 'muted', 'muted-foreground', 'accent', 'accent-foreground', 'destructive', 'border', 'input', 'ring', 'chart-1', 'chart-2', 'chart-3', 'chart-4', 'chart-5'] as const;
export interface ReportTheme { config: ThemeConfig; css: string; style: CSSProperties; mode: 'light' | 'dark' }

export function buildReportTheme(appearance: ReportAppearance | undefined, appDark: boolean, app: Record<string, string>): ReportTheme {
  const settings = appearance ?? DEFAULT_APPEARANCE;
  const preset = presets[settings.theme];
  const mode = settings.mode === 'app' ? (appDark ? 'dark' : 'light') : settings.mode;
  const followCupola = settings.theme === 'cupola' && (mode === (appDark ? 'dark' : 'light'));
  const base = followCupola ? app.card || preset[mode] : preset[mode];
  const accent = settings.accent ?? (followCupola ? app.primary : undefined) ?? (mode === 'dark' ? preset.darkAccent : preset.lightAccent);
  const palette = settings.palette === 'theme'
    ? followCupola ? [1, 2, 3, 4, 5].map(i => app[`chart-${i}`] || palettes.earth[i - 1]) : palettes[preset.palette]
    : palettes[settings.palette];
  const heading = settings.heading === 'theme' ? preset.heading : settings.heading;
  const body = settings.body === 'theme' ? 'sans-serif' : settings.body;
  const density = settings.density === 'theme' ? preset.density : settings.density;
  // Resolve the report's appearance locally. Both variants are identical so
  // Core's global mode watcher cannot override a report's explicit appearance.
  const pair = (color: string) => ({ light: color, dark: color });
  const config: ThemeConfig = {
    ...DEFAULT_THEME,
    colors: { ...DEFAULT_THEME.colors, base: pair(base), card: pair(base), cardLayoutBackground: pair(base) },
    colorPalettes: { default: { light: palette, dark: palette } },
    colorScales: { default: { light: [base, accent], dark: [base, accent] } },
    fonts: { heading, body, mono: 'mono' }, baseFontSize: '14px', density,
    table: { barColor: pair(accent), linkColor: pair(accent), rowLines: true },
  };
  const theme = buildThemes(config).light;
  const colors: Record<string, string> = {
    background: base, foreground: theme.foreground, card: base, 'card-foreground': theme.foreground,
    popover: base, 'popover-foreground': theme.foreground, muted: theme.muted, 'muted-foreground': theme.mutedForeground,
    border: theme.border, input: theme.border, secondary: theme.muted, 'secondary-foreground': theme.foreground,
    accent: theme.muted, 'accent-foreground': theme.foreground,
  };
  if (followCupola) for (const token of APP_THEME_TOKENS) if (app[token]) colors[token] = app[token];
  colors.background = base;
  colors.primary = accent;
  colors.ring = accent;
  // Pick a contrasting label for filled report controls, including custom accents.
  const channel = (offset: number) => parseInt(accent.slice(offset, offset + 2), 16) / 255;
  const linear = (value: number) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  const luminance = 0.2126 * linear(channel(1)) + 0.7152 * linear(channel(3)) + 0.0722 * linear(channel(5));
  colors['primary-foreground'] = luminance > 0.179 ? '#000000' : '#ffffff';
  const variables: Record<string, string> = Object.fromEntries(Object.entries(colors).map(([key, value]) => [`--${key}`, value]));
  Object.assign(variables, {
    '--theme-font-heading': fonts[heading], '--theme-font-body': fonts[body], '--theme-font-mono': fonts.mono,
    '--theme-font-scale': '0.875', '--theme-table-bar': accent, '--theme-table-link': accent,
    '--report-table-padding': density === 'compact' ? '4px 8px' : density === 'comfortable' ? '12px 14px' : '8px 12px',
    '--report-section-gap': density === 'compact' ? '20px' : density === 'comfortable' ? '36px' : '28px',
  });
  const overrides = Object.entries(variables).map(([name, value]) => `${name}: ${value} !important;`).join('\n');
  return { config, mode, style: { ...variables, backgroundColor: base, color: colors.foreground, colorScheme: mode } as CSSProperties,
    css: generateThemeCSS(config, { scopeSelector: ':host', lightModeOnly: true }) + `\n:host, .evidence-theme { ${overrides} color-scheme: ${mode}; }\n.evidence-document { --theme-font-scale: .875; font-family: var(--theme-font-body); }`,
  };
}
