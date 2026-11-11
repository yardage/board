import { type ReactNode, useEffect, useRef, useState } from 'react'
import { type AiChoice, type AiChoices, type AiUse, canBeLeftToProgram, modelName, NOT_CHOSEN, parseThreadChoices, type Provider, THREAD_USES, type ThreadChoices, type ThreadUse } from '../../../shared/ai-uses.ts'
import { call } from '../../lib/api.ts'
import { t } from '../../../shared/i18n/i18n.ts'

/** What a thread's panel is told: the program in use, what it offers, and the member's choices for it. */
export interface AiView {
  provider: Provider
  choices: AiChoices
  models: string[]
  efforts: readonly string[]
  thread?: ThreadChoices
}

const EFFORT_NAMES: Record<string, string> = { minimal: t('minimal'), low: t('faible'), medium: t('moyen'), high: t('élevé'), xhigh: t('très élevé'), max: t('maximal') }
export const USE_NAMES: Record<AiUse, string> = {
  reply: t('Réponses de l\'agent'),
  synthesis: t('Synthèses'),
  summary: t('Résumés oraux'),
  translation: t('Traductions'),
  title: t('Titres des fils'),
}
export const USE_HINTS: Record<AiUse, string> = {
  reply: t('Ce que votre agent écrit dans les fils, en votre nom.'),
  synthesis: t('Les décisions et le travail qu’il propose à partir d’un fil.'),
  summary: t('Le résumé de ce qui a été dit de vive voix.'),
  translation: t('La traduction des messages et des rapports que vous ouvrez.'),
  title: t('Le titre donné à un nouveau fil.'),
}

const effortName = (effort: string) => EFFORT_NAMES[effort] ?? effort
const modelWord = (choice: AiChoice) => (choice.model ? modelName(choice.model) : t('par défaut'))
const effortWord = (choice: AiChoice) => (choice.effort ? effortName(choice.effort) : t('par défaut'))
const sameChoice = (a: AiChoice, b: AiChoice) => a.model === b.model && a.effort === b.effort

/** How long a row says it was saved. */
const SAVED_SHOWN_MS = 1600

/** A row's word on its last save: a tick for a moment, or why not. */
function useSaved() {
  const [state, setState] = useState<'idle' | 'saving' | 'saved'>('idle')
  const [error, setError] = useState<string | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  useEffect(() => () => clearTimeout(timer.current), [])
  return {
    state,
    error,
    saving: () => {
      clearTimeout(timer.current)
      setError(null)
      setState('saving')
    },
    saved: () => {
      setState('saved')
      timer.current = setTimeout(() => setState('idle'), SAVED_SHOWN_MS)
    },
    failed: (message: string) => {
      setState('idle')
      setError(message)
    },
  }
}

/** The columns' heads, then a row for each use. */
export function ChoiceTable({ children, label }: { children: ReactNode; label: string }) {
  return (
    <div className="ai-table" role="table" aria-label={label}>
      <div className="ai-head" role="row">
        <span role="columnheader">{t('Usage')}</span>
        <span role="columnheader">{t('Modèle')}</span>
        <span role="columnheader">{t('Effort')}</span>
        <span aria-hidden />
      </div>
      {children}
    </div>
  )
}

/** A native list, drawn as the board draws its fields. A value of its own stands out from the default. */
function Pick({ label, value, options, chosen, disabled, onChange }: { label: string; value: string; options: [string, string][]; chosen: boolean; disabled?: boolean; onChange: (value: string) => void }) {
  return (
    <span className={`ai-pick ${chosen ? 'chosen' : ''}`}>
      <select className="set-input" aria-label={label} value={value} disabled={disabled} onChange={(event) => onChange(event.target.value)}>
        {options.map(([code, name]) => (
          <option key={code} value={code}>
            {name}
          </option>
        ))}
      </select>
    </span>
  )
}

/**
 * One use: its name, a list of models and a list of efforts in their columns, and a way back to the default.
 * `base` is what the row is when nothing is chosen; `leave` names it in each list, and a null model means a model
 * must always be named.
 */
