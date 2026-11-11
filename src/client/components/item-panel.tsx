import { type ReactNode, useCallback, useEffect, useMemo, useState } from 'react'
import type { ItemState, ItemView } from '../../server/github/item.ts'
import { type Allowed, type Done, DoneLine, ItemActions } from '../features/waiting/answer.tsx'
import { call } from '../lib/api.ts'
import { Discuss, LinkedThreads } from './discuss.tsx'
import { personOf } from '../lib/people.tsx'
import { subjectOfItem } from '../lib/subject.ts'
import { Loading } from './ui.tsx'
import { dateLocale, t } from '../../shared/i18n/i18n.ts'

/**
 * A ticket or a pull request, beside what is being read, without leaving for a browser: what GitHub says of it,
 * what waits on whom, and what this member can do about it, with their own login.
 */

interface PanelView extends ItemView {
  waiting: { who: string; question: string; mine: boolean; label: string } | null
  may: Allowed
}

const STATES: Record<ItemState, string> = { open: t('ouvert'), draft: t('brouillon'), closed: t('fermé'), merged: t('✓ mergée') }
const REVIEWS: Record<string, string> = { none: t('pas encore de revue'), approved: t('✓ approuvée'), stale: t('▲ revue à refaire'), changes: t('× changements demandés') }
const RUNS: Record<string, string> = { success: t('✓ réussi'), failure: t('× échoué'), other: t('annulé'), running: t('en cours'), queued: t('en file') }

const date = (iso: string | null) => (iso ? new Date(iso).toLocaleString(dateLocale(), { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '')

export function ItemPanel({ number, me, tick, markdown, onClose }: { number: number; me: string; tick: number; markdown: (text: string) => ReactNode; onClose: () => void }) {
  const [item, setItem] = useState<PanelView | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const [done, setDone] = useState<Done | null>(null)

  const load = useCallback(() => {
    let closed = false
    call<PanelView>(`item/${number}`).then(
      (found) => {
        if (!closed) {
          setItem(found)
          setFailure(null)
        }
      },
      (error) => {
        if (!closed) setFailure((error as Error).message)
      },
    )
    return () => {
      closed = true
    }
  }, [number])
  useEffect(() => {
    setItem(null)
    setFailure(null)
    setDone(null)
    return load()
  }, [load])
  // What waits, and the review's state, follow each new read of GitHub.
  useEffect(() => {
    if (tick > 0) return load()
  }, [tick, load])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      // The search above it has already used this one.
      if (event.key === 'Escape' && !event.defaultPrevented) onClose()
    }
    addEventListener('keydown', onKey)
    return () => removeEventListener('keydown', onKey)
  }, [onClose])

  const subject = item ? subjectOfItem(item.url, item.number, item.title, item.waiting?.question || undefined) : null
  // Long texts take time to draw, and the app draws again at each word an agent writes in a thread.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the text is the only thing that changes what this draws.
  const body = useMemo(() => (item?.body ? markdown(item.body) : null), [item?.body])
  const requested = Boolean(item?.reviewers.some((login) => login.toLowerCase() === me.toLowerCase()))
  const waitsOnMe = Boolean(item?.waiting?.mine) || requested
  return (
    <aside className="item-panel" aria-label={`#${number}`}>
      <header className="item-head">
        <span className="kind">
          {item?.kind === 'pull' ? 'PR' : item ? t('Ticket') : ''} #{number}
        </span>
        <button type="button" className="link" onClick={onClose}>
          {t('Fermer')}
        </button>
      </header>
      {failure && <div className="inline-error">{failure}</div>}
      {!item && !failure && (
        <div className="empty">
          <Loading>{t('Lecture sur GitHub…')}</Loading>
        </div>
      )}
      {item && (
        <div className="item-body">
          <h2>{item.title}</h2>
          <p className="item-facts">
            <b>{STATES[item.state]}</b>
            {item.author && ` · ${personOf(item.author).name}`}
            {item.created && t(' · ouvert le {0}', { 0: date(item.created) })}
            {item.merged ? t(' · mergée le {0}', { 0: date(item.merged) }) : item.closed ? t(' · fermé le {0}', { 0: date(item.closed) }) : ''}
          </p>
          {(item.milestone || item.labels.length > 0) && (
            <p className="item-labels">
              {item.milestone && <span className="inf-tag">{item.milestone}</span>}
              {item.labels.map((label) => (
                <code key={label}>{label}</code>
              ))}
            </p>
          )}
          {(item.ci || item.review || item.reviewers.length > 0) && (
            <p className="item-facts">
              {[item.ci ? t('CI : {0}', { 0: RUNS[item.ci] ?? item.ci }) : '', item.review ? (REVIEWS[item.review] ?? '') : '', item.reviewers.length ? t('revue demandée à {0}', { 0: item.reviewers.map((login) => personOf(login).name).join(', ') }) : ''].filter(Boolean).join(' · ')}
            </p>
          )}
          {(item.waiting || requested) && (
            <div className={`item-waits ${waitsOnMe ? 'mine' : ''}`}>
              <strong>{waitsOnMe ? t('▲ Attend votre réponse') : t('Attend {0}', { 0: item.waiting?.who ? personOf(item.waiting.who).name : t('une réponse') })}</strong>
              {item.waiting?.question && <p>{item.waiting.question}</p>}
            </div>
          )}
          {item.runs.length > 0 && (
            <ul className="item-list">
              {item.runs.map((run) => (
                <li key={run.id}>
                  <a href={`${item.url.split('/').slice(0, 5).join('/')}/actions/runs/${run.id}`} target="_blank" rel="noreferrer">
                    {RUNS[run.state] ?? run.state}
                  </a>{' '}
                  <small>{date(run.start)}</small>
                </li>
              ))}
            </ul>
          )}
          <p className="item-actions">
            <a className="ghost" href={item.url} data-outside target="_blank" rel="noreferrer">
              {t('Voir sur GitHub')}
            </a>
            {item.kind === 'pull' && (
              <a className="ghost" href={`${item.url}/files`} data-outside target="_blank" rel="noreferrer">
                {t('Voir les changements')}
              </a>
            )}
            {subject && <Discuss subject={subject} className="ghost" />}
            {subject && <LinkedThreads subject={subject} />}
          </p>
          {done && <DoneLine done={done} />}
          {!item.unread && (
            <ItemActions
              item={{ number: item.number, kind: item.kind, url: item.url, open: item.state === 'open' || item.state === 'draft', author: item.author, waiting: item.waiting, head: item.head, requested }}
              may={item.may}
              me={me}
              onDone={(result) => {
                setDone(result)
                load()
              }}
            />
          )}
          {item.unread && <p className="viz-stale">{t('▲ GitHub n\'a pas répondu : voici ce qui en est connu, sans sa description. {0}', { 0: item.unread })}</p>}
          {body ? <div className="prose">{body}</div> : !item.unread && <p className="muted">{t('Pas de description.')}</p>}
        </div>
      )}
    </aside>
  )
}
