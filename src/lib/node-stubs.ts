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
export function openSync(): number { return 0; }
export function closeSync(): void {}
export function readSync(): number { return 0; }
export function unlinkSync(): void {}
export function createWriteStream(): Writable { return new Writable(); }
export const constants = {} as Record<string, number>;

// node:os, node:path, node:child_process stubs — required by transitively
// pulled-in code from vgi-rpc-typescript's launcher modules that are never
// reachable on the browser path but participate in static analysis.
export function tmpdir(): string { return "/tmp"; }
export function homedir(): string { return "/"; }
export function platform(): string { return "browser"; }
export const sep = "/";
export const delimiter = ":";
export function join(...parts: string[]): string { return parts.join("/"); }
export function resolve(...parts: string[]): string { return parts.join("/"); }
export function dirname(p: string): string { return p.split("/").slice(0, -1).join("/"); }
export function basename(p: string): string { return p.split("/").pop() ?? ""; }
export function extname(p: string): string { const i = p.lastIndexOf("."); return i >= 0 ? p.slice(i) : ""; }
export function normalize(p: string): string { return p; }
export function isAbsolute(p: string): boolean { return p.startsWith("/"); }
export function relative(from: string, to: string): string { return to.startsWith(from) ? to.slice(from.length) : to; }
export function parse(p: string): { root: string; dir: string; base: string; ext: string; name: string } {
  const dir = dirname(p);
  const base = basename(p);
  const ext = extname(base);
  return { root: p.startsWith("/") ? "/" : "", dir, base, ext, name: base.slice(0, base.length - ext.length) };
}
export const posix = { sep: "/", delimiter: ":", join, resolve, dirname, basename, extname, normalize, isAbsolute, relative, parse };
export const win32 = posix;
export function spawn() { throw new Error("child_process.spawn stub: not available in browser"); }
export function execSync() { throw new Error("child_process.execSync stub: not available in browser"); }
export function createServer() { throw new Error("net.createServer stub: not available in browser"); }
// node:net client stubs — vgi-rpc's TCP (`connect`) and AF_UNIX
// (`createConnection`) launchers are bundled into vgi-rpc's dist and statically
// imported, but neither code path is reachable from the browser. Throwing on
// call is fine; these exist only so Rollup's static analysis resolves them.
export function connect() { throw new Error("net.connect stub: not available in browser"); }
export function createConnection() { throw new Error("net.createConnection stub: not available in browser"); }
export type Server = any;
export type Socket = any;

// Default export covers `import path from "node:path"` and similar default-
// import patterns that Vite/Rollup synthesize for CJS interop. Mirror every
// named export so `path.extname(...)` style calls work too.
export default {
  Readable, Writable, Duplex, Transform, PassThrough,
  createDeflate, createInflate, createGzip, createGunzip,
  randomBytes, createHmac, createHash, timingSafeEqual, X509Certificate,
  createRequire,
  readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync,
  writeSync, openSync, closeSync, readSync, unlinkSync, createWriteStream,
  constants,
  tmpdir, homedir, platform,
  sep, delimiter, join, resolve, dirname, basename, extname, normalize, isAbsolute, relative, parse,
  posix, win32,
  spawn, execSync,
  createServer, connect, createConnection,
};
