import { useEffect, useMemo, useState } from 'react'
import { call } from '../lib/api.ts'
import type { Activity, Me, Summary, TreeNode } from '../lib/types.ts'
import { t } from '../../shared/i18n/i18n.ts'
import { isUnread, readStored, type ThreadFilter, threadRows } from '../lib/lists.ts'
import { when } from '../components/markdown.tsx'
import { OVERVIEW_TABS } from '../../shared/metrics.ts'
import { nameOf, PersonMark, type ReplyMode, toThread } from '../lib/people.tsx'
import type { Route } from './routes.ts'
import type { NowData } from '../features/overview/team.tsx'
import { Tree } from '../features/knowledge/tree.tsx'
import { Blocks, Loading, percent, useUpdateProgress } from '../components/ui.tsx'
import { ListeningBar } from '../features/voice/voice.tsx'
import { SideTabs } from '../components/side-tabs.tsx'

/** Faces shown at the top of the sidebar. */
const PEOPLE_SHOWN = 5
/** Threads drawn in the list at first: the rest come on request, so a long history draws fast. */
const THREADS_SHOWN = 150

/**
 * The top of the sidebar, which the window is dragged by: the environment's name, which opens a menu to change
 * it or open another window, and the members' faces. The system draws its own buttons at the window's top right.
 */
function EnvironmentMenu({ environment, onNewWindow }: { environment: string; onNewWindow: (repo: string | null) => Promise<void> }) {
  const [open, setOpen] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  useEffect(() => {
    if (!open) return
    const close = (event: MouseEvent) => {
      if (!(event.target instanceof Element) || !event.target.closest('.env-menu')) setOpen(false)
    }
    const key = (event: KeyboardEvent) => event.key === 'Escape' && setOpen(false)
    addEventListener('mousedown', close)
    addEventListener('keydown', key)
    return () => {
      removeEventListener('mousedown', close)
      removeEventListener('keydown', key)
    }
  }, [open])
  const leave = async () => {
    await call('setup/environments/close', {})
    location.hash = ''
    location.reload()
  }
  const act = (work: () => Promise<void>) => {
    setOpen(false)
    setFailure(null)
    work().catch((error) => setFailure((error as Error).message))
  }
  return (
    <div className="env-menu">
      <button type="button" className="env-name" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)} title={environment}>
        <span className="logo" aria-hidden />
        <strong>{environment.split('/')[1]}</strong>
        <small>{environment.split('/')[0]}</small>
        <span className="caret" aria-hidden>
          ▾
        </span>
      </button>
      {open && (
        <ul className="menu" role="menu">
          <li role="none">
            <button type="button" role="menuitem" onClick={() => act(leave)}>
              {t('Changer d\'environnement')}
            </button>
          </li>
          <li role="none">
            <button type="button" role="menuitem" onClick={() => act(() => onNewWindow(null))}>
              {t('Changer d\'environnement dans une nouvelle fenêtre')}
            </button>
          </li>
          <li role="none" className="menu-foot">
            <a href={`https://github.com/${environment}`} target="_blank" rel="noreferrer" data-outside role="menuitem">
              {t('Dépôt sur GitHub')}
            </a>
          </li>
        </ul>
      )}
      {failure && <div className="inline-error">{failure}</div>}
    </div>
  )
}

/** A few faces, this member first, then who is online; the rest as a count that opens the team. */
function Faces({ people, more }: { people: { login: string; online: boolean; reply: ReplyMode | null; working: boolean }[]; more: number }) {
  return (
    <div className="people" aria-label={t('Membres')}>
      {people.map((member) => (
        <PersonMark key={member.login} login={member.login} online={member.online} reply={member.reply} working={member.working} />
      ))}
      {more > 0 && (
        <a href="#vue/equipe" className="people-more" title={t('{0} autres membres', { 0: more })}>
          +{more}
        </a>
      )}
    </div>
  )
}

