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

// node:fs stubs
export function readFileSync(): never { throw new Error("fs not available in browser"); }
export function writeFileSync(): never { throw new Error("fs not available in browser"); }
export function existsSync(): boolean { return false; }

export default { Readable, Writable, Duplex, Transform, PassThrough };
