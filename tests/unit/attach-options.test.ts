import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as A from "@query-farm/apache-arrow";
import { serializeAttachOptionSpecs } from "vgi";

import {
  buildAttachSql,
  buildCliScript,
  getenvName,
  isSecretOption,
  missingRequiredOptions,
  partitionSecrets,
  redactValues,
  shareableOptionsText,
  type AttachSpec,
  type OptionSpecInfo,
} from "../../src/lib/attach/options";
import {
  checkEvaluationAst,
  evaluationSql,
  parsePlainLiteral,
  splitLegacyOptions,
} from "../../src/lib/attach/legacy-options";
import { evaluateLegacyEntries, isCastableType, validateOptionValues } from "../../src/lib/attach/prepare";
import { quoteLiteral } from "../../src/lib/duckdb-query";
import { decodeOptionSpecs } from "../../src/lib/attach/specs";
import { arrowTypeToDuckDB, arrowTypeToDuckDBCast } from "../../src/lib/arrow-to-duckdb";
import { clearRegisteredSecretValues, registerSecretValues, scrubText, scrubUrl } from "../../src/lib/sentry-scrub";
import asts from "../fixtures/attach-option-asts.json";
import type { LegacyEntry } from "../../src/lib/attach/legacy-options";

/** A fake engine: `json_serialize_sql` answers from the fixture DuckDB
 *  produced, and evaluation answers from `results`. Records what ran. */
async function evaluateLegacyExpressionsForTest(entries: LegacyEntry[], { canParse }: { canParse: boolean }) {
  const ran: string[] = [];
  const parses = new Map<string, unknown>();
  for (const [expr, json] of Object.entries(asts as Record<string, unknown>)) {
    parses.set(`SELECT json_serialize_sql(${quoteLiteral(evaluationSql(expr))})`, JSON.stringify(json));
  }
  const results: Record<string, unknown> = { [evaluationSql("[1, 2, 3]")]: "[1, 2, 3]", [evaluationSql("NULL::INTEGER")]: null };
  const out = await evaluateLegacyEntries(entries, {
    canParse,
    scalar: async (sql) => {
      ran.push(sql);
      if (parses.has(sql)) return parses.get(sql);
      if (sql in results) return results[sql];
      throw new Error(`unexpected SQL: ${sql}`);
    },
    scalarPrepared: async () => { throw new Error("unused"); },
  });
  return { ...out, ran };
}

const spec = (over: Partial<OptionSpecInfo> & { name: string }): OptionSpecInfo => ({
  description: "",
  duckdbType: "VARCHAR",
  castType: "VARCHAR",
  arrowType: "Utf8",
  required: false,
  secret: false,
  ...over,
});

const SPECS = [
  spec({ name: "api_key", required: true, secret: true }),
  spec({ name: "region" }),
  spec({ name: "max_rows", duckdbType: "INTEGER", castType: "INTEGER", arrowType: "Int32" }),
];

const base: AttachSpec = {
  kind: "vgi",
  url: "https://sales.example.com",
  catalogName: "sales",
  alias: "sales",
  options: { region: "eu-west-1", api_key: "s3cr3t-value", max_rows: "10" },
  specs: SPECS,
};