function ChoiceRow({ use, hint, value, base, leave, view, disabled, state, error, resetTitle, onPick }: { use: AiUse; hint?: string; value: AiChoice; base: AiChoice; leave: { model: string | null; effort: string }; view: Pick<AiView, 'models' | 'efforts'>; disabled?: boolean; state: 'idle' | 'saving' | 'saved'; error: string | null; resetTitle: string; onPick: (choice: AiChoice) => void }) {
  // A model picked earlier, which the program no longer lists, stays visible until another is picked.
  const models = value.model && !view.models.includes(value.model) ? [value.model, ...view.models] : view.models
  const modelOptions: [string, string][] = [...(leave.model === null ? [] : [['', leave.model] as [string, string]]), ...models.map((model) => [model, modelName(model)] as [string, string])]
  const effortOptions: [string, string][] = [['', leave.effort], ...view.efforts.map((effort) => [effort, effortName(effort)] as [string, string])]
  const own = !sameChoice(value, base)
  return (
    <div className={`ai-line ${own ? 'own' : ''}`} role="row">
      <span className="ai-use" role="rowheader" title={hint ? undefined : USE_HINTS[use]}>
        <span className="ai-use-name">
          {USE_NAMES[use]}
          {state === 'saved' && !error && (
            <span className="set-ok ai-saved" role="status" aria-label={t('Enregistré')}>
              {' '}
              ✓
            </span>
          )}
        </span>
        {hint && <span className="ai-use-hint">{hint}</span>}
      </span>
      <Pick label={t('Modèle : {0}', { 0: USE_NAMES[use] })} value={value.model} options={modelOptions} chosen={value.model !== base.model} disabled={disabled} onChange={(model) => onPick({ ...value, model })} />
      <Pick label={t('Effort : {0}', { 0: USE_NAMES[use] })} value={value.effort} options={effortOptions} chosen={value.effort !== base.effort} disabled={disabled} onChange={(effort) => onPick({ ...value, effort })} />
      <span className="ai-after">
        {own && (
          <button type="button" className="link" disabled={disabled} title={resetTitle} onClick={() => onPick(base)}>
            {t('défaut')}
          </button>
        )}
      </span>
      {error && <p className="ai-error set-bad">✕ {error}</p>}
    </div>
  )
}

/** In the settings: a row for a use, saved as soon as something is picked. */
export function GeneralChoice({ use, view, base, disabled, onSaved }: { use: AiUse; view: Pick<AiView, 'models' | 'efforts' | 'choices'>; base: AiChoice; disabled?: boolean; onSaved: (view: AiView) => void }) {
  const [value, setValue] = useState(view.choices[use])
  const saved = useSaved()
  useEffect(() => setValue(view.choices[use]), [view.choices, use])
  const pick = (choice: AiChoice) => {
    if (sameChoice(choice, value)) return
    const before = value
    setValue(choice)
    saved.saving()
    call<{ ai: AiView }>('settings/models', { use, ...choice }).then(
      ({ ai }) => {
        saved.saved()
        onSaved(ai)
      },
      (failure: Error) => {
        setValue(before)
        saved.failed(failure.message)
      },
    )
  }
  return (
    <ChoiceRow
      use={use}
      hint={USE_HINTS[use]}
      value={value}
      base={base}
      leave={{ model: canBeLeftToProgram(use) ? t('par défaut') : null, effort: t('par défaut') }}
      view={view}
      disabled={disabled}
      state={saved.state}
      error={saved.error}
      resetTitle={t('Revenir au choix par défaut')}
      onPick={pick}
    />
  )
}

/** Under a thread: a row for a use, with the settings' choice as its default. */
function ThreadRow({ use, view, value, onPick, disabled, saves }: { use: ThreadUse; view: AiView; value: AiChoice; disabled?: boolean; saves: boolean; onPick: (choice: AiChoice) => Promise<void> }) {
  const saved = useSaved()
  const general = view.choices[use]
  const pick = (choice: AiChoice) => {
    if (sameChoice(choice, value)) return
    if (saves) saved.saving()
    onPick(choice).then(
      () => saves && saved.saved(),
      (failure: Error) => saved.failed(failure.message),
    )
  }
  return (
    <ChoiceRow
      use={use}
      value={value}
      base={NOT_CHOSEN}
      leave={{ model: t('réglages · {0}', { 0: general.model ? modelName(general.model) : t('défaut') }), effort: t('réglages · {0}', { 0: general.effort ? effortName(general.effort) : t('défaut') }) }}
      view={view}
      disabled={disabled}
      state={saved.state}
      error={saved.error}
      resetTitle={t('Revenir aux réglages')}
      onPick={pick}
    />
  )
}

