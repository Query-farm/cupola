---
paths:
  - "src/styles/**"
  - "src/lib/theme.ts"
  - "src/lib/auth.ts"
  - "src/lib/oauth-client.ts"
  - "src/components/ThemeBuilder.tsx"
  - "src/layouts/**"
  - "public/oauth-callback.html"
---

# Theme and OAuth

Default VGI green palette defined in `src/styles/global.css`:
- Background: `#faf8f0` (warm cream)
- Primary: `#2d5016` (forest green)
- Accent: `#4a7c23` (leaf green)
- Muted: `#6b6b5a`
- Border: `#f0ece0`
- Card: `#ffffff`

Custom themes can be loaded via `?theme=<url>` parameter. Theme JSON includes colors and optional terminal theme. Cached in localStorage.

## OAuth / Authentication

When a VGI server has OAuth PKCE enabled:
1. The frontend reads the JWT token from the URL fragment (`#token=...`) or `_vgi_auth` cookie
2. Token is sent as `Authorization: Bearer` header on all RPC calls
3. `getUserInfo()` in `src/lib/auth.ts` decodes the JWT payload; identity is shown per catalog, on its row in the workspace picker (`ServiceSwitcher`), not on the trigger
4. Token from fragment is cached in memory and cleaned from the URL
5. The DuckDB extension handles its own PKCE flow for ATTACH — uses SharedArrayBuffer to route auth codes from a popup back to the worker thread
