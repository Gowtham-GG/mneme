// The theme registry. The CSS for each theme is a few hue knobs in src/index.css; this file lists them for the
// picker and resolves "match my device". Adding a theme = add knobs in index.css + one entry here (no migration:
// the database only checks the *shape* of the id).

export type ThemeId = 'amethyst' | 'sapphire' | 'jade' | 'ember' | 'crimson' | 'graphite' | 'slate' | 'lilac' | 'sand'
export type ThemePref = ThemeId | 'system'

export interface ThemeInfo {
  id: ThemeId
  label: string
  blurb: string
  dark: boolean
  /** [background glow, accent] for the picker preview */
  swatch: [string, string]
}

export const THEMES: ThemeInfo[] = [
  { id: 'amethyst', label: 'Amethyst', blurb: 'Deep violet', dark: true, swatch: ['#2a1745', '#a855f7'] },
  { id: 'sapphire', label: 'Sapphire', blurb: 'Midnight blue', dark: true, swatch: ['#10254a', '#3b8bf5'] },
  { id: 'jade', label: 'Jade', blurb: 'Forest green', dark: true, swatch: ['#0c2e2a', '#19d59a'] },
  { id: 'ember', label: 'Ember', blurb: 'Warm amber', dark: true, swatch: ['#33200f', '#f59a3d'] },
  { id: 'crimson', label: 'Crimson', blurb: 'Dark rose', dark: true, swatch: ['#3a1220', '#f0506e'] },
  { id: 'graphite', label: 'Graphite', blurb: 'Neutral charcoal', dark: true, swatch: ['#1c1f26', '#b7c3d9'] },
  { id: 'slate', label: 'Slate', blurb: 'Light, cool', dark: false, swatch: ['#e3e8fb', '#4a55d6'] },
  { id: 'lilac', label: 'Lilac', blurb: 'Light violet', dark: false, swatch: ['#eee4fb', '#8a45e0'] },
  { id: 'sand', label: 'Sand', blurb: 'Light, warm', dark: false, swatch: ['#f7ead9', '#c9611b'] },
]

export const DEFAULT_THEME: ThemeId = 'amethyst'
export const LIGHT_DEFAULT: ThemeId = 'slate'

const IDS = new Set<string>(THEMES.map((t) => t.id))

/** Accepts anything stored before (incl. the old 'light' / 'dark') and returns a valid pref. */
export function normalizePref(v: string | null | undefined): ThemePref {
  if (v === 'system') return 'system'
  if (v === 'light') return LIGHT_DEFAULT
  if (v === 'dark') return DEFAULT_THEME
  return v && IDS.has(v) ? (v as ThemeId) : DEFAULT_THEME
}

/** "system" → amethyst on a dark device, slate on a light one; concrete ids pass through. */
export function resolveTheme(pref: ThemePref, prefersDark: boolean): ThemeId {
  if (pref === 'system') return prefersDark ? DEFAULT_THEME : LIGHT_DEFAULT
  return pref
}
