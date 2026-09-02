import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Settings, Database, TerminalSquare, Bot, FileCode2 } from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { useSettings, DEFAULT_AI_MODEL } from "@/lib/settings";
import { resolveThreadCount } from "@/lib/duckdb-worker-boot";
import { useMediaQuery } from "@/lib/use-media-query";

function SettingRow({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={`flex items-center justify-between gap-3 sm:gap-6 py-3 ${className ?? ""}`}>
      {children}
    </div>
  );
}

function SettingLabel({ title, description, htmlFor }: { title: string; description: string; htmlFor?: string }) {
  return (
    /* items-start is load-bearing: the base Label class is `flex items-center`,
       and adding flex-col here turns that into horizontal centring, so every
       title and description in this dialog was centred. It was merely less
       obvious at the old 580px width. */
    <Label htmlFor={htmlFor} className="flex flex-col items-start gap-1 text-left cursor-pointer min-w-0 flex-1">
      <span className="font-medium text-sm">{title}</span>
      <span className="text-xs text-muted-foreground font-normal leading-relaxed max-w-[58ch]">{description}</span>
    </Label>
  );
}

const AI_MODELS: { value: string; label: string }[] = [
  { value: "claude-haiku-4-5-20251001", label: "Haiku (fast)" },
  { value: "claude-sonnet-4-6", label: "Sonnet (balanced)" },
  { value: "claude-opus-4-8", label: "Opus (best)" },
];

