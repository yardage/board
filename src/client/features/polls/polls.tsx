import { useCallback, useEffect, useState } from 'react'
import type { PollSummary } from '../../../server/environment/store.ts'
import { call } from '../../lib/api.ts'
import { t } from '../../../shared/i18n/i18n.ts'
import { Avatar, personOf, toThread } from '../../lib/people.tsx'
import { SideList } from '../../components/side-list.tsx'
import { MentionTextarea } from '../../components/mention-input.tsx'
import { EMPTY_POLL_DRAFT, PollCard, type PollDraft, PollFields, pollDate, pollIsOpen, pollOf, pollProblem, pollStateWords } from '../threads/thread-parts.tsx'
import { Loading } from '../../components/ui.tsx'
import { SideTabs } from '../../components/side-tabs.tsx'

/**
 * Every poll of the board, in one place: the ones still open, the ones closed, each with its result and who chose
 * what. A poll lives in a thread, where it can be discussed; here it is found, voted on and closed.
 */

export interface PollRow extends PollSummary {
  open: boolean
}

export const toPoll = (messageId: string) => `#sondages/${encodeURIComponent(messageId)}`

/** Whether this member still has a vote to cast here. */
export const awaitsVote = (poll: PollRow, me: string) => poll.open && !poll.votes.some((vote) => vote.author.toLowerCase() === me.toLowerCase() && vote.choices.length > 0)

