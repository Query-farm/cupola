/** The Typst template every exported report imports. Kept as a string rather than
 * a `.typ` asset so the browser and the bun unit tests load it the same way.
 * Font names must match the files served from `public/typst/fonts/`. */
export const TEMPLATE_PATH = '/cupola-report.typ';

export const REPORT_TEMPLATE = String.raw`
#let fonts = (serif: "Petrona", sans-serif: "Commissioner", mono: "JetBrains Mono")
// Seeded with a real theme: Typst's first layout pass reads a state's initial
// value before any update has been located, and a field access on none is fatal.
#let palette = state("cupola-theme", (heading: "serif", body: "sans-serif", accent: black,
  foreground: black, muted: gray, border: silver, paper: "a4"))

#let report(title: "", subtitle: none, meta: (), filters: (), appendix: (), view: none, theme: (:), doc) = {
  palette.update(theme)
  set document(title: title)
  set page(
    paper: theme.paper,
    margin: 54pt,
    header: context if here().page() > 1 {
      set text(size: 7.5pt, fill: theme.muted)
      title
      line(length: 100%, stroke: 0.5pt + theme.border)
    },
    footer: context {
      set text(size: 7.5pt, fill: theme.muted)
      grid(columns: (1fr, auto),
        meta.find(item => item.at(0) == "Updated").at(1, default: ""),
        [Page #counter(page).display() of #counter(page).final().first()])
    },
  )
  set text(font: fonts.at(theme.body), size: 9.5pt, fill: theme.foreground, fallback: true)
  set par(justify: false, leading: 0.7em, spacing: 1.15em)
  show raw: set text(font: fonts.mono, size: 0.9em)
  show link: set text(fill: theme.accent)
  show link: underline.with(stroke: 0.5pt + theme.accent.transparentize(40%), offset: 1.5pt)
  // Commissioner has no italic face and Typst does not synthesize one, so slant
  // it word by word (a single skewed box could not wrap across lines).
  show emph: it => if theme.body != "sans-serif" { it } else if it.body.has("text") {
    it.body.text.split(" ").map(word => box(skew(ax: -12deg, word))).join(" ")
  } else { box(skew(ax: -12deg, it.body)) }
  show heading: set text(font: fonts.at(theme.heading), fill: theme.foreground, weight: 600)
  show heading.where(level: 1): set text(size: 17pt)
  show heading.where(level: 2): set text(size: 13.5pt)
  show heading.where(level: 3): set text(size: 11.5pt)
  // Fixed spacing per level, more above than below, so a heading groups with the
  // content it introduces rather than floating between two sections.
  show heading: it => {
    // Typst keeps the larger of a heading's below and the next block's above, so
    // below must exceed paragraph spacing (~11pt) to open a visible gap.
    let (above, below) = if it.level == 1 { (30pt, 15pt) } else if it.level == 2 { (24pt, 13pt) } else if it.level == 3 { (20pt, 11pt) } else { (16pt, 9pt) }
    block(above: above, below: below, sticky: true, it)
  }
  set list(indent: 0.6em)
  set enum(indent: 0.6em)
  show quote.where(block: true): it => block(inset: (left: 10pt, y: 2pt), stroke: (left: 2pt + theme.border), text(fill: theme.muted, it.body))

  block(width: 100%, below: 1.6em, {
    text(font: fonts.at(theme.heading), size: 21pt, weight: 600, title)
    if subtitle != none { v(-0.4em); text(fill: theme.muted, subtitle) }
    if meta.len() > 0 {
      v(0.2em)
      set text(size: 8pt)
      grid(columns: (auto, 1fr), column-gutter: 10pt, row-gutter: 4pt,
        ..meta.map(item => (text(fill: theme.muted, item.at(0)), item.at(1))).flatten())
    }
    if view != none {
      v(0.2em)
      text(size: 8pt, link(view.at(1), view.at(0)))
    }
    // Every parameter and input in effect: a PDF of a filtered view must say so.
    if filters.len() > 0 {
      v(0.5em)
      set text(size: 8pt)
      block(below: 0.35em, text(size: 7pt, weight: 600, tracking: 0.06em, fill: theme.muted, upper("Filters")))
      grid(columns: (auto, 1fr), column-gutter: 10pt, row-gutter: 4pt,
        ..filters.map(item => (text(fill: theme.muted, item.at(0)), item.at(1))).flatten())
    }
    v(0.3em)
    line(length: 100%, stroke: 0.75pt + theme.accent)
  })
  doc
  // Filter values too long for the header, in full.
  if appendix.len() > 0 {
    heading(level: 2, "Filter values")
    for item in appendix {
      block(below: 0.9em, sticky: true, strong(item.at(0)))
      // A grid, not columns(): columns fill the first column down the page before the next.
      block(below: 1.4em, grid(columns: (1fr, 1fr, 1fr), column-gutter: 12pt, row-gutter: 5pt, ..item.at(1).map(value => [• #value])))
    }
  }
}

#let cupola-rule() = context line(length: 100%, stroke: 0.5pt + palette.get().border)

#let cupola-row(items) = grid(
  columns: (1fr,) * items.len(),
  column-gutter: 12pt,
  ..items,
)

#let cupola-callout(color: none, title: none, body) = context {
  let theme = palette.get()
  let accent = if color == none { theme.accent } else { color }
  block(width: 100%, breakable: false, inset: (x: 10pt, y: 8pt), radius: 3pt,
    fill: accent.transparentize(92%), stroke: (left: 2.5pt + accent), {
      if title != none { block(below: 0.6em, strong(title)) }
      body
    })
}

#let chart-heading(title, subtitle) = context {
  let theme = palette.get()
  // Sticky: a title never ends a page apart from the chart or table it names.
  if title != none { block(below: if subtitle == none { 8pt } else { 3pt }, sticky: true, text(weight: 700, size: 9pt, title)) }
  if subtitle != none { block(above: 0pt, below: 8pt, sticky: true, text(size: 8pt, fill: theme.muted, subtitle)) }
}

#let cupola-chart(title: none, subtitle: none, legend: (), graphic) = block(width: 100%, breakable: false, above: 16pt, below: 16pt, {
  chart-heading(title, subtitle)
  if legend.len() > 0 {
    set text(size: 7.5pt)
    block(above: 0pt, below: 6pt, legend.map(entry => box(inset: (right: 8pt),
      box(width: 6pt, height: 6pt, radius: 1pt, fill: entry.at(1)) + h(3pt) + entry.at(0))).join())
  }
  image(graphic.file, width: 100%)
})

#let cupola-metric(title: none, size: none, value: [], comparison: none, sparkline: none) = context {
  let theme = palette.get()
  block(breakable: false, above: 12pt, below: 12pt, {
    if title != none { block(below: 5pt, text(size: 8pt, fill: theme.muted, title)) }
    text(size: if size == none { 19pt } else { size }, weight: 600, value)
    if sparkline != none { h(6pt); box(baseline: 0.1em, image(sparkline.file, height: 1.3em)) }
    if comparison != none { block(above: 0.45em, text(size: 7.5pt, comparison)) }
  })
}

// A viz="bar" cell draws its bar behind the value, like the screen does.
#let table-cell(cell, bold: false) = {
  let body = if bold { strong(cell.body) } else { cell.body }
  let bar = cell.at("bar", default: none)
  if bar != none {
    body = {
      place(left + horizon, dx: bar.left * 100%, box(width: bar.width * 100%, height: 1.1em, fill: bar.color.transparentize(60%)))
      body
    }
  }
  table.cell(
    colspan: cell.at("colspan", default: 1),
    rowspan: cell.at("rowspan", default: 1),
    align: cell.at("align", default: left) + horizon,
    fill: cell.at("fill", default: none),
    body,
  )
}

#let cupola-table(title: none, subtitle: none, note: none, widths: none, header: (), rows: ()) = context {
  let theme = palette.get()
  let first = if header.len() > 0 { header.at(0) } else if rows.len() > 0 { rows.at(0) } else { () }
  let count = first.map(cell => cell.at("colspan", default: 1)).sum(default: 1)
  // Screen proportions at full width, like Evidence; natural widths otherwise.
  let columns = if widths != none and widths.len() == count { widths } else { count }
  // A short table stays on one page, so its total row is never stranded.
  block(width: 100%, above: 16pt, below: 16pt, breakable: rows.len() > 14, {
    chart-heading(title, subtitle)
    set text(size: 8pt)
    table(
      columns: columns,
      stroke: (x, y) => (bottom: 0.5pt + theme.border),
      inset: (x: 6pt, y: 4pt),
      table.header(..header.flatten().map(cell => table-cell(cell, bold: true))),
      ..rows.flatten().map(table-cell),
    )
    if note != none { block(above: 0.5em, text(size: 7.5pt, fill: theme.muted, note)) }
  })
}

// Sizes arrive in CSS pixels (1px = 0.75pt).
#let cupola-inline-graphic(graphic) = box(baseline: 15%, image(graphic.file, width: graphic.width * 0.75pt, height: graphic.height * 0.75pt))

#let cupola-image(title: none, graphic) = block(width: 100%, breakable: false, above: 1.2em, below: 1.2em, {
  chart-heading(title, none)
  layout(size => image(graphic.file, width: calc.min(graphic.width * 0.75pt, size.width)))
})

#let cupola-error(message) = block(width: 100%, inset: (x: 8pt, y: 6pt), radius: 3pt,
  fill: rgb("#b42318").transparentize(94%), stroke: 0.5pt + rgb("#b42318").transparentize(50%),
  text(size: 8pt, fill: rgb("#b42318"), font: fonts.mono, message))

#let cupola-omitted(label) = context block(width: 100%, inset: 6pt, radius: 3pt,
  stroke: (paint: palette.get().border, dash: "dashed"),
  text(size: 8pt, style: "italic", fill: palette.get().muted, label))
`;
