import { useState } from 'react'
import { call } from '../../lib/api.ts'
import { dateLocale, t } from '../../../shared/i18n/i18n.ts'
import { Switch } from '../settings/settings-parts.tsx'
import { Avatar, members, personOf, type ReplyMode } from '../../lib/people.tsx'

/** The parts of a thread that came with members and their agents: polls, drafts, who is asked, what an agent did. */

export interface Poll {
  question: string
  options: string[]
  multiple: boolean
  /** After this date, nobody votes. */
  closesAt?: string
}

export interface Vote {
  poll: string
  author: string
  choices: number[]
  at: number
}

/** The author or an admin closed the poll. */
export interface PollClosed {
  at: string
  by: string
}

export interface ToolAction {
  tool: string
  repo: string
  number: number
  url: string
  what: string
}

export interface Draft {
  threadId: string
  body: string
  sources: string[]
  actions: ToolAction[]
  forMessage: string
  asker: string
  at: string
}

export interface WaitingOn {
  login: string
  name: string
  online: boolean
  reply: ReplyMode | null
}

export const pollDate = (iso: string) => new Date(iso).toLocaleString(dateLocale(), { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })

/** Whether a poll still takes votes: its thread is open, nobody closed it, and its date hasn't come. */
export const pollIsOpen = (poll: Poll, threadClosed: boolean, closed: PollClosed | null, now = Date.now()) => !threadClosed && !closed && !(poll.closesAt && Date.parse(poll.closesAt) <= now)

/** What a poll's state says in a few words, or nothing while it simply runs. */
export function pollStateWords(poll: Poll, threadClosed: boolean, closed: PollClosed | null, now = Date.now()): string {
  if (closed) return t('Clos le {0} par {1}', { 0: pollDate(closed.at), 1: personOf(closed.by).name })
  if (poll.closesAt && Date.parse(poll.closesAt) <= now) return t('Terminé le {0}', { 0: pollDate(poll.closesAt) })
  if (threadClosed) return t('Fil clos')
  if (poll.closesAt) return t('Jusqu’au {0}', { 0: pollDate(poll.closesAt) })
  return ''
}

const VOTERS_SHOWN = 8

/** Who chose an option: a few faces, then a count. */
function Voters({ voters }: { voters: Vote[] }) {
  const [all, setAll] = useState(false)
  const shown = all ? voters : voters.slice(0, VOTERS_SHOWN)
  const names = voters.map((vote) => personOf(vote.author).name).join(', ')
  return (
    <span className="poll-voters" title={names}>
      {shown.map((entry) => (
        <Avatar key={entry.author} login={entry.author} size={16} />
      ))}
      {!all && voters.length > VOTERS_SHOWN && (
        <button type="button" className="link" onClick={() => setAll(true)}>
          {t('+{0}', { 0: voters.length - VOTERS_SHOWN })}
        </button>
      )}
    </span>
  )
}

/**
 * A poll and its votes, which everyone sees with who chose what: the environment is a register. Its author, or an
 * admin, can close it before its date; once closed, the leading choice is marked.
 */
