/**
 * Branded error page for the versioned-asset worker.
 *
 * Rendered from a bundled template rather than fetched from R2, for two
 * reasons: Tailwind is a build-time tool so the app's CSS is unreachable from
 * the worker anyway (the page has to be self-contained regardless), and the
 * one case where R2 can serve nothing at all — an empty bucket — is precisely
 * a case we need to render.
 *
 * Colors mirror the semantic tokens in `src/styles/global.css`. Deliberately
 * NOT copied from `public/oauth-callback.html`, whose palette is a hardcoded
 * older VGI green that has since drifted from the token set. The structure
 * (self-contained, prefers-color-scheme, centered card, Query.Farm footer)
 * does follow that file.
 */

export type ErrorVariant = "outdated-version" | "not-found" | "not-deployed";

export interface ErrorPageOptions {
  variant: ErrorVariant;
  /** Requested pathname, as received. Escaped before interpolation. */
  path: string;
  /** Version parsed out of the URL, when the path was a versioned one. */
  requestedVersion?: string;
  /** Version named by the R2 `_latest` marker, when it could be read. */
  latestVersion?: string;
}

/** Seconds before the page navigates itself to `/latest/`. */
const REDIRECT_SECONDS = 8;

/**
 * sessionStorage key guarding against a redirect loop. If `_latest` ever names
 * a version whose index.html is missing, `/latest/` → `/v{x}/` → 404 → redirect
 * → `/latest/` spins forever; the sentinel lets it happen exactly once.
 */
const REDIRECT_SENTINEL = "cupola-error-redirected";

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** HTTP status that goes with each variant. */
export function statusForVariant(variant: ErrorVariant): number {
  return variant === "not-deployed" ? 503 : 404;
}

/** Plain-text body for clients that did not ask for a document. */
export function plainTextForVariant(variant: ErrorVariant, path: string): string {
  switch (variant) {
    case "not-deployed":
      return "No version deployed yet.";
    case "outdated-version":
      return `Not found: ${path} (this version is no longer available)`;
    default:
      return `Not found: ${path}`;
  }
}

interface Copy {
  title: string;
  heading: string;
  /** Authored HTML — static strings only; interpolated values are escaped. */
  body: string;
  /** Extra muted line under the body. Authored HTML, same rule as `body`. */
  detail?: string;
  cta: string | null;
}

function copyFor(opts: ErrorPageOptions): Copy {
  const requested = opts.requestedVersion ? escapeHtml(opts.requestedVersion) : null;
  const latest = opts.latestVersion ? escapeHtml(opts.latestVersion) : null;

  switch (opts.variant) {
    case "outdated-version": {
      const body = latest
        ? `You asked for <code>v${requested}</code>, which is no longer available. The current version is <code>v${latest}</code>.`
        : `You asked for <code>v${requested}</code>, which is no longer available.`;
      return {
        title: "Version no longer available — Cupola",
        heading: "This version is no longer available",
        body,
        detail:
          "Your connection settings and current view carry over. If you bookmarked this page, update the bookmark to <code>/latest/</code> — it always follows the current release.",
        cta: "Go to the latest version",
      };
    }
    case "not-found":
      return {
        title: "Page not found — Cupola",
        heading: "Page not found",
        body: `Nothing is served at <code>${escapeHtml(opts.path)}</code>.`,
        cta: "Go to the latest version",
      };
    case "not-deployed":
      return {
        title: "Not deployed — Cupola",
        heading: "Cupola isn't deployed yet",
        body: "No version has been published to this installation.",
        detail:
          "If you administer this deployment, publish a release; otherwise check back shortly.",
        cta: null,

      };
  }
}

/**
 * Pre-paint theme script, mirroring `src/layouts/Layout.astro`. Same-origin
 * with the app, so the `vgi-theme-cache` entry the app wrote is readable here
 * and a branded install doesn't flash stock Cupola green.
 *
 * Differs from the Layout copy in one way: keys are gated against the tokens
 * this page actually paints, rather than writing every string key through.
 */
const THEME_SCRIPT = `(function(){try{
var ALLOWED={background:1,foreground:1,card:1,'card-foreground':1,border:1,'muted-foreground':1,accent:1,'accent-foreground':1,primary:1,'primary-foreground':1,radius:1};
var p=new URLSearchParams(window.location.search);
var url=p.get('theme');if(!url)return;
var raw=localStorage.getItem('vgi-theme-cache');if(!raw)return;
var entry=JSON.parse(raw);if(entry.url!==url)return;
var colors=entry.config?entry.config.colors:entry.data;if(!colors)return;
var root=document.documentElement;
for(var k in colors){if(ALLOWED[k]&&typeof colors[k]==='string'){root.style.setProperty('--'+k,colors[k]);}}
}catch(e){}})();`;

