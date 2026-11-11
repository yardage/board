/**
 * How the app looks, chosen in the settings of each computer. A theme is a set of values for the roles at the top of
 * `src/client/styles`. `default` and `vercel`, pure black with white text and accents, and `custom`, whose three colours the person picks, are worked out from three colours by
 * `derive`, so a person never has to know the roles; the default's are also written in `tokens.css`, so the
 * first drawing has them. `omarchy`, a Tokyo Night palette, is tuned by hand there, on `html[data-theme]`. The window's own frame, a report's sandboxed page and a ramp computed in the code can't read the stylesheet, so
 * what they need is here.
 */

export const THEMES = ['default', 'vercel', 'omarchy', 'custom'] as const
export type Theme = (typeof THEMES)[number]
export const isTheme = (value: unknown): value is Theme => (THEMES as readonly unknown[]).includes(value)

export type HandTuned = 'omarchy'
export const isHandTuned = (theme: Theme): theme is HandTuned => theme === 'omarchy'

/** A theme saved by a version before these names. */
export function themeOf(value: unknown): Theme | null {
  if (isTheme(value)) return value
  if (value === 'board') return 'omarchy'
  if (value === 'site' || value === 'ink') return 'default'
  return null
}

/** The three colours a theme is made of: the surface, what is written on it, and what can be clicked. */
export interface ThemeColours {
  bg: string
  text: string
  accent: string
}

export const PRESET_COLOURS: Record<Exclude<Theme, 'custom'>, ThemeColours> = {
  default: { bg: '#000005', text: '#f5f5f5', accent: '#00ffbf' },
  vercel: { bg: '#000000', text: '#ffffff', accent: '#ffffff' },
  omarchy: { bg: '#1a1b26', text: '#c0caf5', accent: '#7aa2f7' },
}

/**
 * What no choice of colours changes: states mean the same whatever the surface, and the charts are the validated hues, in
 * the order that passes on a near-black surface. They are not checked again for a surface a person picks.
 */
export const FIXED_ROLES = {
  '--green': '#9ece6a',
  '--amber': '#e0af68',
  '--danger': '#f7768e',
  '--chart-1': '#23a68c',
  '--chart-2': '#6188e6',
  '--chart-3': '#d67834',
  '--chart-4': '#3a9fd0',
  '--chart-5': '#dd5a7c',
  '--chart-6': '#a874e0',
} as const

/** What the system draws: the window before its page is there, and the buttons over the title row. */
export const WINDOW_COLOURS: Record<HandTuned, { background: string; symbols: string }> = {
  omarchy: { background: '#1a1b26', symbols: '#a9b1d6' },
}

const HEX = /^#[0-9a-f]{6}$/
const COLOUR_KEYS = ['bg', 'text', 'accent'] as const

