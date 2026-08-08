/**
 * Tests for per-model output-token clamping.
 *
 * `max_tokens` above a model's ceiling is a 400 from the API, and below ~1 is
 * also rejected — so this clamp sits between user configuration and every
 * agent request. Haiku's ceiling (64K) is half of Sonnet's and Opus's (128K),
 * which is the reason a single shared constant isn't good enough.
 */
import { test, expect, describe } from "bun:test";
import {
  clampMaxTokens,
  modelMaxOutputTokens,
  DEFAULT_AI_MAX_TOKENS,
  CONSERVATIVE_MAX_OUTPUT_TOKENS,
} from "../../src/lib/ai/model-limits";

describe("modelMaxOutputTokens", () => {
  test("knows the ceiling for each offered model", () => {
    expect(modelMaxOutputTokens("claude-haiku-4-5-20251001")).toBe(64_000);
    expect(modelMaxOutputTokens("claude-sonnet-4-6")).toBe(128_000);
    expect(modelMaxOutputTokens("claude-opus-4-8")).toBe(128_000);
  });

  test("falls back conservatively for an unknown model", () => {
    // Degrading to a smaller cap is recoverable; guessing high is a 400.
    expect(modelMaxOutputTokens("claude-something-new")).toBe(CONSERVATIVE_MAX_OUTPUT_TOKENS);
  });
});

describe("clampMaxTokens", () => {
  test("passes through a value within the model's ceiling", () => {
    expect(clampMaxTokens("claude-sonnet-4-6", 16_384)).toBe(16_384);
  });

  test("clamps to the model ceiling rather than sending a 400", () => {
    // The Haiku case: a user picks 128k on Sonnet, then switches to Haiku.
    expect(clampMaxTokens("claude-haiku-4-5-20251001", 128_000)).toBe(64_000);
  });

  test("never exceeds the conservative fallback on an unknown model", () => {
    expect(clampMaxTokens("claude-mystery", 128_000)).toBe(CONSERVATIVE_MAX_OUTPUT_TOKENS);
  });

  test("substitutes the default for missing or corrupt settings", () => {
    for (const bad of [undefined, 0, -1, NaN, Infinity]) {
      expect(clampMaxTokens("claude-sonnet-4-6", bad as number)).toBe(DEFAULT_AI_MAX_TOKENS);
    }
  });

  test("the default itself fits every offered model", () => {
    for (const m of ["claude-haiku-4-5-20251001", "claude-sonnet-4-6", "claude-opus-4-8"]) {
      expect(clampMaxTokens(m, DEFAULT_AI_MAX_TOKENS)).toBe(DEFAULT_AI_MAX_TOKENS);
    }
  });

  test("is a real increase over the previous hardcoded 4096", () => {
    expect(DEFAULT_AI_MAX_TOKENS).toBeGreaterThan(4096);
  });

  test("floors fractional values (the API wants an integer)", () => {
    expect(clampMaxTokens("claude-sonnet-4-6", 8192.7)).toBe(8192);
  });
});