/**
 * Countdown + navigation. Client-side on purpose: the URL fragment
 * (`#token=`, `#sql=`, `#/schema/...`) never reaches the worker, so only the
 * browser can carry it across to `/latest/`. `location.replace` keeps the dead
 * URL out of history — with `href`, Back would land right back on this page.
 */
const REDIRECT_SCRIPT = `(function(){
var btn=document.getElementById('cta');if(!btn)return;
var label=btn.textContent;
function go(){try{sessionStorage.setItem(${JSON.stringify(REDIRECT_SENTINEL)},'1');}catch(e){}
location.replace('/latest/'+location.search+location.hash);}
btn.addEventListener('click',function(e){e.preventDefault();stop();go();});
var left=${REDIRECT_SECONDS},timer=null;
function stop(){if(timer!==null){clearInterval(timer);timer=null;btn.textContent=label;}}
var looped=false;try{looped=sessionStorage.getItem(${JSON.stringify(REDIRECT_SENTINEL)})==='1';}catch(e){}
if(looped)return;
function tick(){left-=1;if(left<=0){stop();go();return;}btn.textContent=label+' ('+left+')';}
btn.textContent=label+' ('+left+')';
timer=setInterval(tick,1000);
['keydown','wheel','touchstart','pointerdown'].forEach(function(ev){
window.addEventListener(ev,stop,{once:true,passive:true});});
})();`;

/**
 * The product mark is the axonometric cupola in `public/cupola-mark.svg`, the
 * same file `BrandMark` renders and the same shape query.farm uses. It is an
 * SVG (~1.4KB) rather than the old 256x256 PNG, so it stays crisp on the
 * error page's large header mark at any DPR.
 *
 * Referenced by unversioned URL rather than inlined: base64 would add ~126KB
 * to every worker response. The worker's latest-version fallback resolves
 * `/cupola-mark.svg` to `v{latest}/cupola-mark.svg`, the same way
 * `public/oauth-callback.html` reaches `/logo-hero.png`. In the one case that
 * fallback can't resolve — an empty bucket, the `not-deployed` variant — the
 * `onerror` hook drops the image rather than showing a broken-image glyph.
 */
const LOGO_SRC = "/cupola-mark.svg";
const LOGO_FALLBACK = `this.style.display='none'`;

