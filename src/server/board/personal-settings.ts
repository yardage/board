import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { type AiChoices, parseAllChoices, parseThreadChoices, type Provider, type ThreadChoices } from '../../shared/ai-uses.ts'
import { DEFAULT_NOTICES, type NoticeSettings, parseNotices } from '../../shared/notices.ts'
import { DEFAULT_TEXT_SIZE, isTextSize, type TextSize } from '../../shared/text-size.ts'
import { coloursOf, derive, FIXED_ROLES, type HandTuned, isHandTuned, parseColours, type Theme, type ThemeColours, themeOf } from '../../shared/themes.ts'
import { isLanguage, type Language } from '../ai/translate.ts'

/** What a member chose for themselves, on this computer, and the look of a report page under their theme. */

/** Theme for report pages, written for a host that provides these variables. Chart colours pass dataviz's validator on this surface. */
export const REPORT_THEME: Record<HandTuned, string> = {
  omarchy: `:root{color-scheme:dark;--background:#1a1b26;--foreground:#c0caf5;--muted:#24283b;--muted-foreground:#8e97c2;--card:#16161e;--card-foreground:#c0caf5;--popover:#16161e;--popover-foreground:#c0caf5;--secondary:#24283b;--border:#292e42;--ring:#7aa2f7;--primary:#7aa2f7;--accent:#292e42;--destructive:#f7768e;--warning:#e0af68;--success:#9ece6a;--info:#7aa2f7;--chart-1:#6188e6;--chart-2:#d67834;--chart-3:#23a68c;--chart-4:#a874e0;--chart-5:#dd5a7c;--chart-6:#3a9fd0;--radius:0px;--font-sans:'Board Mono','Cascadia Mono',Consolas,ui-monospace,monospace;--font-mono:var(--font-sans)}body{margin:0;padding:16px;background:var(--background);color:var(--foreground);font-family:var(--font-sans)}`,
}

const REPORT_TAIL = `--radius:0px;--font-sans:'Board Mono','Cascadia Mono',Consolas,ui-monospace,monospace;--font-mono:var(--font-sans)}body{margin:0;padding:16px;background:var(--background);color:var(--foreground);font-family:var(--font-sans)}`

/** The same page for a theme made of three colours: what `derive` gives the app, given to the report's names. */
export function reportTheme(theme: Theme, custom: ThemeColours | null): string {
  if (isHandTuned(theme)) return REPORT_THEME[theme]
  const roles = derive(coloursOf(theme, custom))
  const chart = [1, 2, 3, 4, 5, 6].map((n) => `--chart-${n}:${FIXED_ROLES[`--chart-${n}` as keyof typeof FIXED_ROLES]}`).join(';')
  return `:root{color-scheme:dark;--background:${roles['--bg']};--foreground:${roles['--hi']};--muted:${roles['--raised']};--muted-foreground:${roles['--muted']};--card:${roles['--bg-dark']};--card-foreground:${roles['--hi']};--popover:${roles['--bg-dark']};--popover-foreground:${roles['--hi']};--secondary:${roles['--raised']};--border:${roles['--sel']};--ring:${roles['--accent']};--primary:${roles['--accent']};--accent:${roles['--sel']};--destructive:${FIXED_ROLES['--danger']};--warning:${FIXED_ROLES['--amber']};--success:${FIXED_ROLES['--green']};--info:${roles['--accent']};${chart};${REPORT_TAIL}`
}

/** A report page is alone in a sandbox and can't load the app's font: it carries the Latin part of it. */
export const readReportFont = async (client: string): Promise<string> => {
  const assets = join(client, 'assets')
  const file = (await readdir(assets).catch(() => [] as string[])).find((name) => /^jetbrains-mono-latin-wght-normal-.*\.woff2$/.test(name))
  if (!file) return ''
  const data = await readFile(join(assets, file), 'base64')
  return `@font-face{font-family:'Board Mono';font-weight:100 800;src:url(data:font/woff2;base64,${data}) format('woff2')}`
}


/** What a member chose on this computer, for every environment: never committed. */
export interface PersonalSettings {
  language: Language
  theme: Theme
  themeColours: ThemeColours | null
  textSize: TextSize
  /** Each program's model and effort for each use. */
  models: Record<Provider, AiChoices>
  threadModels: Map<string, ThreadChoices>
  notices: NoticeSettings
}

/**
 * The member's settings, from the file this computer keeps. A missing or damaged one is no reason not to start.
 * `codexModels` reads what Codex's own catalogue names, in the folder the member gave it (`AiPrograms.catalogue`).
 */
export async function readPersonal(file: string, codexModels: () => Promise<string[]>, fallbackLanguage: Language = 'en'): Promise<PersonalSettings> {
  const settings: PersonalSettings = { language: fallbackLanguage, theme: 'default', themeColours: null, textSize: DEFAULT_TEXT_SIZE, models: parseAllChoices(null), threadModels: new Map(), notices: DEFAULT_NOTICES }
  try {
    const saved = JSON.parse(await readFile(file, 'utf8'))
    if (isLanguage(saved?.language)) settings.language = saved.language
    settings.theme = themeOf(saved?.theme) ?? settings.theme
    settings.themeColours = parseColours(saved?.themeColours)
    if (isTextSize(saved?.textSize)) settings.textSize = saved.textSize
    // A Codex model only its own catalogue names is still a model the member chose.
    settings.models = parseAllChoices(saved?.models, { codex: await codexModels() })
    settings.notices = parseNotices(saved?.notifications)
    for (const [id, choices] of Object.entries(saved?.threadModels ?? {})) {
      const parsed = parseThreadChoices(choices)
      if (Object.keys(parsed).length) settings.threadModels.set(id, parsed)
    }
  } catch {
    // A preference is no reason not to start.
  }
  return settings
}
