import * as Sentry from "@sentry/astro";

declare const __APP_VERSION__: string;
declare const __GIT_HASH__: string;

const DSN =
  import.meta.env.PUBLIC_SENTRY_DSN ||
  "https://d0991fb45d2c62f5d25db86f2985cb79@o4511299556081664.ingest.us.sentry.io/4511299558637568";

// Only report from production builds. Dev errors are noisy and not actionable.
if (import.meta.env.PROD) {
  Sentry.init({
    dsn: DSN,
    release: `cupola@${__APP_VERSION__}+${__GIT_HASH__}`,
    dist: __GIT_HASH__,
    environment: import.meta.env.MODE,

    tracesSampleRate: 0.1,
    sendDefaultPii: false,

    beforeSend(event) {
      scrubAuth(event);
      return event;
    },
    beforeSendTransaction(event) {
      scrubAuth(event);
      return event;
    },
  });
}

function scrubAuth(event: Sentry.ErrorEvent | Sentry.TransactionEvent): void {
  if (event.request) {
    if (event.request.headers) {
      for (const key of Object.keys(event.request.headers)) {
        if (key.toLowerCase() === "authorization") {
          event.request.headers[key] = "[Filtered]";
        }
      }
    }
    if (typeof event.request.cookies === "string") {
      event.request.cookies = stripVgiCookie(event.request.cookies);
    } else if (event.request.cookies && typeof event.request.cookies === "object") {
      const c = event.request.cookies as Record<string, string>;
      if ("_vgi_auth" in c) c._vgi_auth = "[Filtered]";
    }
    if (typeof event.request.url === "string") {
      event.request.url = stripTokenFragment(event.request.url);
    }
  }
}

function stripVgiCookie(cookieHeader: string): string {
  return cookieHeader
    .split(";")
    .map((part) => {
      const [name] = part.split("=");
      if (name?.trim() === "_vgi_auth") return `${name}=[Filtered]`;
      return part;
    })
    .join(";");
}

function stripTokenFragment(url: string): string {
  const hashIdx = url.indexOf("#");
  if (hashIdx < 0) return url;
  const hash = url.slice(hashIdx + 1);
  if (!/(^|&)token=/.test(hash)) return url;
  const cleaned = hash
    .split("&")
    .map((kv) => (kv.startsWith("token=") ? "token=[Filtered]" : kv))
    .join("&");
  return `${url.slice(0, hashIdx)}#${cleaned}`;
}
