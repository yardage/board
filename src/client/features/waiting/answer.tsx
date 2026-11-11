import { useEffect, useState } from 'react'
import { call } from '../../lib/api.ts'
import { t } from '../../../shared/i18n/i18n.ts'
import { personOf } from '../../lib/people.tsx'
import { Spinner } from '../../components/ui.tsx'

/**
 * What a member does about a ticket or a pull request, from the board, with their own GitHub login: answer what
 * waits on them, with a yes or a no when that is the question; review a pull request, approving it, asking for
 * changes or commenting. Every word is shown in English before it goes, and GitHub keeps it.
 */

export interface ActionTarget {
  number: number
  kind: 'issue' | 'pull'
  url: string
  open: boolean
  author: string
  /** What waits on this item, from the copy of GitHub, and whether it waits on this member. */
  waiting: { who: string; question: string; mine: boolean; label: string } | null
  /** A pull request's commit the member read: a review is made at that one. */
  head: string | null
  /** GitHub asks this member's review. */
  requested: boolean
}

export interface Allowed {
  comment: boolean
  review: boolean
}

export interface Done {
  number: number
  /** Where what was posted can be seen. */
  link: string | null
  warning: string | null
}

type Verdict = 'answer' | 'approve' | 'refuse'
type ReviewEvent = 'approve' | 'changes' | 'comment'

const VERDICTS: [Verdict, string][] = [
  ['answer', t('Répondre')],
  ['approve', t('Approuver')],
  ['refuse', t('Refuser')],
]
const EVENTS: [ReviewEvent, string][] = [
  ['approve', t('Approuver')],
  ['changes', t('Demander des changements')],
  ['comment', t('Commenter')],
]

/**
 * What tells a second try from a second answer. It outlives a move to another item: when GitHub's answer is
 * lost, the comment may exist, and the same answer tried again has to find it. Success forgets it.
 */
const attempts = new Map<string, string>()
const attemptOf = (key: string) => {
  const found = attempts.get(key) ?? crypto.randomUUID()
  attempts.set(key, found)
  return found
}

/** The text, translated to English by the member's own Claude Code unless it already is. */
const prepare = async (number: number, reason: string) => (reason.trim() ? (await call<{ text: string }>(`waiting/${number}/preview`, { reason })).text : '')

function Segmented<T extends string>({ value, options, onPick, label }: { value: T; options: [T, string][]; onPick: (value: T) => void; label: string }) {
  return (
    <span className="set-choices" role="radiogroup" aria-label={label}>
      {options.map(([code, name]) => (
        <button key={code} type="button" role="radio" className="radio" aria-checked={value === code} onClick={() => onPick(code)}>
          {value === code ? '(•)' : '( )'} {name}
        </button>
      ))}
    </span>
  )
}

function Steps({ draft, busy, canPrepare, onPrepare, onConfirm, onCancel, says }: { draft: string | null; busy: 'prepare' | 'send' | null; canPrepare: boolean; onPrepare: () => void; onConfirm: () => void; onCancel: () => void; says: string }) {
  if (draft === null)
    return (
      <div className="wait-actions">
        {busy === 'prepare' ? (
          <>
            <Spinner /> <span>{t('Préparation…')}</span>
          </>
        ) : (
          <button type="button" className="ghost" disabled={!canPrepare} onClick={onPrepare}>
            {t('Préparer')}
          </button>
        )}
      </div>
    )
  return (
    <div className="wait-confirm">
      <p className="wait-note">{says}</p>
      {draft && <blockquote>{draft}</blockquote>}
      <div className="wait-actions">
        {busy === 'send' ? (
          <>
            <Spinner /> <span>{t('Envoi…')}</span>
          </>
        ) : (
          <>
            <button type="button" className="send" onClick={onConfirm}>
              {t('Confirmer')}
            </button>
            <button type="button" className="link" onClick={onCancel}>
              {t('Annuler')}
            </button>
          </>
        )}
      </div>
    </div>
  )
}

