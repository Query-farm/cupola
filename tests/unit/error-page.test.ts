import { describe, expect, test } from "bun:test";

import {
  plainTextForVariant,
  renderErrorPage,
  statusForVariant,
} from "../../worker/error-page";

describe("statusForVariant", () => {
  test("404 for the two not-found flavors, 503 when nothing is deployed", () => {
    expect(statusForVariant("outdated-version")).toBe(404);
    expect(statusForVariant("not-found")).toBe(404);
    expect(statusForVariant("not-deployed")).toBe(503);
  });
});

describe("renderErrorPage — outdated-version", () => {
  const html = renderErrorPage({
    variant: "outdated-version",
    path: "/v0.3.1/",
    requestedVersion: "0.3.1",
    latestVersion: "0.4.90",
  });

  test("names both the requested and the current version", () => {
    expect(html).toContain("<code>v0.3.1</code>");
    expect(html).toContain("<code>v0.4.90</code>");
    expect(html).toContain("This version is no longer available");
  });

  test("offers the redirect CTA", () => {
    expect(html).toContain('id="cta"');
    expect(html).toContain("Go to the latest version");
  });

  test("carries both the query string and the fragment across", () => {
    // The fragment never reaches the worker, so only client-side navigation
    // can preserve #token= / #sql= / #/schema/...
    expect(html).toContain("location.search");
    expect(html).toContain("location.hash");
    expect(html).toContain("location.replace");
  });

  test("uses replace, not href assignment, so Back skips the dead URL", () => {
    expect(html).not.toContain("location.href=");
  });

  test("guards against a redirect loop with a sessionStorage sentinel", () => {
    expect(html).toContain("cupola-error-redirected");
  });

  test("tells the user to update a stale bookmark", () => {
    expect(html).toContain("update the bookmark to <code>/latest/</code>");
  });

  test("drops the current-version line when _latest could not be read", () => {
    const noLatest = renderErrorPage({
      variant: "outdated-version",
      path: "/v0.3.1/",
      requestedVersion: "0.3.1",
    });
    expect(noLatest).toContain("<code>v0.3.1</code>");
    expect(noLatest).not.toContain("The current version is");
  });
});

describe("renderErrorPage — not-found", () => {
  const html = renderErrorPage({
    variant: "not-found",
    path: "/v0.4.90/nope",
    requestedVersion: "0.4.90",
    latestVersion: "0.4.90",
  });

  test("does not claim the version is outdated", () => {
    expect(html).toContain("Page not found");
    expect(html).not.toContain("no longer available");
  });

  test("still offers the redirect", () => {
    expect(html).toContain('id="cta"');
  });
});

describe("renderErrorPage — not-deployed", () => {
  const html = renderErrorPage({ variant: "not-deployed", path: "/latest/" });

  test("renders no CTA and no auto-redirect", () => {
    // /latest/ is the broken thing here; redirecting to it would loop.
    expect(html).toContain("Cupola isn&#39;t deployed yet");
    expect(html).not.toContain('id="cta"');
    expect(html).not.toContain("location.replace");
  });
});

describe("renderErrorPage — escaping", () => {
  test("escapes the requested path", () => {
    const html = renderErrorPage({
      variant: "not-found",
      path: '/"><script>alert(1)</script>',
      latestVersion: "0.4.90",
    });
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain("&quot;&gt;");
  });

  test("escapes version strings", () => {
    const html = renderErrorPage({
      variant: "outdated-version",
      path: "/v1.0.0/",
      requestedVersion: '1.0.0"><b>',
      latestVersion: "0.4.90",
    });
    expect(html).not.toContain('1.0.0"><b>');
    expect(html).toContain("&lt;b&gt;");
  });
});

describe("renderErrorPage — branding", () => {
  const html = renderErrorPage({ variant: "not-found", path: "/nope", latestVersion: "0.4.90" });

  test("uses the same product mark BrandMark renders", () => {
    // Both the header lockup and this page point at cupola-mark.svg — the
    // axonometric cupola, matching query.farm. The mark is REFERENCED, never
    // inlined: base64 would add weight to every worker response.
    expect(html).toContain('src="/cupola-mark.svg"');
    expect(html).not.toContain("<svg");
  });

  test("references the logo unversioned so the latest-version fallback resolves it", () => {
    expect(html).not.toContain("/v0.4.90/cupola-mark.svg");
  });

  test("hides the logo rather than showing a broken image when R2 can't serve it", () => {
    expect(html).toContain("onerror=");
  });

  test("carries the Query.Farm lockup and footer", () => {
    expect(html).toContain("Cupola");
    expect(html).toContain("Query.Farm");
  });
});

describe("plainTextForVariant", () => {
  test("keeps the original bodies for non-document clients", () => {
    expect(plainTextForVariant("not-found", "/a/b")).toBe("Not found: /a/b");
    expect(plainTextForVariant("not-deployed", "/latest/")).toBe("No version deployed yet.");
    expect(plainTextForVariant("outdated-version", "/v0.3.1/")).toContain(
      "no longer available",
    );
  });
});
