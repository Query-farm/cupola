import Markdoc from '@markdoc/markdoc';

export function sourceQueries(source: string) {
  return [...Markdoc.parse(source).walk()]
    .filter(node => node.type === 'fence' && node.attributes.language === 'sql')
    .map(node => ({ name: String(node.attributes.meta ?? '').trim().split(/\s+/)[0], sql: String(node.attributes.content ?? '') }));
}
