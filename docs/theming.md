# Theming

The VGI web frontend supports custom theming via a `?theme=<url>` query parameter. A VGI server (or any static host) serves a JSON file describing colors, logo, and terminal appearance. The frontend fetches it on load and applies CSS variable overrides — every ShadCN component, Tailwind utility class, and the DuckDB shell respond automatically.

## Quick start

1. Create a `theme.json` file:

```json
{
  "name": "My Organization",
  "logo": "https://example.com/logo.png",
  "colors": {
    "primary": "#1a4a6b",
    "accent": "#2a7ab5",
    "background": "#f0f5fa"
  }
}
```

2. Serve it from your VGI server or any URL.

3. Pass it as a query parameter:

```
https://your-frontend.com/?service=http://localhost:9003&theme=http://localhost:9003/theme.json
```

Only the properties you include are overridden — everything else keeps the default VGI green theme.

## Theme JSON format

```json
{
  "name": "Albemarle GIS",
  "logo": "https://example.com/logo.png",
  "colors": {
    "primary": "#2d5016",
    "primary-foreground": "#ffffff",
    "accent": "#4a7c23",
    "accent-foreground": "#ffffff",
    "background": "#faf8f0",
    "foreground": "#2c2c1e",
    "card": "#ffffff",
    "card-foreground": "#2c2c1e",
    "muted": "#f0ece0",
    "muted-foreground": "#6b6b5a",
    "secondary": "#f0ece0",
    "secondary-foreground": "#2c2c1e",
    "border": "#f0ece0",
    "input": "#e0dcd0",
    "ring": "#4a7c23",
    "destructive": "#8b0000",
    "popover": "#ffffff",
    "popover-foreground": "#2c2c1e",
    "sidebar": "#faf8f0",
    "sidebar-foreground": "#2c2c1e",
    "sidebar-primary": "#2d5016",
    "sidebar-primary-foreground": "#ffffff",
    "sidebar-accent": "#f0ece0",
    "sidebar-accent-foreground": "#2c2c1e",
    "sidebar-border": "#f0ece0",
    "sidebar-ring": "#4a7c23",
    "chart-1": "#2d5016",
    "chart-2": "#4a7c23",
    "chart-3": "#c8a43a",
    "chart-4": "#6b6b5a",
    "chart-5": "#1a4a6b",
    "radius": "0.5rem",
    "terminal-bg": "#1a1a0e",
    "terminal-fg": "#f5f0e0",
    "terminal-accent": "#6ba034",
    "terminal-muted": "#4a4a38"
  },
  "terminal": {
    "background": "#1a1a0e",
    "foreground": "#f5f0e0",
    "cursor": "#6ba034",
    "selection": "#3a3a28"
  }
}
```

All fields are optional. The sections are described below.

### `name`

A display name for the theme. Reserved for future use (e.g., a theme picker).

### `logo`

URL to an image that replaces the default VGI logo in the header bar and the error/connection screen. Any image format works; it renders at 28x28 in the header and 64x64 on the error page.

### `colors`

CSS variable overrides applied to the document root. Keys are variable names without the `--` prefix. Only the following names are accepted (anything else is ignored):

| Group | Variables |
|---|---|
| **Core** | `background`, `foreground` |
| **Card** | `card`, `card-foreground` |
| **Popover** | `popover`, `popover-foreground` |
| **Primary** | `primary`, `primary-foreground` |
| **Secondary** | `secondary`, `secondary-foreground` |
| **Muted** | `muted`, `muted-foreground` |
| **Accent** | `accent`, `accent-foreground` |
| **Destructive** | `destructive` |
| **Borders & Input** | `border`, `input`, `ring` |
| **Charts** | `chart-1`, `chart-2`, `chart-3`, `chart-4`, `chart-5` |
| **Radius** | `radius` |
| **Sidebar** | `sidebar`, `sidebar-foreground`, `sidebar-primary`, `sidebar-primary-foreground`, `sidebar-accent`, `sidebar-accent-foreground`, `sidebar-border`, `sidebar-ring` |
| **Terminal** | `terminal-bg`, `terminal-fg`, `terminal-accent`, `terminal-muted` |

These map directly to the ShadCN/Tailwind design token layer. For example, `primary` controls every element using the Tailwind `bg-primary` or `text-primary` class.

