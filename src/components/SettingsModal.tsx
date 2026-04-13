import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Settings, Database, FunctionSquare, TerminalSquare, Bot } from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { useSettings } from "@/lib/settings";
import { resolveThreadCount } from "@/lib/duckdb-worker-boot";

function SettingRow({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={`flex items-center justify-between gap-6 py-3 ${className ?? ""}`}>
      {children}
    </div>
  );
}

function SettingLabel({ title, description, htmlFor }: { title: string; description: string; htmlFor?: string }) {
  return (
    <Label htmlFor={htmlFor} className="flex flex-col gap-1 cursor-pointer min-w-0 flex-1">
      <span className="font-medium text-sm">{title}</span>
      <span className="text-xs text-muted-foreground font-normal leading-relaxed">{description}</span>
    </Label>
  );
}

const AI_MODELS: { value: string; label: string }[] = [
  { value: "claude-haiku-4-5-20251001", label: "Haiku (fast)" },
  { value: "claude-sonnet-4-20250514", label: "Sonnet (balanced)" },
  { value: "claude-opus-4-20250514", label: "Opus (best)" },
];

export function SettingsModal() {
  const { settings, updateSettings } = useSettings();
  const selectedModel = AI_MODELS.find(m => m.value === settings.aiModel);

  return (
    <Dialog>
      <DialogTrigger className="flex items-center gap-2 w-full px-3 py-2 text-sm text-muted-foreground hover:text-foreground transition-colors cursor-pointer">
        <Settings className="h-4 w-4" />
        Settings
      </DialogTrigger>
      <DialogContent className="sm:max-w-[580px] max-h-[85vh] overflow-y-auto p-0">
        <DialogHeader className="px-6 pt-6 pb-0">
          <DialogTitle className="flex items-center gap-2">
            <Settings className="h-5 w-5 text-primary" />
            Settings
          </DialogTitle>
        </DialogHeader>

        <Tabs defaultValue="display" className="px-6 pb-6">
          <TabsList variant="line" className="w-full justify-start mb-4">
            <TabsTrigger value="display" className="gap-1.5">
              <Database className="h-3.5 w-3.5" />
              Display
            </TabsTrigger>
            <TabsTrigger value="shell" className="gap-1.5">
              <TerminalSquare className="h-3.5 w-3.5" />
              Shell
            </TabsTrigger>
            <TabsTrigger value="ai" className="gap-1.5">
              <Bot className="h-3.5 w-3.5" />
              AI
            </TabsTrigger>
          </TabsList>

          {/* Display settings */}
          <TabsContent value="display">
            <div className="divide-y divide-border">
              <SettingRow>
                <SettingLabel
                  htmlFor="duckdb-types"
                  title="Show DuckDB types"
                  description="Display DuckDB type names (VARCHAR, INTEGER) instead of Arrow types (Utf8, Int32)."
                />
                <Switch
                  id="duckdb-types"
                  checked={settings.showDuckDBTypes}
                  onCheckedChange={(checked) => updateSettings({ showDuckDBTypes: checked })}
                />
              </SettingRow>
              <SettingRow>
                <SettingLabel
                  htmlFor="hide-backing-funcs"
                  title="Hide table-backing functions"
                  description="Hide functions that share the same name as a table in the same schema."
                />
                <Switch
                  id="hide-backing-funcs"
                  checked={settings.hideTableBackingFunctions}
                  onCheckedChange={(checked) => updateSettings({ hideTableBackingFunctions: checked })}
                />
              </SettingRow>
            </div>
          </TabsContent>

          {/* Shell settings */}
          <TabsContent value="shell">
            <div className="divide-y divide-border">
              <SettingRow>
                <SettingLabel
                  htmlFor="auto-restore"
                  title="Auto-restore previous session"
                  description="Restore the last saved DuckDB session when opening the shell. You can still restore manually with .sessions."
                />
                <Switch
                  id="auto-restore"
                  checked={settings.autoRestoreSession}
                  onCheckedChange={(checked) => updateSettings({ autoRestoreSession: checked })}
                />
              </SettingRow>
              <SettingRow>
                <SettingLabel
                  title="Font size"
                  description="Terminal font size in the SQL shell."
                />
                <Select
                  value={String(settings.shellFontSize)}
                  onValueChange={(val) => updateSettings({ shellFontSize: Number(val) })}
                >
                  <SelectTrigger className="w-20 h-8 text-sm shrink-0">
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
              </SettingRow>
              <SettingRow>
                <SettingLabel
                  title="Worker threads"
                  description="Threads for DuckDB query execution. Auto uses 1 for Safari, max for other browsers. Requires restart."
                />
                <Select
                  value={settings.shellThreads === 0 ? "auto" : String(settings.shellThreads)}
                  onValueChange={(val) => updateSettings({ shellThreads: val === "auto" ? 0 : Number(val) })}
                >
                  <SelectTrigger className="w-24 h-8 text-sm shrink-0">
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
              </SettingRow>
              <div className="pt-3">
                <div
                  className="rounded-lg bg-terminal-bg px-4 py-2.5 text-terminal-fg overflow-hidden"
                  style={{ fontFamily: "'JetBrains Mono', 'SF Mono', monospace", fontSize: `${settings.shellFontSize}px`, lineHeight: 1.5 }}
                >
                  <span className="text-terminal-accent">D</span> &gt; SELECT * FROM parcels LIMIT 5;
                </div>
              </div>
            </div>
          </TabsContent>

          {/* AI settings */}
          <TabsContent value="ai">
            <div className="divide-y divide-border">
              <div className="pb-3">
                <SettingLabel
                  title="Anthropic API Key"
                  description="Your key is stored locally in the browser only. Use a key with spend limits."
                />
                <Input
                  type="password"
                  placeholder="sk-ant-..."
                  value={settings.anthropicApiKey}
                  onChange={(e) => updateSettings({ anthropicApiKey: e.target.value })}
                  className="font-mono text-sm mt-2"
                />
              </div>
              <SettingRow>
                <SettingLabel
                  title="Model"
                  description="Choose between speed, cost, and quality."
                />
                <Select
                  value={settings.aiModel}
                  onValueChange={(val) => updateSettings({ aiModel: val })}
                >
                  <SelectTrigger className="w-44 h-8 text-sm shrink-0">
                    <span className="truncate">{selectedModel?.label ?? settings.aiModel}</span>
                  </SelectTrigger>
                  <SelectContent>
                    {AI_MODELS.map(m => (
                      <SelectItem key={m.value} value={m.value} className="text-sm">{m.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </SettingRow>
              <SettingRow>
                <SettingLabel
                  title="Max tool rounds"
                  description="How many SQL queries the AI can run per question."
                />
                <Select
                  value={String(settings.aiMaxToolRounds)}
                  onValueChange={(val) => updateSettings({ aiMaxToolRounds: Number(val) })}
                >
                  <SelectTrigger className="w-20 h-8 text-sm shrink-0">
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
              </SettingRow>
            </div>
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}
