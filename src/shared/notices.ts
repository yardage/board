/**
 * The member's choices about desktop notifications, kept on their computer. No React here: the server reads and checks
 * them, and tests can too.
 */

/** What a notification can be about, most personal first. */
export const NOTICE_KINDS = ['mentions', 'polls', 'messages', 'agents', 'waiting', 'drafts'] as const
export type NoticeKind = (typeof NOTICE_KINDS)[number]

export interface NoticeSettings {
  /** Off: no notification at all, whatever else says. */
  enabled: boolean
  sound: boolean
  /** Off: a notification says what happened, but not what was written, for a shared or recorded screen. */
  preview: boolean
  /** The count on the taskbar icon and the dot in the tray. */
  badge: boolean
  kinds: Record<NoticeKind, boolean>
  /** Nothing shows until then. An ISO date, or null. */
  pausedUntil: string | null
}

export const DEFAULT_NOTICES: NoticeSettings = {
  enabled: true,
  sound: true,
  preview: true,
  badge: true,
  kinds: { mentions: true, polls: true, messages: true, agents: true, waiting: true, drafts: true },
  pausedUntil: null,
}

/** Longer than any pause the screen offers: a date further away was not chosen there. */
const PAUSE_MAX_MS = 8 * 24 * 3600_000

const flag = (value: unknown, fallback: boolean) => (typeof value === 'boolean' ? value : fallback)

/** What the settings file or a request says, checked: anything missing or wrong is the default. */
export function parseNotices(saved: unknown, now = Date.now()): NoticeSettings {
  const found = saved && typeof saved === 'object' && !Array.isArray(saved) ? (saved as Record<string, unknown>) : {}
  const kinds = found.kinds && typeof found.kinds === 'object' && !Array.isArray(found.kinds) ? (found.kinds as Record<string, unknown>) : {}
  const until = typeof found.pausedUntil === 'string' && found.pausedUntil.length <= 40 ? Date.parse(found.pausedUntil) : NaN
  return {
    enabled: flag(found.enabled, DEFAULT_NOTICES.enabled),
    sound: flag(found.sound, DEFAULT_NOTICES.sound),
    preview: flag(found.preview, DEFAULT_NOTICES.preview),
    badge: flag(found.badge, DEFAULT_NOTICES.badge),
    kinds: Object.fromEntries(NOTICE_KINDS.map((kind) => [kind, flag(kinds[kind], DEFAULT_NOTICES.kinds[kind])])) as Record<NoticeKind, boolean>,
    pausedUntil: until > now && until <= now + PAUSE_MAX_MS ? new Date(until).toISOString() : null,
  }
}

export const isPaused = (settings: NoticeSettings, now = Date.now()) => settings.pausedUntil !== null && Date.parse(settings.pausedUntil) > now

/** Whether a notification of this kind shows now, and how; null when it doesn't. */
export function noticeFor(settings: NoticeSettings, kind: NoticeKind, now = Date.now()): { silent: boolean; preview: boolean } | null {
  if (!settings.enabled || !settings.kinds[kind] || isPaused(settings, now)) return null
  return { silent: !settings.sound, preview: settings.preview }
}

/** A thread's last message, as a kind: one that names this member comes first, whoever wrote it, then a poll to vote on. */
export function kindOfMessage(last: { lastAgent: string | null; lastMentions?: string[]; lastPoll?: boolean }, me: string): NoticeKind {
  if (last.lastMentions?.some((login) => login.toLowerCase() === me.toLowerCase())) return 'mentions'
  if (last.lastPoll) return 'polls'
  return last.lastAgent ? 'agents' : 'messages'
}

/** The hour a pause "until tomorrow morning" ends, on this computer's clock. */
export const MORNING_HOUR = 8

/** When a pause chosen now ends: in an hour, or at the next morning, today's if it hasn't come yet. */
export function pauseEnd(choice: 'hour' | 'morning', now = new Date()): string {
  if (choice === 'hour') return new Date(now.getTime() + 3600_000).toISOString()
  const morning = new Date(now)
  morning.setHours(MORNING_HOUR, 0, 0, 0)
  if (morning.getTime() <= now.getTime()) morning.setDate(morning.getDate() + 1)
  return morning.toISOString()
}
