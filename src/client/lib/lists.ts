import { t } from '../../shared/i18n/i18n.ts'
/**
 * How the lists are sorted and filtered, and what a screen remembers, on this computer only. No React here, so tests can
 * read it. What is pinned or read isn't shared: it says nothing to the other person.
 */

export type ThreadFilter = 'open' | 'unread' | 'linked' | 'closed'

export interface ThreadRow {
  id: string
  status: string
  lastAt: string
  lastAuthor: string
  subject?: unknown
}

export const isUnread = (thread: ThreadRow, me: string, seen: string | null) => thread.lastAuthor !== me && thread.lastAt > (seen ?? '')

/** Pinned first, and otherwise in the order given, which is the latest first. */
export function threadRows<T extends ThreadRow>(threads: T[], filter: ThreadFilter, pinned: Set<string>, me: string, seenOf: (id: string) => string | null): T[] {
  const kept = threads.filter((thread) => {
    if (filter === 'closed') return thread.status === 'closed'
    if (thread.status === 'closed') return false
    if (filter === 'unread') return isUnread(thread, me, seenOf(thread.id))
    if (filter === 'linked') return Boolean(thread.subject)
    return true
  })
  return [...kept.filter((thread) => pinned.has(thread.id)), ...kept.filter((thread) => !pinned.has(thread.id))]
}

export function threadCounts(threads: ThreadRow[], me: string, seenOf: (id: string) => string | null): Record<ThreadFilter, number> {
  const open = threads.filter((thread) => thread.status !== 'closed')
  return {
    open: open.length,
    unread: open.filter((thread) => isUnread(thread, me, seenOf(thread.id))).length,
    linked: open.filter((thread) => thread.subject).length,
    closed: threads.length - open.length,
  }
}

/** The message at which "nouveaux" goes: the first from someone else since the last visit. A first visit has none. */
export function firstNew(messages: { id: string; author: string; createdAt: string }[], seen: string | null, me: string): string | null {
  if (!seen) return null
  return messages.find((message) => message.author !== me && message.createdAt > seen)?.id ?? null
}

export type WaitingSort = 'age' | 'unblocks'

export interface Ordered {
  number: number
  createdAt?: string | null
  unblocks?: number[]
}

/** Oldest first, or what holds up the most first. A date not known comes last, in the order given. */
export function waitingOrder<T extends Ordered>(items: T[], sort: WaitingSort): T[] {
  const age = (item: T) => (item.createdAt ? Date.parse(item.createdAt) : Number.POSITIVE_INFINITY)
  const byAge = (a: T, b: T) => {
    const [first, second] = [age(a), age(b)]
    return first === second ? 0 : first < second ? -1 : 1
  }
  return [...items].sort((a, b) => (sort === 'unblocks' ? (b.unblocks?.length ?? 0) - (a.unblocks?.length ?? 0) : 0) || byAge(a, b))
}

export function ageWords(iso: string | null | undefined, now: number): string | null {
  if (!iso) return null
  const hours = (now - Date.parse(iso)) / 3_600_000
  if (Number.isNaN(hours) || hours < 0) return null
  return hours < 1 ? t('moins d\'1 h') : hours < 24 ? t('{0} h', { 0: Math.floor(hours) }) : t('{0} j', { 0: Math.floor(hours / 24) })
}

/** Periods before anything happened at all, which only squeeze the chart. Days in between stay: they did have nothing. */
export function trimEmptyStart<T>(rows: T[], isEmpty: (row: T) => boolean): T[] {
  const first = rows.findIndex((row) => !isEmpty(row))
  return first <= 0 ? rows : rows.slice(first)
}

const SCROLLS_MAX = 30

/** The reading position of the last reports opened: the map stays small, and the latest come last. */
export function rememberScroll(found: Record<string, number>, id: string, top: number): Record<string, number> {
  const rest = Object.entries(found).filter(([key]) => key !== id)
  return Object.fromEntries([...rest, [id, top]].slice(-SCROLLS_MAX))
}

/** What was stored, if it still reads as what is wanted. Storage belongs to a page that may have been updated since. */
export function readStored<T>(raw: string | null, valid: (value: unknown) => value is T): T | null {
  if (raw === null) return null
  try {
    const value: unknown = JSON.parse(raw)
    return valid(value) ? value : null
  } catch {
    return null
  }
}
