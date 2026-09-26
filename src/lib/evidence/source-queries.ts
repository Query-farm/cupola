import Markdoc from '@markdoc/markdoc';

export function sourceQueries(source: string) {
  return [...Markdoc.parse(source).walk()]
    .filter(node => node.type === 'fence' && node.attributes.language === 'sql')
    .map(node => ({ name: String(node.attributes.meta ?? '').trim().split(/\s+/)[0], sql: String(node.attributes.content ?? ''),
      /** 1-based line of the fence's opening ``` in the source. */
      line: node.lines?.[0] === undefined ? undefined : node.lines[0] + 1 }));
}
