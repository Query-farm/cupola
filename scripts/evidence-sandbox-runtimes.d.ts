// The core's manifest of sandbox runtimes is plain JavaScript; this is its shape.
declare module '@evidence/core/user-components/sandbox/sandbox-runtimes.js' {
  export const SANDBOX_RUNTIMES: { fileName: string; globalName: string; entry: string }[];
  export const SANDBOX_SERVE_DIR: string;
}
