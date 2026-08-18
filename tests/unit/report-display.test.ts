import { expect, test } from "bun:test";
import { makeData, Table, TimeUnit, Timestamp, Vector, vectorFromArray } from "@query-farm/apache-arrow";
import { reportDisplayRows } from "../../src/lib/reports/display";

test("report tables use the standard Arrow timestamp formatter", () => {
  const type = new Timestamp(TimeUnit.MICROSECOND);
  const data = makeData({ type, length: 1, data: BigInt64Array.from([1609459200123456n]) });
  const table = new Table({ occurred_at: new Vector([data]) });

  expect(reportDisplayRows(table, ["occurred_at"], 10)).toEqual([
    { occurred_at: "2021-01-01 00:00:00.123456" },
  ]);
});

test("report tables preserve text cell content and nulls", () => {
  const table = new Table({
    note: vectorFromArray([
      "All three datasets have issues.",
      "Line one\nLine two",
      "<b>literal text</b>",
      null,
    ]),
  });

  expect(reportDisplayRows(table, ["note"], 10)).toEqual([
    { note: "All three datasets have issues." },
    { note: "Line one\nLine two" },
    { note: "<b>literal text</b>" },
    { note: null },
  ]);
});