const THREAD_FILTERS: [ThreadFilter, string][] = [
  ['open', t('Ouverts')],
  ['unread', t('Non lus')],
  ['linked', t('Liés')],
  ['closed', t('Clos')],
]
const THREADS_EMPTY: Record<ThreadFilter, string> = { open: t('Aucun fil ouvert.'), unread: t('Tout est lu.'), linked: t('Aucun fil lié à un ticket ou une PR.'), closed: t('Aucun fil clos.') }
const isStrings = (value: unknown): value is string[] => Array.isArray(value) && value.every((one) => typeof one === 'string')

/** The sidebar goes back to the tab last open. The tabs themselves always go where they say. */
const lastOverview = () => {
  const tab = localStorage.getItem('overview-tab')
  return tab && OVERVIEW_TABS.some(([id]) => id === tab) && tab !== 'global' ? `#vue/${tab}` : '#vue'
}

interface SidebarProps {
  me: Me
  now: NowData | null
  /** Whether this member's own agent can answer at all: null until asked. */
  agentReady: boolean | null
  activities: Record<string, Activity>
  threads: Summary[] | null
  tree: TreeNode[]
  route: Route
  /** The route the screen shows: the one under the settings while they are open. */
  screen: Route
  counted: Record<ThreadFilter, number>
  seenOf: (id: string) => string | null
  toAnswer: number
  offline: boolean
  onSearch: () => void
  onNew: () => void
  /** Where a page that brings its own list draws it. */
  onSlot: (element: HTMLElement | null) => void
}

