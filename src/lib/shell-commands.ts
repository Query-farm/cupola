/**
 * Dot-command dispatch for the DuckDB WASM shell.
 * Each command is a pure function of its input + a context interface.
 */
import { formatCellValue, safeGetArrowValue } from "@/lib/format";
import { bridge } from "@/lib/shell-bridge";

/** Mutable shell state exposed to commands via getters/setters. */
export interface ShellState {
  maxDisplayRows: number;
  outputMode: "box" | "line";
  lastTable: any;
  lastArrowBuffer: Uint8Array | null;
  currentWasmVersion: string;
}

/** I/O and async operations commands can perform. */
export interface ShellIO {
  writeln: (msg: string, color?: string) => void;
  serviceUrl: string;
  runQueryAsync: (sql: string) => Promise<any>;
  tableFromIPC: (buf: any) => any;
  downloadFile: (table: any, format: "csv" | "excel") => Promise<void>;
}

/**
 * Try to handle a dot-command. Returns true if the input was a recognized
 * dot-command (and has been fully handled), false if it should be treated as SQL.
 */
export async function handleDotCommand(trimmed: string, state: ShellState, io: ShellIO): Promise<boolean> {
  const { writeln } = io;

  // .exit / \q
  if (trimmed === ".exit" || trimmed === "\\q") {
    writeln("Use the X button to close the shell.", "33");
    return true;
  }

  // .help / \?
  if (trimmed === ".help" || trimmed === "\\?") {
    writeln(".help              Show this help");
    writeln(".ai                Enter AI mode (resumes last conversation)");
    writeln(".ai new            Start a new AI conversation");
    writeln(".ai name <text>    Name the AI conversation");
    writeln(".mode box          Table output with box drawing (default)");
    writeln(".mode line         One field per line, vertical display");
    writeln(`.maxrows [n]       Set max display rows (current: ${state.maxDisplayRows})`);
    writeln(".download csv      Download last result as CSV");
    writeln(".download excel    Download last result as Excel (.xlsx)");
    writeln(".reset             Reload with a fresh database");
    writeln(".perspective       Open last result in Perspective viewer");
    return true;
  }

  // .maxrows [n]
  if (trimmed.startsWith(".maxrows")) {
    const arg = trimmed.split(/\s+/)[1];
    if (arg) {
      const n = parseInt(arg, 10);
      if (n >= 2 && Number.isFinite(n)) {
        state.maxDisplayRows = n % 2 === 0 ? n : n + 1;
        writeln(`Max display rows: ${state.maxDisplayRows}`, "33");
      } else {
        writeln("Usage: .maxrows <number> (minimum 2)", "33");
      }
    } else {
      writeln(`Max display rows: ${state.maxDisplayRows}`, "33");
    }
    return true;
  }

  // .mode [box|line]
  if (trimmed.startsWith(".mode")) {
    const arg = trimmed.split(/\s+/)[1]?.toLowerCase();
    if (arg === "box" || arg === "line") {
      state.outputMode = arg;
      writeln(`Output mode: ${arg}`, "33");
    } else {
      writeln("Usage: .mode [box|line]", "33");
    }
    return true;
  }

  // .reset
  if (trimmed === ".reset") {
    writeln("Reloading with a fresh database.", "33");
    window.location.reload();
    return true;
  }

  // .download [csv|excel]
  if (trimmed.startsWith(".download")) {
    const fmt = trimmed.split(/\s+/)[1]?.toLowerCase();
    if (!state.lastTable) {
      writeln("No result to download. Run a query first.", "31");
    } else if (fmt === "csv") {
      await io.downloadFile(state.lastTable, "csv");
    } else if (fmt === "excel" || fmt === "xlsx") {
      await io.downloadFile(state.lastTable, "excel");
    } else {
      writeln("Usage: .download [csv|excel]", "33");
    }
    return true;
  }

  // .perspective
  if (trimmed === ".perspective") {
    if (!state.lastArrowBuffer) {
      writeln("No result to view. Run a query first.", "31");
    } else {
      bridge.showPerspective?.(state.lastArrowBuffer);
      writeln("Switched to Perspective viewer", "32");
    }
    return true;
  }


  // .test_formats
  if (trimmed === ".test_formats") {
    await runFormatTests(io);
    return true;
  }

  return false;
}

// ---------------------------------------------------------------------------
// .test_formats — compare formatted output against DuckDB CLI reference
// ---------------------------------------------------------------------------

