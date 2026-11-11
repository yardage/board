import { type RefObject, useCallback, useEffect, useRef, useState } from 'react'
import { call } from '../lib/api.ts'
import type { Activity, Me, Summary } from '../lib/types.ts'
import { t } from '../../shared/i18n/i18n.ts'
import { DEFAULT_NOTICES, kindOfMessage, type NoticeKind, type NoticeSettings, noticeFor } from '../../shared/notices.ts'
import { nameOf, toThread } from '../lib/people.tsx'
import type { Route } from './routes.ts'
import { itemOfUrl } from '../lib/subject.ts'
import { DEFAULT_TEXT_SIZE, stepTextSize, type TextSize } from '../../shared/text-size.ts'

/** Beyond this many threads changed in one refresh, one notification says so instead of one each. */
const NOTICES_GROUPED_FROM = 3
/** Events close together make one refresh. */
const REFRESH_DEBOUNCE_MS = 250

/**
 * The desktop notifications: what to say when the threads, what waits on GitHub, or a draft move, and whether to
 * say it at all, as the member chose. The first read of each is what was there before: only what follows is news.
 */
export function useNotifications(me: Me | null, route: Route) {
  const known = useRef<Map<string, string> | null>(null)
  const knownWaiting = useRef<Set<string> | null>(null)
  const person = useRef<string | null>(null)
  const openThread = useRef<string | null>(null)
  openThread.current = route.view === 'thread' ? route.id : null
  const notices = useRef<NoticeSettings>(DEFAULT_NOTICES)
  notices.current = me?.notices ?? DEFAULT_NOTICES

  useEffect(() => {
    person.current = me?.login ?? null
  }, [me?.login])

  useEffect(() => {
    if (typeof Notification !== 'undefined' && Notification.permission === 'default') void Notification.requestPermission()
  }, [])

  /** Every desktop notification goes through here, so the member's choices hold for all of them. */
  const notify = useCallback((kind: NoticeKind, title: string, body: string, quietTitle: string, open: () => void) => {
    if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return
    const how = noticeFor(notices.current, kind)
    if (!how) return
    const notice = how.preview ? new Notification(title, { body, silent: how.silent }) : new Notification(quietTitle, { silent: how.silent })
    notice.onclick = () => {
      open()
      void call('focus', {})
    }
  }, [])

  /** The threads just read: says which moved since the last read, and keeps this one. */
  const threadsChanged = useCallback(
    (list: Summary[]) => {
      // The first answer is what was there before: only what comes after is news.
      const before = known.current
      known.current = new Map(list.map((thread) => [thread.id, thread.lastAt]))
      if (!before) return
      const fresh = list.filter((thread) => before.get(thread.id) !== thread.lastAt && !(!document.hidden && openThread.current === thread.id) && thread.lastAuthor !== person.current)
      // Back from a while away, or on a busy board, one word says it all; a mention still gets its own.
      if (fresh.length > NOTICES_GROUPED_FROM) {
        const mentions = fresh.filter((thread) => kindOfMessage(thread, person.current ?? '') === 'mentions')
        const rest = fresh.length - mentions.length
        if (rest > 0) {
          const title = t('{0} fils ont bougé', { 0: rest })
          notify('messages', title, fresh.filter((thread) => !mentions.includes(thread)).slice(0, 5).map((thread) => thread.title).join(' · '), title, () => {
            location.hash = ''
          })
        }
        for (const thread of mentions) {
          const author = nameOf(thread.lastAuthor, thread.lastAgent)
          notify('mentions', thread.title, t('{0} : {1}', { 0: author, 1: thread.preview.replace(/[*_`#>]/g, '') }), t('{0} vous mentionne', { 0: author }), () => {
            location.hash = toThread(thread.id)
          })
        }
        return
      }
      for (const thread of fresh) {
        const author = nameOf(thread.lastAuthor, thread.lastAgent)
        const kind = kindOfMessage(thread, person.current ?? '')
        notify(
          kind,
          thread.title,
          t('{0} : {1}', { 0: author, 1: thread.preview.replace(/[*_`#>]/g, '') }),
          kind === 'mentions' ? t('{0} vous mentionne', { 0: author }) : kind === 'polls' ? t('Nouveau sondage de {0}', { 0: author }) : t('Nouveau message de {0}', { 0: author }),
          () => {
            location.hash = toThread(thread.id)
          },
        )
      }
    },
    [notify],
  )

  /** What waits for this member, just read: says what is new since the last read, and keeps this one. */
  const waitingChanged = useCallback(
    (mine: { number: number; question: string; title: string }[]) => {
      // The first answer is what was there before: only what comes after is news. A new question on the same item is news.
      const before = knownWaiting.current
      const keyOf = (item: { number: number; question: string }) => `${item.number}:${item.question}`
      knownWaiting.current = new Set(mine.map(keyOf))
      if (!before) return
      for (const item of mine) {
        if (before.has(keyOf(item))) continue
        const title = t('#{0} attend votre réponse', { 0: item.number })
        notify('waiting', title, item.question || item.title, title, () => {
          location.hash = '#valider'
        })
      }
    },
    [notify],
  )

  /** A draft is this member's own: it tells them, even with the window behind others. */
  const draftReady = useCallback(
    (threadId: string) => {
      if (!document.hidden && openThread.current === threadId) return
      const title = t('Votre agent a préparé un brouillon')
      notify('drafts', title, t('À relire avant de l\'envoyer.'), title, () => {
        location.hash = toThread(threadId)
      })
    },
    [notify],
  )

  return { person, threadsChanged, waitingChanged, draftReady }
}

/**
 * What the server tells the page as it happens: a change to refresh on, a draft, a new copy of the knowledge, an
 * agent at work, and whether the server is there at all.
 */
export function useBoardEvents(refresh: () => void, loadTree: () => void, on: { draft: (threadId: string) => void; knowledge: () => void }) {
  const [activities, setActivities] = useState<Record<string, Activity>>({})
  const [offline, setOffline] = useState(false)
  const [stopVoice, setStopVoice] = useState(0)
  const handlers = useRef(on)
  handlers.current = on

  useEffect(() => {
    refresh()
    loadTree()
    const events = new EventSource('/api/events')
    // A pull, a post and an agent's end can arrive together: one refresh, a moment later, serves them all.
    let pending: ReturnType<typeof setTimeout> | undefined
    const soon = () => {
      clearTimeout(pending)
      pending = setTimeout(refresh, REFRESH_DEBOUNCE_MS)
    }
    events.addEventListener('changed', soon)
    events.addEventListener('draft', (event) => {
      const { threadId } = JSON.parse((event as MessageEvent).data) as { threadId: string }
      refresh()
      handlers.current.draft(threadId)
    })
    events.addEventListener('voice-stop', () => setStopVoice((value) => value + 1))
    events.addEventListener('knowledge', loadTree)
    // A new read of GitHub, and so what waits.
    events.addEventListener('knowledge', () => handlers.current.knowledge())
    events.addEventListener('activity', (event) => {
      const activity: Activity = JSON.parse((event as MessageEvent).data)
      setActivities((current) => {
        const next = { ...current }
        if (activity.done) delete next[activity.threadId]
        else next[activity.threadId] = activity
        return next
      })
    })
    events.onopen = () => setOffline(false)
    events.onerror = () => setOffline(true)
    return () => {
      clearTimeout(pending)
      events.close()
    }
  }, [refresh, loadTree])

  return { activities, offline, stopVoice }
}

/** The keys and clicks the whole window answers: text size, search, and a link to a ticket or a pull request. */
export function useShortcuts({
  textSize,
  refresh,
  composing,
  onItem,
  onSearch,
}: {
  /** Null in a browser, which has its own zoom. */
  textSize: TextSize | null | undefined
  refresh: () => void
  /** Whether a compose panel is open: a link clicked from it goes to GitHub. */
  composing: RefObject<boolean>
  onItem: (number: number) => void
  onSearch: () => void
}) {
  const handlers = useRef({ onItem, onSearch })
  handlers.current = { onItem, onSearch }

  useEffect(() => {
    // A file dropped outside a drop zone must not replace the page.
    const refuse = (event: DragEvent) => event.preventDefault()
    addEventListener('dragover', refuse)
    addEventListener('drop', refuse)
    return () => {
      removeEventListener('dragover', refuse)
      removeEventListener('drop', refuse)
    }
  }, [])

  // A link to a ticket or a pull request opens beside what is being read. With Ctrl, or from a compose panel, it goes to GitHub.
  useEffect(() => {
    const onClick = (event: MouseEvent) => {
      if (composing.current || event.defaultPrevented || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return
      const link = event.target instanceof Element ? event.target.closest('a[href]') : null
      if (!link || link.hasAttribute('data-outside')) return
      const number = itemOfUrl(link.getAttribute('href') ?? '')
      if (number === null) return
      event.preventDefault()
      handlers.current.onItem(number)
    }
    document.addEventListener('click', onClick)
    return () => document.removeEventListener('click', onClick)
  }, [composing])

  // Ctrl+K anywhere, Cmd+K on a Mac when run from a browser.
  // Without a menu, the window has no shortcut of its own for this. In a browser, its own zoom answers.
  useEffect(() => {
    if (!textSize) return
    const onKey = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey) return
      const wanted = event.key === '0' || event.code === 'Digit0' ? DEFAULT_TEXT_SIZE : event.key === '-' ? stepTextSize(textSize, -1) : event.key === '+' || event.key === '=' ? stepTextSize(textSize, 1) : null
      if (!wanted) return
      event.preventDefault()
      if (wanted !== textSize) void call('settings/text-size', { size: wanted }).then(refresh).catch(() => undefined)
    }
    addEventListener('keydown', onKey)
    return () => removeEventListener('keydown', onKey)
  }, [textSize, refresh])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        handlers.current.onSearch()
      }
    }
    addEventListener('keydown', onKey)
    return () => removeEventListener('keydown', onKey)
  }, [])
}
