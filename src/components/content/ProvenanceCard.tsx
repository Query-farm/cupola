import { ExternalLink } from "lucide-react";
import {
  getTag,
  TAG_SOURCE_URL,
  TAG_AUTHOR,
  TAG_COPYRIGHT,
  TAG_LICENSE,
  TAG_SUPPORT_CONTACT,
  TAG_SUPPORT_POLICY_URL,
} from "@/lib/tags";

interface Props {
  tags?: Record<string, string> | null;
}

/** Render a value as a link when it looks like an http(s) URL or an email, else plain text. */
function ValueLink({ value }: { value: string }) {
  const isUrl = /^https?:\/\//i.test(value);
  const isEmail = !isUrl && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
  if (isUrl || isEmail) {
    return (
      <a
        href={isEmail ? `mailto:${value}` : value}
        target={isUrl ? "_blank" : undefined}
        rel={isUrl ? "noopener noreferrer" : undefined}
        className="inline-flex items-center gap-1 text-primary hover:underline break-all"
      >
        {value}
        {isUrl && <ExternalLink className="h-3 w-3 shrink-0" />}
      </a>
    );
  }
  return <span className="break-words">{value}</span>;
}

/** Catalog-level provenance / legal / support metadata (source, author, license, support). */
export function ProvenanceCard({ tags }: Props) {
  const rows: Array<{ label: string; value: string }> = [];
  const push = (label: string, key: string) => {
    const v = getTag(tags, key);
    if (v) rows.push({ label, value: v });
  };
  push("Source", TAG_SOURCE_URL);
  push("Author", TAG_AUTHOR);
  push("Copyright", TAG_COPYRIGHT);
  push("License", TAG_LICENSE);
  push("Support", TAG_SUPPORT_CONTACT);
  push("Support policy", TAG_SUPPORT_POLICY_URL);
  if (rows.length === 0) return null;

  return (
    <>
      <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mt-6 mb-2">About</h2>
      <div className="border rounded-md overflow-hidden mb-4 bg-card shadow-sm">
        <table className="text-sm w-full" style={{ tableLayout: "auto" }}>
          <tbody>
            {rows.map(({ label, value }) => (
              <tr key={label} className="border-t border-border first:border-t-0">
                <td className="px-3 py-1.5 font-medium text-muted-foreground whitespace-nowrap align-top" style={{ width: "1%" }}>{label}</td>
                <td className="px-3 py-1.5 text-foreground/90"><ValueLink value={value} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
