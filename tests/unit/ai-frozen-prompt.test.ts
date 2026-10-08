import { expect, test } from "bun:test";
import { promptForTurn, promptKey, withNote } from "../../src/lib/ai/frozen-prompt";
import type { CatalogData } from "../../src/lib/service";

const cat = (name: string, tables: string[] = []): CatalogData => ({
  catalogName: name, catalogComment: null, catalogTags: {}, defaultSchema: "main",
  schemas: [{ info: { name: "main" }, tables: tables.map(t => ({ name: t })), views: [], functions: [] } as any],
});

test("the prompt survives the agent creating memory tables; the change rides in a note", () => {
  let builds = 0;
  const build = () => `prompt ${++builds}`;
  const before = [cat("sales", ["orders"]), cat("memory")];
  const first = promptForTurn(null, before, promptKey(before, "sql"), build);
  expect(first.memoryNote).toBeNull();

  const after = [cat("sales", ["orders"]), cat("memory", ["summary"])];
  const second = promptForTurn(first.prompt, after, promptKey(after, "sql"), build);
  expect(second.prompt.system).toBe(first.prompt.system);
  expect(builds).toBe(1);
  expect(second.memoryNote).toContain("memory.main.summary");

  // Told once: the next turn has nothing new to say.
  const third = promptForTurn(second.prompt, after, promptKey(after, "sql"), build);
  expect(third.memoryNote).toBeNull();
  expect(third.prompt).toBe(second.prompt);
});

test("another catalog's metadata or the query mode rebuilds it", () => {
  let builds = 0;
  const build = () => `prompt ${++builds}`;
  const a = [cat("sales", ["orders"])];
  const first = promptForTurn(null, a, promptKey(a, "sql"), build);
  const b = [cat("sales", ["orders", "returns"])];
  expect(promptForTurn(first.prompt, b, promptKey(b, "sql"), build).prompt.system).toBe("prompt 2");
  expect(promptForTurn(first.prompt, a, promptKey(a, "semantic-only"), build).prompt.system).toBe("prompt 3");
});

test("withNote prepends to string and block content", () => {
  expect(withNote("hi", null)).toBe("hi");
  expect(withNote("hi", "n")).toEqual([{ type: "text", text: "n" }, { type: "text", text: "hi" }]);
  expect(withNote([{ type: "text", text: "hi" }], "n")).toEqual([{ type: "text", text: "n" }, { type: "text", text: "hi" }]);
});
