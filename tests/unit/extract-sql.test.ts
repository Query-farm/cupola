/**
 * Tests for the editor AI panel's fenced-SQL extractor.
 */
import { test, expect, describe } from "bun:test";
import { extractSql } from "../../src/lib/ai/extract-sql";

describe("extractSql", () => {
  test("extracts a ```sql fenced block", () => {
    expect(extractSql("Here you go:\n```sql\nSELECT 1\n```")).toBe("SELECT 1");
  });

  test("extracts a bare fenced block", () => {
    expect(extractSql("```\nSELECT 2\n```")).toBe("SELECT 2");
  });

  test("returns the LAST block when several are present", () => {
    const md = "first:\n```sql\nSELECT 1\n```\nrevised:\n```sql\nSELECT 2 WHERE x\n```";
    expect(extractSql(md)).toBe("SELECT 2 WHERE x");
  });

  test("trims surrounding whitespace", () => {
    expect(extractSql("```sql\n  SELECT 3  \n```")).toBe("SELECT 3");
  });

  test("returns null when there is no fence", () => {
    expect(extractSql("just prose, no code")).toBeNull();
  });
});
