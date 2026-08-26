/**
 * Coerce a raw query-result cell to a finite JS number, without throwing.
 *
 * Arrow BigNum values (BIGINT/UINT64/HUGEINT/DECIMAL columns) have a custom
 * Symbol.toPrimitive/valueOf that *throws* a TypeError instead of returning
 * Infinity/NaN when the value exceeds Number.MAX_SAFE_INTEGER (see
 * @query-farm/apache-arrow's bigIntToNumber). A plain `Number(value)` on such
 * a cell crashes rather than failing gracefully, so every caller that turns
 * result rows into numbers for display/plotting must route through here.
 */
export function safeNumber(value: unknown): number | null {
  if (value == null || value === "" || typeof value === "boolean") return null;
  try {
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  } catch {
    return null;
  }
}
