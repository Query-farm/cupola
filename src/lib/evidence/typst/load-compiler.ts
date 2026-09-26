import type { TypstCompiler } from '@myriaddreamin/typst.ts/compiler';
import wasmUrl from '@myriaddreamin/typst-ts-web-compiler/pkg/typst_ts_web_compiler_bg.wasm?url';
import { createCompiler, PDF_FONT_FILES } from './compiler';

export interface PdfFont { file: (typeof PDF_FONT_FILES)[number]; bytes: Uint8Array }

let fonts: Promise<PdfFont[]> | undefined;
let compiler: Promise<TypstCompiler> | undefined;

/** The PDF's fonts, served by Cupola itself (never typst.ts's default CDN). Shared
 * by the compiler and by snapshots, which embed them so captured text matches. */
export function loadPdfFonts(): Promise<PdfFont[]> {
  fonts ??= Promise.all(PDF_FONT_FILES.map(async file => {
    const response = await fetch(`${import.meta.env.BASE_URL.replace(/\/?$/, '/')}typst/fonts/${file}`);
    if (!response.ok) throw new Error(`Could not load the PDF font ${file} (${response.status}).`);
    return { file, bytes: new Uint8Array(await response.arrayBuffer()) };
  }));
  // A failed load (offline, a deploy mid-session) must not poison later attempts.
  fonts.catch(() => { fonts = undefined; });
  return fonts;
}

/** The Typst compiler (~7MB brotli) loads on the first export only. */
export function loadTypstCompiler(): Promise<TypstCompiler> {
  compiler ??= loadPdfFonts().then(loaded => createCompiler(fetch(wasmUrl), loaded.map(font => font.bytes)));
  compiler.catch(() => { compiler = undefined; });
  return compiler;
}
