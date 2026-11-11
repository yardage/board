import { useCallback, useEffect, useMemo, useState } from 'react'
import { call } from '../../lib/api.ts'
import { t } from '../../../shared/i18n/i18n.ts'
import { changedParts, type EnvironmentConfig, type EnvironmentView, type Problems, problemParts, problemsOf } from './environment-config.ts'
import type { EnvironmentSection } from './settings-sections.ts'
import { Loading } from '../../components/ui.tsx'

/**
 * One draft for the whole configuration, above its parts: going from one part to another keeps what was changed, and
 * one save sends it all. The draft starts from what the environment has, and follows it while nothing is changed.
 */

export interface EnvironmentEditor {
  view: EnvironmentView
  draft: EnvironmentConfig
  /** An admin, and no save under way. */
  editable: boolean
  set: (change: Partial<EnvironmentConfig>) => void
  problems: Problems
  /** Something outside the draft changed, such as the protection: the settings read again. */
  onChange: () => void
}

export interface EnvironmentDraft {
  editor: EnvironmentEditor | null
  dirty: boolean
  changed: Set<EnvironmentSection>
  broken: Set<EnvironmentSection>
  state: 'idle' | 'saving' | 'saved'
  error: string | null
  /** The environment's configuration changed under a draft: saving would replace what someone else saved. */
  stale: boolean
  save: () => Promise<boolean>
  discard: () => void
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

/**
 * The draft outlives the settings page: leaving them by the search, a link or the back button, rather than by closing
 * them, keeps the changes, and they are still there, unsaved, when the person comes back. Only for the same environment.
 */
let kept: { repo: string; base: EnvironmentConfig; draft: EnvironmentConfig } | null = null
/** What was kept for this environment, if it holds changes: a clean draft is taken anew from what the environment says. */
const keptFor = (view: EnvironmentView | null) => (kept && view && kept.repo === view.repo && !same(kept.draft, kept.base) ? { base: kept.base, draft: kept.draft } : null)

export function useEnvironmentDraft(view: EnvironmentView | null, onSaved: () => void): EnvironmentDraft {
  /** `base` is what the draft started from: the environment's configuration when nothing was changed yet. */
  const [held, setHeld] = useState<{ base: EnvironmentConfig; draft: EnvironmentConfig } | null>(() => keptFor(view))
  const [state, setState] = useState<'idle' | 'saving' | 'saved'>('idle')
  const [error, setError] = useState<string | null>(null)
  const latest = view?.config ?? null

  const dirty = Boolean(held && !same(held.draft, held.base))
  // A new reading of the environment is taken as it is while nothing is changed; under changes, they are kept, and
  // taken once the changes are gone, undone by hand or discarded.
  useEffect(() => {
    if (!latest) return
    setHeld((now) => {
      if (!now && keptFor(view)) return keptFor(view)
      return !now || (!same(now.base, latest) && same(now.draft, now.base)) ? { base: latest, draft: latest } : now
    })
  }, [latest, dirty])
  useEffect(() => {
    if (held && view) kept = { repo: view.repo, ...held }
  }, [held, view])

  const draft = held?.draft ?? null
  const base = held?.base ?? null
  const stale = Boolean(dirty && base && latest && !same(base, latest))
  const problems = useMemo(() => (draft ? problemsOf(draft) : {}), [draft])
  const changed = useMemo(() => (draft && base ? changedParts(draft, base) : new Set<EnvironmentSection>()), [draft, base])
  const broken = useMemo(() => problemParts(problems), [problems])

  const set = useCallback((change: Partial<EnvironmentConfig>) => {
    setHeld((now) => (now ? { ...now, draft: { ...now.draft, ...change } } : now))
    setState('idle')
    setError(null)
  }, [])

  const save = async () => {
    if (!draft || Object.keys(problems).length > 0) return false
    setState('saving')
    setError(null)
    try {
      const { config } = await call<{ config: EnvironmentConfig }>('environment/config', { config: draft, base })
      setHeld({ base: config, draft: config })
      setState('saved')
      onSaved()
      return true
    } catch (failure) {
      setState('idle')
      setError((failure as Error).message)
      // Refused because the configuration changed: reading it again shows the changes beside the draft, which stays.
      onSaved()
      return false
    }
  }

  const discard = () => {
    if (latest) setHeld({ base: latest, draft: latest })
    setState('idle')
    setError(null)
  }

  const editor = view && draft ? { view, draft, editable: view.admin && state !== 'saving', set, problems, onChange: onSaved } : null
  return { editor, dirty, changed, broken, state, error, stale, save, discard }
}

/** Under the scrolling part, never over it: what is changed, what is wrong, and the one save for every part. */
export function SaveBar({ env, names }: { env: EnvironmentDraft; names: Record<EnvironmentSection, string> }) {
  const list = (parts: Set<EnvironmentSection>) => [...parts].map((part) => names[part]).join(', ')
  const wrong = env.editor ? Object.keys(env.editor.problems).length : 0
  const busy = env.state === 'saving'
  let status = <span className="dim">{t('Rien à enregistrer.')}</span>
  if (busy) status = <Loading>{t('Envoi de la configuration…')}</Loading>
  else if (env.error) status = <span className="set-bad">✕ {env.error}</span>
  else if (env.dirty && wrong > 0) status = <span className="set-warn">{t('▲ {0} à corriger · {1}', { 0: wrong === 1 ? t('1 champ') : t('{0} champs', { 0: wrong }), 1: list(env.broken) })}</span>
  else if (env.stale) status = <span className="set-warn">{t('▲ La configuration a changé entre-temps : annuler reprend la nouvelle, enregistrer la remplace.')}</span>
  else if (env.dirty) status = <span className="set-new">{t('● Modifications non enregistrées · {0}', { 0: list(env.changed) })}</span>
  else if (env.state === 'saved') status = <span className="set-ok">{t('✓ Enregistrée et envoyée à tous les membres.')}</span>
  return (
    <footer className="set-savebar" aria-live="polite">
      <div className="set-savebar-status">{status}</div>
      <button type="button" className="ghost" disabled={busy || !env.dirty} onClick={env.discard}>
        {t('Annuler les modifications')}
      </button>
      <button type="button" className="send" disabled={busy || !env.dirty || wrong > 0} onClick={() => void env.save()}>
        {t('Enregistrer')}
      </button>
    </footer>
  )
}

/** Asked before unsaved changes would be lost: by closing the settings, or by leaving the environment's parts. */
export function LeaveQuestion({ env, names, closing, onStay, onLeave }: { env: EnvironmentDraft; names: Record<EnvironmentSection, string>; closing: boolean; onStay: () => void; onLeave: () => void }) {
  const wrong = env.editor ? Object.keys(env.editor.problems).length : 0
  const busy = env.state === 'saving'
  return (
    <div className="set-ask-scrim" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onStay()}>
      <div className="set-ask" role="alertdialog" aria-modal="true" aria-labelledby="set-ask-title" aria-describedby="set-ask-text">
        <h3 id="set-ask-title">{t('Modifications non enregistrées')}</h3>
        <p id="set-ask-text">
          {closing ? t('Fermer les réglages les abandonne : {0}.', { 0: [...env.changed].map((part) => names[part]).join(', ') }) : t('Quitter l’environnement les abandonne : {0}.', { 0: [...env.changed].map((part) => names[part]).join(', ') })}
        </p>
        {env.stale && <p className="set-warn">{t('▲ La configuration a changé entre-temps : enregistrer remplacerait ce qu’un autre administrateur a enregistré.')}</p>}
        {env.error && <p className="set-bad">✕ {env.error}</p>}
        <div className="set-ask-actions">
          {/* biome-ignore lint/a11y/noAutofocus: the safe answer has the focus, so Enter keeps the changes. */}
          <button type="button" className="ghost" autoFocus disabled={busy} onClick={onStay}>
            {t('Continuer à modifier')}
          </button>
          <button
            type="button"
            className="link danger"
            disabled={busy}
            onClick={() => {
              env.discard()
              onLeave()
            }}
          >
            {t('Abandonner')}
          </button>
          <button type="button" className="send" disabled={busy || wrong > 0} onClick={() => void env.save().then((saved) => saved && onLeave())}>
            {busy ? t('Envoi…') : t('Enregistrer')}
          </button>
        </div>
      </div>
    </div>
  )
}
