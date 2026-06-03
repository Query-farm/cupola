/**
 * The "Cupola — by 🚜 Query.Farm" icon + wordmark, linking to query.farm.
 *
 * Shared by the connected-app `Header` and the welcome / connecting / error
 * `BrandShell` so the lockup is byte-identical and vertically centered
 * everywhere. (The welcome header previously used its own `items-baseline`
 * copy, which sat off-center inside the `items-center` header bar.)
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
        src={`${import.meta.env.BASE_URL}cupola-icon.png`}
        alt=""
        aria-hidden="true"
        width={32}
        height={32}
        className="w-8 h-8 shrink-0 self-center text-foreground group-hover/brand:text-earth-700 transition-colors"
      />
      <span className="font-heading font-bold text-base leading-none text-foreground group-hover/brand:text-earth-700 transition-colors">
        Cupola
      </span>
      <span className="hidden md:inline font-heading text-sm leading-none text-muted-foreground group-hover/brand:text-foreground transition-colors">
        by <span aria-hidden="true">🚜&nbsp;</span>Query.Farm
      </span>
    </a>
  );
}
