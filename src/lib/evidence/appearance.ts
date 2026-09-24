import { z } from 'zod';

export const appearanceSchema = z.object({
  theme: z.enum(['cupola', 'paper', 'ocean', 'forest']).default('cupola'),
  mode: z.enum(['app', 'light', 'dark']).default('app'),
  palette: z.enum(['theme', 'ocean', 'earth', 'accessible']).default('theme'),
  accent: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  heading: z.enum(['theme', 'sans-serif', 'serif', 'mono']).default('theme'),
  body: z.enum(['theme', 'sans-serif', 'serif', 'mono']).default('theme'),
  density: z.enum(['theme', 'compact', 'comfortable']).default('theme'),
}).strict();
export type ReportAppearance = z.infer<typeof appearanceSchema>;
export const DEFAULT_APPEARANCE = appearanceSchema.parse({});
export const REPORT_THEMES = [
  { id: 'cupola', name: 'Match Cupola', description: 'Use the platform’s colors and typography.' },
  { id: 'paper', name: 'Financial paper', description: 'Neutral page, serif headings and compact tables.' },
  { id: 'ocean', name: 'Ocean', description: 'Cool blue accents and clean sans-serif typography.' },
  { id: 'forest', name: 'Forest', description: 'Warm paper, green accents and relaxed spacing.' },
] as const;
