import { t } from '../../shared/i18n/i18n.ts'

/**
 * How a member is named and drawn, on every screen. There are only members, by their GitHub login: a
 * member's agent writes in their name, and the screens add a mark when it did.
 */

export interface Person {
  login: string
  name: string
  admin?: boolean
}

export type ReplyMode = 'off' | 'auto' | 'draft'

let people: Person[] = []

/** The environment's members, as the board read them: set once when the page starts. */
export function setPeople(found: Person[]): void {
  people = found
}

export const members = () => people

const TONES = 6
/** A colour per member that stays the same on every screen and every computer. */
const toneOf = (login: string) => {
  let hash = 0
  for (const char of login.toLowerCase()) hash = (hash * 31 + char.charCodeAt(0)) >>> 0
  return `t${(hash % TONES) + 1}`
}

export function personOf(login: string): { login: string; name: string; initial: string; tone: string } {
  const found = people.find((person) => person.login.toLowerCase() === login.toLowerCase())
  const name = found?.name || login
  return { login: found?.login ?? login, name, initial: (name.match(/\p{L}|\d/u)?.[0] ?? '?').toUpperCase(), tone: toneOf(login) }
}

/** A member's name, and "(agent)" when their agent wrote by itself. */
export const nameOf = (login: string, agent?: 'auto' | 'draft' | null) => (agent === 'auto' ? t('{0} (agent)', { 0: personOf(login).name }) : personOf(login).name)

const Spark = ({ className = '' }: { className?: string }) => (
  <svg className={`spark ${className}`} viewBox="0 0 12 12" width="12" height="12" aria-hidden>
    <path d="M6 0l1.3 4.7L12 6 7.3 7.3 6 12 4.7 7.3 0 6l4.7-1.3z" fill="currentColor" />
  </svg>
)

/** A member's mark. With `agent`, the star says their agent wrote it. */
export function Avatar({ login, agent, size = 34 }: { login: string; agent?: boolean; size?: number }) {
  const person = personOf(login)
  return (
    <span className={`avatar ${person.tone} ${agent ? 'is-agent' : ''}`} style={{ width: size, height: size }} title={agent ? t('{0}, par son agent', { 0: person.name }) : person.name}>
      {person.initial}
      {agent && <Spark />}
    </span>
  )
}

const REPLY_WORDS: Record<ReplyMode, string> = { off: t('répond en personne'), auto: t('son agent répond'), draft: t('son agent prépare un brouillon') }

/**
 * A member, online or not. The dot says they are online; what their agent does when asked is in the words that
 * come on hover or focus, with their name. Colour is never alone.
 */
export function PersonMark({ login, online, reply, working, size = 28 }: { login: string; online: boolean; reply: ReplyMode | null; working: boolean; size?: number }) {
  const person = personOf(login)
  const lines = [t('{0} : {1}', { 0: person.name, 1: online ? t('en ligne') : t('hors ligne') })]
  if (reply) lines.push(REPLY_WORDS[reply])
  if (working) lines.push(t('son agent est au travail'))
  const says = lines.join('\n')
  return (
    <span className={`avatar person-mark ${person.tone} ${online ? 'online' : 'away'} ${working ? 'at-work' : ''}`} style={{ width: size, height: size }} role="img" tabIndex={0} aria-label={says} data-says={says}>
      {person.initial}
      {online && <i className="status-dot" aria-hidden />}
    </span>
  )
}

export const ago = (iso: string) => {
  const minutes = Math.round((Date.now() - Date.parse(iso)) / 60_000)
  return minutes < 1 ? t('à l\'instant') : t('il y a {0} min', { 0: minutes })
}

export const toThread = (id: string) => `#t/${encodeURIComponent(id)}`