/** Expected values from DuckDB CLI (line mode) — row 0 = min, row 1 = max. */
const FORMAT_TEST_EXPECTED: Record<string, [string, string]> = {
  "bool": ["false", "true"],
  "tinyint": ["-128", "127"],
  "smallint": ["-32768", "32767"],
  "int": ["-2147483648", "2147483647"],
  "bigint": ["-9223372036854775808", "9223372036854775807"],
  "hugeint": ["-170141183460469231731687303715884105728", "170141183460469231731687303715884105727"],
  "uhugeint": ["0", "340282366920938463463374607431768211455"],
  "utinyint": ["0", "255"],
  "usmallint": ["0", "65535"],
  "uint": ["0", "4294967295"],
  "ubigint": ["0", "18446744073709551615"],
  "bignum": ["-179769313486231570814527423731704356798070567525844996598917476803157260780028538760589558632766878171540458953514382464234321326889464182768467546703537516986049910576551282076245490090389328944075868508455133942304583236903222948165808559332123348274797826204144723168738177180919299881250404026184124858368", "179769313486231570814527423731704356798070567525844996598917476803157260780028538760589558632766878171540458953514382464234321326889464182768467546703537516986049910576551282076245490090389328944075868508455133942304583236903222948165808559332123348274797826204144723168738177180919299881250404026184124858368"],
  "date": ["5877642-06-25 (BC)", "5881580-07-10"],
  "time": ["00:00:00", "24:00:00"],
  "timestamp": ["290309-12-22 (BC) 00:00:00", "294247-01-10 04:00:54.775806"],
  "timestamp_s": ["290309-12-22 (BC) 00:00:00", "294247-01-10 04:00:54"],
  "timestamp_ms": ["290309-12-22 (BC) 00:00:00", "294247-01-10 04:00:54.775"],
  "timestamp_ns": ["1677-09-22 00:00:00", "2262-04-11 23:47:16.854775806"],
  "time_tz": ["00:00:00+15:59:59", "24:00:00-15:59:59"],
  "timestamp_tz": ["290309-12-21 (BC) 19:03:58-04:56", "294247-01-09 23:00:54.776806-05"],
  "float": ["-3.4028235e+38", "3.4028235e+38"],
  "double": ["-1.7976931348623157e+308", "1.7976931348623157e+308"],
  "dec_4_1": ["-999.9", "999.9"],
  "dec_9_4": ["-99999.9999", "99999.9999"],
  "dec_18_6": ["-999999999999.999999", "999999999999.999999"],
  "dec38_10": ["-9999999999999999999999999999.9999999999", "9999999999999999999999999999.9999999999"],
  "uuid": ["00000000-0000-0000-0000-000000000000", "ffffffff-ffff-ffff-ffff-ffffffffffff"],
  "varchar": ["🦆🦆🦆🦆🦆🦆", "goo\tse"],
  "small_enum": ["DUCK_DUCK_ENUM", "GOOSE"],
  "medium_enum": ["enum_0", "enum_299"],
  "large_enum": ["enum_0", "enum_69999"],
  "time_ns": ["00:00:00", "24:00:00"],
  "interval": ["00:00:00", "83 years 3 months 999 days 00:16:39.999999"],
  "bit": ["0010001001011100010101011010111", "10101"],
  "blob": ["thisisalongblob\\x00withnullbytes", "\\x00\\x00\\x00a"],
  "union": ["Frank", "5"],
  "struct": ["{'a': NULL, 'b': NULL}", "{'a': 42, 'b': 🦆🦆🦆🦆🦆🦆}"],
  "struct_of_arrays": ["{'a': NULL, 'b': NULL}", "{'a': [42, 999, NULL, NULL, -42], 'b': [🦆🦆🦆🦆🦆🦆, goose, NULL, '']}"],
  "array_of_structs": ["[]", "[{'a': NULL, 'b': NULL}, {'a': 42, 'b': 🦆🦆🦆🦆🦆🦆}, NULL]"],
  "map": ["{}", "{key1=🦆🦆🦆🦆🦆🦆, key2=goose}"],
  "int_array": ["[]", "[42, 999, NULL, NULL, -42]"],
  "double_array": ["[]", "[42.0, nan, inf, -inf, NULL, -42.0]"],
  "date_array": ["[]", "[1970-01-01, infinity, -infinity, NULL, 2022-05-12]"],
  "timestamp_array": ["[]", "['1970-01-01 00:00:00', infinity, -infinity, NULL, '2022-05-12 16:23:45']"],
  "timestamptz_array": ["[]", "['1969-12-31 19:00:00-05', infinity, -infinity, NULL, '2022-05-12 18:23:45-05']"],
  "varchar_array": ["[]", "[🦆🦆🦆🦆🦆🦆, goose, NULL, '']"],
  "nested_int_array": ["[]", "[[], [42, 999, NULL, NULL, -42], NULL, [], [42, 999, NULL, NULL, -42]]"],
  "fixed_int_array": ["[NULL, 2, 3]", "[4, 5, 6]"],
  "fixed_varchar_array": ["[a, NULL, c]", "[d, e, f]"],
  "fixed_nested_int_array": ["[[NULL, 2, 3], NULL, [NULL, 2, 3]]", "[[4, 5, 6], [NULL, 2, 3], [4, 5, 6]]"],
  "fixed_nested_varchar_array": ["[[a, NULL, c], NULL, [a, NULL, c]]", "[[d, e, f], [a, NULL, c], [d, e, f]]"],
  "fixed_struct_array": ["[{'a': NULL, 'b': NULL}, {'a': 42, 'b': 🦆🦆🦆🦆🦆🦆}, {'a': NULL, 'b': NULL}]", "[{'a': 42, 'b': 🦆🦆🦆🦆🦆🦆}, {'a': NULL, 'b': NULL}, {'a': 42, 'b': 🦆🦆🦆🦆🦆🦆}]"],
  "struct_of_fixed_array": ["{'a': [NULL, 2, 3], 'b': [a, NULL, c]}", "{'a': [4, 5, 6], 'b': [d, e, f]}"],
  "fixed_array_of_int_list": ["[[], [42, 999, NULL, NULL, -42], []]", "[[42, 999, NULL, NULL, -42], [], [42, 999, NULL, NULL, -42]]"],
  "list_of_fixed_int_array": ["[[NULL, 2, 3], [4, 5, 6], [NULL, 2, 3]]", "[[4, 5, 6], [NULL, 2, 3], [4, 5, 6]]"],
};

