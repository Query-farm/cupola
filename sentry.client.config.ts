import * as Sentry from "@sentry/astro";

import { scrubUrl } from "./src/lib/sentry-scrub";

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

    // AI agent traces are sampled at 100% — they're low-volume (interactive
    // chat) and the gen_ai spans power Sentry's AI Agents / Conversations
    // views, where a dropped root loses the whole turn. Everything else keeps
    // the prior 10% (respecting upstream parent decisions).
    tracesSampler: (ctx) => {
      const isAgentRoot =
        ctx.name.startsWith("invoke_agent ") ||
        ctx.attributes?.["sentry.op"] === "gen_ai.invoke_agent";
      if (isAgentRoot) return 1.0;
      return ctx.inheritOrSampleWith(0.1);
    },
    // Required for conversation analytics (gen_ai.input/output.messages);
    // users can opt out via Settings → "Share AI conversation analytics".
    sendDefaultPii: true,
    // Send gen_ai spans as standalone envelope items so large conversations
    // don't blow the transaction payload limit (and Conversations works).
    streamGenAiSpans: true,

    beforeSend(event) {
      scrubAuth(event);
      return event;
    },
    beforeSendTransaction(event) {
      scrubAuth(event);
      return event;
    },
    // Navigation/fetch/xhr breadcrumbs carry URLs that beforeSend never sees.
    beforeBreadcrumb(breadcrumb) {
      const data = breadcrumb.data;
      if (data) {
        for (const key of ["url", "from", "to"] as const) {
          if (typeof data[key] === "string") data[key] = scrubUrl(data[key]);
        }
      }
      return breadcrumb;
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
      event.request.url = scrubUrl(event.request.url);
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
