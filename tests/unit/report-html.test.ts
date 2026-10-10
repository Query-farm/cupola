import { describe, expect, test } from 'bun:test';
import { reportHtml } from '../../src/lib/reporting/export-html';

describe('standalone report HTML', () => {
  test('escapes report content and excludes executable links', () => {
    const html = reportHtml('<script>title</script>', [{ kind: 'paragraph', children: [
      { kind: 'text', text: '<img src=x onerror=alert(1)>' },
      { kind: 'link', href: 'javascript:alert(1)', children: [{ kind: 'text', text: 'unsafe link' }] },
      { kind: 'link', href: 'https://example.test/?a=1&b=2', children: [{ kind: 'text', text: 'source' }] },
    ] }], {});
    expect(html).toContain('&lt;script&gt;title&lt;/script&gt;');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).not.toContain('javascript:');
    expect(html).not.toContain('<script');
    expect(html).toContain('https://example.test/?a=1&amp;b=2');
    expect(html).toContain("default-src 'none'");
  });

  test('embeds graphics, chart legends and every table row', () => {
    const html = reportHtml('Finance', [
      { kind: 'chart', title: 'Revenue', subtitle: 'USD', legend: [{ label: 'Actual & forecast', color: '#123456' }], graphic: { file: '/chart.svg', width: 400, height: 200 } },
      { kind: 'table', title: 'Results', subtitle: 'All observations', header: [], rows: Array.from({ length: 150 }, (_, i) => [{ children: [{ kind: 'text' as const, text: `row-${i}` }], align: 'right' as const }]) },
    ], { '/chart.svg': '<svg xmlns="http://www.w3.org/2000/svg"></svg>' });
    expect(html).toContain('data:image/svg+xml;base64,');
    expect(html).toContain('Actual &amp; forecast');
    expect(html).toContain('USD');
    expect(html).toContain('row-149');
    expect(html).toContain('text-align:right');
    expect(html.match(/<tr>/g)?.length).toBe(150);
  });

  test('fails visibly for unsupported or missing report content', () => {
    expect(() => reportHtml('Report', [{ kind: 'omitted', label: 'Map' }], {})).toThrow('Map');
    expect(() => reportHtml('Report', [{ kind: 'error', message: 'Query failed' }], {})).toThrow('Query failed');
    expect(() => reportHtml('Report', [{ kind: 'image', graphic: { file: '/missing.png', width: 1, height: 1 } }], {})).toThrow('graphic');
  });
});
