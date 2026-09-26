import { beforeAll, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import type { TypstCompiler } from '@myriaddreamin/typst.ts/compiler';
import { compilePdf, createCompiler, PDF_FONT_FILES, TypstCompileError } from '../../src/lib/evidence/typst/compiler';
import { blockExpr, color, emitTypst, inlineExpr, lit } from '../../src/lib/evidence/typst/emit';
import { contentWidthPx, defaultPaper, dropRepeatedTitle, normalizeInlines, type ReportDocument } from '../../src/lib/evidence/typst/model';

const root = new URL('../../', import.meta.url).pathname;
let compiler: TypstCompiler;

beforeAll(async () => {
  const wasm = readFileSync(`${root}node_modules/@myriaddreamin/typst-ts-web-compiler/pkg/typst_ts_web_compiler_bg.wasm`);
  compiler = await createCompiler(wasm, PDF_FONT_FILES.map(file => new Uint8Array(readFileSync(`${root}public/typst/fonts/${file}`))));
});

// Every character with meaning in Typst markup, code or strings.
const HOSTILE = 'a#b*c_d`e$f<g>h@i[j]k~l\\m"n//o/*p*/q= r- s+ t\n#set page(width: 1pt)\t\u0001\u{1F600}';

const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100"><rect width="200" height="100" fill="#3366cc"/><text x="10" y="50" font-family="Commissioner" font-size="12">chart</text></svg>';
// A 1×1 PNG, standing in for an html-to-image capture.
const PNG = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='), c => c.charCodeAt(0));
const icon = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 12 12"><path d="M6 2L10 9H2Z" fill="#16a34a"/></svg>';

function sampleDocument(text = HOSTILE): ReportDocument {
  const t = (value: string) => [{ kind: 'text' as const, text: value }];
  return {
    title: text, subtitle: text, meta: [{ label: 'Updated', value: text }, { label: text, value: 'x' }],
    filters: [{ label: text, value: text }], appendix: [{ label: text, values: [text, 'b'] }],
    link: { label: text, url: 'https://example.com/r?p.state="VA"' },
    theme: { heading: 'serif', body: 'sans-serif', accent: '#685442', foreground: 'rgb(20, 20, 20)', muted: 'rgba(100, 100, 100, 0.8)', border: '#ddd', paper: 'us-letter' },
    files: { '/charts/1.svg': svg, '/icons/1.svg': icon, '/shots/1.png': PNG },
    blocks: [
      { kind: 'heading', level: 1, children: t(text) },
      { kind: 'paragraph', children: [
        { kind: 'text', text: text, bold: true, italic: true, color: 'rgb(200, 0, 0)' },
        { kind: 'text', text: text, code: true },
        { kind: 'link', href: 'https://example.com/?q="x"', children: t(text) },
        { kind: 'link', href: 'javascript:alert(1)', children: t('unsafe') },
        { kind: 'graphic', file: '/icons/1.svg', width: 10, height: 10 },
        { kind: 'linebreak' },
        { kind: 'text', text: text, strike: true },
      ] },
      { kind: 'list', ordered: false, items: [[{ kind: 'paragraph', children: t(text) }]] },
      { kind: 'list', ordered: true, start: 3, items: [[{ kind: 'paragraph', children: t('a') }], [{ kind: 'paragraph', children: t('b') }]] },
      { kind: 'quote', blocks: [{ kind: 'paragraph', children: t(text) }] },
      { kind: 'code', text, lang: 'sql' },
      { kind: 'rule' },
      { kind: 'group', blocks: [{ kind: 'paragraph', children: t('kept together') }] },
      { kind: 'row', items: [
        [{ kind: 'metric', title: text, value: t('780'), comparison: t('+5%'), sparkline: { file: '/charts/1.svg', width: 60, height: 20 } }],
        [{ kind: 'metric', value: t('12') }],
      ] },
      { kind: 'callout', color: '#2563eb', title: t(text), blocks: [{ kind: 'paragraph', children: t(text) }] },
      { kind: 'callout', blocks: [] },
      { kind: 'chart', title: text, subtitle: text, legend: [{ label: text, color: 'rgb(1, 2, 3)' }], graphic: { file: '/charts/1.svg', width: 200, height: 100 } },
      { kind: 'table', title: text, note: text,
        header: [[{ children: t('Region') }, { children: t(text), align: 'right' }]],
        rows: [
          [{ children: t('west'), rowspan: 2 }, { children: t('1'), align: 'right' }],
          [{ children: t('2'), align: 'right' }],
          [{ children: t('Total'), colspan: 2 }],
          [{ children: t('scaled'), fill: '#16a34a40' }, { children: t('3'), align: 'right', bar: { left: 0.1, width: 0.5, color: '#2563eb' } }],
        ] },
      { kind: 'table', header: [], rows: [] },
      { kind: 'pagebreak' },
      { kind: 'image', title: text, graphic: { file: '/shots/1.png', width: 900, height: 200 } },
      { kind: 'error', message: text },
      { kind: 'omitted', label: text },
    ],
  };
}

async function compile(doc: ReportDocument): Promise<Uint8Array> {
  const { main, files } = emitTypst(doc);
  return compilePdf(compiler, main, files);
}

describe('Typst string literals', () => {
  test('round-trip any text exactly, so report data can never become markup', async () => {
    const samples = [HOSTILE, '', '"', '\\', '\\"', '#{panic()}', ']', '\r\n', ' '];
    const main = samples.map((sample, i) => `#metadata(${lit(sample)}) <s${i}>`).join('\n');
    for (let i = 0; i < samples.length; i++) {
      await compilePdf(compiler, main, {});
      // compiler.query() neither compiles first nor avoids parsing its JSON twice.
      const values = await compiler.runWithWorld({ mainFilePath: '/main.typ' }, async world => {
        await world.compile();
        return world.query({ selector: `<s${i}>` }) as Promise<{ value: string }[]>;
      });
      expect(values[0].value).toBe(samples[i]);
    }
  });
  test('browser colors become hex, and garbage never reaches the compiler', () => {
    expect(color('rgb(22, 163, 74)')).toBe('#16a34a');
    expect(color('rgba(0, 0, 0, 0.5)')).toBe('#00000080');
    expect(color('rgb(255 0 0 / 50%)')).toBe('#ff000080');
    expect(color('#ABC')).toBe('#abc');
    expect(color('red"); panic("x')).toBe('#000000');
  });
});

describe('Typst emitter', () => {
  test('compiles every block kind, with hostile text everywhere, to a PDF', async () => {
    const pdf = await compile(sampleDocument());
    expect(new TextDecoder().decode(pdf.slice(0, 5))).toBe('%PDF-');
    // Hostile text (`#set page(width: 1pt)`) must not have changed the page: every page stays US Letter.
    const raw = new TextDecoder('latin1').decode(pdf);
    const pages = raw.match(/\/Type\s*\/Page\b/g)?.length ?? 0;
    expect(pages).toBeGreaterThanOrEqual(2);
    expect(raw.match(/\/MediaBox\s*\[0 0 612 792\]/g)?.length).toBe(pages);
  });
  test('only http(s) and mailto links become links', () => {
    expect(inlineExpr([{ kind: 'link', href: 'javascript:alert(1)', children: [{ kind: 'text', text: 'x' }] }])).toBe('text("x")');
    expect(inlineExpr([{ kind: 'link', href: 'https://a.b', children: [{ kind: 'text', text: 'x' }] }])).toBe('link("https://a.b", text("x"))');
  });
  test('one-element arrays keep their trailing comma', () => {
    expect(blockExpr({ kind: 'row', items: [[{ kind: 'rule' }]] })).toBe('cupola-row((cupola-rule(),))');
  });
  test('a broken template surfaces the diagnostics rather than an empty file', async () => {
    await expect(compilePdf(compiler, '#let x = (', {})).rejects.toBeInstanceOf(TypstCompileError);
  });
});

describe('document model helpers', () => {
  test('collapses HTML whitespace across nodes and trims the run', () => {
    expect(normalizeInlines([
      { kind: 'text', text: '  Total  revenue is ' },
      { kind: 'text', text: ' 780', bold: true },
      { kind: 'text', text: '   and\n change ' },
      { kind: 'text', text: '  a  b ', code: true },
      { kind: 'text', text: '  ' },
    ])).toEqual([
      { kind: 'text', text: 'Total revenue is ' },
      { kind: 'text', text: '780', bold: true },
      { kind: 'text', text: ' and change ' },
      { kind: 'text', text: '  a  b ', code: true },
    ]);
  });
  test('drops an opening heading that repeats the report title, and nothing else', () => {
    const h1 = (text: string, level = 1) => ({ kind: 'heading' as const, level, children: [{ kind: 'text' as const, text }] });
    const para = { kind: 'paragraph' as const, children: [] };
    expect(dropRepeatedTitle([h1('Your  week outdoors'), para], 'Your week Outdoors')).toEqual([para]);
    expect(dropRepeatedTitle([h1('Sales overview'), para], 'Probe report')).toHaveLength(2);
    expect(dropRepeatedTitle([h1('Probe report', 2), para], 'Probe report')).toHaveLength(2);
    expect(dropRepeatedTitle([para, h1('Probe report')], 'Probe report')).toHaveLength(2);
  });
  test('paper follows the locale, and charts render at the printed width', () => {
    expect(defaultPaper('en-US')).toBe('us-letter');
    expect(defaultPaper('en-GB')).toBe('a4');
    expect(defaultPaper(undefined)).toBe('a4');
    expect(contentWidthPx('us-letter')).toBe(672);
  });
});

describe('text color filter', () => {
  test('keeps deltas and accents, drops theme text and grays', async () => {
    const { isChromatic } = await import('../../src/lib/evidence/typst/css-color');
    for (const hex of ['#16a34a', '#dc2626', '#9a6a3a', '#2563eb']) expect(isChromatic(hex)).toBe(true);
    for (const hex of ['#211a12', '#1f1d1a', '#6b6b5a', '#71717b', '#f5f0e6', '#000000', '#ffffff']) expect(isChromatic(hex)).toBe(false);
    expect(isChromatic(null)).toBe(false);
  });
});

describe('chart geometry at print size', () => {
  test('takes lost width out of pixel widths and keeps pixel margins for labels', async () => {
    const { fitChartGeometry } = await import('../../src/lib/evidence/typst/chart-geometry');
    // The styled funnel Evidence resolves for a 1086px screen chart, printed at 672px.
    const option = { series: [{ type: 'funnel', left: 115.8, width: 970.2, right: 80, top: '5%', data: [1, 2] }], grid: { left: '0%', right: 40, top: 20 }, color: ['#fff'] };
    const out = fitChartGeometry(option, { width: 1086, height: 215 }, { width: 672, height: 215 });
    expect(out.series[0].left).toBe(115.8);
    expect(out.series[0].width).toBeCloseTo(556.2, 1);
    expect(out.series[0].top).toBe('5%');
    expect(out.series[0].data).toEqual([1, 2]);
    expect(out.grid).toEqual({ left: '0%', right: 40, top: 20 });
    expect(out.color).toEqual(['#fff']);
    // The live option is not mutated, and an unchanged size is a no-op.
    expect(option.series[0].width).toBe(970.2);
    expect(fitChartGeometry(option, { width: 672, height: 215 }, { width: 672, height: 215 })).toBe(option);
  });
  test('scales pixel centers and radii with the box', async () => {
    const { fitChartGeometry } = await import('../../src/lib/evidence/typst/chart-geometry');
    const out = fitChartGeometry({ series: [{ type: 'pie', center: [500, '50%'], radius: [40, '70%'] }] }, { width: 1000, height: 500 }, { width: 500, height: 400 });
    expect(out.series[0]).toMatchObject({ center: [250, '50%'], radius: [20, '70%'] });
  });
});

describe('long tables', () => {
  test('repeat their header row on every page they span, and keep every row', async () => {
    const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const t = (text: string) => [{ kind: 'text' as const, text }];
    const rows = Array.from({ length: 150 }, (_, i) => [{ children: t(`Region ${i + 1}`) }, { children: t(String((i + 1) * 10)), align: 'right' as const }]);
    const doc = sampleDocument('plain');
    doc.blocks = [{ kind: 'table', title: 'Sales by region', header: [[{ children: t('Region name') }, { children: t('Revenue total'), align: 'right' }]], rows, widths: [300, 100] }];
    const pdf = await getDocument({ data: await compile(doc) }).promise;
    expect(pdf.numPages).toBeGreaterThanOrEqual(3);
    const seen: string[] = [];
    for (let n = 1; n <= pdf.numPages; n++) {
      const text = (await (await pdf.getPage(n)).getTextContent()).items.map(item => ('str' in item ? item.str : '')).join('\n');
      const onPage = [...text.matchAll(/Region (\d+)/g)].map(match => match[1]);
      seen.push(...onPage);
      // Every page carrying table rows starts them under the column headers.
      if (onPage.length) expect(text).toContain('Region name');
      if (onPage.length) expect(text).toContain('Revenue total');
    }
    expect(seen).toEqual(Array.from({ length: 150 }, (_, i) => String(i + 1)));
  });
});

describe('table column widths', () => {
  const t = (value: string) => [{ kind: 'text' as const, text: value }];
  const theme = { heading: 'serif' as const, body: 'sans-serif' as const, accent: '#685442', foreground: '#1f1d1a', muted: '#6b6b5a', border: '#dddddd', paper: 'us-letter' as const };
  async function layouts(blocks: ReportDocument['blocks']) {
    await compile({ title: 'Widths', meta: [], theme, files: {}, blocks });
    const found = await compiler.runWithWorld({ mainFilePath: '/main.typ' }, async world => {
      await world.compile();
      return world.query({ selector: '<cupola-table-layout>' }) as Promise<{ value: { widths: string[]; size: string; overflow: boolean } }[]>;
    });
    return found.map(item => ({ widths: item.value.widths.map(parseFloat), size: parseFloat(item.value.size), overflow: item.value.overflow }));
  }
  const available = 612 - 2 * 54; // US Letter minus the template's margins, in pt.

  test('numbers get room for their widest value, even when the screen squeezed their columns', async () => {
    const money = ['1,234,567.89', '-98,765,432.10', '0.00'];
    const [layout] = await layouts([{ kind: 'table', widths: [900, 40, 40, 40],
      header: [[{ children: t('Description') }, { children: t('Revenue') }, { children: t('Cost') }, { children: t('Margin') }]],
      rows: money.map(value => [{ children: t('A long description of the line item that should wrap onto several lines rather than squeeze the figures') }, { children: t(value), align: 'right' }, { children: t(value), align: 'right' }, { children: t(value), align: 'right' }]),
    }]);
    // The screen's proportions would have given each figure column ~17pt; "-98,765,432.10" needs far more.
    for (const width of layout.widths.slice(1)) expect(width).toBeGreaterThan(55);
    expect(layout.widths[0]).toBeGreaterThan(layout.widths[1]);
    expect(layout.widths.reduce((a, b) => a + b)).toBeCloseTo(available, 0);
    expect(layout.size).toBe(8);
  });
  test('a table that fits keeps the screen proportions for its spare width', async () => {
    const [layout] = await layouts([{ kind: 'table', widths: [300, 100],
      header: [[{ children: t('Region') }, { children: t('Total') }]],
      rows: [[{ children: t('West') }, { children: t('12') }], [{ children: t('East') }, { children: t('7') }]],
    }]);
    expect(layout.widths[0] / layout.widths[1]).toBeGreaterThan(2);
    expect(layout.widths.reduce((a, b) => a + b)).toBeCloseTo(available, 0);
  });
  test('wide figures shrink the text rather than overlap, and a table too wide even at 6pt says so', async () => {
    const figures = (columns: number) => ({ kind: 'table' as const,
      header: [Array.from({ length: columns }, (_, i) => ({ children: t(`C${i}`) }))],
      rows: [Array.from({ length: columns }, () => ({ children: t('-12,345,678.90'), align: 'right' as const }))],
    });
    const [squeezed, impossible] = await layouts([figures(8), figures(14)]);
    expect(squeezed.size).toBeLessThan(8);
    expect(squeezed.size).toBeGreaterThanOrEqual(6);
    expect(squeezed.widths.reduce((a, b) => a + b)).toBeLessThanOrEqual(available + 0.5);
    expect(impossible.size).toBe(6);
    expect(impossible.overflow).toBe(true);
  });
});
