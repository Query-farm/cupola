import { test, expect, describe, afterEach, beforeAll, afterAll } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { render, fireEvent, cleanup } from "@testing-library/react";
import { TreeView } from "../../src/components/tree-view";
import type { TreeDataItem } from "../../src/lib/tree";

// Register a happy-dom global environment only for this file's lifetime. A
// global `[test] preload` would make `window`/`history` read-only for every
// test file, breaking the ones that install their own fakes (auth, url-params).
// We avoid `screen` (it binds to document.body at import time, before this hook
// runs) and instead use the queries returned by render(), which bind lazily.
beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(() => GlobalRegistrator.unregister());

const data: TreeDataItem[] = [
  {
    id: "schemaA",
    name: "Schema A",
    children: [{ id: "tableA1", name: "Table A1" }],
  },
  {
    id: "schemaB",
    name: "Schema B",
    children: [{ id: "tableB1", name: "Table B1" }],
  },
];

/**
 * Resolve a node row's Radix accordion trigger (the `<button>`). We assert on
 * its `aria-expanded`, which Radix updates synchronously — unlike child-node
 * DOM presence, which depends on an exit animation that never fires headless.
 */
function trigger(getByText: (t: string) => HTMLElement, label: string): HTMLElement {
  const btn = getByText(label).closest("button");
  if (!btn) throw new Error(`no accordion trigger for "${label}"`);
  return btn;
}

function isExpanded(getByText: (t: string) => HTMLElement, label: string): boolean {
  return trigger(getByText, label).getAttribute("aria-expanded") === "true";
}

describe("TreeView expand/collapse", () => {
  test("clicking a collapsed node's chevron expands it and reveals its children", () => {
    const { queryByText, getByText } = render(<TreeView data={data} />);
    expect(isExpanded(getByText, "Schema A")).toBe(false);
    expect(queryByText("Table A1")).toBeNull();

    fireEvent.click(getByText("Schema A"));

    expect(isExpanded(getByText, "Schema A")).toBe(true);
    expect(queryByText("Table A1")).not.toBeNull();
  });

  test("clicking an expanded node's chevron collapses it", () => {
    // initialSelectedItemId reveals the selected node's ancestors, so schemaA
    // starts expanded.
    const { getByText } = render(
      <TreeView data={data} initialSelectedItemId="tableA1" />
    );
    expect(isExpanded(getByText, "Schema A")).toBe(true);

    fireEvent.click(getByText("Schema A"));

    expect(isExpanded(getByText, "Schema A")).toBe(false);
  });

  test("regression: collapse sticks after the selection moved away and back", () => {
    // The exact sequence the user reported failing:
    //   1. expand & select node A
    //   2. navigate to a sibling (selection leaves A)
    //   3. click A's chevron to collapse it
    // Previously step 3 re-expanded A in the same tick. It must now collapse.
    const { getByText, rerender } = render(<TreeView data={data} />);

    // 1. expand & select Schema A
    fireEvent.click(getByText("Schema A"));
    expect(isExpanded(getByText, "Schema A")).toBe(true);

    // 2. navigate away — selection moves to Schema B (e.g. content-panel nav)
    rerender(<TreeView data={data} initialSelectedItemId="schemaB" />);
    // Schema A stays open (reveal is additive and never auto-collapses)
    expect(isExpanded(getByText, "Schema A")).toBe(true);

    // 3. click Schema A's chevron to collapse it — must actually collapse
    fireEvent.click(getByText("Schema A"));
    expect(isExpanded(getByText, "Schema A")).toBe(false);
  });

  test("an externally-selected deep node is revealed (ancestors expanded)", () => {
    const { queryByText, getByText } = render(
      <TreeView data={data} initialSelectedItemId="tableA1" />
    );
    expect(isExpanded(getByText, "Schema A")).toBe(true);
    expect(queryByText("Table A1")).not.toBeNull();
    // Unrelated sibling stays collapsed
    expect(isExpanded(getByText, "Schema B")).toBe(false);
  });

  test("collapsing one node leaves a sibling's expansion untouched", () => {
    const { getByText } = render(<TreeView data={data} />);
    fireEvent.click(getByText("Schema A"));
    fireEvent.click(getByText("Schema B"));
    expect(isExpanded(getByText, "Schema A")).toBe(true);
    expect(isExpanded(getByText, "Schema B")).toBe(true);

    fireEvent.click(getByText("Schema A"));

    expect(isExpanded(getByText, "Schema A")).toBe(false);
    expect(isExpanded(getByText, "Schema B")).toBe(true);
  });

  test("selecting a node fires onSelectChange with that item", () => {
    const seen: (string | undefined)[] = [];
    const { getByText } = render(
      <TreeView data={data} onSelectChange={(item) => seen.push(item?.id)} />
    );
    fireEvent.click(getByText("Schema A"));
    expect(seen).toContain("schemaA");
  });
});