export function PollCard({
  threadId,
  messageId,
  poll,
  votes,
  me,
  closed,
  pollClosed = null,
  canClose = false,
  onVoted,
}: {
  threadId: string
  messageId: string
  poll: Poll
  votes: Vote[]
  me: string
  /** The thread is closed. */
  closed: boolean
  pollClosed?: PollClosed | null
  /** This member is the author, or an admin. */
  canClose?: boolean
  onVoted: () => void
}) {
  const mine = votes.find((vote) => vote.poll === messageId && vote.author.toLowerCase() === me.toLowerCase())
  const [chosen, setChosen] = useState<number[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const current = chosen ?? mine?.choices ?? []
  const these = votes.filter((vote) => vote.poll === messageId && vote.choices.length)
  const total = these.length
  const open = pollIsOpen(poll, closed, pollClosed)
  const counts = poll.options.map((_, index) => these.filter((entry) => entry.choices.includes(index)).length)
  const best = Math.max(0, ...counts)
  const toggle = (index: number) => {
    if (poll.multiple) setChosen(current.includes(index) ? current.filter((one) => one !== index) : [...current, index].sort())
    else setChosen(current[0] === index ? [] : [index])
  }
  const act = async (work: () => Promise<unknown>) => {
    setBusy(true)
    setError(null)
    try {
      await work()
      setChosen(null)
      onVoted()
    } catch (failure) {
      setError((failure as Error).message)
    } finally {
      setBusy(false)
    }
  }
  const vote = (choices: number[]) => act(() => call(`threads/${encodeURIComponent(threadId)}/votes`, { poll: messageId, choices }))
  const close = (wanted: boolean) => act(() => call(`threads/${encodeURIComponent(threadId)}/polls/${encodeURIComponent(messageId)}/close`, { closed: wanted }))
  const changed = chosen !== null && JSON.stringify(chosen) !== JSON.stringify(mine?.choices ?? [])
  const state = pollStateWords(poll, closed, pollClosed)
  return (
    <div className={`poll ${open ? '' : 'ended'}`}>
      <strong className="poll-question">{poll.question}</strong>
      <small>
        {poll.multiple ? t('Plusieurs choix possibles.') : t('Un seul choix.')} {t('{0} votant{1}', { 0: total, 1: total > 1 ? 's' : '' })}
        {state ? ` · ${state}` : ''}
      </small>
      <ul>
        {poll.options.map((option, index) => {
          const voters = these.filter((entry) => entry.choices.includes(index))
          const share = total ? Math.round((100 * voters.length) / total) : 0
          const leads = !open && total > 0 && voters.length === best
          return (
            <li key={option} className={leads ? 'leads' : ''}>
              <label className={current.includes(index) ? 'on' : ''}>
                <input type={poll.multiple ? 'checkbox' : 'radio'} name={`poll-${messageId}`} checked={current.includes(index)} disabled={!open || busy} onChange={() => toggle(index)} />
                <span className="poll-option">
                  {option}
                  {leads && <span className="tag">{t('en tête')}</span>}
                </span>
                <span className="poll-bar" aria-hidden>
                  <i style={{ width: `${share}%` }} />
                </span>
                <span className="num">
                  {voters.length} · {share} %
                </span>
              </label>
              {voters.length > 0 && <Voters voters={voters} />}
            </li>
          )
        })}
      </ul>
      {(open || (canClose && !closed)) && (
        <div className="poll-actions">
          {open && (
            <button type="button" className="send" disabled={busy || !changed || !current.length} onClick={() => void vote(current)}>
              {mine?.choices.length ? t('Changer mon vote') : t('Voter')}
            </button>
          )}
          {open && mine?.choices.length ? (
            <button type="button" className="link" disabled={busy} onClick={() => void vote([])}>
              {t('Retirer mon vote')}
            </button>
          ) : null}
          {canClose && !closed && open && (
            <button type="button" className="link" disabled={busy} title={t('Les votes s’arrêtent. Tout le monde voit le résultat.')} onClick={() => void close(true)}>
              {t('Clore le sondage')}
            </button>
          )}
          {canClose && !closed && pollClosed && (
            <button type="button" className="link" disabled={busy} onClick={() => void close(false)}>
              {t('Rouvrir le sondage')}
            </button>
          )}
          {error && <span className="inline-error">{error}</span>}
        </div>
      )}
    </div>
  )
}

export const POLL_OPTIONS_MAX = 12
type Ending = 'none' | '1' | '3' | '7' | '14' | 'date'
const ENDINGS: [Ending, string][] = [
  ['none', t('Sans date de fin')],
  ['1', t('Dans 1 jour')],
  ['3', t('Dans 3 jours')],
  ['7', t('Dans 7 jours')],
  ['14', t('Dans 14 jours')],
  ['date', t('À une date précise')],
]

/** What the form holds, and the poll it makes once it is complete. */
export interface PollDraft {
  question: string
  options: string
  multiple: boolean
  ending: Ending
  date: string
}
export const EMPTY_POLL_DRAFT: PollDraft = { question: '', options: '', multiple: false, ending: 'none', date: '' }

const optionsOf = (text: string) =>
  text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)