/** An answer to what waits on this member: words, a yes or a no, and the label taken off when it is settled. */
function AnswerPart({ item, onDone }: { item: ActionTarget & { waiting: NonNullable<ActionTarget['waiting']> }; onDone: (done: Done) => void }) {
  const [verdict, setVerdict] = useState<Verdict>('answer')
  const [reason, setReason] = useState('')
  const [settle, setSettle] = useState(true)
  const [draft, setDraft] = useState<string | null>(null)
  const [busy, setBusy] = useState<'prepare' | 'send' | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const { question, label } = item.waiting
  // Confirming shows the text under the question: if the question changes, it has to be read again.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the question is the reason to run.
  useEffect(() => setDraft(null), [question])
  const route = `waiting/${item.number}`
  const needsWords = verdict === 'answer'

  const onPrepare = async () => {
    setBusy('prepare')
    setFailure(null)
    try {
      setDraft(await prepare(item.number, reason))
    } catch (error) {
      setFailure((error as Error).message)
    } finally {
      setBusy(null)
    }
  }
  const onConfirm = async () => {
    if (draft === null) return
    setBusy('send')
    setFailure(null)
    const key = JSON.stringify(['answer', item.number, question, draft, settle, verdict])
    try {
      const done = await call<{ comment: string; warning: string | null }>(`${route}/answer`, { reason, text: draft, settle, question, verdict, attempt: attemptOf(key) })
      attempts.delete(key)
      setReason('')
      setDraft(null)
      onDone({ number: item.number, link: done.comment, warning: done.warning })
    } catch (error) {
      onDone({ number: item.number, link: null, warning: (error as Error).message })
    } finally {
      setBusy(null)
    }
  }
  const heading = verdict === 'approve' ? t('Vous approuvez.') : verdict === 'refuse' ? t('Vous refusez.') : ''
  return (
    <section className="act-part">
      <h3>{t('Votre réponse')}</h3>
      <p className="wait-note">{t('Postée sur GitHub avec votre compte, en anglais : vous relisez la traduction avant l’envoi.')}</p>
      <Segmented value={verdict} options={VERDICTS} label={t('Votre réponse')} onPick={(next) => { setVerdict(next); setDraft(null) }} />
      <textarea
        value={reason}
        rows={4}
        disabled={busy !== null}
        placeholder={needsWords ? t('Votre réponse, en français ou en anglais. Ni secret ni donnée réelle.') : t('Un mot d’explication, si vous voulez.')}
        aria-label={t('Votre réponse')}
        onChange={(event) => {
          setReason(event.target.value)
          setDraft(null)
        }}
      />
      <label className="check">
        <input type="checkbox" checked={settle} disabled={busy !== null} onChange={(event) => setSettle(event.target.checked)} />
        {t('C\'est réglé : retirer l\'étiquette {0}', { 0: label })}
      </label>
      <Steps
        draft={draft}
        busy={busy}
        canPrepare={!needsWords || reason.trim().length > 0}
        onPrepare={() => void onPrepare()}
        onConfirm={() => void onConfirm()}
        onCancel={() => setDraft(null)}
        says={`${heading ? `${heading} ` : ''}${t('Ce texte sera posté sur #{0} avec votre compte GitHub.', { 0: item.number })}${settle ? ` ${t('Puis l\'étiquette {0} est retirée.', { 0: label })}` : ''}`}
      />
      {failure && <div className="inline-error">{failure}</div>}
    </section>
  )
}

