import { useState, useMemo, useCallback, useRef } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Separator } from "@/components/ui/separator";
import { Copy, Check, Upload, RotateCcw, Download } from "lucide-react";

// ── Default values (from global.css :root) ──────────────────────────────────

const DEFAULT_COLORS: Record<string, string> = {
  background: "#faf8f0",
  foreground: "#2c2c1e",
  card: "#ffffff",
  "card-foreground": "#2c2c1e",
  popover: "#ffffff",
  "popover-foreground": "#2c2c1e",
  primary: "#2d5016",
  "primary-foreground": "#ffffff",
  secondary: "#f0ece0",
  "secondary-foreground": "#2c2c1e",
  muted: "#f0ece0",
  "muted-foreground": "#6b6b5a",
  accent: "#4a7c23",
  "accent-foreground": "#ffffff",
  destructive: "#8b0000",
  border: "#f0ece0",
  input: "#e0dcd0",
  ring: "#4a7c23",
  "chart-1": "#2d5016",
  "chart-2": "#4a7c23",
  "chart-3": "#c8a43a",
  "chart-4": "#6b6b5a",
  "chart-5": "#1a4a6b",
  sidebar: "#faf8f0",
  "sidebar-foreground": "#2c2c1e",
  "sidebar-primary": "#2d5016",
  "sidebar-primary-foreground": "#ffffff",
  "sidebar-accent": "#f0ece0",
  "sidebar-accent-foreground": "#2c2c1e",
  "sidebar-border": "#f0ece0",
  "sidebar-ring": "#4a7c23",
  "terminal-bg": "#1a1a0e",
  "terminal-fg": "#f5f0e0",
  "terminal-accent": "#6ba034",
  "terminal-muted": "#4a4a38",
};

const DEFAULT_TERMINAL = {
  background: "#1a1a0e",
  foreground: "#f5f0e0",
  cursor: "#6ba034",
  selection: "#3a3a28",
};

const DEFAULT_LOGO = `${import.meta.env.BASE_URL}logo-hero.png`;

// ── Color group definitions ─────────────────────────────────────────────────

interface ColorField {
  key: string;
  label: string;
}

const COLOR_GROUPS: { id: string; label: string; fields: ColorField[] }[] = [
  {
    id: "core",
    label: "Core",
    fields: [
      { key: "background", label: "Background" },
      { key: "foreground", label: "Foreground" },
      { key: "card", label: "Card" },
      { key: "card-foreground", label: "Card text" },
      { key: "popover", label: "Popover" },
      { key: "popover-foreground", label: "Popover text" },
    ],
  },
  {
    id: "brand",
    label: "Brand",
    fields: [
      { key: "primary", label: "Primary" },
      { key: "primary-foreground", label: "Primary text" },
      { key: "accent", label: "Accent" },
      { key: "accent-foreground", label: "Accent text" },
      { key: "secondary", label: "Secondary" },
      { key: "secondary-foreground", label: "Secondary text" },
    ],
  },
  {
    id: "ui",
    label: "UI",
    fields: [
      { key: "muted", label: "Muted" },
      { key: "muted-foreground", label: "Muted text" },
      { key: "destructive", label: "Destructive" },
      { key: "border", label: "Border" },
      { key: "input", label: "Input border" },
      { key: "ring", label: "Focus ring" },
    ],
  },
  {
    id: "sidebar",
    label: "Sidebar",
    fields: [
      { key: "sidebar", label: "Background" },
      { key: "sidebar-foreground", label: "Text" },
      { key: "sidebar-primary", label: "Primary" },
      { key: "sidebar-primary-foreground", label: "Primary text" },
      { key: "sidebar-accent", label: "Accent" },
      { key: "sidebar-accent-foreground", label: "Accent text" },
      { key: "sidebar-border", label: "Border" },
      { key: "sidebar-ring", label: "Focus ring" },
    ],
  },
  {
    id: "charts",
    label: "Charts",
    fields: [
      { key: "chart-1", label: "Chart 1" },
      { key: "chart-2", label: "Chart 2" },
      { key: "chart-3", label: "Chart 3" },
      { key: "chart-4", label: "Chart 4" },
      { key: "chart-5", label: "Chart 5" },
    ],
  },
  {
    id: "terminal",
    label: "Terminal",
    fields: [
      { key: "terminal-bg", label: "Background" },
      { key: "terminal-fg", label: "Text" },
      { key: "terminal-accent", label: "Accent" },
      { key: "terminal-muted", label: "Muted" },
    ],
  },
];