export function renderErrorPage(opts: ErrorPageOptions): string {
  const copy = copyFor(opts);
  const autoRedirect = copy.cta !== null;
  const versionLine = opts.latestVersion
    ? `<p>v${escapeHtml(opts.latestVersion)}</p>`
    : "";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(copy.title)}</title>
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" crossorigin="anonymous" href="https://fonts.googleapis.com/css2?family=Commissioner:wght@300;500;600&family=Petrona:wght@600;700&display=swap">
<script>${THEME_SCRIPT}</script>
<style>
:root{
  --background:#f7f3ea; --foreground:#211a12;
  --card:#fffdf7; --card-foreground:#211a12;
  --border:#cfc4ad; --muted-foreground:#5d4632;
  --accent:#45632f; --accent-hover:#33501f; --accent-foreground:#ffffff;
  --code-bg:#e6dbc2;
  --ring-subtle:rgba(207,196,173,0.6);
  --page-gradient:linear-gradient(to bottom,#f7f3ea,#efe9db,#e6dbc2);
  --radius:0.5rem;
}
@media (prefers-color-scheme: dark){
  :root{
    --background:#100d0a; --foreground:#f4ece0;
    --card:#1a1512; --card-foreground:#f4ece0;
    --border:#2a2420; --muted-foreground:#c6b8a2;
    --accent:#8cb878; --accent-hover:#aecb84; --accent-foreground:#1a1512;
    --code-bg:#2a2420;
    --ring-subtle:rgba(42,36,32,0.6);
    --page-gradient:linear-gradient(to bottom,#100d0a,#100d0a,rgba(42,36,32,0.4));
  }
}
*{margin:0;padding:0;box-sizing:border-box}
body{
  font-family:'Commissioner',ui-sans-serif,system-ui,-apple-system,sans-serif;
  background:var(--background);
  background-image:var(--page-gradient);
  color:var(--foreground);
  min-height:100vh;
  display:flex;flex-direction:column;
  -webkit-font-smoothing:antialiased;
}
header{
  display:flex;align-items:center;gap:0.5rem;
  height:3.5rem;padding:0 1rem;flex-shrink:0;
  border-bottom:1px solid var(--border);
  background:var(--card);
}
.brand{display:flex;align-items:center;gap:0.5rem;white-space:nowrap;text-decoration:none;color:inherit}
header .mark{width:32px;height:32px;flex-shrink:0}
.wordmark{font-family:'Petrona',Georgia,serif;font-weight:700;font-size:1rem;line-height:1;color:var(--foreground)}
.byline{font-family:'Commissioner',ui-sans-serif,system-ui,sans-serif;font-size:0.875rem;line-height:1;color:var(--muted-foreground)}
@media (max-width:640px){.byline{display:none}}
main{
  flex:1;display:flex;align-items:flex-start;justify-content:center;
  padding:3rem 1.5rem;
}
.card{
  width:100%;max-width:32rem;
  background:var(--card);color:var(--card-foreground);
  border:1px solid var(--border);
  border-radius:calc(var(--radius) * 1.4);
  box-shadow:0 4px 24px rgba(0,0,0,0.06);
  padding:2rem;text-align:center;
}
/* Matches ErrorScreen's treatment: 96px, rounded-2xl (radius*1.8), ring + shadow. */
.hero{
  width:96px;height:96px;display:block;margin:0 auto 1.5rem;
  border-radius:calc(var(--radius) * 1.8);
  box-shadow:0 10px 15px -3px rgba(0,0,0,0.1),0 4px 6px -4px rgba(0,0,0,0.1);
  outline:1px solid var(--ring-subtle);outline-offset:-1px;
}
h1{font-family:'Petrona',Georgia,serif;font-size:1.5rem;font-weight:600;line-height:1.15;letter-spacing:-0.022em;margin-bottom:0.75rem}
p.body{font-size:0.938rem;line-height:1.6;color:var(--muted-foreground)}
p.detail{font-size:0.813rem;line-height:1.5;color:var(--muted-foreground);margin-top:0.75rem}
code{
  font-family:'JetBrains Mono',ui-monospace,SFMono-Regular,Menlo,monospace;
  font-size:0.875em;
  background:var(--code-bg);
  border-radius:calc(var(--radius) * 0.6);
  padding:0.125em 0.375em;
  word-break:break-all;
  color:var(--foreground);
}
.cta{
  display:inline-block;margin-top:1.5rem;
  padding:0.625rem 1.25rem;
  border:none;border-radius:var(--radius);
  background:var(--accent);color:var(--accent-foreground);
  font-family:inherit;font-size:0.875rem;font-weight:600;
  text-decoration:none;cursor:pointer;
  transition:background-color 0.15s;
  min-width:15rem;
}
.cta:hover{background:var(--accent-hover)}
.cta:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
footer{
  padding:1.5rem;text-align:center;
  font-size:0.75rem;line-height:1.6;color:var(--muted-foreground);
}
footer a{color:inherit;text-decoration:none}
footer a:hover{color:var(--foreground)}
</style>
</head>
<body>
<header>
  <a class="brand" href="https://query.farm" target="_blank" rel="noopener noreferrer" title="Cupola — a Query.Farm tool">
    <img class="mark" src="${LOGO_SRC}" alt="" aria-hidden="true" width="32" height="32" onerror="${LOGO_FALLBACK}">
    <span class="wordmark">Cupola</span>
    <span class="byline">by &#x1F69C;&nbsp;Query.Farm</span>
  </a>
</header>
<main>
  <div class="card">
    <img class="hero" src="${LOGO_SRC}" alt="" aria-hidden="true" width="96" height="96" onerror="${LOGO_FALLBACK}">
    <h1>${escapeHtml(copy.heading)}</h1>
    <p class="body">${copy.body}</p>
    ${copy.detail ? `<p class="detail">${copy.detail}</p>` : ""}
    ${copy.cta ? `<a class="cta" id="cta" href="/latest/">${escapeHtml(copy.cta)}</a>` : ""}
  </div>
</main>
<footer>
  <p>&copy; 2026 &#x1F69C; <a href="https://query.farm">Query.Farm LLC</a></p>
  ${versionLine}
</footer>
${autoRedirect ? `<script>${REDIRECT_SCRIPT}</script>` : ""}
</body>
</html>`;
}