/** A review of a pull request, made on GitHub at the commit the member read. */
function ReviewPart({ item, onDone }: { item: ActionTarget; onDone: (done: Done) => void }) {
  const [event, setEvent] = useState<ReviewEvent>('approve')
  const [reason, setReason] = useState('')
  const [draft, setDraft] = useState<string | null>(null)
  const [busy, setBusy] = useState<'prepare' | 'send' | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const needsWords = event !== 'approve'
  const onPrepare = async () => {
    setBusy('prepare')
    setFailure(null)
    try {
      setDraft(await prepare(item.number, reason))
    } catch (error) {
      setFailure((error as Error).message)
    } finally {
      setBusy(null)
    }
  }
  const onConfirm = async () => {
    if (draft === null) return
    setBusy('send')
    setFailure(null)
    const key = JSON.stringify(['review', item.number, item.head, event, draft])
    try {
      const done = await call<{ review: string }>(`waiting/${item.number}/review`, { event, text: draft, head: item.head ?? '', attempt: attemptOf(key) })
      attempts.delete(key)
      setReason('')
      setDraft(null)
      onDone({ number: item.number, link: done.review, warning: null })
    } catch (error) {
      onDone({ number: item.number, link: null, warning: (error as Error).message })
    } finally {
      setBusy(null)
    }
  }
  const says: Record<ReviewEvent, string> = {
    approve: t('Vous approuvez la pull request #{0}, à la version que vous avez lue, avec votre compte GitHub.', { 0: item.number }),
    changes: t('Vous demandez des changements sur #{0}, avec votre compte GitHub. Son auteur le verra sur GitHub.', { 0: item.number }),
    comment: t('Ce commentaire de revue sera posté sur #{0} avec votre compte GitHub.', { 0: item.number }),
  }
  return (
    <section className="act-part">
      <h3>{t('Votre revue')}</h3>
      <p className="wait-note">{item.requested ? t('GitHub vous demande cette revue.') : t('Une revue sur GitHub, avec votre compte : elle compte pour le merge comme toute autre.')}</p>
      <Segmented value={event} options={EVENTS} label={t('Votre revue')} onPick={(next) => { setEvent(next); setDraft(null) }} />
      <textarea
        value={reason}
        rows={4}
        disabled={busy !== null}
        placeholder={needsWords ? t('Ce qui doit changer, ou ce que vous remarquez, en français ou en anglais.') : t('Un mot, si vous voulez.')}
        aria-label={t('Votre revue')}
        onChange={(event) => {
          setReason(event.target.value)
          setDraft(null)
        }}
      />
      <Steps draft={draft} busy={busy} canPrepare={!needsWords || reason.trim().length > 0} onPrepare={() => void onPrepare()} onConfirm={() => void onConfirm()} onCancel={() => setDraft(null)} says={says[event]} />
      {failure && <div className="inline-error">{failure}</div>}
    </section>
  )
}

/** What this member can do here, and a word when they can't. */
export function ItemActions({ item, may, me, onDone }: { item: ActionTarget; may: Allowed; me: string; onDone: (done: Done) => void }) {
  const mine = item.author.toLowerCase() === me.toLowerCase()
  const canReview = item.kind === 'pull' && item.open && may.review && !mine
  const canAnswer = Boolean(item.waiting?.mine) && may.comment
  const notes: string[] = []
  if (item.kind === 'pull' && item.open && mine) notes.push(t('C’est votre pull request : un autre membre la relit.'))
  if (item.kind === 'pull' && item.open && !mine && !may.review) notes.push(t('L’environnement ne permet pas de relire ici : la revue se fait sur GitHub.'))
  if (item.waiting && !item.waiting.mine) notes.push(item.waiting.who ? t('Réponse réservée à {0}.', { 0: personOf(item.waiting.who).name }) : t('Personne n\'est indiqué : la réponse se fait sur GitHub.'))
  if (item.waiting?.mine && !may.comment) notes.push(t('L’environnement ne permet pas de commenter ici : la réponse se fait sur GitHub.'))
  return (
    <div className="item-acts">
      {canReview && <ReviewPart item={item} onDone={onDone} />}
      {canAnswer && item.waiting && <AnswerPart item={{ ...item, waiting: item.waiting }} onDone={onDone} />}
      {notes.length > 0 && !canReview && !canAnswer && (
        <p className="wait-note">
          {notes.join(' ')}{' '}
          <a href={item.url} target="_blank" rel="noreferrer" data-outside>
            {t('Voir sur GitHub')}
          </a>
        </p>
      )}
    </div>
  )
}

/** What was just posted, with its link, or what went wrong. */
export function DoneLine({ done }: { done: Done }) {
  return (
    <div className={done.warning ? 'inline-error' : 'wait-done'}>
      {done.warning ?? t('Posté sur #{0}.', { 0: done.number })}{' '}
      {done.link && (
        <a href={done.link} target="_blank" rel="noreferrer" data-outside>
          {t('Voir sur GitHub')}
        </a>
      )}
    </div>
  )
}