/** The left column: the environment, the faces, the places of the board, then the threads or the knowledge. */
export function Sidebar({ me, now, agentReady, activities, threads, tree, route, screen, counted, seenOf, toAnswer, offline, onSearch, onNew, onSlot }: SidebarProps) {
  const [tab, setTab] = useState<'threads' | 'knowledge'>(route.view === 'doc' ? 'knowledge' : 'threads')
  const [filter, setFilter] = useState<ThreadFilter>('open')
  const [pinned, setPinned] = useState<Set<string>>(() => new Set(readStored(localStorage.getItem('pinned'), isStrings) ?? []))
  const [updating, setUpdating] = useState<string | null>(null)
  const downloaded = useUpdateProgress(updating === 'busy')
  const [listLimit, setListLimit] = useState(THREADS_SHOWN)

  useEffect(() => {
    if (route.view === 'doc') setTab('knowledge')
    if (route.view === 'thread' || route.view === 'new') setTab('threads')
    if (route.view === 'overview') localStorage.setItem('overview-tab', route.tab)
  }, [route])

  const myself = me.login
  const toVote = useMemo(() => (threads ?? []).reduce((sum, thread) => sum + (thread.openPolls ?? []).filter((poll) => !poll.voters.some((voter) => voter.toLowerCase() === myself.toLowerCase())).length, 0), [threads, myself])
  const allShown = useMemo(() => threadRows(threads ?? [], filter, pinned, myself, seenOf), [threads, filter, pinned, myself, seenOf])
  const shown = allShown.slice(0, listLimit)
  /** These pages bring their own list to the sidebar, in place of threads or knowledge. */
  const paged = screen.view === 'overview' || screen.view === 'waiting' || screen.view === 'polls' || screen.view === 'reports'
  const showList = (which: 'threads' | 'knowledge') => {
    setTab(which)
    if (paged) location.hash = ''
  }
  const togglePin = (id: string) => {
    const next = new Set(pinned)
    if (!next.delete(id)) next.add(id)
    setPinned(next)
    localStorage.setItem('pinned', JSON.stringify([...next]))
  }
  const currentDoc = route.view === 'doc' ? route.path : ''

  return (
    <aside>
      <div className="brand">
        <EnvironmentMenu environment={me.environment} onNewWindow={(repo) => call('setup/environments/window', { repo }).then(() => undefined)} />
        {(() => {
          const all = (now?.members ?? me.members.map((member) => ({ ...member, online: member.login === me.login, reply: member.login === me.login ? me.reply : null }))).map((member) => {
            const mine = member.login.toLowerCase() === me.login.toLowerCase()
            return { login: member.login, mine, online: mine ? !me.syncError : member.online, reply: mine ? (agentReady === false ? ('off' as const) : me.reply) : member.reply, working: mine && Object.keys(activities).length > 0 }
          })
          // This member first, then who is online, then the others, as many as fit.
          const ordered = [...all].sort((a, b) => Number(b.mine) - Number(a.mine) || Number(b.online) - Number(a.online) || a.login.localeCompare(b.login))
          const shown = ordered.slice(0, PEOPLE_SHOWN)
          return <Faces people={shown} more={ordered.length - shown.length} />
        })()}
      </div>
      <ListeningBar />
      <button type="button" className="side-search" onClick={onSearch}>
        <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden>
          <circle cx="7" cy="7" r="4.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
          <path d="M10.5 10.5 14 14" stroke="currentColor" strokeWidth="1.5" />
        </svg>
        <span>{t('Rechercher')}</span>
        <small>{t('Ctrl K')}</small>
      </button>
      <button type="button" className="new" onClick={onNew}>
        <span>+</span>{' '}{t('Nouveau fil')}
      </button>
      <a href={lastOverview()} className={`now-link ${screen.view === 'overview' ? 'active' : ''}`}>
        <span className="pulse" />
        <strong>{t('Vue d\'ensemble')}</strong>
        {now && <small>{t('{0} en ligne', { 0: now.members.filter((member) => member.online).length })}</small>}
      </a>
      <a href="#valider" className={`now-link ${screen.view === 'waiting' ? 'active' : ''} ${toAnswer ? 'warn' : ''}`}>
        <span className={toAnswer ? 'wait-dot on' : 'wait-dot'}>▲</span>
        <strong>{t('À valider')}</strong>
        {toAnswer > 0 && <small>{toAnswer}</small>}
      </a>
      <a href="#sondages" className={`now-link ${screen.view === 'polls' ? 'active' : ''} ${toVote ? 'warn' : ''}`}>
        <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden>
          <path d="M2.5 4h11M2.5 8h7M2.5 12h9" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="square" />
        </svg>
        <strong>{t('Sondages')}</strong>
        {toVote > 0 && <small>{t('{0} à voter', { 0: toVote })}</small>}
      </a>
      <a href="#rapports" className={`now-link ${screen.view === 'reports' ? 'active' : ''}`}>
        <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden>
          <path d="M3 13.5V8M8 13.5V3M13 13.5V6" fill="none" stroke="currentColor" strokeWidth="2" />
        </svg>
        <strong>{t('Rapports')}</strong>
      </a>
      <button type="button" className={`now-link ${!paged && tab === 'threads' ? 'active' : ''}`} onClick={() => showList('threads')}>
        <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden>
          <path d="M2.5 3h11v7.5H7L4 13.5v-3H2.5z" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
        </svg>
        <strong>{t('Fils')}</strong>
        {counted.unread > 0 && <small>{t('{0} non lus', { 0: counted.unread })}</small>}
      </button>
      <button type="button" className={`now-link ${!paged && tab === 'knowledge' ? 'active' : ''}`} onClick={() => showList('knowledge')}>
        <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden>
          <path d="M3 2.5h7l3 3v8H3zM10 2.5v3h3M5.5 8.5h5M5.5 11h5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
        </svg>
        <strong>{t('Connaissance')}</strong>
      </button>
      {paged ? <div className="side-scroll" ref={onSlot} /> : <div className="side-scroll">
        {tab === 'threads' ? (
          <>
            <SideTabs label={t('Filtrer les fils')} value={filter} onPick={setFilter} tabs={THREAD_FILTERS.map(([id, label]) => ({ id, label, count: counted[id] }))} />
            {threads === null && <p className="side-empty"><Loading>{t('Chargement…')}</Loading></p>}
            {threads !== null && allShown.length === 0 && <p className="side-empty">{THREADS_EMPTY[filter]}</p>}
            {shown.map((thread) => (
              <div key={thread.id} className="thread-wrap">
              <a href={toThread(thread.id)} className={`thread-row ${route.view === 'thread' && route.id === thread.id ? 'active' : ''}`}>
                <div className="row-top">
                  <span className={`dot ${thread.kind} ${isUnread(thread, me.login, seenOf(thread.id)) ? 'unread' : ''}`} title={isUnread(thread, me.login, seenOf(thread.id)) ? t('Non lu') : undefined} />
                  <strong>{thread.title}</strong>
                  <time>{when(thread.lastAt)}</time>
                </div>
                <div className="row-bottom">
                  {activities[thread.id] ? (
                    <span className="row-live">{t('Votre agent travaille…')}</span>
                  ) : (
                    <span>
                      <b>{t('{0} : ', { 0: nameOf(thread.lastAuthor, thread.lastAgent) })}</b>
                      {thread.preview.replace(/[*_`#>]/g, '').trim()}
                    </span>
                  )}
                </div>
              </a>
              <button type="button" className={`pin ${pinned.has(thread.id) ? 'on' : ''}`} aria-pressed={pinned.has(thread.id)} title={pinned.has(thread.id) ? t('Retirer des épinglés, sur ce poste') : t('Épingler en haut, sur ce poste')} aria-label={t('Épingler {0}', { 0: thread.title })} onClick={() => togglePin(thread.id)}>
                {pinned.has(thread.id) ? '◆' : '◇'}
              </button>
              </div>
            ))}
            {allShown.length > shown.length && (
              <button type="button" className="link side-more" onClick={() => setListLimit(listLimit + THREADS_SHOWN)}>
                {t('Afficher {0} fils de plus', { 0: Math.min(THREADS_SHOWN, allShown.length - shown.length) })}
              </button>
            )}
          </>
        ) : tree.length ? (
          <Tree nodes={tree} current={currentDoc} />
        ) : (
          <p className="side-empty">
            <Loading>{t('Récupération de la documentation…')}</Loading>
            <br />
            {t('La première fois prend une minute.')}
          </p>
        )}
      </div>}
      {me.update && (
        <button
          type="button"
          className="update"
          disabled={updating === 'busy'}
          onClick={() => {
            setUpdating('busy')
            call('update', {}).catch((failure) => setUpdating((failure as Error).message))
          }}
        >
          {updating === 'busy' ? (
            <span className="loading">
              <Blocks ratio={downloaded ?? 0} cells={20} />
              <span>{percent(downloaded ?? 0)}</span>
            </span>
          ) : updating ? (
            t('Échec de la mise à jour : {0}', { 0: updating })
          ) : (
            t('Version {0} disponible : installer', { 0: me.update })
          )}
        </button>
      )}
      <a href="#settings" className={`settings-link ${route.view === 'settings' ? 'active' : ''}`}>
        <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden>
          <circle cx="8" cy="8" r="2.2" fill="none" stroke="currentColor" />
          <path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M3.4 12.6l1.4-1.4M11.2 4.8l1.4-1.4" fill="none" stroke="currentColor" strokeLinecap="round" />
        </svg>
        {t('Réglages')}
        {me.version && <small>v{me.version}</small>}
      </a>
      {(me.syncError || me.knowledgeError || me.configWarning || offline) && (
        <div className="sync-error" title={me.syncError ?? me.configWarning ?? me.knowledgeError ?? ''}>
          {offline ? t('Serveur injoignable') : me.syncError ? t('Synchronisation GitHub en échec') : me.configWarning ? t('Configuration refusée') : t('Documentation non mise à jour')}
        </div>
      )}
    </aside>
  )
}
