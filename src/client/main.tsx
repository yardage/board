import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { call } from './lib/api.ts'
import { useBoardEvents, useNotifications, useShortcuts } from './app/hooks.ts'
import type { Me, Summary, TreeNode } from './lib/types.ts'
import { DiscussContext } from './components/discuss.tsx'
import { DocScreen } from './features/knowledge/doc-screen.tsx'
import { Home } from './app/home.tsx'
import { adoptLanguage, language, t } from '../shared/i18n/i18n.ts'
import { ItemPanel } from './components/item-panel.tsx'
import { threadCounts } from './lib/lists.ts'
import { Markdown } from './components/markdown.tsx'
import { DockedThread, NewThreadScreen } from './features/threads/new-thread.tsx'
import { setEpicLabel, setZone } from '../shared/metrics.ts'
import { OverviewScreen } from './features/overview/overview.tsx'
import { Palette } from './features/search/palette.tsx'
import { setPeople } from './lib/people.tsx'
import { PollsScreen } from './features/polls/polls.tsx'
import { ReportsScreen } from './features/reports/reports.tsx'
import { type Route, routeHash, useRoute } from './app/routes.ts'
import { SettingsDialog } from './features/settings/settings-dialog.tsx'
import { SettingsScreen } from './features/settings/settings.tsx'
import { SetupScreen } from './features/setup/setup.tsx'
import { Sidebar } from './app/sidebar.tsx'
import { SideSlot } from './components/side-list.tsx'
import { setRepository, type Subject } from './lib/subject.ts'
import type { NowData } from './features/overview/team.tsx'
import { applyStoredTheme, applyTheme } from '../shared/themes.ts'
import { ThreadScreen } from './features/threads/thread-screen.tsx'
import { TreeContext } from './features/knowledge/tree.tsx'
import { Loading } from './components/ui.tsx'
import { VoiceProvider } from './features/voice/voice.tsx'
import { type WaitingData, WaitingScreen } from './features/waiting/waiting.tsx'
import './styles/index.css'

applyStoredTheme()
document.documentElement.lang = language()

/** How often the sidebar looks again at who is online and at this person's Claude Code. */
const NOW_POLL_MS = 30_000
const AGENT_POLL_MS = 2 * 60_000

