import { test, expect, beforeAll, afterAll } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

// happy-dom only for this file's lifetime: bun runs every test file in one global scope.
beforeAll(() => GlobalRegistrator.register());
afterAll(() => GlobalRegistrator.unregister());

const render = (html: string) => {
  const host = document.createElement("div");
  host.innerHTML = `<div data-markdoc-content><article>${html}</article></div>`;
  return host;
};
const table = (rows: string) => `<div><table><tbody>${rows}</tbody></table></div>`;

test("an unchanged report has no changes", async () => {
  const { markReportChanges } = await import("../../src/lib/evidence/report-changes");
  const html = `<h2>Sales</h2>${table("<tr><td>North</td><td>10</td></tr>")}`;
  expect(markReportChanges(render(html), render(html))).toEqual([]);
});

test("edited blocks are changed, added blocks are new, moved blocks are neither", async () => {
  const { markReportChanges, CHANGE_ATTRIBUTE } = await import("../../src/lib/evidence/report-changes");
  const before = render(`<h2>Sales</h2>${table("<tr><td>North</td><td>10</td></tr>")}<h2>Costs</h2><p>Notes about costs.</p>`);
  const next = render(`<h2>Costs</h2><p>Notes about costs.</p><h2>Sales</h2>${table("<tr><td>North</td><td>20</td></tr>")}<h2>Margin</h2>${table("<tr><td>North</td><td>5</td></tr>")}`);
  expect(markReportChanges(before, next)).toEqual([
    { label: "Table in “Sales”", kind: "changed" },
    { label: "Margin", kind: "new" },
    { label: "Table in “Margin”", kind: "new" },
  ]);
  expect([...next.querySelectorAll(`[${CHANGE_ATTRIBUTE}]`)].map(block => block.getAttribute(CHANGE_ATTRIBUTE))).toEqual(["0", "1", "2"]);
});

test("a rewrite of nearly everything is not outlined block by block", async () => {
  const { markReportChanges } = await import("../../src/lib/evidence/report-changes");
  const blocks = (word: string) => Array.from({ length: 8 }, (_, i) => `<p>${word} ${i}</p>`).join("");
  const next = render(blocks("new"));
  expect(markReportChanges(render(blocks("old")), next)).toEqual([]);
  expect(next.querySelector("[data-cupola-change]")).toBeNull();
});