/** The local date the input gives, as an ISO date; null when it isn't one. */
const closesAtOf = (draft: PollDraft): string | null | undefined => {
  if (draft.ending === 'none') return undefined
  if (draft.ending === 'date') {
    const time = Date.parse(draft.date)
    return Number.isNaN(time) ? null : new Date(time).toISOString()
  }
  const end = new Date()
  end.setDate(end.getDate() + Number(draft.ending))
  return end.toISOString()
}

/** The poll a draft makes, or null while something is missing or wrong. */
export function pollOf(draft: PollDraft): Poll | null {
  const question = draft.question.trim()
  const options = optionsOf(draft.options)
  const closesAt = closesAtOf(draft)
  if (!question || options.length < 2 || options.length > POLL_OPTIONS_MAX || new Set(options).size !== options.length || closesAt === null) return null
  if (closesAt && Date.parse(closesAt) <= Date.now()) return null
  return { question, options, multiple: draft.multiple, ...(closesAt ? { closesAt } : {}) }
}

/** Why a draft isn't a poll yet, in a few words, or nothing. */
export function pollProblem(draft: PollDraft): string {
  if (!draft.question && !draft.options) return ''
  const options = optionsOf(draft.options)
  if (!draft.question.trim()) return t('Il manque la question.')
  if (options.length < 2) return t('Il faut au moins 2 choix, un par ligne.')
  if (options.length > POLL_OPTIONS_MAX) return t('Pas plus de {0} choix.', { 0: POLL_OPTIONS_MAX })
  if (new Set(options).size !== options.length) return t('Deux choix sont identiques.')
  const closesAt = closesAtOf(draft)
  if (closesAt === null) return t('La date de fin est incomplète.')
  if (closesAt && Date.parse(closesAt) <= Date.now()) return t('La date de fin est déjà passée.')
  return ''
}

/** The fields of a poll: in the composer, under a message, or on the polls screen as a whole. */
export function PollFields({ draft, onChange, autoFocus }: { draft: PollDraft; onChange: (draft: PollDraft) => void; autoFocus?: boolean }) {
  const problem = pollProblem(draft)
  const count = optionsOf(draft.options).length
  return (
    <>
      <label className="poll-field">
        <span>{t('Question')}</span>
        <input value={draft.question} autoFocus={autoFocus} maxLength={300} placeholder={t('Ce que vous demandez aux membres')} onChange={(event) => onChange({ ...draft, question: event.target.value })} />
      </label>
      <label className="poll-field">
        <span>
          {t('Choix')} <small>{count ? t('{0} sur {1} au plus', { 0: count, 1: POLL_OPTIONS_MAX }) : t('un par ligne, de 2 à {0}', { 0: POLL_OPTIONS_MAX })}</small>
        </span>
        <textarea rows={4} value={draft.options} placeholder={t('Un choix par ligne')} onChange={(event) => onChange({ ...draft, options: event.target.value })} />
      </label>
      <div className="poll-options">
        <Switch on={draft.multiple} label={t('Plusieurs choix possibles')} onFlip={() => onChange({ ...draft, multiple: !draft.multiple })} />
        <label className="poll-field inline">
          <span>{t('Fin des votes')}</span>
          <select value={draft.ending} onChange={(event) => onChange({ ...draft, ending: event.target.value as Ending })}>
            {ENDINGS.map(([code, name]) => (
              <option key={code} value={code}>
                {name}
              </option>
            ))}
          </select>
        </label>
        {draft.ending === 'date' && <input type="datetime-local" value={draft.date} aria-label={t('Date de fin')} onChange={(event) => onChange({ ...draft, date: event.target.value })} />}
      </div>
      {problem && <small className="hint poll-problem">{problem}</small>}
    </>
  )
}

