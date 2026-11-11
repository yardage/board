import type { ReactNode } from 'react'

/**
 * The pieces every settings screen is made of: a row with its label, a choice among a few, a switch, and a word
 * on what just happened. One look for every setting, wherever it is.
 */

export function Row({ label, children, actions, hint }: { label: string; children: ReactNode; actions?: ReactNode; hint?: ReactNode }) {
  return (
    <div className="set-row">
      <span className="set-label">{label}</span>
      <div className="set-value">
        {children}
        {hint && <p className="set-hint">{hint}</p>}
      </div>
      {actions && <div className="set-actions">{actions}</div>}
    </div>
  )
}

/** One among a few: a radio drawn in text, as the rest of the board draws its controls. */
export function Choices<T extends string>({ value, options, onPick, disabled, label }: { value: T; options: [T, string][]; onPick: (value: T) => void; disabled?: boolean; label?: string }) {
  return (
    <span className="set-choices" role="radiogroup" aria-label={label}>
      {options.map(([code, name]) => (
        <button key={code} type="button" role="radio" className="radio" aria-checked={value === code} disabled={disabled} onClick={() => onPick(code)}>
          {value === code ? '(•)' : '( )'} {name}
        </button>
      ))}
    </span>
  )
}

/** On or off, with a label that stays the same whichever it is. */
export function Switch({ on, label, disabled, onFlip }: { on: boolean; label: string; disabled?: boolean; onFlip: () => void }) {
  return (
    <button type="button" role="switch" className="switch" aria-checked={on} disabled={disabled} onClick={onFlip}>
      {on ? '[x]' : '[ ]'} {label}
    </button>
  )
}

/** A heading between groups of rows. */
export function Group({ title, children, note }: { title: string; children: ReactNode; note?: ReactNode }) {
  return (
    <section className="set-group-block">
      <h3 className="set-title">{title}</h3>
      {note && <p className="set-note">{note}</p>}
      {children}
    </section>
  )
}

/** What just happened to a row: saved, or why not. */
export function Saved({ state, error }: { state: 'idle' | 'saving' | 'saved'; error?: string | null }) {
  if (error) return <span className="set-bad">✕ {error}</span>
  if (state === 'saving') return <span className="dim">…</span>
  if (state === 'saved') return <span className="set-ok">✓</span>
  return null
}
