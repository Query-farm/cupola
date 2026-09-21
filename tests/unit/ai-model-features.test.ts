import { describe, expect, test } from "bun:test";

import {
  AI_EFFORT_LEVELS,
  DEFAULT_AI_EFFORT,
  normalizeEffort,
  supportsAdaptiveThinking,
  supportsEffort,
  thinkingRequestFields,
} from "../../src/lib/ai/model-features";
import { modelMaxOutputTokens } from "../../src/lib/ai/model-limits";
import { MODEL_PRICING } from "../../src/lib/pricing";

/** Every model the settings picker offers. Kept here so the per-model tables
 *  can be asserted against one list — a model added to the picker without a
 *  pricing or output-ceiling entry degrades silently, which is the failure
 *  mode these assertions exist to catch. */
const OFFERED_MODELS = [
  "claude-haiku-4-5-20251001",
  "claude-sonnet-5",
  "claude-opus-5",
];

describe("model feature gating", () => {
  test("adaptive thinking is on for Sonnet 5 and Opus 5, off for Haiku", () => {
    expect(supportsAdaptiveThinking("claude-sonnet-5")).toBe(true);
    expect(supportsAdaptiveThinking("claude-opus-5")).toBe(true);
    expect(supportsAdaptiveThinking("claude-haiku-4-5-20251001")).toBe(false);
  });

  test("an unknown model sends neither field — the combination every model accepts", () => {
    expect(supportsAdaptiveThinking("claude-something-unreleased")).toBe(false);
    expect(thinkingRequestFields("claude-something-unreleased", "high")).toEqual({});
  });

  test("effort tracks thinking support, because it 400s without it", () => {
    for (const model of OFFERED_MODELS) {
      expect(supportsEffort(model)).toBe(supportsAdaptiveThinking(model));
    }
  });

  test("capable models send adaptive thinking plus the chosen effort", () => {
    expect(thinkingRequestFields("claude-opus-5", "max")).toEqual({
      thinking: { type: "adaptive" },
      output_config: { effort: "max" },
    });
  });

  test("Haiku gets neither field — output_config.effort is a 400 there", () => {
    expect(thinkingRequestFields("claude-haiku-4-5-20251001", "max")).toEqual({});
  });

  test("a corrupt or absent persisted effort falls back to the default", () => {
    expect(normalizeEffort(undefined)).toBe(DEFAULT_AI_EFFORT);
    expect(normalizeEffort("enormous")).toBe(DEFAULT_AI_EFFORT);
    expect(normalizeEffort(7)).toBe(DEFAULT_AI_EFFORT);
    for (const level of AI_EFFORT_LEVELS) expect(normalizeEffort(level)).toBe(level);
  });

  test("the request never carries an invalid effort, even from a corrupt setting", () => {
    const fields = thinkingRequestFields("claude-sonnet-5", "enormous" as never);
    expect((fields.output_config as { effort: string }).effort).toBe(DEFAULT_AI_EFFORT);
  });
});

describe("per-model tables cover every offered model", () => {
  test("each has explicit pricing rather than the fallback rate", () => {
    for (const model of OFFERED_MODELS) {
      expect(MODEL_PRICING[model]).toBeDefined();
    }
  });

  test("each has an explicit output ceiling, not the conservative 8K default", () => {
    for (const model of OFFERED_MODELS) {
      expect(modelMaxOutputTokens(model)).toBeGreaterThan(8_192);
    }
  });

  test("Haiku's ceiling stays below the Sonnet/Opus one — sending 128K there is a 400", () => {
    expect(modelMaxOutputTokens("claude-haiku-4-5-20251001")).toBe(64_000);
    expect(modelMaxOutputTokens("claude-sonnet-5")).toBe(128_000);
    expect(modelMaxOutputTokens("claude-opus-5")).toBe(128_000);
  });
});
