/**
 * `vgi.doc_md` is written to stand alone, so it usually opens with a heading
 * naming the object (`# slow_rows`, `## \`cat.schema.fn(x)\``). Where the name
 * is already the title of what's on screen, that heading is a second copy.
 */

/** The bare object name a heading's text refers to, if it is only a name:
 *  formatting, qualification and an argument list are ignored. */
function headingName(text: string): string {
  let t = text.replace(/[`*]/g, "").trim(); // not `_`: names are full of them
  const paren = t.indexOf("(");
  if (paren > 0) t = t.slice(0, paren);
  t = t.trim();
  const dot = t.lastIndexOf(".");
  if (dot >= 0) t = t.slice(dot + 1);
  return t.replace(/^"|"$/g, "").trim().toLowerCase();
}

/** `markdown` without a leading heading that only repeats `name`. */
export function stripLeadingNameHeading(markdown: string, name: string): string {
  const m = /^\s*(#{1,6})[ \t]+(.+?)[ \t#]*(?:\r?\n|$)/.exec(markdown);
  if (!m || headingName(m[2]) !== name.toLowerCase()) return markdown;
  return markdown.slice(m[0].length).replace(/^\s*\n/, "");
}
