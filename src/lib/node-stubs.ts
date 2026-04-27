/**
 * Stubs for Node.js built-ins that Apache Arrow references but never
 * actually uses in browser code paths. Provides minimal class shells
 * so `class X extends Readable` doesn't throw.
 */

// node:stream stubs
export class Readable {
  constructor(_opts?: any) {}
  read(_size?: number): any { return null; }
  pipe(_dest: any): any { return _dest; }
  on(_event: string, _fn: (...args: any[]) => void): this { return this; }
  destroy(): this { return this; }
}

export class Writable {
  constructor(_opts?: any) {}
  write(_chunk: any): boolean { return true; }
  end(): this { return this; }
  on(_event: string, _fn: (...args: any[]) => void): this { return this; }
  destroy(): this { return this; }
}

export class Duplex extends Readable {
  constructor(_opts?: any) { super(_opts); }
  write(_chunk: any): boolean { return true; }
  end(): this { return this; }
}

export class Transform extends Duplex {
  constructor(_opts?: any) { super(_opts); }
}

export class PassThrough extends Transform {}

export type ReadableOptions = any;
export type WritableOptions = any;
export type DuplexOptions = any;
export type TransformOptions = any;

// node:zlib stubs
export function createDeflate() { return new PassThrough(); }
export function createInflate() { return new PassThrough(); }
export function createGzip() { return new PassThrough(); }
export function createGunzip() { return new PassThrough(); }

// node:crypto stubs
export function randomBytes(n: number): Uint8Array { return new Uint8Array(n); }
export function createHmac() { return { update() { return this; }, digest() { return ""; } }; }
export function createHash() { return { update() { return this; }, digest() { return ""; } }; }
export function timingSafeEqual(_a: Uint8Array, _b: Uint8Array): boolean { return false; }
export class X509Certificate {
  constructor(_input?: any) {}
}

// node:module stubs — vgi-rpc-typescript's node-target dist injects
// `createRequire(import.meta.url)` at the top of its bundle. Returning a
// function that throws on actual call is fine: nothing on the browser code
// path invokes it.
export function createRequire(_url?: string | URL) {
  const req: any = () => { throw new Error("createRequire stub: not available in browser"); };
  req.resolve = () => { throw new Error("createRequire stub: not available in browser"); };
  return req;
}

// node:fs stubs (must not throw — Astro SSR pipeline may call these during dev)
export function readFileSync(): string { return ""; }
export function writeFileSync(): void {}
export function existsSync(): boolean { return false; }
export function mkdirSync(): void {}
export function readdirSync(): string[] { return []; }
export function statSync(): null { return null; }
export function writeSync(): number { return 0; }

export default { Readable, Writable, Duplex, Transform, PassThrough };
