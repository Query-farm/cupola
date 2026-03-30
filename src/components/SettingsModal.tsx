import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Settings, Database, FunctionSquare } from "lucide-react";
import { useSettings } from "@/lib/settings";

export function SettingsModal() {
  const { settings, updateSettings } = useSettings();

  return (
    <Dialog>
      <DialogTrigger className="flex items-center gap-2 w-full px-3 py-2 text-sm text-muted-foreground hover:text-foreground transition-colors cursor-pointer">
        <Settings className="h-4 w-4" />
        Settings
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Settings className="h-5 w-5 text-primary" />
            Settings
          </DialogTitle>
          <DialogDescription>
            Configure how catalog metadata is displayed.
          </DialogDescription>
        </DialogHeader>

        <Separator />

        <div className="space-y-6 py-2">
          {/* Type Display */}
          <div className="space-y-3">
            <h3 className="text-sm font-semibold flex items-center gap-2">
              <Database className="h-4 w-4 text-muted-foreground" />
              Type Display
            </h3>
            <div className="flex items-start justify-between gap-4 rounded-lg border border-border p-4">
              <Label htmlFor="duckdb-types" className="flex flex-col gap-1.5 cursor-pointer">
                <span className="font-medium">Show DuckDB types</span>
                <span className="text-xs text-muted-foreground font-normal leading-relaxed">
                  Display DuckDB type names like <code className="bg-muted px-1 rounded text-xs">VARCHAR</code>, <code className="bg-muted px-1 rounded text-xs">INTEGER</code>, <code className="bg-muted px-1 rounded text-xs">GEOMETRY</code> instead
                  of Arrow types like <code className="bg-muted px-1 rounded text-xs">Utf8</code>, <code className="bg-muted px-1 rounded text-xs">Int32</code>, <code className="bg-muted px-1 rounded text-xs">Binary</code>.
                </span>
              </Label>
              <Switch
                id="duckdb-types"
                checked={settings.showDuckDBTypes}
                onCheckedChange={(checked) =>
                  updateSettings({ showDuckDBTypes: checked })
                }
              />
            </div>
          </div>

          {/* Catalog Display */}
          <div className="space-y-3">
            <h3 className="text-sm font-semibold flex items-center gap-2">
              <FunctionSquare className="h-4 w-4 text-muted-foreground" />
              Catalog Display
            </h3>
            <div className="flex items-start justify-between gap-4 rounded-lg border border-border p-4">
              <Label htmlFor="hide-backing-funcs" className="flex flex-col gap-1.5 cursor-pointer">
                <span className="font-medium">Hide table-backing functions</span>
                <span className="text-xs text-muted-foreground font-normal leading-relaxed">
                  Hide functions that share the same name as a table in the same schema.
                  These functions back the table and are typically not called directly.
                </span>
              </Label>
              <Switch
                id="hide-backing-funcs"
                checked={settings.hideTableBackingFunctions}
                onCheckedChange={(checked) =>
                  updateSettings({ hideTableBackingFunctions: checked })
                }
              />
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