/** A new poll, written in the composer with a message. */
export function PollForm({ onCancel, onReady }: { onCancel: () => void; onReady: (poll: Poll | null) => void }) {
  const [draft, setDraft] = useState<PollDraft>(EMPTY_POLL_DRAFT)
  return (
    <div className="poll-form">
      <PollFields
        draft={draft}
        onChange={(next) => {
          setDraft(next)
          onReady(pollOf(next))
        }}
      />
      <button type="button" className="link" onClick={onCancel}>
        {t('Retirer le sondage')}
      </button>
    </div>
  )
}

/** What an agent did on GitHub while writing a message: the links, so anyone can check. */
export function ActionsList({ actions }: { actions: ToolAction[] }) {
  if (!actions.length) return null
  return (
    <ul className="agent-actions">
      {actions.map((action, index) => (
        <li key={`${action.url}-${index}`}>
          <span className="tag">{t('GitHub')}</span>{' '}
          <a href={action.url} target="_blank" rel="noreferrer" data-outside>
            {action.repo}#{action.number}
          </a>{' '}
          <small>{action.what}</small>
        </li>
      ))}
    </ul>
  )
}

/** What this member's agent prepared: they read it, change it, and send it in their name, or throw it away. */
export function DraftCard({ threadId, draft, onDone }: { threadId: string; draft: Draft; onDone: () => void }) {
  const [text, setText] = useState(draft.body)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const act = async (path: string, body: unknown) => {
    setBusy(true)
    setError(null)
    try {
      await call(`threads/${encodeURIComponent(threadId)}/draft/${path}`, body)
      onDone()
    } catch (failure) {
      setError((failure as Error).message)
    } finally {
      setBusy(false)
    }
  }
  const asker = draft.forMessage ? personOf(draft.asker).name : null
  return (
    <div className="draft-card">
      <header>
        <strong>{asker ? t('Brouillon de votre agent, pour répondre à {0}', { 0: asker }) : t('Brouillon de votre agent')}</strong>
        <small>{t('Personne d\'autre ne le voit. Relisez-le, changez-le, puis envoyez-le en votre nom.')}</small>
      </header>
      <textarea rows={Math.min(14, Math.max(4, text.split('\n').length + 1))} value={text} onChange={(event) => setText(event.target.value)} />
      {draft.actions.length > 0 && (
        <div className="draft-actions">
          <small>{t('Déjà fait sur GitHub par votre agent :')}</small>
          <ActionsList actions={draft.actions} />
        </div>
      )}
      <div className="row">
        <button type="button" className="send" disabled={busy || !text.trim()} onClick={() => void act('send', { body: text })}>
          {t('Envoyer')}
        </button>
        <button type="button" className="ghost" disabled={busy} onClick={() => void act('discard', {})}>
          {t('Jeter')}
        </button>
        {error && <span className="inline-error">{error}</span>}
      </div>
    </div>
  )
}

const REPLY_LINE: Record<ReplyMode, string> = {
  off: t('{0} répondra en personne.'),
  auto: t('L\'agent de {0} répond à sa place, dès que son app est ouverte.'),
  draft: t('L\'agent de {0} prépare une réponse à relire.'),
}

const WAITING_SHOWN = 3

/** Who has been asked something and hasn't answered yet, and what happens next. Many people make one line. */
export function WaitingOnLine({ waiting }: { waiting: WaitingOn[] }) {
  const [all, setAll] = useState(false)
  if (!waiting.length) return null
  if (waiting.length > WAITING_SHOWN && !all) {
    const online = waiting.filter((member) => member.online).length
    return (
      <div className="status-line waiting-on">
        <span>
          {t('{0} membres n’ont pas encore répondu, dont {1} en ligne.', { 0: waiting.length, 1: online })}{' '}
          <button type="button" className="link" onClick={() => setAll(true)}>
            {t('Qui ?')}
          </button>
        </span>
      </div>
    )
  }
  return (
    <div className="status-line waiting-on">
      {waiting.map((member) => (
        <span key={member.login}>
          {t('{0} n\'a pas encore répondu', { 0: member.name })}
          {member.online ? '' : t(' (hors ligne)')}. {REPLY_LINE[member.reply ?? 'off'].replace('{0}', member.name)}
        </span>
      ))}
    </div>
  )
}

