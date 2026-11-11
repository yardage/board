import { EN } from './en.ts'

/**
 * The interface in French or in English. French is the key: a text is written once, where it is used, and the English
 * for it is in `i18n-en.ts`, which a test keeps complete. What people, agents and reports wrote is never changed here:
 * that goes through the translator. Only what the app itself says does.
 */

export type Language = 'fr' | 'en'

const STORED = 'language'

/** English unless this computer chose French, or, before any choice, unless the browser is French. */
function stored(): Language {
  try {
    const saved = localStorage.getItem(STORED)
    if (saved === 'en' || saved === 'fr') return saved
    return typeof navigator !== 'undefined' && navigator.language.toLowerCase().startsWith('fr') ? 'fr' : 'en'
  } catch {
    return 'en'
  }
}

// Read when this module loads, before the modules that use it: texts in constants are written once, at that moment.
// Outside a browser (the server, tests), French: the keys themselves.
let current: Language = typeof localStorage === 'undefined' ? 'fr' : stored()

export const language = (): Language => current
export const dateLocale = () => (current === 'en' ? 'en-GB' : 'fr-FR')

/** For the window's own menus, which have no page to reload. */
export function setLanguage(next: Language): void {
  current = next
}

/** After a change, or a first reading of the server's choice: true if the page has to draw again in that language. */
export function adoptLanguage(next: Language): boolean {
  localStorage.setItem(STORED, next)
  if (next === current) return false
  current = next
  return true
}

const fill = (text: string, params?: Record<number, string | number | null | undefined>) => (params ? text.replace(/\{(\d+)\}/g, (_, index) => String(params[Number(index)] ?? '')) : text)

export function t(key: string, params?: Record<number, string | number | null | undefined>): string {
  return fill(current === 'en' ? (EN[key] ?? key) : key, params)
}

/** So few words around the blanks would also fit a title someone wrote, as "{0} sur {1}" fits "Travail sur la CI". */
const PATTERN_LETTERS = 8
const DEPTH_MAX = 4

/** Keys with blanks, as a pattern that gets back what filled them. Longest first: the most specific one wins. */
const PATTERNS = Object.entries(EN)
  .filter(([key]) => /\{\d+\}/.test(key) && (key.replace(/\{\d+\}/g, '').match(/\p{L}/gu)?.length ?? 0) >= PATTERN_LETTERS)
  .sort(([a], [b]) => b.length - a.length)
  .map(([key, english]) => ({
    english,
    blanks: [...key.matchAll(/\{(\d+)\}/g)].map((found) => Number(found[1])),
    pattern: new RegExp(
      `^${key
        .split(/\{\d+\}/)
        .map((piece) => piece.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
        .join('(.*?)')}$`,
      's',
    ),
  }))

/**
 * What the server says, in French, reaches a screen that reads English: errors, and the sentences of a generated report,
 * which stay in French in the shared history. Anything not in the dictionary stays as it was written.
 */
export function localize(text: string, depth = 0): string {
  if (current !== 'en' || !text) return text
  const exact = EN[text]
  if (exact !== undefined) return exact
  if (depth >= DEPTH_MAX) return text
  for (const { english, blanks, pattern } of PATTERNS) {
    const match = pattern.exec(text)
    if (!match) continue
    const params: Record<number, string> = {}
    blanks.forEach((blank, at) => {
      params[blank] = localize(match[at + 1], depth + 1)
    })
    return fill(english, params)
  }
  return text
}

/** Words that take no "s" in English, whatever the number. */
const SAME_PLURAL = new Set(['open', 'ready', 'closed', 'merged'])

/** A number and its word, which is already in the language shown. */
export const count = (amount: number, word: string) => `${amount} ${word}${amount > 1 && !SAME_PLURAL.has(word) ? 's' : ''}`

/**
 * What people or a model wrote: these fields are never read as something the app says, because a title can be the same
 * words as a button, and some of them are posted back into the shared history. Where the server names something itself
 * under one of these fields (a section, a voice engine, a folder of the tree), the screen calls `localize` on it.
 */
const NOT_THE_APP = new Set(['title', 'home', 'detail', 'label', 'name', 'reason', 'line', 'now', 'text', 'subject', 'claudeChoices', 'body', 'content', 'partial', 'preview', 'question', 'translations', 'translated', 'synthesis', 'url', 'href', 'path', 'doc', 'branch', 'author', 'login', 'file', 'id', 'options', 'who', 'owner', 'repo', 'config', 'members', 'aliases'])
/** The same long lists come back at each refresh. */
const known = new Map<string, string>()
const KNOWN_MAX = 20_000

function localizeOnce(text: string): string {
  const found = known.get(text)
  if (found !== undefined) return found
  const result = localize(text)
  if (known.size >= KNOWN_MAX) known.clear()
  known.set(text, result)
  return result
}

/** A whole answer from the server: its states and sentences are French there, whoever reads them. Nothing happens in French. */
export function localizeData<T>(data: T): T {
  if (current !== 'en') return data
  const walk = (value: unknown): unknown => {
    if (typeof value === 'string') return value.length <= 600 ? localizeOnce(value) : value
    if (Array.isArray(value)) return value.map(walk)
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, NOT_THE_APP.has(key) ? inner : walk(inner)]))
    return value
  }
  return walk(data) as T
}