async function runFormatTests(io: ShellIO): Promise<void> {
  const { writeln, runQueryAsync, tableFromIPC } = io;
  writeln("Running format tests against DuckDB CLI reference...", "33");
  try {
    const result = await runQueryAsync("SELECT * FROM test_all_types() LIMIT 2");
    if (!result.ok || !result.arrowBuffers?.length) {
      writeln(`Query failed: ${result.error}`, "31");
      return;
    }
    const table = tableFromIPC(result.arrowBuffers[0]);
    const fields = table.schema.fields;

    let passed = 0, failed = 0;
    for (let c = 0; c < fields.length; c++) {
      const name = fields[c].name;
      const exp = FORMAT_TEST_EXPECTED[name];
      if (!exp) continue;
      for (let r = 0; r < 2; r++) {
        try {
          const val = safeGetArrowValue(table.getChildAt(c), r, fields[c]);
          const got = val === null || val === undefined ? "NULL"
            : formatCellValue(val, fields[c].name, fields[c]);
          if (got === exp[r]) {
            passed++;
          } else {
            failed++;
            const typeInfo = fields[c].type?.toString() || "?";
            const valType = val === null ? "null" : typeof val === "object" ? val.constructor?.name || "object" : typeof val;
            const meta = fields[c].metadata ? JSON.stringify(Object.fromEntries(fields[c].metadata)) : "none";
            writeln(`  FAIL ${name}[${r}]: expected "${exp[r]}" got "${got}"`, "31");
            console.log(`FAIL ${name}[${r}]: expected "${exp[r]}" got "${got}" | arrowType="${typeInfo}" valType=${valType} meta=${meta} rawVal=${val instanceof Uint32Array ? Array.from(val).join(",") : String(val).slice(0, 50)}`);
          }
        } catch (e: any) {
          failed++;
          writeln(`  ERROR ${name}[${r}]: ${e.message}`, "31");
          console.log(`ERROR ${name}[${r}]: ${e.message}`);
        }
      }
    }
    if (failed === 0) {
      writeln(`All ${passed} tests passed.`, "32");
      console.log(`FORMAT_TEST: All ${passed} tests passed.`);
    } else {
      writeln(`${passed} passed, ${failed} failed.`, "31");
      console.log(`FORMAT_TEST: ${passed} passed, ${failed} failed.`);
    }
  } catch (err: any) {
    writeln(`Test error: ${err.message}`, "31");
  }
}
