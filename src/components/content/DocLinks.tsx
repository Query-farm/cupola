import { ExternalLink } from "lucide-react";
import type { DocLink } from "@/lib/tags";

interface Props {
  links: DocLink[];
}

/** Renders `vgi.doc_links` as a labeled list of external links (open in a new tab). */
export function DocLinks({ links }: Props) {
  if (links.length === 0) return null;
  return (
    <>
      <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mt-6 mb-2">Links</h2>
      <ul className="flex flex-col gap-1.5 mb-4">
        {links.map((link, i) => (
          <li key={i}>
            <a
              href={link.url}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 text-sm text-primary hover:underline"
            >
              <ExternalLink className="h-3.5 w-3.5 shrink-0" />
              <span className="truncate">{link.title || link.url}</span>
            </a>
          </li>
        ))}
      </ul>
    </>
  );
}
