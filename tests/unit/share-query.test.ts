import { describe, expect, test } from "bun:test";
import {
  AUTO_COMPRESS_THRESHOLD,
  buildShareQueryUrl,
  compressSql,
  decodeSqlParams,
  decompressSql,
} from "../../src/lib/share-query";

const BASE = "https://cupola.example/v1/";

/** The SQL rides in the fragment; connection context in the query string. */
const fragmentParams = (url: URL) => new URLSearchParams(url.hash.slice(1));

describe("sql_z codec", () => {
  test("round-trips SQL through deflate + base64url", async () => {
    const sql = "SELECT * FROM property.parcels WHERE owner = 'O''Brien' LIMIT 10;";
    expect(await decompressSql(await compressSql(sql))).toBe(sql);
  });

  test("round-trips unicode", async () => {
    const sql = "SELECT '☕ café — 東京' AS s";
    expect(await decompressSql(await compressSql(sql))).toBe(sql);
  });

  test("emits url-safe tokens (no +, /, or padding)", async () => {
    const token = await compressSql("SELECT ".repeat(200));
    expect(token).not.toMatch(/[+/=]/);
  });

  test("compresses long repetitive SQL well below the plain encoding", async () => {
    const sql = "SELECT a, b, c FROM t UNION ALL ".repeat(80);
    expect((await compressSql(sql)).length).toBeLessThan(encodeURIComponent(sql).length / 2);
  });
});

describe("buildShareQueryUrl", () => {
  test("puts the SQL in the fragment, never the query string", async () => {
    const url = new URL(await buildShareQueryUrl({ sql: "SELECT 1", baseUrl: BASE }));
    expect(fragmentParams(url).get("sql")).toBe("SELECT 1");
    expect(url.searchParams.has("sql")).toBe(false);
    expect(url.searchParams.has("sql_z")).toBe(false);
  });

  test("uses the plain sql param for a short query", async () => {
    const url = new URL(await buildShareQueryUrl({ sql: "SELECT 1", baseUrl: BASE }));
    expect(fragmentParams(url).has("sql_z")).toBe(false);
  });

  test("carries service and attach_options in the query string, so the recipient attaches identically", async () => {
    const url = new URL(await buildShareQueryUrl({
      sql: "SELECT 1",
      serviceUrl: "http://localhost:9003",
      attachOptions: "opt_string 'hello', data_version_spec 'v3'",
      baseUrl: BASE,
    }));
    expect(url.searchParams.get("service")).toBe("http://localhost:9003");
    expect(url.searchParams.get("attach_options")).toBe("opt_string 'hello', data_version_spec 'v3'");
  });

  test("omits absent connection params entirely, leaving no stray '?'", async () => {
    const link = await buildShareQueryUrl({ sql: "SELECT 1", baseUrl: BASE });
    expect(link.startsWith(`${BASE}#`)).toBe(true);
  });

  test("auto-compresses only past the threshold", async () => {
    const long = `SELECT ${"x".repeat(AUTO_COMPRESS_THRESHOLD + 1)}`;
    const frag = fragmentParams(new URL(await buildShareQueryUrl({ sql: long, baseUrl: BASE })));
    expect(frag.has("sql_z")).toBe(true);
    expect(frag.has("sql")).toBe(false);
    expect(await decodeSqlParams(frag)).toBe(long);
  });

  test("compress:false keeps the plain form even for long SQL", async () => {
    const long = `SELECT ${"x".repeat(AUTO_COMPRESS_THRESHOLD + 1)}`;
    const url = new URL(await buildShareQueryUrl({ sql: long, compress: false, baseUrl: BASE }));
    expect(fragmentParams(url).get("sql")).toBe(long);
  });

  test("compress:true forces sql_z for a short query", async () => {
    const frag = fragmentParams(new URL(await buildShareQueryUrl({ sql: "SELECT 1", compress: true, baseUrl: BASE })));
    expect(frag.has("sql_z")).toBe(true);
    expect(await decodeSqlParams(frag)).toBe("SELECT 1");
  });

  test("survives a URL round-trip with characters that need escaping", async () => {
    // A literal '#' in the SQL is the sharp edge of a fragment-borne payload:
    // unescaped it would truncate the link.
    const sql = "SELECT * FROM t WHERE a = 'x&y' AND b LIKE '%z#1' -- note\nORDER BY a";
    const url = new URL(await buildShareQueryUrl({ sql, baseUrl: BASE }));
    expect(await decodeSqlParams(fragmentParams(url))).toBe(sql);
  });

  test("a fragment payload coexists with query-string connection context", async () => {
    const url = new URL(await buildShareQueryUrl({
      sql: "SELECT * FROM t WHERE x = 'a#b'",
      serviceUrl: "http://localhost:9003",
      baseUrl: BASE,
    }));
    expect(url.searchParams.get("service")).toBe("http://localhost:9003");
    expect(await decodeSqlParams(fragmentParams(url))).toBe("SELECT * FROM t WHERE x = 'a#b'");
  });
});

describe("decodeSqlParams", () => {
  test("returns null when neither param is present", async () => {
    expect(await decodeSqlParams(new URLSearchParams("service=http://x"))).toBeNull();
  });

  test("prefers the plain form when both are present", async () => {
    const params = new URLSearchParams();
    params.set("sql", "SELECT 1");
    params.set("sql_z", await compressSql("SELECT 2"));
    expect(await decodeSqlParams(params)).toBe("SELECT 1");
  });

  test("returns null rather than throwing on a corrupt sql_z token", async () => {
    expect(await decodeSqlParams(new URLSearchParams("sql_z=not-a-real-token"))).toBeNull();
  });

  test("treats an empty sql param as absent", async () => {
    expect(await decodeSqlParams(new URLSearchParams("sql="))).toBeNull();
  });
});
