import { Fragment, useCallback, useEffect, useRef, useState } from 'react'
import { ThreadAi } from '../settings/ai-choice.tsx'
import { call, CallError } from '../../lib/api.ts'
import type { Activity, Me, ThreadView } from '../../lib/types.ts'
import { Bubble } from './bubble.tsx'
import { Composer } from './composer.tsx'
import { SubjectLinks } from '../../components/discuss.tsx'
import { localize, t } from '../../../shared/i18n/i18n.ts'
import { firstNew } from '../../lib/lists.ts'
import { Markdown, when } from '../../components/markdown.tsx'
import { Avatar, nameOf } from '../../lib/people.tsx'
import { REPOSITORY_URL } from '../../lib/subject.ts'
import { SynthesisCard } from './synthesis.tsx'
import { DraftCard, PollCard, WaitingOnLine } from './thread-parts.tsx'
import { Loading, Spinner } from '../../components/ui.tsx'
import { VoicePanel, VoiceShared, VoiceTool } from '../voice/voice.tsx'

/** Close enough to the end of a thread to count as reading what comes next. */
const FOLLOW_WITHIN = 120

export function ThreadScreen({ id, me, tick, live }: { id: string; me: Me; tick: number; live: Activity | undefined }) {
  const [view, setView] = useState<ThreadView | null>(null)
  const [speaking, setSpeaking] = useState(false)
  const [missing, setMissing] = useState(false)
  const [refused, setRefused] = useState<string | null>(null)
  const bottom = useRef<HTMLDivElement>(null)
  const zone = useRef<HTMLElement>(null)
  // Read while drawing, before the app marks this thread as read. Each thread has its own screen, so this holds for the visit.
  const [seenAt] = useState(() => localStorage.getItem(`seen:${id}`))
  const newFrom = useRef<string | null | undefined>(undefined)
  const divider = useRef<HTMLDivElement>(null)
  const placed = useRef(false)

  const [stale, setStale] = useState<string | null>(null)
  const load = useCallback(() => {
    call<ThreadView>(`threads/${encodeURIComponent(id)}`)
      .then((data) => {
        setView(data)
        setMissing(false)
        setStale(null)
      })
      .catch((error: unknown) => {
        // Gone for good, or a blip: what was read stays on screen with a word.
        if (error instanceof CallError && error.status === 404) setMissing(true)
        else setStale((error as Error).message)
      })
  }, [id])

  useEffect(load, [load, tick])

  const activity = live ?? view?.activity ?? undefined
  if (view && newFrom.current === undefined) newFrom.current = firstNew(view.messages, seenAt, me.login)
  // What arrived with the window behind others, thread open: nothing marks it as read, and this says where it starts.
  if (view && !newFrom.current && !document.hasFocus()) newFrom.current = firstNew(view.messages, localStorage.getItem(`seen:${id}`), me.login)
  const lastAuthor = view?.messages.at(-1)?.author
  const scroller = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!view) return
    // Opened at what is new. After that, it follows the end only for someone already there, or who has just written.
    if (!placed.current) {
      placed.current = true
      if (divider.current) {
        divider.current.scrollIntoView({ block: 'start' })
        return
      }
    } else {
      const zone = scroller.current
      const away = zone ? zone.scrollHeight - zone.scrollTop - zone.clientHeight : 0
      if (away > FOLLOW_WITHIN && lastAuthor !== me.login) return
    }
    bottom.current?.scrollIntoView({ block: 'end' })
  }, [view?.messages.length, activity?.partial, id])

  if (missing && !view) return <div className="empty">{t('Ce fil n\'existe pas, ou pas encore sur ce poste.')}</div>
  if (!view)
    return (
      <div className="empty">
        <Loading>{t('Chargement…')}</Loading>
      </div>
    )

  const closed = view.messages.findLast((message) => message.status)?.status === 'closed'

  return (
    <section className="chat" ref={zone}>
      <header className="chat-head">
        <div>
          <span className={`kind ${view.thread.kind}`}>{view.thread.kind === 'question' ? t('Question') : t('Sujet')}</span>
          <ThreadTitle id={id} title={view.thread.title} onDone={load} />
          {view.thread.subject && (
            <div className="thread-subject">
              <span>{t('Sur')}</span> <SubjectLinks subject={view.thread.subject} />
              {view.thread.subject.detail && <small title={view.thread.subject.detail}>{view.thread.subject.detail}</small>}
            </div>
          )}
        </div>
        <div className="chat-actions">
          {!closed && !view.draft && (
            <button
              type="button"
              className="ghost"
              disabled={Boolean(activity)}
              title={t('Votre agent prépare votre prochain message, que vous relirez. Cela utilise votre quota.')}
              onClick={() => {
                setRefused(null)
                call(`threads/${encodeURIComponent(id)}/draft`, {})
                  .then(load)
                  .catch((failure) => setRefused((failure as Error).message))
              }}
            >
              {t('Brouillon par mon agent')}
            </button>
          )}
          {!closed && (
            <button
              type="button"
              className="ghost"
              disabled={Boolean(activity)}
              title={t('Votre agent résume ce fil : décisions, points à trancher, répartition. Cela utilise votre quota.')}
              onClick={() => {
                setRefused(null)
                call(`threads/${encodeURIComponent(id)}/synthesis`, {})
                  .then(load)
                  .catch((failure) => setRefused((failure as Error).message))
              }}
            >
              {view.synthesis ? t('Synthétiser à nouveau') : t('Synthétiser')}
            </button>
          )}
          <button
            type="button"
            className="ghost"
            onClick={() => void call(`threads/${encodeURIComponent(id)}/status`, { status: closed ? 'open' : 'closed' }).then(load)}
          >
            {closed ? t('Rouvrir') : t('Clore le fil')}
          </button>
          {me.reply !== 'off' && (
            <label className="check" title={t('Ici, votre agent ne répond pas et ne prépare rien quand on vous mentionne.')}>
              <input type="checkbox" checked={view.muted} onChange={(event) => void call(`threads/${encodeURIComponent(id)}/mute`, { muted: event.target.checked }).then(load)} />
              {t('Agent en silence ici')}
            </label>
          )}
        </div>
      </header>
      <div className="messages" ref={scroller}>
        {view.messages.map((message, index) => (
          <Fragment key={message.id}>
          {message.id === newFrom.current && (
            <div className="new-divider" ref={divider}>
              <span>{t('nouveaux')}</span>
            </div>
          )}
          {message.synthesis && view.synthesis?.id === message.id ? (
            <SynthesisCard
              threadId={id}
              original={message.synthesis}
              foreign={Boolean(message.language && message.language !== me.language)}
              language={me.language}
              view={view.synthesis}
              by={nameOf(message.author, message.agent)}
              at={when(message.createdAt)}
              later={view.messages.length - index - 1}
              closed={closed}
              repository={REPOSITORY_URL}
              onChanged={load}
            />
          ) : (
            <Bubble
              message={message}
              threadId={id}
              language={me.language}
              saved={view.translations[message.id]}
              poll={message.poll && <PollCard threadId={id} messageId={message.id} poll={message.poll} votes={view.votes} me={me.login} closed={closed} pollClosed={view.pollStates?.[message.id] ?? null} canClose={me.admin || message.author.toLowerCase() === me.login.toLowerCase()} onVoted={load} />}
            />
          )}
          </Fragment>
        ))}
        {activity && (
          <article className="message from-agent live">
            <Avatar login={activity.agent} agent />
            <div className="message-body">
              <header>
                <strong>{t('Votre agent')}</strong>
                <Spinner />
                <span className="doing">{localize(activity.doing ?? '') || (activity.partial ? t('Écrit') : t('Réfléchit'))}</span>
                <button type="button" className="link" onClick={() => void call(`threads/${encodeURIComponent(id)}/stop`, {})}>
                  {t('Arrêter')}
                </button>
              </header>
              {activity.partial && (
                <div className="prose">
                  <Markdown text={activity.partial} />
                </div>
              )}
            </div>
          </article>
        )}
        {refused && <div className="inline-error">{refused}</div>}
        {stale && <div className="inline-error">{t('Le fil n’a pas pu être relu : {0}', { 0: stale })}</div>}
        {view.agentError && !activity && (
          <div className="inline-error">
            {/^(Synthèse|Résumé|Synthesis|Summary)/.test(view.agentError) ? view.agentError : t('Votre agent n\'a pas pu répondre : {0}', { 0: view.agentError })}{' '}
            <button type="button" className="link" onClick={() => void call(`threads/${encodeURIComponent(id)}/retry`, {}).then(load)}>
              {t('Réessayer')}
            </button>
          </div>
        )}
        <WaitingOnLine waiting={view.waitingOn} />
        {view.draft && <DraftCard key={view.draft.at} threadId={id} draft={view.draft} onDone={load} />}
        <div ref={bottom} />
      </div>
      {view.voice && <VoiceShared threadId={id} state={view.voice} me={me.login} closed={closed} busy={Boolean(activity)} onAsked={load} />}
      <VoicePanel threadId={id} open={speaking} closed={closed} onPublished={() => {
        setSpeaking(false)
        load()
      }} />
      <Composer
        key={id}
        me={me}
        disabled={closed}
        autoFocus
        dropZone={zone}
        tools={
          <>
            <VoiceTool threadId={id} open={speaking} disabled={closed} onToggle={() => setSpeaking(!speaking)} />
            <ThreadAi threadId={id} disabled={closed} />
          </>
        }
        placeholder={closed ? t('Ce fil est clos. Rouvrez-le pour continuer.') : t('Écrire dans ce fil…')}
        onSend={async (body, attachments, poll) => {
          await call(`threads/${encodeURIComponent(id)}/messages`, { body, attachments, ...(poll ? { poll } : {}) })
          load()
        }}
      />
    </section>
  )
}

