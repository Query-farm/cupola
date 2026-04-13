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
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { Settings, Database, FunctionSquare, TerminalSquare, Bot } from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useSettings } from "@/lib/settings";
import { resolveThreadCount } from "@/lib/duckdb-worker-boot";

export function SettingsModal() {
  const { settings, updateSettings } = useSettings();

  return (
    <Dialog>
      <DialogTrigger className="flex items-center gap-2 w-full px-3 py-2 text-sm text-muted-foreground hover:text-foreground transition-colors cursor-pointer">
        <Settings className="h-4 w-4" />
        Settings
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg max-h-[85vh] overflow-y-auto">
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

          {/* Shell */}
          <div className="space-y-3">
            <h3 className="text-sm font-semibold flex items-center gap-2">
              <TerminalSquare className="h-4 w-4 text-muted-foreground" />
              SQL Shell
            </h3>
            <div className="rounded-lg border border-border p-4 space-y-3">
              <div className="flex items-start justify-between gap-4">
                <Label htmlFor="auto-restore" className="flex flex-col gap-1.5 cursor-pointer">
                  <span className="font-medium">Auto-restore previous session</span>
                  <span className="text-xs text-muted-foreground font-normal leading-relaxed">
                    Automatically restore the last saved DuckDB session when opening the shell.
                    When off, the shell always starts fresh. You can still restore manually with <code className="bg-muted px-1 rounded text-xs">.sessions</code>.
                  </span>
                </Label>
                <Switch
                  id="auto-restore"
                  checked={settings.autoRestoreSession}
                  onCheckedChange={(checked) =>
                    updateSettings({ autoRestoreSession: checked })
                  }
                />
              </div>
              <div className="flex items-center justify-between gap-4">
                <Label className="flex flex-col gap-1.5">
                  <span className="font-medium">Font size</span>
                  <span className="text-xs text-muted-foreground font-normal">
                    Terminal font size in the DuckDB shell.
                  </span>
                </Label>
                <Select
                  value={String(settings.shellFontSize)}
                  onValueChange={(val) => updateSettings({ shellFontSize: Number(val) })}
                >
                  <SelectTrigger className="w-[80px] h-8 text-sm">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {[10, 11, 12, 13, 14, 15, 16, 18, 20].map((size) => (
                      <SelectItem key={size} value={String(size)} className="text-sm">
                        {size}px
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="flex items-center justify-between gap-4">
                <Label className="flex flex-col gap-1.5">
                  <span className="font-medium">Worker threads</span>
                  <span className="text-xs text-muted-foreground font-normal">
                    Number of threads for DuckDB query execution. Auto uses 1 for Safari, max for other browsers. Requires shell restart.
                  </span>
                </Label>
                <Select
                  value={settings.shellThreads === 0 ? "auto" : String(settings.shellThreads)}
                  onValueChange={(val) => updateSettings({ shellThreads: val === "auto" ? 0 : Number(val) })}
                >
                  <SelectTrigger className="w-[100px] h-8 text-sm">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="auto" className="text-sm">Auto ({resolveThreadCount(0)})</SelectItem>
                    <SelectItem value="1" className="text-sm">1</SelectItem>
                    <SelectItem value="2" className="text-sm">2</SelectItem>
                    <SelectItem value="4" className="text-sm">4</SelectItem>
                    <SelectItem value="8" className="text-sm">8</SelectItem>
                    {(navigator.hardwareConcurrency || 0) > 8 && (
                      <SelectItem value={String(navigator.hardwareConcurrency)} className="text-sm">{navigator.hardwareConcurrency}</SelectItem>
                    )}
                  </SelectContent>
                </Select>
              </div>
              <div
                className="rounded bg-terminal-bg px-3 py-2 text-terminal-fg overflow-hidden"
                style={{ fontFamily: "'JetBrains Mono', 'SF Mono', monospace", fontSize: `${settings.shellFontSize}px`, lineHeight: 1.4 }}
              >
                <span className="text-terminal-accent">D</span> &gt; SELECT * FROM parcels LIMIT 5;
              </div>
            </div>
          </div>

          {/* AI Assistant */}
          <div className="space-y-3">
            <h3 className="text-sm font-semibold flex items-center gap-2">
              <Bot className="h-4 w-4 text-muted-foreground" />
              AI Assistant
            </h3>
            <div className="rounded-lg border border-border p-4 space-y-3">
              <div className="space-y-2">
                <Label className="flex flex-col gap-1.5">
                  <span className="font-medium">Anthropic API Key</span>
                  <span className="text-xs text-muted-foreground font-normal">
                    Your key is stored locally only. Use a key with spend limits.
                  </span>
                </Label>
                <Input
                  type="password"
                  placeholder="sk-ant-..."
                  value={settings.anthropicApiKey}
                  onChange={(e) => updateSettings({ anthropicApiKey: e.target.value })}
                  className="font-mono text-sm"
                />
              </div>
              <div className="flex items-center justify-between gap-4">
                <Label className="flex flex-col gap-1.5">
                  <span className="font-medium">Model</span>
                  <span className="text-xs text-muted-foreground font-normal">
                    Choose between speed, cost, and quality.
                  </span>
                </Label>
                <Select
                  value={settings.aiModel}
                  onValueChange={(val) => updateSettings({ aiModel: val })}
                >
                  <SelectTrigger className="w-[160px] h-8 text-sm">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="claude-haiku-4-5-20251001" className="text-sm">Haiku (fast)</SelectItem>
                    <SelectItem value="claude-sonnet-4-20250514" className="text-sm">Sonnet (default)</SelectItem>
                    <SelectItem value="claude-opus-4-20250514" className="text-sm">Opus (best)</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="flex items-center justify-between gap-4">
                <Label className="flex flex-col gap-1.5">
                  <span className="font-medium">Max tool rounds</span>
                  <span className="text-xs text-muted-foreground font-normal">
                    How many SQL queries the AI can run per question.
                  </span>
                </Label>
                <Select
                  value={String(settings.aiMaxToolRounds)}
                  onValueChange={(val) => updateSettings({ aiMaxToolRounds: Number(val) })}
                >
                  <SelectTrigger className="w-[80px] h-8 text-sm">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {[5, 10, 20, 30, 50].map((n) => (
                      <SelectItem key={n} value={String(n)} className="text-sm">
                        {n}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
