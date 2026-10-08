/**
 * One system prompt per conversation, shared by every AI surface (the chat
 * panel, the editor's AI panel and the shell's `.ai` mode).
 *
 * `system` renders ahead of every message, so a changed byte there re-bills the
 * whole conversation. The prompt lists the catalogs, and the agent changes the
 * memory catalog by doing what the prompt tells it to (`CREATE TABLE
 * memory.main.…`), so rebuilding it each turn cost a full-price request on
 * exactly the turns the agent had just succeeded. The prompt is therefore
 * built once and reused byte for byte; memory changes travel in the user turn
 * as a note (see ./memory-context). It is rebuilt only when something it
 * describes besides memory changes: another catalog's metadata, or the query
 * mode (which also swaps the tool set).
 *
 * Pure apart from the types, so it unit-tests without the RPC graph.
 */

import type { CatalogData } from "../service";
import { memoryContextNote, memoryObjectNames } from "./memory-context";

export interface FrozenPrompt {
  system: string;
  /** Everything the prompt depends on except the memory catalog. */
  key: string;
  /** Memory objects the prompt (or the last note) told the agent about. */
  memory: string[];
}

export function promptKey(catalogs: readonly CatalogData[], ...extra: string[]): string {
  const described = catalogs.filter(c => c.catalogName !== "memory");
  return [...extra, JSON.stringify(described, (_k, v) => typeof v === "bigint" ? `${v}n` : v)].join("\u0000");
}

/**
 * The prompt to send this turn, and a note for the user turn when the memory
 * catalog changed since the agent was last told. `build` runs only when the
 * prompt has to be (re)built.
 */
export function promptForTurn(
  previous: FrozenPrompt | null,
  catalogs: readonly CatalogData[],
  key: string,
  build: () => string,
): { prompt: FrozenPrompt; memoryNote: string | null } {
  const memory = memoryObjectNames(catalogs.find(c => c.catalogName === "memory"));
  if (!previous || previous.key !== key) return { prompt: { system: build(), key, memory }, memoryNote: null };
  const memoryNote = memoryContextNote(previous.memory, memory);
  return { prompt: memoryNote ? { ...previous, memory } : previous, memoryNote };
}

/** Put a note ahead of a user message's content, after the cached prefix. */
export function withNote<C extends string | readonly { type: string }[]>(content: C, note: string | null): C | { type: "text"; text: string }[] {
  if (!note) return content;
  const rest = typeof content === "string" ? [{ type: "text" as const, text: content }] : content;
  return [{ type: "text", text: note }, ...(rest as any[])];
}