const channels = (hex: string): [number, number, number] => {
  const value = Number.parseInt(hex.slice(1), 16)
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255]
}
const luminance = (hex: string) => {
  const [r, g, b] = channels(hex).map((one) => {
    const c = one / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}
export const contrast = (a: string, b: string) => {
  const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (high + 0.05) / (low + 0.05)
}
/** `amount` of `towards` in `from`. */
const mix = (from: string, towards: string, amount: number) => {
  const a = channels(from)
  const b = channels(towards)
  return `#${a.map((one, index) => Math.round(one + (b[index] - one) * amount).toString(16).padStart(2, '0')).join('')}`
}
const alpha = (hex: string, opacity: number) => `rgb(${channels(hex).join(' ')} / ${opacity})`

/** Why these colours can't make a theme, in the language of the screen; null if they can. */
export function themeProblem(value: unknown): string | null {
  const colours = value as Record<string, unknown> | null
  if (typeof colours !== 'object' || colours === null || !COLOUR_KEYS.every((key) => typeof colours[key] === 'string' && HEX.test(colours[key] as string))) return 'Couleur inconnue.'
  const { bg, text, accent } = colours as unknown as ThemeColours
  if (luminance(bg) > 0.12) return 'Le fond doit rester sombre : l’application n’a pas de thème clair.'
  if (contrast(text, bg) < 7) return 'Le texte doit trancher davantage sur le fond.'
  if (contrast(accent, bg) < 4.5) return 'L’accent doit trancher davantage sur le fond.'
  return null
}

export function parseColours(value: unknown): ThemeColours | null {
  if (themeProblem(value) !== null) return null
  const { bg, text, accent } = value as ThemeColours
  return { bg, text, accent }
}

export const coloursOf = (theme: Theme, custom: ThemeColours | null): ThemeColours => (theme === 'custom' ? (custom ?? PRESET_COLOURS.default) : PRESET_COLOURS[theme])

/** The roles of the stylesheet that follow from three colours: every grey is the surface and the text in some proportion. */
export function derive({ bg, text, accent }: ThemeColours): Record<string, string> {
  const dark = mix(bg, '#000000', 0.25)
  const sel = mix(bg, text, 0.13)
  return {
    '--bg': bg,
    '--bg-dark': dark,
    '--raised': mix(bg, text, 0.08),
    '--sel': sel,
    '--hover': alpha(sel, 0.55),
    '--scrim': alpha(dark, 0.7),
    '--rule': mix(bg, text, 0.28),
    '--hi': text,
    '--fg': mix(text, bg, 0.12),
    '--muted': mix(text, bg, 0.28),
    '--faint': mix(text, bg, 0.4),
    '--accent': accent,
    '--accent-fg': bg,
    '--blue': accent,
    '--agent-bg': dark,
    ...FIXED_ROLES,
  }
}

export function windowColours(theme: Theme, custom: ThemeColours | null): { background: string; symbols: string } {
  if (isHandTuned(theme)) return WINDOW_COLOURS[theme]
  const colours = coloursOf(theme, custom)
  return { background: colours.bg, symbols: derive(colours)['--fg'] }
}

/** One hue, from few to many: each passes dataviz's validator on its theme's surface. In hex, since text is chosen to sit on it. */
const STATUS_RAMPS = {
  blue: ['#184f95', '#256abf', '#3987e5', '#6da7ec', '#9ec5f4', '#cde2fb'],
  green: ['#1d5442', '#2a7059', '#3d8d73', '#62a98f', '#94c6b0', '#cbe3d8'],
} as const

export function statusRamp(): readonly string[] {
  const shown = typeof document === 'undefined' ? undefined : document.documentElement.dataset.theme
  return STATUS_RAMPS[shown === 'omarchy' ? 'blue' : 'green']
}

const STORED = 'theme'
const STORED_COLOURS = 'theme-colours'
const DERIVED_ROLES = Object.keys(derive(PRESET_COLOURS.default))

function paint(theme: Theme, custom: ThemeColours | null): void {
  const root = document.documentElement
  for (const role of DERIVED_ROLES) root.style.removeProperty(role)
  root.dataset.theme = theme
  if (isHandTuned(theme)) return
  for (const [role, value] of Object.entries(derive(coloursOf(theme, custom)))) root.style.setProperty(role, value)
}

/** Before the first drawing, so that the app doesn't flash in the other theme. */
export function applyStoredTheme(): void {
  const stored = themeOf(localStorage.getItem(STORED))
  if (!stored) return
  let custom: ThemeColours | null = null
  try {
    custom = parseColours(JSON.parse(localStorage.getItem(STORED_COLOURS) ?? 'null'))
  } catch {
    // A damaged copy is only a flash: the server's answer repaints.
  }
  paint(stored, custom)
}

export function applyTheme(theme: Theme, custom: ThemeColours | null): void {
  paint(theme, custom)
  localStorage.setItem(STORED, theme)
  localStorage.setItem(STORED_COLOURS, JSON.stringify(custom))
}
