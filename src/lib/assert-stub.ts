/**
 * Minimal browser stub for Node.js assert module.
 * Used by kepler.gl's dataset-utils.ts for input validation.
 */
function assert(value: unknown, message?: string): asserts value {
  if (!value) {
    throw new Error(message || "Assertion failed");
  }
}

assert.ok = assert;
assert.strictEqual = (a: unknown, b: unknown, msg?: string) => {
  if (a !== b) throw new Error(msg || `Expected ${a} === ${b}`);
};
assert.deepStrictEqual = assert.strictEqual;

export default assert;
export { assert };
