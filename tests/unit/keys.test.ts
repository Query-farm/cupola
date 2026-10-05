import { test, expect } from "bun:test";
import { keyLabel } from "../../src/lib/keys";

test("shortcuts read as the platform writes them", () => {
  expect(keyLabel("Mod-Enter", false)).toBe("Ctrl+Enter");
  expect(keyLabel("Mod-Enter", true)).toBe("⌘Enter");
  expect(keyLabel("Shift-Mod-z", false)).toBe("Shift+Ctrl+z");
  expect(keyLabel("Ctrl-Space", true)).toBe("⌃Space");
  expect(keyLabel("Escape", false)).toBe("Escape");
});