// ── Component ───────────────────────────────────────────────────────────────

export function ThemeBuilder() {
  const [colors, setColors] = useState<Record<string, string>>({ ...DEFAULT_COLORS });
  const [name, setName] = useState("");
  const [logo, setLogo] = useState("");
  const [copied, setCopied] = useState(false);
  const importRef = useRef<HTMLInputElement>(null);

  const setColor = useCallback((key: string, value: string) => {
    setColors((prev) => ({ ...prev, [key]: value }));
  }, []);

  const resetAll = useCallback(() => {
    setColors({ ...DEFAULT_COLORS });
    setName("");
    setLogo("");
  }, []);

  // Build the output JSON
  const themeJson = useMemo(() => {
    // Only include colors that differ from defaults
    const changedColors: Record<string, string> = {};
    for (const [k, v] of Object.entries(colors)) {
      if (v !== DEFAULT_COLORS[k]) changedColors[k] = v;
    }

    const terminal: Record<string, string> = {};
    if (colors["terminal-bg"] !== DEFAULT_COLORS["terminal-bg"])
      terminal.background = colors["terminal-bg"];
    if (colors["terminal-fg"] !== DEFAULT_COLORS["terminal-fg"])
      terminal.foreground = colors["terminal-fg"];
    if (colors["terminal-accent"] !== DEFAULT_COLORS["terminal-accent"])
      terminal.cursor = colors["terminal-accent"];
    if (colors["terminal-muted"] !== DEFAULT_COLORS["terminal-muted"])
      terminal.selection = colors["terminal-muted"];

    const obj: Record<string, any> = {};
    if (name) obj.name = name;
    if (logo) obj.logo = logo;
    if (Object.keys(changedColors).length > 0) obj.colors = changedColors;
    if (Object.keys(terminal).length > 0) obj.terminal = terminal;

    if (Object.keys(obj).length === 0) return "{}";
    return JSON.stringify(obj, null, 2);
  }, [colors, name, logo]);

  const copyJson = useCallback(() => {
    navigator.clipboard.writeText(themeJson);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [themeJson]);

  const downloadJson = useCallback(() => {
    const blob = new Blob([themeJson], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${name || "theme"}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }, [themeJson, name]);

  const importJson = useCallback((text: string) => {
    try {
      const raw = JSON.parse(text);
      if (raw.name) setName(raw.name);
      if (raw.logo) setLogo(raw.logo);
      const importedColors = raw.colors ?? (raw.name || raw.logo || raw.terminal ? {} : raw);
      setColors((prev) => {
        const next = { ...DEFAULT_COLORS };
        for (const [k, v] of Object.entries(importedColors)) {
          if (k in next && typeof v === "string") next[k] = v;
        }
        // Map terminal section back to CSS variable names
        if (raw.terminal) {
          if (raw.terminal.background) next["terminal-bg"] = raw.terminal.background;
          if (raw.terminal.foreground) next["terminal-fg"] = raw.terminal.foreground;
          if (raw.terminal.cursor) next["terminal-accent"] = raw.terminal.cursor;
          if (raw.terminal.selection) next["terminal-muted"] = raw.terminal.selection;
        }
        return next;
      });
    } catch {
      alert("Invalid JSON");
    }
  }, []);

  const handleFileImport = useCallback(() => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".json,application/json";
    input.onchange = async () => {
      const file = input.files?.[0];
      if (file) importJson(await file.text());
    };
    input.click();
  }, [importJson]);

  // Scoped CSS variables for the preview
  const previewStyle = useMemo(() => {
    const style: Record<string, string> = {};
    for (const [k, v] of Object.entries(colors)) {
      style[`--${k}`] = v;
    }
    return style;
  }, [colors]);

  const logoUrl = logo || DEFAULT_LOGO;

  return (
    <div className="flex flex-col h-screen bg-background text-foreground overflow-hidden">
      {/* Top bar */}
      <header className="flex items-center justify-between px-4 py-3 border-b border-border bg-card shrink-0">
        <div className="flex items-center gap-3">
          <img
            src={DEFAULT_LOGO}
            alt="VGI"
            className="w-7 h-7 rounded-full"
          />
          <h1 className="font-semibold text-primary text-lg">Theme Builder</h1>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={handleFileImport}>
            <Upload className="size-3.5" data-icon="inline-start" />
            Import
          </Button>
          <Button variant="outline" size="sm" onClick={downloadJson}>
            <Download className="size-3.5" data-icon="inline-start" />
            Download
          </Button>
          <Button variant="outline" size="sm" onClick={resetAll}>
            <RotateCcw className="size-3.5" data-icon="inline-start" />
            Reset
          </Button>
        </div>
      </header>

      {/* Main content */}
      <div className="flex flex-1 overflow-hidden">
        {/* Left: Controls */}
        <div className="w-[380px] shrink-0 border-r border-border overflow-y-auto p-4 space-y-4">
          {/* Name and logo */}
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="theme-name">Theme name</Label>
              <Input
                id="theme-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="My Theme"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="theme-logo">Logo URL</Label>
              <Input
                id="theme-logo"
                value={logo}
                onChange={(e) => setLogo(e.target.value)}
                placeholder={DEFAULT_LOGO}
              />
            </div>
          </div>

          <Separator />

          {/* Color groups */}
          <Tabs defaultValue="core">
            <TabsList className="w-full flex-wrap h-auto gap-1">
              {COLOR_GROUPS.map((g) => (
                <TabsTrigger key={g.id} value={g.id} className="text-xs px-2">
                  {g.label}
                </TabsTrigger>
              ))}
            </TabsList>
            {COLOR_GROUPS.map((group) => (
              <TabsContent key={group.id} value={group.id}>
                <div className="grid grid-cols-2 gap-3 pt-3">
                  {group.fields.map((field) => (
                    <ColorPicker
                      key={field.key}
                      label={field.label}
                      value={colors[field.key]}
                      defaultValue={DEFAULT_COLORS[field.key]}
                      onChange={(v) => setColor(field.key, v)}
                    />
                  ))}
                </div>
              </TabsContent>
            ))}
          </Tabs>
        </div>

        {/* Right: Preview + JSON */}
        <div className="flex-1 overflow-y-auto p-6 space-y-6">
          {/* Live Preview */}
          <div>
            <h2 className="text-sm font-medium text-muted-foreground mb-3">Live Preview</h2>
            <div
              className="rounded-xl border border-border overflow-hidden shadow-sm"
              style={previewStyle}
            >
              <PreviewPanel logoUrl={logoUrl} colors={colors} />
            </div>
          </div>

          {/* JSON output */}
          <div>
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-sm font-medium text-muted-foreground">theme.json</h2>
              <Button variant="outline" size="sm" onClick={copyJson}>
                {copied ? (
                  <Check className="size-3.5" data-icon="inline-start" />
                ) : (
                  <Copy className="size-3.5" data-icon="inline-start" />
                )}
                {copied ? "Copied" : "Copy"}
              </Button>
            </div>
            <pre className="rounded-lg bg-muted p-4 text-xs font-mono overflow-x-auto max-h-80 whitespace-pre-wrap">
              {themeJson}
            </pre>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Color Picker ────────────────────────────────────────────────────────────

function ColorPicker({
  label,
  value,
  defaultValue,
  onChange,
}: {
  label: string;
  value: string;
  defaultValue: string;
  onChange: (value: string) => void;
}) {
  const isChanged = value !== defaultValue;

  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between">
        <Label className="text-xs">{label}</Label>
        {isChanged && (
          <button
            onClick={() => onChange(defaultValue)}
            className="text-[10px] text-muted-foreground hover:text-foreground cursor-pointer"
            title="Reset to default"
          >
            reset
          </button>
        )}
      </div>
      <div className="flex items-center gap-1.5">
        <label
          className="w-8 h-8 rounded-md border border-input shrink-0 cursor-pointer overflow-hidden"
          style={{ backgroundColor: value }}
        >
          <input
            type="color"
            value={value}
            onChange={(e) => onChange(e.target.value)}
            className="opacity-0 w-0 h-0"
          />
        </label>
        <Input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="font-mono text-xs h-8"
          spellCheck={false}
        />
      </div>
    </div>
  );
}

// ── Preview Panel ───────────────────────────────────────────────────────────

function PreviewPanel({
  logoUrl,
  colors,
}: {
  logoUrl: string;
  colors: Record<string, string>;
}) {
  return (
    <div style={{ background: colors.background, color: colors.foreground }}>
      {/* Header */}
      <div
        className="flex items-center gap-3 px-4 py-2"
        style={{
          background: colors.card,
          color: colors["card-foreground"],
          borderBottom: `1px solid ${colors.border}`,
        }}
      >
        <img src={logoUrl} alt="" className="w-6 h-6 rounded-full" />
        <span
          className="font-semibold text-sm"
          style={{ color: colors.primary }}
        >
          my_catalog
        </span>
        <span
          className="text-xs"
          style={{ color: colors["muted-foreground"] }}
        >
          Example catalog
        </span>
      </div>

      <div className="flex" style={{ minHeight: 280 }}>
        {/* Sidebar */}
        <div
          className="w-44 shrink-0 p-3 text-xs space-y-1 overflow-hidden"
          style={{
            background: colors.sidebar,
            color: colors["sidebar-foreground"],
            borderRight: `1px solid ${colors["sidebar-border"]}`,
          }}
        >
          <div className="font-semibold text-xs mb-2" style={{ color: colors["sidebar-primary"] }}>
            Schemas
          </div>
          <SidebarItem colors={colors} label="public" active />
          <SidebarItem colors={colors} label="property" />
          <SidebarItem colors={colors} label="gis" />
          <div className="pt-2 font-semibold text-xs mb-1" style={{ color: colors["sidebar-primary"] }}>
            Tables
          </div>
          <SidebarItem colors={colors} label="parcels" />
          <SidebarItem colors={colors} label="owners" />
          <SidebarItem colors={colors} label="addresses" />
        </div>

        {/* Main content */}
        <div className="flex-1 p-4 space-y-4 overflow-hidden">
          {/* Card */}
          <div
            className="rounded-lg p-4 space-y-3"
            style={{
              background: colors.card,
              color: colors["card-foreground"],
              boxShadow: `0 0 0 1px ${colors.border}`,
            }}
          >
            <div className="font-semibold text-sm">parcels</div>
            <div className="text-xs" style={{ color: colors["muted-foreground"] }}>
              Land parcel boundaries and ownership records
            </div>

            {/* Mini table */}
            <div className="rounded-md overflow-hidden text-xs" style={{ border: `1px solid ${colors.border}` }}>
              <div className="grid grid-cols-3 gap-0" style={{ background: colors.muted }}>
                <div className="px-2 py-1.5 font-medium" style={{ color: colors["muted-foreground"] }}>Column</div>
                <div className="px-2 py-1.5 font-medium" style={{ color: colors["muted-foreground"] }}>Type</div>
                <div className="px-2 py-1.5 font-medium" style={{ color: colors["muted-foreground"] }}>Comment</div>
              </div>
              {[
                ["id", "INTEGER", "Primary key"],
                ["parcel_id", "VARCHAR", "County ID"],
                ["geom", "GEOMETRY", "Boundary"],
              ].map(([col, type, comment], i) => (
                <div
                  key={i}
                  className="grid grid-cols-3 gap-0"
                  style={{
                    background: colors.card,
                    borderTop: `1px solid ${colors.border}`,
                  }}
                >
                  <div className="px-2 py-1.5 font-mono" style={{ color: colors.foreground }}>{col}</div>
                  <div className="px-2 py-1.5">
                    <span
                      className="inline-block rounded px-1.5 py-0.5 text-[10px] font-medium"
                      style={{ background: colors.secondary, color: colors["secondary-foreground"] }}
                    >
                      {type}
                    </span>
                  </div>
                  <div className="px-2 py-1.5" style={{ color: colors["muted-foreground"] }}>{comment}</div>
                </div>
              ))}
            </div>
          </div>

          {/* Buttons and badges */}
          <div className="flex items-center gap-2 flex-wrap">
            <button
              className="px-3 py-1.5 rounded-lg text-xs font-medium"
              style={{ background: colors.primary, color: colors["primary-foreground"] }}
            >
              Primary
            </button>
            <button
              className="px-3 py-1.5 rounded-lg text-xs font-medium"
              style={{ background: colors.secondary, color: colors["secondary-foreground"] }}
            >
              Secondary
            </button>
            <button
              className="px-3 py-1.5 rounded-lg text-xs font-medium"
              style={{
                background: "transparent",
                color: colors.foreground,
                boxShadow: `inset 0 0 0 1px ${colors.border}`,
              }}
            >
              Outline
            </button>
            <button
              className="px-3 py-1.5 rounded-lg text-xs font-medium"
              style={{ background: colors.destructive + "1a", color: colors.destructive }}
            >
              Destructive
            </button>
            <span
              className="inline-block rounded-full px-2 py-0.5 text-[10px] font-medium"
              style={{ background: colors.primary, color: colors["primary-foreground"] }}
            >
              Badge
            </span>
            <span
              className="inline-block rounded-full px-2 py-0.5 text-[10px] font-medium"
              style={{ background: colors.accent, color: colors["accent-foreground"] }}
            >
              Accent
            </span>
          </div>

          {/* Input preview */}
          <div className="flex items-center gap-2">
            <div
              className="flex-1 h-8 rounded-lg px-2.5 flex items-center text-xs"
              style={{
                border: `1px solid ${colors.input}`,
                background: "transparent",
                color: colors["muted-foreground"],
              }}
            >
              Search tables...
            </div>
            <div
              className="h-8 w-8 rounded-lg flex items-center justify-center"
              style={{
                background: colors.accent,
                color: colors["accent-foreground"],
              }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="11" cy="11" r="8" /><path d="m21 21-4.3-4.3" />
              </svg>
            </div>
          </div>

          {/* Chart colors preview */}
          <div className="flex items-center gap-1.5">
            <span className="text-[10px] mr-1" style={{ color: colors["muted-foreground"] }}>Charts:</span>
            {["chart-1", "chart-2", "chart-3", "chart-4", "chart-5"].map((k) => (
              <div
                key={k}
                className="h-4 flex-1 rounded-sm first:rounded-l-md last:rounded-r-md"
                style={{ background: colors[k] }}
                title={k}
              />
            ))}
          </div>
        </div>
      </div>

      {/* Terminal */}
      <div
        className="px-4 py-3 font-mono text-xs space-y-1"
        style={{
          background: colors["terminal-bg"],
          color: colors["terminal-fg"],
          borderTop: `1px solid ${colors.border}`,
        }}
      >
        <div>
          <span style={{ color: colors["terminal-accent"] }}>D</span>
          {" > "}SELECT * FROM parcels LIMIT 3;
        </div>
        <div style={{ color: colors["terminal-muted"] }}>
          {"┌──────┬────────────┬───────────┐"}
        </div>
        <div style={{ color: colors["terminal-muted"] }}>
          {"│"}<span style={{ color: colors["terminal-fg"] }}> id </span>
          {"│"}<span style={{ color: colors["terminal-fg"] }}> parcel_id  </span>
          {"│"}<span style={{ color: colors["terminal-fg"] }}> owner     </span>{"│"}
        </div>
        <div style={{ color: colors["terminal-muted"] }}>
          {"├──────┼────────────┼───────────┤"}
        </div>
        <div style={{ color: colors["terminal-muted"] }}>
          {"│"}<span style={{ color: colors["terminal-fg"] }}> 1  </span>
          {"│"}<span style={{ color: colors["terminal-fg"] }}> 060A-01-02 </span>
          {"│"}<span style={{ color: colors["terminal-fg"] }}> Smith, J  </span>{"│"}
        </div>
        <div style={{ color: colors["terminal-muted"] }}>
          {"└──────┴────────────┴───────────┘"}
        </div>
        <div>
          <span style={{ color: colors["terminal-accent"] }}>D</span>
          {" > "}
          <span
            className="inline-block w-2 h-3.5 align-text-bottom"
            style={{ background: colors["terminal-accent"] }}
          />
        </div>
      </div>
    </div>
  );
}

function SidebarItem({
  colors,
  label,
  active,
}: {
  colors: Record<string, string>;
  label: string;
  active?: boolean;
}) {
  return (
    <div
      className="px-2 py-1 rounded-md text-xs truncate"
      style={
        active
          ? {
              background: colors["sidebar-accent"],
              color: colors["sidebar-accent-foreground"],
            }
          : { color: colors["sidebar-foreground"] }
      }
    >
      {label}
    </div>
  );
}
