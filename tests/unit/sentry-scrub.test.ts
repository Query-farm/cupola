import { describe, expect, test } from "bun:test";

import { scrubText, scrubUrl } from "../../src/lib/sentry-scrub";

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

describe("scrubText", () => {
  test("filters a sensitive param in a URL embedded in a message", () => {
    expect(
      scrubText("Token endpoint https://idp/token#refresh_token=def failed"),
    ).toBe("Token endpoint https://idp/token#refresh_token=[Filtered] failed");
  });

  test("filters ai_key in a query string inside free text", () => {
    expect(scrubText("redirect to https://app.example/?ai_key=sk-ant-xyz now")).toBe(
      "redirect to https://app.example/?ai_key=[Filtered] now",
    );
  });

  test("does not swallow a trailing delimiter into the URL", () => {
    expect(scrubText("see (https://app.example/#token=abc), then retry")).toBe(
      "see (https://app.example/#token=[Filtered]), then retry",
    );
  });

  test("scrubs multiple URLs in one message", () => {
    expect(
      scrubText("from https://a/#token=x to https://b/?ai_key=y end"),
    ).toBe("from https://a/#token=[Filtered] to https://b/?ai_key=[Filtered] end");
  });

  test("leaves messages without URLs untouched", () => {
    expect(scrubText("invalid_grant: refresh token expired")).toBe(
      "invalid_grant: refresh token expired",
    );
  });

  test("leaves a URL with no sensitive params untouched", () => {
    expect(scrubText("failed to reach https://idp/.well-known/openid-configuration")).toBe(
      "failed to reach https://idp/.well-known/openid-configuration",
    );
  });
});
