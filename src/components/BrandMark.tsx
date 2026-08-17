/**
 * The "Cupola — by 🚜 Query.Farm" mark + wordmark, linking to query.farm.
 *
 * Shared by the connected-app `Header` and the welcome / connecting / error
 * `BrandShell` so the lockup is byte-identical and vertically centered
 * everywhere. (The welcome header previously used its own `items-baseline`
 * copy, which sat off-center inside the `items-center` header bar.)
 *
 * The mark is `cupola-mark.svg` — the axonometric cupola, matching the one on
 * query.farm/products/cupola. It is loaded as an <img> rather than inlined,
 * so the finial resolves to the file's own `color` attribute (ink) instead of
 * inheriting the header's text colour; that keeps it stable across the light
 * and dark chrome without needing two files. `text-*` classes on the element
 * therefore no longer do anything to it, so the hover tint lives on the
 * wordmark alone.
 */
export function BrandMark() {
  return (
    <a
      href="https://query.farm"
      className="flex items-center gap-2 whitespace-nowrap group/brand"
      target="_blank"
      rel="noopener noreferrer"
      title="Cupola — a Query.Farm tool"
    >
      <img
        src={`${import.meta.env.BASE_URL}cupola-mark.svg`}
        alt=""
        aria-hidden="true"
        width={32}
        height={32}
        className="w-8 h-8 shrink-0 self-center object-contain"
      />
      <span className="font-heading font-bold text-base leading-none text-foreground group-hover/brand:text-sun-700 dark:group-hover/brand:text-sun-300 transition-colors">
        Cupola
      </span>
      <span className="hidden md:inline font-sans text-sm leading-none text-muted-foreground group-hover/brand:text-foreground transition-colors">
        by <span aria-hidden="true">🚜&nbsp;</span>Query.Farm
      </span>
    </a>
  );
}
