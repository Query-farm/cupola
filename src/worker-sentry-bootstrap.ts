/// <reference lib="webworker" />
// Bundled into public/shell/sentry-bootstrap.js (IIFE) and imported by
// public/shell/worker.js via importScripts. Exposes self.SentryWorker —
// the worker calls .init() once it knows the release/DSN, and the
// global error handlers route uncaught failures and unhandled rejections
// to Sentry. Fetch instrumentation is automatic (default integrations).

import * as Sentry from "@sentry/browser";

declare const self: DedicatedWorkerGlobalScope & {
  SentryWorker?: {
    init: (opts: SentryWorkerInitOpts) => void;
    captureException: (err: unknown, ctx?: Record<string, unknown>) => void;
    captureMessage: (msg: string, level?: Sentry.SeverityLevel) => void;
    setTag: (key: string, value: string) => void;
    setUser: (user: Sentry.User | null) => void;
    startSpan: <T>(
      opts: { name: string; op?: string; attributes?: Record<string, string | number | boolean> },
      callback: (span: { setStatus: (s: "ok" | "error") => void }) => Promise<T> | T,
    ) => Promise<T>;
  };
};

interface SentryWorkerInitOpts {
  dsn: string;
  release?: string;
  dist?: string;
  environment?: string;
  tracesSampleRate?: number;
}

let initialized = false;

function scrubAuth(event: Sentry.ErrorEvent | Sentry.TransactionEvent): void {
  if (event.request) {
    if (event.request.headers) {
      for (const key of Object.keys(event.request.headers)) {
        if (key.toLowerCase() === "authorization") {
          event.request.headers[key] = "[Filtered]";
        }
      }
    }
    if (typeof event.request.url === "string") {
      const hashIdx = event.request.url.indexOf("#");
      if (hashIdx >= 0) {
        const hash = event.request.url.slice(hashIdx + 1);
        if (/(^|&)token=/.test(hash)) {
          const cleaned = hash
            .split("&")
            .map((kv) => (kv.startsWith("token=") ? "token=[Filtered]" : kv))
            .join("&");
          event.request.url = `${event.request.url.slice(0, hashIdx)}#${cleaned}`;
        }
      }
    }
  }
}

self.SentryWorker = {
  init(opts) {
    if (initialized) return;
    initialized = true;
    Sentry.init({
      dsn: opts.dsn,
      release: opts.release,
      dist: opts.dist,
      environment: opts.environment ?? "production",
      tracesSampleRate: opts.tracesSampleRate ?? 1.0,
      sendDefaultPii: false,
      // browserTracingIntegration patches fetch + XHR globally so requests
      // inside any active span emit child spans. Pageload/navigation tracking
      // is window-only (no document in a worker) so we disable it — the
      // worker.js side starts its own root spans (boot + per-query).
      integrations: [
        Sentry.browserTracingIntegration({
          instrumentPageLoad: false,
          instrumentNavigation: false,
          enableLongTask: false,
          enableInp: false,
        }),
      ],
      beforeSend(event) {
        scrubAuth(event);
        return event;
      },
    });
    Sentry.setTag("thread", "shell-worker");
  },
  startSpan(opts, callback) {
    if (!initialized) return Promise.resolve(callback({ setStatus: () => {} }));
    return Sentry.startSpan(
      { name: opts.name, op: opts.op, attributes: opts.attributes },
      async (span) => {
        try {
          const result = await callback({
            setStatus: (s) => span.setStatus({ code: s === "ok" ? 1 : 2, message: s }),
          });
          return result;
        } catch (err) {
          span.setStatus({ code: 2, message: "internal_error" });
          throw err;
        }
      },
    );
  },
  captureException(err, ctx) {
    if (!initialized) return;
    if (ctx) {
      Sentry.withScope((scope) => {
        scope.setContext("worker", ctx);
        Sentry.captureException(err);
      });
    } else {
      Sentry.captureException(err);
    }
  },
  captureMessage(msg, level) {
    if (!initialized) return;
    Sentry.captureMessage(msg, level);
  },
  setTag(key, value) {
    if (!initialized) return;
    Sentry.setTag(key, value);
  },
  setUser(user) {
    if (!initialized) return;
    Sentry.setUser(user);
  },
};
