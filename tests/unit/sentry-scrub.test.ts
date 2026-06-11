import { describe, expect, test } from "bun:test";

import { scrubUrl } from "../../src/lib/sentry-scrub";

describe("scrubUrl", () => {
  test("filters the OAuth token fragment", () => {
    expect(scrubUrl("https://app.example/#token=eyJhbGc.secret")).toBe(
      "https://app.example/#token=[Filtered]",
    );
  });

  test("filters every sensitive key in a combined auth fragment", () => {
    const url =
      "https://app.example/?service=http://s#token=abc&refresh_token=def&token_endpoint=https://idp/token&client_id=cid&client_secret=shh&use_id_token=true&ai_key=sk-ant-xyz";
    expect(scrubUrl(url)).toBe(
      "https://app.example/?service=http://s#token=[Filtered]&refresh_token=[Filtered]&token_endpoint=https://idp/token&client_id=cid&client_secret=[Filtered]&use_id_token=true&ai_key=[Filtered]",
    );
  });

  test("filters ai_key in the query string", () => {
    expect(scrubUrl("https://app.example/?service=http://s&ai_key=sk-ant-xyz")).toBe(
      "https://app.example/?service=http://s&ai_key=[Filtered]",
    );
  });

  test("does not filter refresh_token via a bare token= prefix match", () => {
    expect(scrubUrl("https://app.example/#refresh_token=def")).toBe(
      "https://app.example/#refresh_token=[Filtered]",
    );
  });

  test("leaves selection-routing fragments untouched", () => {
    const url = "https://app.example/?service=http://s#/schema/property/table/parcels";
    expect(scrubUrl(url)).toBe(url);
  });

  test("leaves the prefill fragment untouched", () => {
    const url = "https://app.example/#prefill=http://localhost:9003";
    expect(scrubUrl(url)).toBe(url);
  });

  test("leaves URLs without query or fragment untouched", () => {
    expect(scrubUrl("https://app.example/v0.4.80/index.html")).toBe(
      "https://app.example/v0.4.80/index.html",
    );
  });

  test("handles a fragment that mixes kv pairs and non-kv segments", () => {
    expect(scrubUrl("https://app.example/#foo&token=abc")).toBe(
      "https://app.example/#foo&token=[Filtered]",
    );
  });
});
