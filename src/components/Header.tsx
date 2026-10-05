import { ServiceSwitcher, type PickerCatalog, type WorkspaceActions } from "./ServiceSwitcher";
import { BrandMark } from "./BrandMark";
import type { Workspace } from "@/lib/workspace/store";

interface Props {
  workspace: Pick<Workspace, "id" | "name">;
  catalogs: PickerCatalog[];
  actions: WorkspaceActions;
}

/**
 * Top bar. Layout: [🚜 Query.Farm]   [workspace picker]
 *
 * This bar used to also carry the catalog's name and its comment. Both are
 * gone: the comment is the same string `CatalogOverview` prints under the
 * catalog title, and the name is already the root node of the sidebar tree.
 * The picker on the right says which catalogs are connected (multi-catalog
 * phase 2); who is signed in is now per catalog, inside it.
 */
export function Header({ workspace, catalogs, actions }: Props) {
  return (
    <header className="sticky top-0 z-40 flex items-center justify-between gap-4 px-4 h-14 border-b border-border bg-card/95 backdrop-blur-sm shadow-sm">
      <BrandMark />
      <ServiceSwitcher workspace={workspace} catalogs={catalogs} actions={actions} />
    </header>
  );
}
