import { Database, Folder } from "lucide-react";
import { getColorForType } from "./CatalogIcons";
import { ConnectBox } from "@/components/ConnectBox";
import { useSettings } from "@/lib/settings";
import type { CatalogData } from "@/lib/service";
import type { Selection } from "@/lib/tree";
import { CatalogListItem } from "./CatalogListItem";
import { TagsTable } from "./TagsTable";
import { filterDisplayTags, getTag, parseKeywords, TAG_DOC_MD, TAG_TITLE } from "@/lib/tags";
import { DescriptionSection } from "./DescriptionSection";
import { MetaChips } from "./MetaChips";
import { ProvenanceCard } from "./ProvenanceCard";
import { useCatalogIdentity } from "@/lib/catalog-identity";
import { CatalogIdentityCard } from "./CatalogIdentityCard";

interface Props {
  catalog: CatalogData;
  serviceUrl: string;
  attachOptions?: string;
  onNavigate: (selection: Selection) => void;
}

export function CatalogOverview({ catalog, serviceUrl, attachOptions, onNavigate }: Props) {
  const { settings } = useSettings();
  const { identity, loading: identityLoading } = useCatalogIdentity(catalog.catalogName, serviceUrl);
  const totalTables = catalog.schemas.reduce((sum, s) => {
    if (settings.hideDollarTables) {
      return sum + s.tables.filter((t) => !t.name.includes("$")).length;
    }
    return sum + s.tables.length;
  }, 0);
  const totalViews = catalog.schemas.reduce((sum, s) => sum + s.views.length, 0);
  const totalFunctions = catalog.schemas.reduce((sum, s) => {
    if (settings.hideTableBackingFunctions) {
      const tableNames = new Set(s.tables.map((t) => t.name));
      return sum + s.functions.filter((f) => !tableNames.has(f.name)).length;
    }
    return sum + s.functions.length;
  }, 0);

  const title = getTag(catalog.catalogTags, TAG_TITLE);
  const docMd = getTag(catalog.catalogTags, TAG_DOC_MD);
  const keywords = parseKeywords(catalog.catalogTags);

  return (
    <div>
      <div className="flex items-center gap-3 mb-6">
        <Database className="h-8 w-8 text-primary" />
        <div>
          <h1 className="text-2xl font-bold text-primary">{title || catalog.catalogName}</h1>
          {title && <p className="text-xs font-mono text-muted-foreground/70">{catalog.catalogName}</p>}
          <p className="text-sm text-muted-foreground">
            {catalog.schemas.length} schemas, {totalTables} tables
            {totalViews > 0 && `, ${totalViews} views`}
            {totalFunctions > 0 && `, ${totalFunctions} functions`}
          </p>
        </div>
      </div>

      {catalog.catalogComment && (
        <p className="text-muted-foreground mb-6">{catalog.catalogComment}</p>
      )}

      {docMd && <DescriptionSection markdown={docMd} defaultOpen />}

      <MetaChips keywords={keywords} />

      <CatalogIdentityCard identity={identity} loading={identityLoading} />

      <ConnectBox catalogName={catalog.catalogName} serviceUrl={serviceUrl} attachOptions={attachOptions} />

      {catalog.schemas.length > 0 && (
        <>
          <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground mb-3 mt-8">
            Schemas
          </h2>
          <div className="grid gap-2">
            {catalog.schemas.map((s) => {
              const tableCount = settings.hideDollarTables
                ? s.tables.filter((t) => !t.name.includes("$")).length
                : s.tables.length;
              const counts = [
                `${tableCount} tables`,
                s.views.length > 0 ? `${s.views.length} views` : null,
              ].filter(Boolean).join(", ");
              return (
                <CatalogListItem
                  key={s.info.name}
                  icon={Folder}
                  iconClassName={getColorForType("schema")}
                  title={s.info.name}
                  description={s.info.comment || undefined}
                  badge={s.info.name === catalog.defaultSchema ? "default" : undefined}
                  rightLabel={counts}
                  onClick={() => onNavigate({ type: "schema", name: s.info.name, schema: s.info.name })}
                />
              );
            })}
          </div>
        </>
      )}

      <ProvenanceCard tags={catalog.catalogTags} />

      {(() => {
        const filtered = filterDisplayTags(catalog.catalogTags);
        return filtered ? <TagsTable tags={filtered} /> : null;
      })()}
    </div>
  );
}
