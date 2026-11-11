import type { ReactNode } from 'react'
import { t } from '../../../shared/i18n/i18n.ts'

/**
 * What the environment's parts are drawn with: a text box that is text for whoever can't change it, a tick in a grid,
 * a list with its empty state and its "add" under it. One size per kind of box, so that fields line up from part to part.
 */

export type Width = 'short' | 'medium' | 'long' | 'full'

/** A box for an admin; for anyone else, the value as text, or a dash. */
export function TextBox({ value, onChange, editable, placeholder, label, width = 'medium', problem, list, type = 'text', min, max, step, autoFocus, suffix }: { value: string | number; onChange: (value: string) => void; editable: boolean; placeholder?: string; label: string; width?: Width; problem?: string; list?: string; type?: 'text' | 'number'; min?: number; max?: number; step?: number; autoFocus?: boolean; suffix?: string }) {
  if (!editable)
    return (
      <span className={`set-text ${value === '' ? 'dim' : ''}`}>
        {value === '' ? '—' : value}
        {value !== '' && suffix ? ` ${suffix}` : ''}
      </span>
    )
  return (
    <span className={`set-box ${width}`}>
      <input
        className={`set-input ${problem ? 'wrong' : ''}`}
        type={type}
        value={value}
        min={min}
        max={max}
        step={step}
        list={list}
        placeholder={placeholder}
        aria-label={label}
        aria-invalid={problem ? true : undefined}
        spellCheck={false}
        autoComplete="off"
        // biome-ignore lint/a11y/noAutofocus: a row just added gets the focus, where the person is about to type.
        autoFocus={autoFocus}
        onChange={(event) => onChange(event.target.value)}
      />
      {suffix && <span className="dim">{suffix}</span>}
    </span>
  )
}

/** One among a few, as a list; for anyone else, the name of the one chosen. */
export function Pick<T extends string>({ value, options, onPick, editable, label }: { value: T; options: [T, string][]; onPick: (value: T) => void; editable: boolean; label: string }) {
  if (!editable) return <span className="set-text">{options.find(([code]) => code === value)?.[1] ?? value}</span>
  return (
    <select className="set-input" value={value} aria-label={label} onChange={(event) => onPick(event.target.value as T)}>
      {options.map(([code, name]) => (
        <option key={code} value={code}>
          {name}
        </option>
      ))}
    </select>
  )
}

/** A yes or no in a grid: `[x]` to click for an admin, a mark for anyone else. */
export function Tick({ on, label, editable, onFlip }: { on: boolean; label: string; editable: boolean; onFlip: () => void }) {
  if (!editable)
    return (
      <span className={on ? 'set-tick on' : 'set-tick'} role="img" aria-label={t('{0} : {1}', { 0: label, 1: on ? t('oui') : t('non') })}>
        {on ? '✓' : '·'}
      </span>
    )
  return (
    <button type="button" role="checkbox" aria-checked={on} aria-label={label} title={label} className={on ? 'set-tick on' : 'set-tick'} onClick={onFlip}>
      {on ? '[x]' : '[ ]'}
    </button>
  )
}

/** What is wrong with a field, under it. */
export function Problem({ text }: { text?: string }) {
  return text ? <small className="set-problem">▲ {text}</small> : null
}

/** A list of the configuration: its rows, what to do when it is empty, and the way to add one, under the last row. */
export function ListBlock({ count, empty, editable, onAdd, addLabel, full, children }: { count: number; empty: ReactNode; editable: boolean; onAdd: () => void; addLabel: string; full?: boolean; children: ReactNode }) {
  return (
    <div className="set-list">
      {count === 0 ? <p className="set-empty">{empty}</p> : children}
      {editable && (
        <div className="set-list-add">
          <button type="button" className="ghost" disabled={full} onClick={onAdd}>
            {addLabel}
          </button>
          {full && <small className="dim">{t('La liste est pleine.')}</small>}
        </div>
      )}
    </div>
  )
}

/** The last column of a row: take it out of the list. */
export function RemoveButton({ what, onRemove }: { what: string; onRemove: () => void }) {
  return (
    <button type="button" className="link set-remove" aria-label={t('Retirer {0}', { 0: what || t('cette ligne') })} title={t('Retirer')} onClick={onRemove}>
      {t('Retirer')}
    </button>
  )
}

/** For anyone who can't change the configuration: why the boxes are text. */
export function ReadOnlyNote() {
  return <p className="set-readonly">{t('Seul un administrateur de l’environnement change ces réglages : vous les voyez tels qu’ils sont.')}</p>
}