describe("buildAttachSql", () => {
  test("quotes the alias and every value; secrets inline only for execution", () => {
    expect(buildAttachSql(base)).toBe(
      `ATTACH OR REPLACE 'sales' AS "sales" (TYPE vgi, LOCATION 'https://sales.example.com', region 'eu-west-1', api_key 's3cr3t-value', max_rows '10')`,
    );
    expect(buildAttachSql(base, "redacted")).toBe(
      `ATTACH OR REPLACE 'sales' AS "sales" (TYPE vgi, LOCATION 'https://sales.example.com', region 'eu-west-1', api_key '***', max_rows '10')`,
    );
    expect(buildAttachSql(base, "cli")).toBe(
      `ATTACH 'sales' AS "sales" (TYPE vgi, LOCATION 'https://sales.example.com', region 'eu-west-1', api_key getenv('SALES_API_KEY'), max_rows '10')`,
    );
  });

  test("a value cannot break out of its literal", () => {
    const sql = buildAttachSql({ ...base, specs: [], options: { opt: "x'); DROP TABLE t; --" } });
    expect(sql).toContain(`opt 'x''); DROP TABLE t; --'`);
    expect(sql.endsWith("')")).toBe(true);
  });

  test("refuses an option name that is not an identifier", () => {
    expect(() => buildAttachSql({ ...base, options: { "a) ; DROP": "x" } })).toThrow(/Invalid ATTACH option name/);
  });

  test("an alias with a quote is an identifier, not an injection", () => {
    expect(buildAttachSql({ ...base, alias: 'we"ird', options: {} })).toContain(`AS "we""ird" (TYPE vgi`);
  });

  test("sign-in credentials: refresh wins over bearer, both redacted, CLI omits them", () => {
    const spec = { ...base, options: {}, auth: { bearerToken: "bearer-abc", refreshToken: "refresh-xyz" } };
    expect(buildAttachSql(spec)).toContain(`oauth_refresh_token 'refresh-xyz')`);
    expect(buildAttachSql(spec)).not.toContain("bearer_token");
    expect(buildAttachSql(spec, "redacted")).toContain(`oauth_refresh_token '***'`);
    expect(buildAttachSql(spec, "cli")).not.toContain("refresh");
    expect(buildAttachSql({ ...spec, auth: { bearerToken: "b" } })).toContain(`bearer_token 'b'`);
  });

  test("grainlift quotes the target like any other option", () => {
    const sql = buildAttachSql({
      kind: "grainlift", url: "grainlift+https://gw", catalogName: "sqlite", alias: "sqlite",
      options: { target: "it's" }, auth: { bearerToken: "tok" },
    });
    expect(sql).toBe(`ATTACH OR REPLACE 'grainlift+https://gw' AS "sqlite" (TYPE grainlift, bearer_token 'tok', target 'it''s')`);
  });

  test("no options, no trailing comma", () => {
    expect(buildAttachSql({ ...base, options: {} })).toBe(`ATTACH OR REPLACE 'sales' AS "sales" (TYPE vgi, LOCATION 'https://sales.example.com')`);
  });
});

describe("secrets", () => {
  test("spec flag decides; the name heuristic covers undeclared options", () => {
    expect(isSecretOption("api_key", SPECS)).toBe(true);
    expect(isSecretOption("region", SPECS)).toBe(false);
    expect(isSecretOption("my_password")).toBe(true);
    expect(isSecretOption("AUTH_header")).toBe(true);
    expect(isSecretOption("pool")).toBe(false);
    expect(isSecretOption("opaque", [spec({ name: "opaque", secret: true })])).toBe(true);
  });

  test("partition and share text keep secrets out", () => {
    expect(partitionSecrets(base.options, SPECS)).toEqual({
      plain: { region: "eu-west-1", max_rows: "10" },
      secret: { api_key: "s3cr3t-value" },
    });
    expect(shareableOptionsText(base.options, SPECS)).toBe(`region 'eu-west-1', max_rows '10'`);
  });

  test("getenv names", () => {
    expect(getenvName("sales", "api_key")).toBe("SALES_API_KEY");
    expect(getenvName("my-db", "Key")).toBe("MY_DB_KEY");
  });

  test("CLI script lists the variables to export", () => {
    const script = buildCliScript(base, "INSTALL vgi FROM community");
    expect(script).toContain("INSTALL vgi FROM community;\nLOAD vgi;");
    expect(script).toContain("--   export SALES_API_KEY=...");
    expect(script).not.toContain("s3cr3t-value");
  });

  test("redactValues", () => {
    expect(redactValues("Could not convert string 's3cr3t-value' to INT32", ["s3cr3t-value"])).toBe(
      "Could not convert string '***' to INT32",
    );
  });

  test("missing required options", () => {
    expect(missingRequiredOptions({ region: "x" }, SPECS).map((s) => s.name)).toEqual(["api_key"]);
    expect(missingRequiredOptions({ API_KEY: "x" }, SPECS)).toEqual([]);
  });
});

