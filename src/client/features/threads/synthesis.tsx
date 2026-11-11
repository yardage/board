import { useEffect, useState } from 'react'
import { call } from '../../lib/api.ts'
import { Spinner } from '../../components/ui.tsx'
import { t } from '../../../shared/i18n/i18n.ts'
import { personOf } from '../../lib/people.tsx'

/**
 * What an agent proposes from a thread: decisions, what is still open, and who would do what. Approving
 * the work is GitHub's business: once nothing is open, any member can turn the work into issues.
 */

interface WorkItem {
  title: string
  owner: string
  repo: string
  what: string
  why: string
  done: string[]
  area: string
  type: string
  milestone: string
  after: number[]
}

export interface Synthesis {
  decisions: string[]
  open: string[]
  work: WorkItem[]
}

export interface SynthesisView {
  id: string
  state: {
    waiting: 'no-work' | 'open' | null
    issues: { index: number; number: number; repo?: string }[]
  }
  translated: Synthesis | null
}

export function SynthesisCard({
  threadId,
  original,
  foreign,
  language,
  view,
  by,
  at,
  later,
  closed,
  repository,
  onChanged,
}: {
  threadId: string
  original: Synthesis
  foreign: boolean
  language: 'fr' | 'en'
  view: SynthesisView
  by: string
  at: string
  later: number
  closed: boolean
  repository: string
  onChanged: () => void
}) {
  const route = `threads/${encodeURIComponent(threadId)}/synthesis/${encodeURIComponent(view.id)}`
  const [fresh, setFresh] = useState<Synthesis | null>(null)
  const [translating, setTranslating] = useState(false)
  const [showOriginal, setShowOriginal] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [creating, setCreating] = useState(false)
  const translated = fresh ?? view.translated

  const translate = async (again = false) => {
    setTranslating(true)
    setFailure(null)
    try {
      setFresh((await call<{ synthesis: Synthesis }>(`${route}/translate`, { to: language, again })).synthesis)
    } catch (error) {
      setFailure((error as Error).message)
    } finally {
      setTranslating(false)
    }
  }
  // Like a report, it opens in the person's language: it is there to be read.
  useEffect(() => {
    if (foreign && !translated) void translate()
  }, [foreign, view.id])

  const shown = foreign && translated && !showOriginal ? translated : original
  const { state } = view
  const created = new Map(state.issues.map((issue) => [issue.index, issue]))
  const allCreated = original.work.length > 0 && created.size === original.work.length
  const repoOf = (item: WorkItem) => item.repo || repository.replace(/^https:\/\/github\.com\//, '')
  const targets = [...new Set(original.work.map(repoOf))]
  const owners = [...new Set(shown.work.map((item) => item.owner.toLowerCase()))]

  const create = async () => {
    setCreating(true)
    setFailure(null)
    try {
      await call(`${route}/issues`, {})
    } catch (error) {
      setFailure((error as Error).message)
    } finally {
      setCreating(false)
      setConfirming(false)
      onChanged()
    }
  }

  return (
    <article className="syn">
      <header className="syn-head">
        <strong>{t('Synthèse')}</strong>
        <small>{t('par {0} · {1} · Une proposition : rien n\'est décidé sans les membres.', { 0: by, 1: at })}</small>
      </header>
      {foreign && (
        <div className="message-foot">
          {translating && (
            <>
              <Spinner /> <span>{t('Traduction…')}</span>
            </>
          )}
          {!translating && translated && (
            <>
              {!showOriginal && <span>{t('Traduit par votre Claude Code')}</span>}
              <button type="button" className="link" onClick={() => setShowOriginal(!showOriginal)}>
                {showOriginal ? t('Voir la traduction') : t('Voir l\'original')}
              </button>
            </>
          )}
          {!translating && !translated && (
            <button type="button" className="link" onClick={() => void translate(true)}>
              {t('Traduire')}
            </button>
          )}
        </div>
      )}

      {shown.decisions.length > 0 && (
        <>
          <h3>{t('Décisions proposées')}</h3>
          <ul className="syn-decisions">
            {shown.decisions.map((text, index) => (
              <li key={index}>{text}</li>
            ))}
          </ul>
        </>
      )}

      {shown.open.length > 0 && (
        <>
          <h3>{t('À trancher')}</h3>
          {shown.open.map((text, index) => (
            <div key={index} className="syn-open">
              <span>▲</span> {text}
            </div>
          ))}
          <p className="syn-note">{t('Un membre tranche : répondez dans le fil, puis synthétisez à nouveau.')}</p>
        </>
      )}

      {shown.work.length > 0 && (
        <>
          <h3>{t('Répartition proposée')}</h3>
          {owners.map((owner) => (
            <div key={owner} className="syn-lane">
              <div className="syn-lane-name">{personOf(owner).name}</div>
              <div className="syn-items">
                {shown.work.map((item, index) => {
                  if (item.owner.toLowerCase() !== owner) return null
                  const issue = created.get(index)
                  const repo = issue?.repo ?? repoOf(original.work[index])
                  return (
                    <details key={`${index}-${item.title}`} className="syn-item">
                      <summary>
                        {issue && (
                          <a href={`https://github.com/${repo}/issues/${issue.number}`} target="_blank" rel="noreferrer">
                            {repo === repoOf({ ...item, repo: '' }) ? '' : repo}#{issue.number}
                          </a>
                        )}{' '}
                        {item.title}
                        {item.after.length > 0 && <small>{t('après :')}{' '}{item.after.map((other) => `« ${shown.work[other]?.title} »`).join(', ')}</small>}
                      </summary>
                      <p>{item.what}</p>
                      <p className="syn-why">{item.why}</p>
                      <ul>
                        {item.done.map((check, checkIndex) => (
                          <li key={checkIndex}>{check}</li>
                        ))}
                      </ul>
                      <small>{[repoOf(original.work[index]), item.type, item.area, item.milestone].filter(Boolean).join(' · ')}</small>
                    </details>
                  )
                })}
              </div>
            </div>
          ))}
        </>
      )}

      <footer className="syn-foot">
        {state.waiting === 'open' && <span>{t('Créer les tickets : possible une fois tout tranché.')}</span>}
        {state.waiting === 'no-work' && <span>{t('Cette synthèse ne propose aucun travail.')}</span>}
        {allCreated && <span className="syn-yes">{t('✓ Tickets créés et assignés.')}</span>}
        {state.waiting === null && !allCreated && !confirming && !creating && !closed && (
          <button type="button" className="ghost" onClick={() => setConfirming(true)}>
            {created.size ? t('Créer les tickets restants') : t('Créer les tickets')}
          </button>
        )}
        {confirming && !creating && (
          <>
            <span>{t('Créer {0} ticket(s) dans {1} avec votre compte GitHub, et les assigner ?', { 0: original.work.length - created.size, 1: targets.join(', ') })}</span>
            <button type="button" className="ghost" onClick={() => void create()}>
              {t('Confirmer')}
            </button>
            <button type="button" className="link" onClick={() => setConfirming(false)}>
              {t('Annuler')}
            </button>
          </>
        )}
        {creating && !allCreated && (
          <>
            <Spinner /> <span>{t('Création des tickets…')}</span>
          </>
        )}
      </footer>
      {later > 0 && !allCreated && <p className="syn-note">{t('Le fil a continué depuis cette synthèse : synthétisez à nouveau si cela change quelque chose.')}</p>}
      {failure && <div className="inline-error">{failure}</div>}
    </article>
  )
}
