import { test, expect } from "bun:test";
import { stripLeadingNameHeading } from "../../src/lib/doc-markdown";

test("a heading that only names the object is dropped", () => {
  expect(stripLeadingNameHeading("# slow_rows\n\nSleeps.", "slow_rows")).toBe("Sleeps.");
  expect(stripLeadingNameHeading("## `cupola_test.edge.slow_rows(rows, delay_ms)`\nSleeps.", "slow_rows")).toBe("Sleeps.");
  expect(stripLeadingNameHeading("  # **Slow_Rows** ##\n\nSleeps.", "slow_rows")).toBe("Sleeps.");
});

test("anything else stays", () => {
  expect(stripLeadingNameHeading("# Slow row generator\n\nSleeps.", "slow_rows")).toBe("# Slow row generator\n\nSleeps.");
  expect(stripLeadingNameHeading("Sleeps.\n\n# slow_rows", "slow_rows")).toBe("Sleeps.\n\n# slow_rows");
  expect(stripLeadingNameHeading("#slow_rows is a hashtag", "slow_rows")).toBe("#slow_rows is a hashtag");
});