describe("splitLegacyOptions", () => {
  test("splits at top-level commas only", () => {
    const { entries, problems } = splitLegacyOptions(
      `opt_string 'a, b', opt_list [1, 2], opt_struct {'a': 1, 'b': 'x'}, flag, "quoted_name" 5,  opt_int64 -42`,
    );
    expect(problems).toEqual([]);
    expect(entries).toEqual([
      { name: "opt_string", expr: "'a, b'" },
      { name: "opt_list", expr: "[1, 2]" },
      { name: "opt_struct", expr: "{'a': 1, 'b': 'x'}" },
      { name: "flag", expr: "true" },
      { name: "quoted_name", expr: "5" },
      { name: "opt_int64", expr: "-42" },
    ]);
  });

  test("doubled quotes do not end a string", () => {
    expect(splitLegacyOptions(`a 'it''s, fine', b 2`).entries).toEqual([
      { name: "a", expr: "'it''s, fine'" },
      { name: "b", expr: "2" },
    ]);
  });

  test("an injection attempt is refused, not split into something runnable", () => {
    const { entries, problems } = splitLegacyOptions(`opt 1); DROP TABLE x; --`);
    expect(entries).toEqual([]);
    expect(problems[0].reason).toMatch(/unbalanced/);
  });

  test("bad names and unterminated quotes are problems", () => {
    const { entries, problems } = splitLegacyOptions(`1bad 'x', ok 'y', "has space" 1, open 'unterminated`);
    expect(entries).toEqual([{ name: "ok", expr: "'y'" }]);
    expect(problems.map((p) => p.name ?? p.text)).toEqual(["1bad", "has space", "open 'unterminated"]);
  });

  test("leading comma and blank input", () => {
    expect(splitLegacyOptions(", a 1").entries).toEqual([{ name: "a", expr: "1" }]);
    expect(splitLegacyOptions("   ")).toEqual({ entries: [], problems: [] });
  });
});

describe("parsePlainLiteral", () => {
  test("strings, numbers, booleans", () => {
    expect(parsePlainLiteral("'it''s'")).toBe("it's");
    expect(parsePlainLiteral("42")).toBe("42");
    expect(parsePlainLiteral("-1.5")).toBe("-1.5");
    expect(parsePlainLiteral("+7")).toBe("7");
    expect(parsePlainLiteral("TRUE")).toBe("true");
  });
  test("everything else is an expression", () => {
    for (const e of ["NULL", "[1]", "'a' || 'b'", "getenv('X')", "1e3", "'a'::DATE", "x"]) {
      expect(parsePlainLiteral(e)).toBeNull();
    }
  });
});

describe("checkEvaluationAst (DuckDB's own parse, tests/fixtures/attach-option-asts.json)", () => {
  const ast = (expr: string) => {
    const v = (asts as Record<string, unknown>)[expr];
    if (!v) throw new Error(`no fixture for ${expr}; run bun scripts/attach-option-asts.ts`);
    return v as Record<string, any>;
  };
  const accepted = [
    "42", "-5", "1.5e3", "'hello'", "'it''s'", "true", "[1, 2, 3]", "{'a': 1, 'b': 'x'}", "MAP {'k': 1}",
    "'2024-01-01'::DATE", "CAST(1 AS INTEGER)", "DATE '2024-01-01'", "-(1)", "row(1, 'a')", "struct_pack(a := 1)",
    "list_value(1, 2)", "map(['a'], [1])", "[[1], [2, 3]]", "{'a': [1, 2], 'b': {'c': 'd'}}",
  ];
  const refused = [
    "NULL", "getenv('HOME')", "1 + 2", "(SELECT 1)", "x", "read_text('/etc/passwd')", "current_date",
    "1; SELECT 2", "1) AS VARCHAR), (SELECT 1", "[1, getenv('X')]", "CAST(getenv('X') AS VARCHAR)",
    "upper('a')", "'a' || 'b'", "now()", "nextval('s')", "list_value(1, (SELECT 2))", "INTERVAL 3 DAY",
  ];
  for (const expr of accepted) test(`accepts ${expr}`, () => expect(checkEvaluationAst(ast(expr))).toBeNull());
  for (const expr of refused) test(`refuses ${expr}`, () => expect(checkEvaluationAst(ast(expr))).toBeString());

  test("NULL::INTEGER parses but evaluation reports NULL", () => {
    // A cast of NULL is an allowed constant; prepare.ts refuses the NULL result.
    expect(checkEvaluationAst(ast("NULL::INTEGER"))).toBeNull();
  });

  test("fixtures were generated from the current evaluation SQL", () => {
    expect(evaluationSql("42")).toBe("SELECT CAST((42) AS VARCHAR)");
  });
});

describe("evaluateLegacyEntries", () => {
  test("plain literals need no engine; expressions are parsed, checked, then run", async () => {
    const { values, problems, ran } = await evaluateLegacyExpressionsForTest(
      [
        { name: "s", expr: "'x'" },
        { name: "l", expr: "[1, 2, 3]" },
        { name: "bad", expr: "getenv('HOME')" },
        { name: "n", expr: "NULL::INTEGER" },
      ],
      { canParse: true },
    );
    expect(values).toEqual({ s: "x", l: "[1, 2, 3]" });
    expect(problems.map((p) => p.name)).toEqual(["bad", "n"]);
    // getenv is refused by the allowlist before anything runs.
    expect(ran.some((sql) => sql.includes("getenv") && !sql.startsWith("SELECT json_serialize_sql"))).toBe(false);
  });

  test("without the parser only plain literals pass", async () => {
    const { values, problems } = await evaluateLegacyExpressionsForTest(
      [{ name: "s", expr: "'x'" }, { name: "l", expr: "[1, 2]" }],
      { canParse: false },
    );
    expect(values).toEqual({ s: "x" });
    expect(problems[0].reason).toMatch(/parser is unavailable/);
  });
});

