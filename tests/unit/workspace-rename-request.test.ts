import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { ALIAS_RENAME_EVENT, requestAliasRename, type AliasRenameRequest } from "../../src/lib/workspace/events";

// requestAliasRename talks to the AliasRenameHost through a window event. Bun runs every unit
// file in one global scope, so the stub window is restored afterwards (see CLAUDE.md, Testing).
const hadWindow = "window" in globalThis;
const previousWindow = (globalThis as { window?: unknown }).window;
const target = new EventTarget();

beforeAll(() => {
  (globalThis as { window?: unknown }).window = target;
});
afterAll(() => {
  if (hadWindow) (globalThis as { window?: unknown }).window = previousWindow;
  else delete (globalThis as { window?: unknown }).window;
});

/** Answer the next rename request the way the host does when its dialog closes. */
function answerNext(renamedTo: (req: AliasRenameRequest) => string | null): Promise<AliasRenameRequest> {
  return new Promise((resolve) => {
    const listener = (event: Event) => {
      target.removeEventListener(ALIAS_RENAME_EVENT, listener);
      const req = (event as CustomEvent<AliasRenameRequest>).detail;
      req.settle?.(renamedTo(req));
      resolve(req);
    };
    target.addEventListener(ALIAS_RENAME_EVENT, listener);
  });
}

describe("requestAliasRename", () => {
  test("asks for a fixed, store-only rename and resolves true once renamed to the asked alias", async () => {
    const seen = answerNext((req) => req.newAlias);
    await expect(requestAliasRename("ws", "cat", "sales", "sales_eu")).resolves.toBe(true);
    const req = await seen;
    expect(req).toMatchObject({ workspaceId: "ws", catalogId: "cat", oldAlias: "sales", newAlias: "sales_eu", fixedAlias: true, storeOnly: true });
  });

  test("resolves false when the dialog closes without renaming", async () => {
    void answerNext(() => null);
    await expect(requestAliasRename("ws", "cat", "sales", "sales_eu")).resolves.toBe(false);
  });

  test("resolves false if the alias ended up different from the one asked for", async () => {
    void answerNext(() => "something_else");
    await expect(requestAliasRename("ws", "cat", "sales", "sales_eu")).resolves.toBe(false);
  });
});