### `terminal`

Controls the xterm.js terminal emulator used by the DuckDB shell:

| Key | Description | Default |
|---|---|---|
| `background` | Terminal background color | `#1a1a0e` |
| `foreground` | Terminal text color | `#f5f0e0` |
| `cursor` | Cursor color | `#6ba034` |
| `selection` | Text selection highlight | `#3a3a28` |

The `terminal` section and `colors.terminal-*` both affect the shell, but through different paths:

- **`colors.terminal-*`** sets CSS variables that control the shell panel UI (scrollbars, loading states, settings preview, borders).
- **`terminal.*`** is passed directly to the xterm.js `Terminal` constructor for the actual terminal emulator canvas.

If you want both to match (recommended), set both. If you only set one, the other keeps its defaults.

**Priority for the xterm.js terminal:** `terminal` section > `colors.terminal-*` > built-in defaults.

## Legacy flat format

For backward compatibility, a flat object of color overrides is also accepted:

```json
{
  "primary": "#8b0000",
  "accent": "#c0392b",
  "background": "#fdf6f6"
}
```

This is equivalent to `{ "colors": { ... } }` with no logo or terminal customization.

## Caching and flash prevention

Fetched themes are cached in `localStorage` (key: `vgi-theme-cache`) along with the URL they were fetched from. On subsequent page loads:

1. An inline `<script>` in the HTML `<head>` runs before first paint.
2. It checks if the current `?theme=` URL matches the cached URL.
3. If so, it applies the cached color variables synchronously — no flash of default colors.
4. The async `loadTheme()` call then confirms the cache is current; if the URL changed, it fetches and re-caches.

If the `?theme=` parameter is removed, the cache is cleared and the default theme is restored.

## Example themes

### Ocean blue

```json
{
  "name": "Ocean",
  "colors": {
    "primary": "#1a4a6b",
    "primary-foreground": "#ffffff",
    "accent": "#2a7ab5",
    "accent-foreground": "#ffffff",
    "background": "#f0f5fa",
    "foreground": "#1a2a3a",
    "card": "#ffffff",
    "card-foreground": "#1a2a3a",
    "muted": "#e0e8f0",
    "muted-foreground": "#5a6a7a",
    "secondary": "#e0e8f0",
    "secondary-foreground": "#1a2a3a",
    "border": "#d0d8e0",
    "input": "#c0c8d0",
    "ring": "#2a7ab5",
    "sidebar": "#f0f5fa",
    "sidebar-primary": "#1a4a6b",
    "sidebar-border": "#d0d8e0"
  },
  "terminal": {
    "background": "#0a1a2a",
    "foreground": "#e0e8f0",
    "cursor": "#2a7ab5",
    "selection": "#1a3a5a"
  }
}
```

### Warm red

```json
{
  "name": "Warm Red",
  "colors": {
    "primary": "#8b2020",
    "primary-foreground": "#ffffff",
    "accent": "#c0392b",
    "accent-foreground": "#ffffff",
    "background": "#fdf6f6",
    "foreground": "#2c1e1e",
    "card": "#ffffff",
    "card-foreground": "#2c1e1e",
    "muted": "#f0e0e0",
    "muted-foreground": "#6b5a5a",
    "secondary": "#f0e0e0",
    "secondary-foreground": "#2c1e1e",
    "border": "#f0e0e0",
    "input": "#e0d0d0",
    "ring": "#c0392b",
    "sidebar": "#fdf6f6",
    "sidebar-primary": "#8b2020",
    "sidebar-border": "#f0e0e0"
  }
}
```

### Minimal: just a logo and primary color

```json
{
  "logo": "https://example.com/my-logo.png",
  "colors": {
    "primary": "#4a2d80",
    "accent": "#6b44b0"
  }
}
```

## Serving themes from a VGI server

A VGI server can serve a static `theme.json` and redirect browsers with both parameters:

```
https://frontend.example.com/?service=https://api.example.com&theme=https://api.example.com/theme.json
```

This lets each VGI deployment have its own branding without forking or rebuilding the frontend. The theme file can be a static file or generated dynamically.

### CORS

The theme URL is fetched from the browser via `fetch()`. If the theme is hosted on a different origin than the frontend, the server must return appropriate `Access-Control-Allow-Origin` headers.
