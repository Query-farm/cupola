import type { TypstCompiler } from '@myriaddreamin/typst.ts/compiler';

/** Environment-neutral half of the Typst compiler: the browser loader
 * (`load-compiler.ts`) and the unit tests each supply the wasm module and font
 * bytes their own way, then compile through here. */

export const PDF_FONT_FILES = [
  'Commissioner-Regular.ttf', 'Commissioner-SemiBold.ttf', 'Commissioner-Bold.ttf',
  'Petrona-Regular.ttf', 'Petrona-SemiBold.ttf', 'Petrona-Bold.ttf', 'Petrona-Italic.ttf',
  'JetBrainsMono-Regular.ttf', 'JetBrainsMono-Bold.ttf',
] as const;

export async function createCompiler(wasm: ArrayBuffer | Uint8Array | Response | Promise<Response>, fonts: Uint8Array[]): Promise<TypstCompiler> {
  const [{ createTypstCompiler }, { loadFonts }] = await Promise.all([
    import('@myriaddreamin/typst.ts/compiler'), import('@myriaddreamin/typst.ts/options.init'),
  ]);
  const compiler = createTypstCompiler();
  // `assets: false`: never fetch typst.ts's default fonts from its CDN.
  await compiler.init({ getModule: () => wasm, beforeBuild: [loadFonts(fonts, { assets: false })] });
  return compiler;
}

export class TypstCompileError extends Error {
  constructor(readonly diagnostics: unknown[]) {
    super(`Typst could not compile the report: ${diagnostics.map(describe).join('; ')}`);
  }
}

function describe(diagnostic: unknown): string {
  if (typeof diagnostic === 'string') return diagnostic;
  const d = diagnostic as { message?: string; range?: string; path?: string };
  return [d.message, d.path && d.range ? `(${d.path} ${d.range})` : ''].filter(Boolean).join(' ');
}

let queue: Promise<unknown> = Promise.resolve();

/** Compile to PDF bytes. Calls are serialized: the compiler holds one shadow
 * file system, so two overlapping exports would read each other's files. */
export function compilePdf(compiler: TypstCompiler, main: string, files: Record<string, string | Uint8Array>): Promise<Uint8Array> {
  const run = queue.then(async () => {
    compiler.resetShadow();
    const encoder = new TextEncoder();
    for (const [path, content] of Object.entries(files)) compiler.mapShadow(path, typeof content === 'string' ? encoder.encode(content) : content);
    compiler.addSource('/main.typ', main);
    // 1 = CompileFormatEnum.pdf; the enum is a runtime value we avoid importing eagerly.
    const result = await compiler.compile({ mainFilePath: '/main.typ', format: 1, diagnostics: 'full' });
    const errors = (result.diagnostics ?? []).filter(d => (d as { severity?: string }).severity !== 'warning');
    if (!result.result || errors.length) throw new TypstCompileError(errors.length ? errors : ['no output']);
    return result.result;
  });
  queue = run.catch(() => undefined);
  return run;
}