/** The title, which anyone can change. It changes for both people, without a message in the thread. */
function ThreadTitle({ id, title, onDone }: { id: string; title: string; onDone: () => void }) {
  const [draft, setDraft] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  if (draft === null)
    return (
      <h1 className="thread-title">
        {title}{' '}
        <button
          type="button"
          className="link rename"
          title={t('Renommer ce fil, pour vous deux')}
          onClick={() => {
            setFailure(null)
            setDraft(title)
          }}
        >
          {t('Renommer')}
        </button>
      </h1>
    )
  const save = () => {
    if (busy) return
    if (!draft.trim() || draft.trim() === title) return setDraft(null)
    setBusy(true)
    setFailure(null)
    call(`threads/${encodeURIComponent(id)}/title`, { title: draft })
      .then(() => {
        setDraft(null)
        onDone()
      })
      .catch((error) => setFailure((error as Error).message))
      .finally(() => setBusy(false))
  }
  return (
    <form
      className="rename-form"
      onSubmit={(event) => {
        event.preventDefault()
        save()
      }}
    >
      <input
        autoFocus
        aria-label={t('Titre du fil')}
        value={draft}
        maxLength={200}
        onFocus={(event) => event.target.select()}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') setDraft(null)
        }}
      />
      <button type="submit" className="ghost" disabled={busy}>
        {t('Enregistrer')}
      </button>
      <button type="button" className="link" onClick={() => setDraft(null)}>
        {t('Annuler')}
      </button>
      {failure && <span className="inline-error">{failure}</span>}
    </form>
  )
}