describe("validateOptionValues", () => {
  test("reports missing required options and failed casts", async () => {
    const calls: string[] = [];
    const problems = await validateOptionValues({ region: "x", max_rows: "abc" }, SPECS, {
      scalarPrepared: async (sql, params) => {
        calls.push(sql);
        return !(sql.includes("INTEGER") && params[0] === "abc");
      },
    });
    expect(problems.map((p) => [p.name, p.reason])).toEqual([
      ["api_key", "Required, but no value was given."],
      ["max_rows", "Not a valid INTEGER."],
    ]);
    expect(calls).toEqual(["SELECT TRY_CAST(? AS VARCHAR) IS NOT NULL", "SELECT TRY_CAST(? AS INTEGER) IS NOT NULL"]);
  });

  test("a type the engine refuses is skipped, not blamed on the value", async () => {
    const problems = await validateOptionValues({ api_key: "k", max_rows: "5" }, SPECS, {
      scalarPrepared: async () => { throw new Error("Catalog Error: Type with name X does not exist"); },
    });
    expect(problems).toEqual([]);
  });

  test("isCastableType refuses anything that could continue the statement", () => {
    expect(isCastableType("INTEGER")).toBe(true);
    expect(isCastableType("DECIMAL(18, 4)")).toBe(true);
    expect(isCastableType("BIGINT[]")).toBe(true);
    expect(isCastableType("STRUCT(a BIGINT, b VARCHAR[])")).toBe(true);
    expect(isCastableType("MAP(VARCHAR, STRUCT(x INTEGER))")).toBe(true);
    expect(isCastableType("STRUCT(a INTEGER)) IS NOT NULL OR (1")).toBe(false);
    expect(isCastableType("INTEGER) IS NULL; DROP TABLE t; --")).toBe(false);
    expect(isCastableType("STRUCT(a 'x')")).toBe(false);
  });
});

describe("spec decoding", () => {
  test("decodes specs into plain records with DuckDB cast types", () => {
    const bytes = serializeAttachOptionSpecs([
      { name: "api_key", description: "API key", type: new A.Utf8(), required: true, secret: true },
      { name: "max_rows", description: "Row cap", type: new A.Int32(), default: 100 },
      { name: "s", description: "", type: new A.Struct([new A.Field("a", new A.Int64()), new A.Field("b", new A.Utf8())]) },
      { name: "ts", description: "", type: new A.Timestamp(A.TimeUnit.MICROSECOND), default: null },
    ]);
    const specs = decodeOptionSpecs(bytes);
    expect(specs.map((s) => [s.name, s.castType, s.required, s.secret, s.defaultText])).toEqual([
      ["api_key", "VARCHAR", true, true, null],
      ["max_rows", "INTEGER", false, false, "100"],
      ["s", "STRUCT(a BIGINT, b VARCHAR)", false, false, null],
      ["ts", "TIMESTAMP", false, false, null],
    ]);
  });

  test("microsecond timestamps are TIMESTAMP, not TIMESTAMP_S", () => {
    expect(arrowTypeToDuckDB(new A.Timestamp(A.TimeUnit.MICROSECOND))).toBe("TIMESTAMP");
    expect(arrowTypeToDuckDB(new A.Timestamp(A.TimeUnit.SECOND))).toBe("TIMESTAMP_S");
    expect(arrowTypeToDuckDB(new A.Timestamp(A.TimeUnit.MILLISECOND))).toBe("TIMESTAMP_MS");
    expect(arrowTypeToDuckDB(new A.Timestamp(A.TimeUnit.NANOSECOND))).toBe("TIMESTAMP_NS");
    expect(arrowTypeToDuckDB(new A.Timestamp(A.TimeUnit.NANOSECOND, "UTC"))).toBe("TIMESTAMPTZ");
  });

  test("cast syntax for nested and unmappable types", () => {
    expect(arrowTypeToDuckDBCast(new A.List(new A.Field("item", new A.Int64())))).toBe("BIGINT[]");
    expect(arrowTypeToDuckDBCast(new A.Interval(A.IntervalUnit.MONTH_DAY_NANO))).toBe("INTERVAL");
    expect(arrowTypeToDuckDBCast(new A.Struct([new A.Field("has space", new A.Int64())]))).toBeNull();
  });
});

