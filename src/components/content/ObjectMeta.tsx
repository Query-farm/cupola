import { ExternalLink } from "lucide-react";
import { MetaChips } from "./MetaChips";
import { DocLinks } from "./DocLinks";
import {
  getTag,
  parseKeywords,
  parseClassificationTags,
  parseDocLinks,
  TAG_SOURCE_URL,
} from "@/lib/tags";

interface Props {
  tags?: Record<string, string> | null;
}

/**
 * Shared per-object metadata block: keyword / classification chips, an optional
 * source link, and documentation links. Rendered below the object's description
 * and above its type-specific body. Returns null when nothing is present.
 */
export function ObjectMeta({ tags }: Props) {
  const keywords = parseKeywords(tags);
  const classificationTags = parseClassificationTags(tags);
  const docLinks = parseDocLinks(tags);
  const sourceUrl = getTag(tags, TAG_SOURCE_URL);

  if (!keywords.length && !classificationTags.length && !docLinks.length && !sourceUrl) {
    return null;
  }

  return (
    <>
      <MetaChips keywords={keywords} classificationTags={classificationTags} />
      {sourceUrl && (
        <p className="mb-3 text-sm">
          <a
            href={sourceUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-primary hover:underline"
          >
            <ExternalLink className="h-3.5 w-3.5" />
            Source
          </a>
        </p>
      )}
      <DocLinks links={docLinks} />
    </>
  );
}
