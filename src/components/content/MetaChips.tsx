import { Badge } from "@/components/ui/badge";

interface Props {
  /** `vgi.keywords` — search terms / synonyms. */
  keywords?: string[];
  /** `vgi.classification_tags` — cross-cutting facet labels. */
  classificationTags?: string[];
}

/** Renders keyword and classification-facet chip rows (each shown only when non-empty). */
export function MetaChips({ keywords, classificationTags }: Props) {
  const hasKeywords = keywords && keywords.length > 0;
  const hasTags = classificationTags && classificationTags.length > 0;
  if (!hasKeywords && !hasTags) return null;

  return (
    <div className="flex flex-col gap-2 mb-4">
      {hasKeywords && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-xs font-medium text-muted-foreground/70 uppercase tracking-wide mr-1">Keywords</span>
          {keywords!.map((k) => (
            <Badge key={k} variant="secondary" className="text-xs font-normal px-2 py-0">{k}</Badge>
          ))}
        </div>
      )}
      {hasTags && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-xs font-medium text-muted-foreground/70 uppercase tracking-wide mr-1">Tags</span>
          {classificationTags!.map((t) => (
            <Badge key={t} variant="outline" className="text-xs font-normal px-2 py-0">{t}</Badge>
          ))}
        </div>
      )}
    </div>
  );
}