describe("sentry scrubbing of secret options", () => {
  afterEach(() => clearRegisteredSecretValues());

  test("attach_options is filtered from URLs", () => {
    expect(scrubUrl("https://app/?service=http://s&attach_options=api_key%20'x'")).toBe(
      "https://app/?service=http://s&attach_options=[Filtered]",
    );
  });

  test("credential-named literals and registered values are filtered from text", () => {
    registerSecretValues(["hunter2-long"]);
    expect(scrubText("ATTACH 'c' AS \"c\" (TYPE vgi, api_key 'abc''d', region 'eu')")).toBe(
      "ATTACH 'c' AS \"c\" (TYPE vgi, api_key '[Filtered]', region 'eu')",
    );
    expect(scrubText("Could not convert string 'hunter2-long' to INT32")).toBe(
      "Could not convert string '[Filtered]' to INT32",
    );
  });
});

describe("secret store", () => {
  const stash = new Map<string, string>();
  const g = globalThis as Record<string, unknown>;
  const hadLocalStorage = "localStorage" in g;
  const previous = g.localStorage;
  beforeEach(() => {
    stash.clear();
    g.localStorage = {
      getItem: (k: string) => stash.get(k) ?? null,
      setItem: (k: string, v: string) => void stash.set(k, v),
      removeItem: (k: string) => void stash.delete(k),
    };
  });
  afterAll(() => {
    if (hadLocalStorage) g.localStorage = previous;
    else delete g.localStorage;
    clearRegisteredSecretValues();
  });

  test("keyed by service, catalog and option; nameless values move under the catalog", async () => {
    const { saveSecrets, secretsFor, clearSecretsForService, SECRET_STORE_KEY } = await import("../../src/lib/attach/secret-store");
    saveSecrets("http://a", "", { api_key: "early-value" });
    expect(secretsFor("http://a", "cat")).toEqual({ api_key: "early-value" });
    saveSecrets("http://a", "cat", { token: "tok-value" });
    expect(secretsFor("http://a", "cat")).toEqual({ api_key: "early-value", token: "tok-value" });
    expect(JSON.parse(stash.get(SECRET_STORE_KEY)!)).toEqual({
      [JSON.stringify(["http://a", "cat", "api_key"])]: "early-value",
      [JSON.stringify(["http://a", "cat", "token"])]: "tok-value",
    });
    saveSecrets("http://a", "cat", { token: "new" }, { replace: true });
    expect(secretsFor("http://a", "cat")).toEqual({ token: "new" });
    expect(secretsFor("http://b", "cat")).toEqual({});
    clearSecretsForService("http://a");
    expect(stash.has(SECRET_STORE_KEY)).toBe(false);
  });
});

describe("options form", () => {
  test("typed fields, raw fallback, and refusals", async () => {
    const { collectFormOptions } = await import("../../src/lib/attach/form");
    const ok = collectFormOptions({ api_key: "k-1", region: "", max_rows: "5" }, "pool 'p', list_opt [1, 2]", SPECS);
    expect(ok).toEqual({ options: { api_key: "k-1", max_rows: "5", pool: "p" }, rawOptions: "list_opt [1, 2]", errors: [] });

    const bad = collectFormOptions({ region: "x" }, "max_rows 1, max_rows 2, token CAST('x' AS VARCHAR), 9bad 1", SPECS);
    expect(bad.errors).toEqual([
      "9bad: Option names must be letters, digits and underscores, not starting with a digit.",
      "max_rows is set twice.",
      "token is secret: give it a plain 'string' value.",
      "api_key is required.",
    ]);
  });

  test("field kinds", async () => {
    const { fieldKind } = await import("../../src/lib/attach/form");
    expect(fieldKind(SPECS[0])).toBe("secret");
    expect(fieldKind(SPECS[2])).toBe("integer");
    expect(fieldKind(spec({ name: "b", duckdbType: "BOOLEAN" }))).toBe("boolean");
    expect(fieldKind(spec({ name: "d", duckdbType: "DECIMAL(18,4)" }))).toBe("number");
    expect(fieldKind(spec({ name: "u", duckdbType: "UBIGINT" }))).toBe("integer");
  });
});