const SlidersIcon = () => (
  <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden>
    <path d="M2 4h12M2 8h12M2 12h12" fill="none" stroke="currentColor" strokeWidth="1.5" />
    <circle cx="6" cy="4" r="1.8" fill="var(--bg)" stroke="currentColor" strokeWidth="1.5" />
    <circle cx="11" cy="8" r="1.8" fill="var(--bg)" stroke="currentColor" strokeWidth="1.5" />
    <circle cx="5" cy="12" r="1.8" fill="var(--bg)" stroke="currentColor" strokeWidth="1.5" />
  </svg>
)

/**
 * In the composer's row: a button that says what the next reply runs on, and opens a small panel where the thread's
 * own model and effort are picked for each use. A new thread hands its choices to its first post.
 */
function ThreadLine({ view, choices, disabled, saves, onPick }: { view: AiView | null; choices: ThreadChoices; disabled?: boolean; saves: boolean; onPick: (use: ThreadUse, choice: AiChoice) => Promise<void> }) {
  const [open, setOpen] = useState(false)
  const box = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    if (!open) return
    const close = (event: MouseEvent) => {
      if (!(event.target instanceof Node) || !box.current?.contains(event.target)) setOpen(false)
    }
    const key = (event: KeyboardEvent) => event.key === 'Escape' && setOpen(false)
    addEventListener('mousedown', close)
    addEventListener('keydown', key)
    return () => {
      removeEventListener('mousedown', close)
      removeEventListener('keydown', key)
    }
  }, [open])
  if (!view) return null
  const general = view.choices
  const current = { model: choices.reply?.model || general.reply.model, effort: choices.reply?.effort || general.reply.effort }
  const own = THREAD_USES.some((use) => choices[use]?.model || choices[use]?.effort)
  return (
    <span className="ai-anchor" ref={box}>
      <button type="button" className={`tool ${open || own ? 'on' : ''}`} aria-expanded={open} disabled={disabled} title={t('Réponses : {0}', { 0: `${modelWord(current)}, ${t('effort {0}', { 0: effortWord(current) })}` })} onClick={() => setOpen(!open)}>
        <SlidersIcon /> {t('Modèle')}
      </button>
      {open && (
        <div className="ai-popover" role="dialog" aria-label={t('Modèle et effort pour ce fil')}>
          <h4>{t('Pour ce fil')}</h4>
          <ChoiceTable label={t('Modèle et effort pour ce fil')}>
            {THREAD_USES.map((use) => (
              <ThreadRow key={use} use={use} view={view} value={choices[use] ?? NOT_CHOSEN} disabled={disabled} saves={saves} onPick={(choice) => onPick(use, choice)} />
            ))}
          </ChoiceTable>
          <p className="ai-note">{t('Pour ce fil, et pour votre agent seulement, sur votre forfait. Vaut à partir de son prochain passage. Un modèle ou un effort plus élevé consomme plus.')}</p>
        </div>
      )}
    </span>
  )
}

export function ThreadAi({ threadId, disabled }: { threadId: string; disabled?: boolean }) {
  const [view, setView] = useState<AiView | null>(null)
  const [choices, setChoices] = useState<ThreadChoices>({})
  useEffect(() => {
    let alive = true
    setView(null)
    call<{ ai: AiView }>(`threads/${encodeURIComponent(threadId)}/models`)
      .then(({ ai }) => {
        if (!alive) return
        setView(ai)
        setChoices(ai.thread ?? {})
      })
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [threadId])
  const pick = async (use: ThreadUse, choice: AiChoice) => {
    const before = choices
    setChoices({ ...choices, [use]: choice })
    try {
      await call(`threads/${encodeURIComponent(threadId)}/models`, { use, ...choice })
    } catch (failure) {
      setChoices(before)
      throw failure
    }
  }
  return <ThreadLine view={view} choices={choices} disabled={disabled} saves onPick={pick} />
}

/** A thread that doesn't exist yet: what is chosen here goes with its first message. */
export function NewThreadAi({ choices, onChange }: { choices: ThreadChoices; onChange: (choices: ThreadChoices) => void }) {
  const [view, setView] = useState<AiView | null>(null)
  useEffect(() => {
    let alive = true
    call<{ ai: AiView }>('settings/models')
      .then(({ ai }) => {
        if (alive) setView(ai)
      })
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [])
  const pick = async (use: ThreadUse, choice: AiChoice) => onChange(parseThreadChoices({ ...choices, [use]: choice }))
  return <ThreadLine view={view} choices={choices} saves={false} onPick={pick} />
}