export function SettingsModal() {
  const { settings, updateSettings } = useSettings();
  const selectedModel = AI_MODELS.find(m => m.value === settings.aiModel);
  const isNarrow = useMediaQuery("(max-width: 639px)");

  return (
    <Dialog>
      <DialogTrigger className="flex items-center gap-2 w-full px-3 py-2 text-sm text-muted-foreground hover:text-foreground transition-colors cursor-pointer">
        <Settings className="h-4 w-4" />
        Settings
      </DialogTrigger>
      {/*
        Fixed height, not max-height. The four sections differ a lot in length,
        and on a purely intrinsic height the dialog jumped every time you
        switched — the footer button moved out from under the cursor. A stable
        frame with only the panel scrolling keeps the header and the Done
        button in one place.
      */}
      <DialogContent className="sm:max-w-[760px] w-full h-[min(560px,90dvh)] p-0 grid grid-rows-[auto_minmax(0,1fr)_auto] gap-0 overflow-hidden">
        <DialogHeader className="px-5 py-4 border-b border-border">
          <DialogTitle className="flex items-center gap-2">
            <Settings className="h-5 w-5 text-primary" />
            Settings
          </DialogTitle>
        </DialogHeader>

        <Tabs defaultValue="display" orientation={isNarrow ? "horizontal" : "vertical"} className="min-h-0 gap-0 flex-col sm:flex-row">
          {/* Left rail. A vertical list is the convention for settings once
              there is more than a handful of groups (VS Code, Slack, macOS),
              and unlike top tabs it has room to grow without wrapping. */}
          <TabsList
            variant="line"
            className="w-full sm:w-[168px] shrink-0 group-data-vertical/tabs:h-full items-stretch justify-start gap-0.5 p-2 border-b sm:border-b-0 sm:border-r border-border bg-muted/40 rounded-none overflow-x-auto sm:overflow-y-auto"
          >
            <TabsTrigger value="display" className="gap-2 justify-start sm:w-full flex-none h-auto px-2.5 py-2 text-foreground">
              <Database className="h-3.5 w-3.5 shrink-0" />
              Display
            </TabsTrigger>
            <TabsTrigger value="shell" className="gap-2 justify-start sm:w-full flex-none h-auto px-2.5 py-2 text-foreground">
              <TerminalSquare className="h-3.5 w-3.5 shrink-0" />
              Shell
            </TabsTrigger>
            <TabsTrigger value="editor" className="gap-2 justify-start sm:w-full flex-none h-auto px-2.5 py-2 text-foreground">
              <FileCode2 className="h-3.5 w-3.5 shrink-0" />
              Editor
            </TabsTrigger>
            <TabsTrigger value="ai" className="gap-2 justify-start sm:w-full flex-none h-auto px-2.5 py-2 text-foreground">
              <Bot className="h-3.5 w-3.5 shrink-0" />
              AI
            </TabsTrigger>
          </TabsList>

          {/* Display settings */}
          <TabsContent value="display" className="min-w-0 overflow-y-auto px-5 py-3">
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
              <SettingRow>
                <SettingLabel
                  htmlFor="hide-dollar-tables"
                  title="Hide tables with $ in name"
                  description="Hide tables whose name contains the $ character (often internal or system tables)."
                />
                <Switch
                  id="hide-dollar-tables"
                  checked={settings.hideDollarTables}
                  onCheckedChange={(checked) => updateSettings({ hideDollarTables: checked })}
                />
              </SettingRow>
              <SettingRow>
                <SettingLabel
                  htmlFor="geometry-as-text"
                  title="Show geometry as text"
                  description="Render geometry columns as WKT text instead of a clickable map preview."
                />
                <Switch
                  id="geometry-as-text"
                  checked={settings.geometryAsText}
                  onCheckedChange={(checked) => updateSettings({ geometryAsText: checked })}
                />
              </SettingRow>
              <SettingRow>
                <SettingLabel
                  htmlFor="number-grouping"
                  title="Group digits in numbers"
                  description="Separate thousands in numeric cells using your browser's locale (1,234,567). Affects the data grid only — copied cells and CSV/Excel exports stay unformatted so they paste and re-import cleanly."
                />
                <Switch
                  id="number-grouping"
                  checked={settings.numberGrouping}
                  onCheckedChange={(checked) => updateSettings({ numberGrouping: checked })}
                />
              </SettingRow>
            </div>
          </TabsContent>

          {/* Shell settings */}
          <TabsContent value="shell" className="min-w-0 overflow-y-auto px-5 py-3">
            <div className="divide-y divide-border">
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

          {/* SQL Editor settings */}
          <TabsContent value="editor" className="min-w-0 overflow-y-auto px-5 py-3">
            <div className="divide-y divide-border">
              <SettingRow>
                <SettingLabel
                  title="Font size"
                  description="Font size for the DBeaver-style SQL query editor."
                />
                <Select
                  value={String(settings.editorFontSize)}
                  onValueChange={(val) => updateSettings({ editorFontSize: Number(val) })}
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
                  title="Autocomplete"
                  htmlFor="editor-autocomplete"
                  description="Suggest keywords, tables, and columns as you type (uses DuckDB's sql_auto_complete)."
                />
                <Switch
                  id="editor-autocomplete"
                  checked={settings.editorAutocomplete}
                  onCheckedChange={(checked) => updateSettings({ editorAutocomplete: checked })}
                />
              </SettingRow>
            </div>
          </TabsContent>

          {/* AI settings */}
          <TabsContent value="ai" className="min-w-0 overflow-y-auto px-5 py-3">
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
              <div className="py-3">
                <SettingLabel
                  title="Anthropic Workspace ID"
                  htmlFor="anthropic-workspace-id"
                  description="Required only for identity-linked keys with access to multiple workspaces. Find the wrkspc_… ID under Anthropic Console → Settings → Workspaces."
                />
                <Input
                  id="anthropic-workspace-id"
                  type="text"
                  placeholder="wrkspc_… (optional)"
                  value={settings.anthropicWorkspaceId}
                  onChange={(e) => updateSettings({ anthropicWorkspaceId: e.target.value.trim() })}
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
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
                  // base-ui emits null when the selection is cleared; the
                  // setting is a plain string, so fall back to the default.
                  onValueChange={(val) => updateSettings({ aiModel: val ?? DEFAULT_AI_MODEL })}
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
              <SettingRow>
                <SettingLabel
                  title="Max response tokens"
                  description="Output cap per AI request. Lower saves cost; too low truncates long answers and charts. Clamped to the selected model's limit."
                />
                <Select
                  value={String(settings.aiMaxTokens)}
                  onValueChange={(val) => updateSettings({ aiMaxTokens: Number(val) })}
                >
                  <SelectTrigger className="w-24 h-8 text-sm shrink-0">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {[4096, 8192, 16384, 32768, 64000].map((n) => (
                      <SelectItem key={n} value={String(n)} className="text-sm">
                        {n.toLocaleString()}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </SettingRow>
              <SettingRow>
                <SettingLabel
                  htmlFor="ai-telemetry"
                  title="Share AI conversation analytics"
                  description="Allow prompts, responses, and tool inputs to be sent to Sentry. Token, cache, timing, model, and tool-name metrics may still be recorded without report or query content."
                />
                <Switch
                  id="ai-telemetry"
                  checked={settings.aiTelemetry}
                  onCheckedChange={(checked) => updateSettings({ aiTelemetry: checked })}
                />
              </SettingRow>
            </div>
          </TabsContent>
        </Tabs>

        {/*
          Settings are instant-apply — every control writes straight through to
          localStorage — so this commits nothing and is labelled "Done" rather
          than "Save". It exists because the only way out used to be a ghost
          ✕ in the corner, Esc, or a backdrop click, and people were missing
          all three. Filled and full-height so it cannot be missed.
        */}
        <div className="flex items-center justify-between gap-4 px-5 py-3 border-t border-border bg-muted/30">
          <p className="text-xs text-muted-foreground">Changes are saved as you make them.</p>
          <DialogClose
            render={<Button size="sm" className="h-8 px-5" data-testid="settings-done" />}
          >
            Done
          </DialogClose>
        </div>
      </DialogContent>
    </Dialog>
  );
}
