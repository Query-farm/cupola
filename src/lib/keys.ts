/**
 * Keyboard shortcuts as the reader's own platform writes them: "Ctrl+Enter"
 * on Windows and Linux, "⌘Enter" only on a Mac. Shortcuts are named in
 * tooltips and the shortcuts list, never on buttons.
 */
export const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

const MAC: Record<string, string> = { Mod: "⌘", Ctrl: "⌃", Alt: "⌥", Shift: "⇧" };

/** `"Mod-Enter"` → `"⌘Enter"` on a Mac, `"Ctrl+Enter"` elsewhere. */
export function keyLabel(binding: string, mac = isMac): string {
  const parts = binding.split("-");
  const key = parts.pop()!;
  const mods = parts.map((m) => (mac ? MAC[m] ?? m : m === "Mod" ? "Ctrl" : m));
  return mac ? `${mods.join("")}${key}` : [...mods, key].join("+");
}

/** "Run (Ctrl+Enter)". */
export function withShortcut(label: string, binding: string): string {
  return `${label} (${keyLabel(binding)})`;
}
