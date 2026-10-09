import { describe, expect, test } from "bun:test";
import { IROH_SECRET_KEY_STORAGE, generateIrohSecretKey, getOrCreateIrohSecretKey, irohEndpointIdFromSecretKey } from "../../src/lib/iroh";

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
    data,
  };
}

describe("Iroh identity", () => {
  test("keys are 32 random bytes as 64 hex characters", () => {
    const a = generateIrohSecretKey();
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(generateIrohSecretKey()).not.toBe(a);
  });

  test("the first key is persisted and then reused, for a stable identity", () => {
    const storage = memoryStorage();
    const first = getOrCreateIrohSecretKey(storage);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(storage.data.get(IROH_SECRET_KEY_STORAGE)).toBe(first);
    expect(getOrCreateIrohSecretKey(storage)).toBe(first);
  });

  test("a corrupt stored key is replaced", () => {
    const storage = memoryStorage({ [IROH_SECRET_KEY_STORAGE]: "not-a-key" });
    expect(getOrCreateIrohSecretKey(storage)).toMatch(/^[0-9a-f]{64}$/);
  });

  test("without usable storage the identity is ephemeral", () => {
    // An undefined argument selects browser storage. Make its absence explicit,
    // independently of DOM/storage fixtures installed by earlier test files.
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    try {
      Object.defineProperty(globalThis, "localStorage", { configurable: true, value: undefined });
      expect(getOrCreateIrohSecretKey()).toBeUndefined();
      Object.defineProperty(globalThis, "localStorage", { configurable: true, get() { throw new Error("blocked"); } });
      expect(getOrCreateIrohSecretKey()).toBeUndefined();
    } finally {
      if (descriptor) Object.defineProperty(globalThis, "localStorage", descriptor);
      else Reflect.deleteProperty(globalThis, "localStorage");
    }
    const throwing = { getItem: () => { throw new Error("blocked"); }, setItem: () => {} };
    expect(getOrCreateIrohSecretKey(throwing)).toBeUndefined();
  });

  test("the endpoint ID is derived from the key without starting a node", async () => {
    // RFC 8032 section 7.1, TEST 1. Checked against a real node's endpointId.
    expect(await irohEndpointIdFromSecretKey("9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60"))
      .toBe("d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a");
  });
});