function App() {
  const route = useRoute()
  const [me, setMe] = useState<Me | null>(null)
  const [startFailure, setStartFailure] = useState<string | null>(null)
  const [threads, setThreads] = useState<Summary[] | null>(null)
  const [tree, setTree] = useState<TreeNode[]>([])
  const [slot, setSlot] = useState<HTMLElement | null>(null)
  const [tick, setTick] = useState(0)
  const [compose, setCompose] = useState<{ subject: Subject } | null>(null)
  const openNew = () => {
    setCompose(null)
    location.hash = '#nouveau'
  }
  const discussing = useMemo(() => ({ threads: threads ?? [], discuss: (subject: Subject) => { setItem(null); setCompose({ subject }) } }), [threads])
  const [searching, setSearching] = useState(false)
  const [item, setItem] = useState<number | null>(null)
  const composing = useRef(false)
  composing.current = compose !== null
  // Reading a thread changes what counts as unread, which lives in storage: this asks for the count again.
  const [read, setRead] = useState(0)
  const [now, setNow] = useState<NowData | null>(null)
  const [agentReady, setAgentReady] = useState<boolean | null>(null)
  const [toAnswer, setToAnswer] = useState(0)

  const { person, threadsChanged, waitingChanged, draftReady } = useNotifications(me, route)

  const loadWaiting = useCallback(() => {
    call<WaitingData>('waiting')
      .then((data) => {
        const who = person.current
        if (!who || !data.items) return
        const mine = data.items.filter((item) => item.mine)
        setToAnswer(mine.length)
        waitingChanged(mine)
      })
      .catch(() => undefined)
  }, [person, waitingChanged])

  const loadNow = useCallback(() => {
    call<NowData>('now')
      .then(setNow)
      .catch(() => undefined)
  }, [])

  const refresh = useCallback(() => {
    call<Summary[]>('threads')
      .then((list) => {
        setThreads(list)
        threadsChanged(list)
      })
      .catch(() => undefined)
    loadNow()
    call<Me>('me')
      .then((found) => {
        // The server keeps the choice. What this computer last read lets the first drawing be in the right language.
        if (adoptLanguage(found.language)) {
          location.reload()
          return
        }
        setPeople(found.members)
        setRepository(found.repository)
        setEpicLabel(found.conventions?.epicLabel ?? 'epic')
        setZone(found.timezone ?? 'UTC')
        setMe(found)
        setStartFailure(null)
        applyTheme(found.theme, found.themeColours)
      })
      .catch((error: unknown) => setStartFailure((error as Error).message))
    loadWaiting()
    setTick((value) => value + 1)
  }, [loadWaiting, loadNow, threadsChanged])
  const loadTree = useCallback(() => {
    call<TreeNode[]>('tree').then(setTree).catch(() => undefined)
  }, [])

  // Nothing tells the page that a session has gone quiet, or that the login of this person's Claude Code has changed.
  useEffect(() => {
    const now = setInterval(() => {
      if (!document.hidden) loadNow()
    }, NOW_POLL_MS)
    const askAgent = () => void call<{ ready: boolean }>('agent-ready').then(({ ready }) => setAgentReady(ready)).catch(() => undefined)
    askAgent()
    const agent = setInterval(askAgent, AGENT_POLL_MS)
    return () => {
      clearInterval(now)
      clearInterval(agent)
    }
  }, [loadNow])

  useEffect(() => {
    // The first refresh can come before we know who this is.
    if (me) loadWaiting()
  }, [me?.login, loadWaiting])

  // What has been read stays on this computer. A window behind others, or in the tray, hasn't read anything.
  const [focused, setFocused] = useState(() => document.hasFocus())
  useEffect(() => {
    const onFocus = () => setFocused(true)
    const onBlur = () => setFocused(false)
    addEventListener('focus', onFocus)
    addEventListener('blur', onBlur)
    return () => {
      removeEventListener('focus', onFocus)
      removeEventListener('blur', onBlur)
    }
  }, [])
  useEffect(() => {
    if (route.view !== 'thread' || !focused) return
    const thread = threads?.find((candidate) => candidate.id === route.id)
    if (!thread || localStorage.getItem(`seen:${thread.id}`) === thread.lastAt) return
    localStorage.setItem(`seen:${thread.id}`, thread.lastAt)
    setRead((value) => value + 1)
  }, [route, threads, focused])

  useShortcuts({ textSize: me?.textSize, refresh, composing, onItem: setItem, onSearch: () => setSearching((open) => !open) })

  const { activities, offline, stopVoice } = useBoardEvents(refresh, loadTree, {
    draft: draftReady,
    knowledge: () => {
      loadWaiting()
      setTick((value) => value + 1)
    },
  })

  const myself = me?.login ?? ''
  // One read per thread per drawing, not two or three.
  const seenOf = useMemo(() => {
    const cache = new Map<string, string | null>()
    return (id: string) => {
      if (!cache.has(id)) cache.set(id, localStorage.getItem(`seen:${id}`))
      return cache.get(id) ?? null
    }
    // biome-ignore lint/correctness/useExhaustiveDependencies: what is read changes with the threads and with each visit.
  }, [threads, read])
  const counted = useMemo(() => threadCounts(threads ?? [], myself, seenOf), [threads, myself, seenOf])
  /** Settings open over the screen that was there: the route underneath is the last one that wasn't theirs. */
  const under = useRef<Route>({ view: 'home' })
  if (route.view !== 'settings') under.current = route
  const shown_ = route.view === 'settings' ? under.current : route
  // What the system shows outside the window. Only when it changes: this runs at each drawing.
  useEffect(() => {
    if (myself) void call('badge', { unread: counted.unread, waiting: toAnswer }).catch(() => undefined)
  }, [myself, counted.unread, toAnswer])

  if (!me)
    return (
      <div className="frame">
        <div className="drag-strip" aria-hidden />
        <div className="empty">
          {offline ? (
            t('Le serveur du board est arrêté.')
          ) : startFailure ? (
            <span>
              {startFailure}{' '}
              <button type="button" className="link" onClick={refresh}>
                {t('Réessayer')}
              </button>
            </span>
          ) : (
            <Loading>{t('Ouverture de l\'environnement…')}</Loading>
          )}
        </div>
      </div>
    )

  return (
    <TreeContext.Provider value={tree}>
    <SideSlot.Provider value={slot}>
    <DiscussContext.Provider value={discussing}>
    <VoiceProvider stopSignal={stopVoice}>
    <div className="frame">
    <div className="window-drag" aria-hidden />
    <div className={compose || item !== null ? 'app docked' : 'app'}>
      <Sidebar
        me={me}
        now={now}
        agentReady={agentReady}
        activities={activities}
        threads={threads}
        tree={tree}
        route={route}
        screen={shown_}
        counted={counted}
        seenOf={seenOf}
        toAnswer={toAnswer}
        offline={offline}
        onSearch={() => setSearching(true)}
        onNew={openNew}
        onSlot={setSlot}
      />
      <main>
        {shown_.view === 'thread' && <ThreadScreen key={shown_.id} id={shown_.id} me={me} tick={tick} live={activities[shown_.id]} />}
        {shown_.view === 'doc' && <DocScreen key={shown_.path} path={shown_.path} language={me.language} />}
        {shown_.view === 'overview' && <OverviewScreen tab={shown_.tab} tick={tick} />}
        {shown_.view === 'reports' && <ReportsScreen path={shown_.path} tick={tick} />}
        {shown_.view === 'waiting' && <WaitingScreen tick={tick} />}
        {shown_.view === 'polls' && <PollsScreen me={me.login} admin={me.admin} selected={shown_.id} creating={shown_.creating} tick={tick} />}
        {shown_.view === 'home' && <Home me={me} count={threads?.length ?? 0} onNew={openNew} />}
        {shown_.view === 'new' && <NewThreadScreen me={me} />}
      </main>
      {route.view === 'settings' && (
        <SettingsDialog
          onClose={() => {
            location.hash = routeHash(under.current)
          }}
        >
          <SettingsScreen section={route.section} textSize={me.textSize} admin={me.admin} me={me.login} onChange={refresh} />
        </SettingsDialog>
      )}
      {compose && <DockedThread me={me} subject={compose.subject} onClose={() => setCompose(null)} />}
      {item !== null && !compose && <ItemPanel key={item} number={item} me={me.login} tick={tick} markdown={(text) => <Markdown text={text} fromGithub />} onClose={() => setItem(null)} />}
    </div>
    {searching && <Palette onClose={() => setSearching(false)} onNewThread={openNew} onItem={compose ? undefined : setItem} />}
    </div>
    </VoiceProvider>
    </DiscussContext.Provider>
    </SideSlot.Provider>
    </TreeContext.Provider>
  )
}

/** Before an environment is open, the setup screens; then the board. Changing environment reloads the page. */
function Root() {
  const [open, setOpen] = useState<boolean | null>(null)
  useEffect(() => {
    call<{ environment: { current: string | null } }>('setup')
      .then((state) => setOpen(Boolean(state.environment.current)))
      .catch(() => setOpen(false))
  }, [])
  const opened = useCallback(() => setOpen(true), [])
  if (open === null)
    return (
      <div className="frame">
        <div className="drag-strip" aria-hidden />
        <div className="empty">
          <Loading>{t('Chargement…')}</Loading>
        </div>
      </div>
    )
  if (!open)
    return (
      <div className="frame">
        <div className="drag-strip" aria-hidden />
        <SetupScreen onOpened={opened} />
      </div>
    )
  return <App />
}

createRoot(document.getElementById('root') as HTMLElement).render(<Root />)