function PollDetail({ poll, me, admin, onChanged }: { poll: PollRow; me: string; admin: boolean; onChanged: () => void }) {
  const voters = poll.votes.filter((vote) => vote.choices.length)
  return (
    <article className="poll-detail">
      <div className="wait-meta">
        <span>
          <Avatar login={poll.author} size={16} /> {t('par {0}', { 0: personOf(poll.author).name })}
        </span>
        <span>{pollDate(poll.createdAt)}</span>
        <span className={poll.open ? 'ok' : ''}>{poll.open ? t('en cours') : pollStateWords(poll.poll, poll.threadStatus === 'closed', poll.closed)}</span>
        <a href={toThread(poll.threadId)}>{t('Ouvrir le fil : {0}', { 0: poll.threadTitle })}</a>
      </div>
      <PollCard threadId={poll.threadId} messageId={poll.messageId} poll={poll.poll} votes={poll.votes} me={me} closed={poll.threadStatus === 'closed'} pollClosed={poll.closed} canClose={admin || poll.author.toLowerCase() === me.toLowerCase()} onVoted={onChanged} />
      {voters.length > 0 && (
        <details className="poll-register">
          <summary>{t('Qui a voté quoi ({0})', { 0: voters.length })}</summary>
          <table className="viz-table">
            <tbody>
              {voters
                .sort((a, b) => a.at - b.at)
                .map((vote) => (
                  <tr key={vote.author}>
                    <td>{personOf(vote.author).name}</td>
                    <td className="wide">{vote.choices.map((choice) => poll.poll.options[choice]).filter(Boolean).join(', ')}</td>
                    <td className="n">{pollDate(new Date(vote.at).toISOString())}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        </details>
      )}
    </article>
  )
}

/** A poll on its own, with a word for the thread it opens. */
function NewPoll({ me, onCreated }: { me: string; onCreated: (threadId: string, messageId: string) => void }) {
  const [draft, setDraft] = useState<PollDraft>(EMPTY_POLL_DRAFT)
  const [intro, setIntro] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const poll = pollOf(draft)
  const create = async () => {
    if (!poll || busy) return
    setBusy(true)
    setError(null)
    try {
      const thread = await call<{ id: string; firstMessage: string }>('threads', { body: intro.trim(), poll, kind: 'question' })
      onCreated(thread.id, thread.firstMessage)
    } catch (failure) {
      setError((failure as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <article className="poll-new">
      <h2>{t('Nouveau sondage')}</h2>
      <p className="wait-note">{t('Chaque membre vote une fois, peut changer d’avis tant que le sondage est ouvert, et tout le monde voit qui a choisi quoi. Un fil s’ouvre avec le sondage pour en discuter.')}</p>
      <div className="poll-form poll-form-page">
        <PollFields draft={draft} onChange={setDraft} autoFocus />
        <label className="poll-field">
          <span>
            {t('Présentation')} <small>{t('facultative · @ pour nommer quelqu’un')}</small>
          </span>
          <MentionTextarea me={me} rows={3} value={intro} onChange={setIntro} maxLength={4000} placeholder={t('Quelques mots pour présenter le sondage')} onSubmitKey={() => void create()} />
        </label>
        <div className="poll-new-actions">
          <span className="hint">{t('Ctrl + Entrée')}</span>
          <button type="button" className="send" disabled={busy || !poll} onClick={() => void create()}>
            {busy ? t('Envoi…') : t('Lancer le sondage')}
          </button>
        </div>
        {error && <div className="inline-error">{error}</div>}
      </div>
    </article>
  )
}

export function PollsScreen({ me, admin, selected, creating, tick }: { me: string; admin: boolean; selected: string | null; creating: boolean; tick: number }) {
  const [polls, setPolls] = useState<PollRow[] | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const [tab, setTab] = useState<'open' | 'closed'>('open')
  const load = useCallback(() => {
    call<{ polls: PollRow[] }>('polls')
      .then((found) => {
        setPolls(found.polls)
        setFailure(null)
      })
      .catch((error) => setFailure((error as Error).message))
  }, [])
  useEffect(load, [load, tick])

  if (failure) return <div className="empty">{failure}</div>
  if (!polls)
    return (
      <div className="empty">
        <Loading>{t('Chargement…')}</Loading>
      </div>
    )
  const open = polls.filter((poll) => poll.open)
  const closed = polls.filter((poll) => !poll.open)
  const chosen = polls.find((poll) => poll.messageId === selected) ?? null
  const shownTab = chosen && !creating ? (chosen.open ? 'open' : 'closed') : tab
  const list = shownTab === 'open' ? open : closed
  const current = creating ? null : (chosen ?? list[0] ?? null)
  const toVote = open.filter((poll) => awaitsVote(poll, me)).length
  return (
    <section className="wait">
      <SideList>
        <div className="wait-list">
          <a href="#sondages/nouveau" className={`new ${creating ? 'on' : ''}`}>
            <span>+</span> {t('Nouveau sondage')}
          </a>
          <SideTabs<'open' | 'closed'>
            label={t('Sondages')}
            value={shownTab}
            onPick={(key) => {
              setTab(key)
              location.hash = '#sondages'
            }}
            tabs={[
              { id: 'open', label: t('Ouverts'), count: open.length },
              { id: 'closed', label: t('Clos'), count: closed.length },
            ]}
          />
          {list.length === 0 && <p className="wait-note">{shownTab === 'open' ? t('Aucun sondage en cours.') : t('Aucun sondage clos.')}</p>}
          {list.map((poll) => {
            const voters = poll.votes.filter((vote) => vote.choices.length).length
            return (
              <a key={poll.messageId} href={toPoll(poll.messageId)} className={`wait-item ${current?.messageId === poll.messageId ? 'on' : ''}`}>
                <strong>{poll.poll.question}</strong>
                <small>
                  {t('{0} votant{1}', { 0: voters, 1: voters > 1 ? 's' : '' })}
                  {' · '}
                  {personOf(poll.author).name}
                  {poll.open && awaitsVote(poll, me) ? ` · ${t('à voter')}` : ''}
                  {!poll.open && pollStateWords(poll.poll, poll.threadStatus === 'closed', poll.closed) ? ` · ${pollStateWords(poll.poll, poll.threadStatus === 'closed', poll.closed)}` : ''}
                  {poll.open && poll.poll.closesAt ? ` · ${t('jusqu’au {0}', { 0: pollDate(poll.poll.closesAt) })}` : ''}
                </small>
              </a>
            )
          })}
          {toVote > 0 && shownTab === 'open' && <p className="wait-note">{toVote > 1 ? t('{0} sondages attendent votre vote.', { 0: toVote }) : t('Un sondage attend votre vote.')}</p>}
        </div>
      </SideList>
      <div className="wait-pane">
        {creating && (
          <NewPoll
            me={me}
            onCreated={(_threadId, messageId) => {
              load()
              location.hash = toPoll(messageId)
            }}
          />
        )}
        {!creating && current && <PollDetail key={current.messageId} poll={current} me={me} admin={admin} onChanged={load} />}
        {!creating && !current && (
          <div className="empty">
            <p>
              {polls.length === 0 ? t('Aucun sondage pour le moment.') : t('Rien ici.')}{' '}
              <a href="#sondages/nouveau" className="link">
                {t('Lancer un sondage')}
              </a>
            </p>
          </div>
        )}
      </div>
    </section>
  )
}
