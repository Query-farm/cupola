/**
 * Unit tests for parseStreamedToolInput.
 *
 * Regression guard for the "Looking up tables" loop: a no-argument tool call
 * (list_tables) streams an empty input string, and JSON.parse("") throwing used
 * to poison the call with a __parseError sentinel that looped the agent.
 */
import { test, expect, describe } from "bun:test";
import { parseStreamedToolInput } from "../../src/lib/tool-input";

describe("parseStreamedToolInput", () => {
  test("empty string (no-arg tool like list_tables) → {} with no error", () => {
    const r = parseStreamedToolInput("");
    expect(r.input).toEqual({});
    expect(r.parseError).toBe(false);
  });

  test("whitespace-only input → {} with no error", () => {
    expect(parseStreamedToolInput("  \n ").input).toEqual({});
    expect(parseStreamedToolInput("  \n ").parseError).toBe(false);
  });

  test("explicit empty object {} parses normally", () => {
    expect(parseStreamedToolInput("{}").input).toEqual({});
    expect(parseStreamedToolInput("{}").parseError).toBe(false);
  });

  test("valid arguments parse to the object", () => {
    const r = parseStreamedToolInput('{"schema":"public","table":"t"}');
    expect(r.input).toEqual({ schema: "public", table: "t" });
    expect(r.parseError).toBe(false);
  });

  test("genuinely malformed JSON yields the __parseError sentinel", () => {
    const r = parseStreamedToolInput('{"sql": "SELECT');
    expect(r.parseError).toBe(true);
    expect(r.input.__parseError).toBe('{"sql": "SELECT');
  });
});
