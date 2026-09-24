import { DEFAULT_APPEARANCE, REPORT_THEMES, type ReportAppearance } from '../../lib/evidence/appearance';
import { Button } from '../ui/button';
import type { ReportTheme } from '../../lib/evidence/report-theme';

export function EvidenceAppearance({ value = DEFAULT_APPEARANCE, onChange, theme }: {
  value?: ReportAppearance; onChange: (value: ReportAppearance) => void; theme: ReportTheme;
}) {
  const update = (patch: Partial<ReportAppearance>) => onChange({ ...value, ...patch });
  const selectClass = 'block h-9 w-full rounded-lg border border-input bg-background px-2 text-sm';
  return <section aria-label="Report appearance" className="space-y-5 text-sm">
    <div><h3 className="font-medium">Report appearance</h3><p className="mt-1 text-xs text-muted-foreground">Changes appear immediately. Save the report to keep them.</p></div>
    <label className="block space-y-1 text-xs font-medium">Theme<select aria-label="Report theme" className={selectClass} value={value.theme} onChange={event => update({ theme: event.target.value as ReportAppearance['theme'] })}>{REPORT_THEMES.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
    <p className="text-xs text-muted-foreground">{REPORT_THEMES.find(item => item.id === value.theme)?.description}</p>
    <label className="block space-y-1 text-xs font-medium">Appearance<select aria-label="Report color mode" className={selectClass} value={value.mode} onChange={event => update({ mode: event.target.value as ReportAppearance['mode'] })}><option value="app">Follow app</option><option value="light">Light</option><option value="dark">Dark</option></select></label>
    <label className="block space-y-1 text-xs font-medium">Chart palette<select aria-label="Report chart palette" className={selectClass} value={value.palette} onChange={event => update({ palette: event.target.value as ReportAppearance['palette'] })}><option value="theme">Theme default</option><option value="ocean">Ocean</option><option value="earth">Earth</option><option value="accessible">Colorblind-friendly</option></select></label>
    <div className="flex gap-1" aria-label="Chart palette preview">{theme.config.colorPalettes.default.light.map((color, index) => <span key={index} className="h-5 flex-1 rounded border border-black/10" style={{ backgroundColor: color }} title={color} />)}</div>
    <div className="flex flex-wrap items-center gap-3"><label className="flex items-center gap-2 text-xs font-medium">Accent<input aria-label="Report accent color" type="color" className="h-8 w-12 cursor-pointer rounded border border-input" value={value.accent ?? String((theme.style as Record<string, unknown>)['--primary'])} onChange={event => update({ accent: event.target.value })} /></label>{value.accent && <Button variant="ghost" size="sm" onClick={() => update({ accent: undefined })}>Use theme accent</Button>}</div>
    <div className="grid grid-cols-2 gap-3">{(['heading', 'body'] as const).map(key => <label key={key} className="block space-y-1 text-xs font-medium">{key === 'heading' ? 'Heading font' : 'Body font'}<select aria-label={`Report ${key} font`} className={selectClass} value={value[key]} onChange={event => update({ [key]: event.target.value })}><option value="theme">Theme default</option><option value="sans-serif">Sans serif</option><option value="serif">Serif</option><option value="mono">Monospace</option></select></label>)}</div>
    <label className="block space-y-1 text-xs font-medium">Spacing<select aria-label="Report spacing" className={selectClass} value={value.density} onChange={event => update({ density: event.target.value as ReportAppearance['density'] })}><option value="theme">Theme default</option><option value="compact">Compact</option><option value="comfortable">Comfortable</option></select></label>
    <Button variant="outline" size="sm" onClick={() => onChange({ ...DEFAULT_APPEARANCE })}>Reset appearance</Button>
  </section>;
}
