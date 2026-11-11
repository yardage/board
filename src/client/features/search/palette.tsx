import { useEffect, useRef, useState } from 'react'
import type { SearchHit } from '../../../server/environment/search.ts'
import { call } from '../../lib/api.ts'
import { itemOfUrl } from '../../lib/subject.ts'
import { Spinner } from '../../components/ui.tsx'
import { localize, t } from '../../../shared/i18n/i18n.ts'

/** `Ctrl+K`: go anywhere, or find anything, from the keyboard. It only reads and moves: nothing here changes anything. */

const COMMANDS: SearchHit[] = [
  { kind: 'doc', title: t('Vue d\'ensemble'), detail: t('aller à'), href: '#vue' },
  { kind: 'doc', title: t('À valider'), detail: t('aller à'), href: '#valider' },
  { kind: 'doc', title: t('Sondages'), detail: t('aller à'), href: '#sondages' },
  { kind: 'doc', title: t('Rapports'), detail: t('aller à'), href: '#rapports' },
  { kind: 'doc', title: t('Réglages'), detail: t('aller à'), href: '#settings' },
]

const WORDS: Record<SearchHit['kind'], string> = { thread: t('fil'), message: t('message'), item: 'github', doc: 'doc', report: t('rapport') }

export function Palette({ onClose, onNewThread, onItem }: { onClose: () => void; onNewThread: () => void; onItem?: (number: number) => void }) {
  const [query, setQuery] = useState('')
  const [found, setFound] = useState<SearchHit[] | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [index, setIndex] = useState(0)
  const list = useRef<HTMLUListElement>(null)
  const field = useRef<HTMLInputElement>(null)
  const opener = useRef(document.activeElement)
  const asking = query.trim().length > 0

  useEffect(() => {
    if (!asking) {
      setFound(null)
      setFailure(null)
      setBusy(false)
      return
    }
    let closed = false
    setBusy(true)
    const timer = setTimeout(() => {
      call<{ hits: SearchHit[] }>(`search?q=${encodeURIComponent(query)}`).then(
        ({ hits }) => {
          if (closed) return
          setFound(hits)
          setFailure(null)
          setIndex(0)
          setBusy(false)
        },
        (error) => {
          if (closed) return
          setFailure((error as Error).message)
          setBusy(false)
        },
      )
    }, 160)
    return () => {
      closed = true
      clearTimeout(timer)
    }
  }, [query, asking])

  // Back where the keyboard was: a thread's composer, in most cases.
  useEffect(
    () => () => {
      if (opener.current instanceof HTMLElement) opener.current.focus()
    },
    [],
  )

  const rows = asking ? (found ?? []) : COMMANDS
  const pick = (hit: SearchHit) => {
    onClose()
    const item = itemOfUrl(hit.href)
    if (item !== null && onItem) onItem(item)
    else if (hit.href.startsWith('#')) location.hash = hit.href
    else window.open(hit.href, '_blank', 'noreferrer')
  }
  useEffect(() => {
    list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [index])

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: the keyboard closes it from the field, with Escape.
    <div className="palette-back" onClick={(event) => event.target === event.currentTarget && onClose()}>
      <div
        className="palette"
        role="dialog"
        aria-modal="true"
        aria-label={t('Rechercher')}
        tabIndex={-1}
        onMouseUp={() => field.current?.focus()}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault()
            onClose()
          } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault()
            const extra = asking ? 0 : 1
            const size = rows.length + extra
            if (size) setIndex((current) => (current + (event.key === 'ArrowDown' ? 1 : size - 1)) % size)
          } else if (event.key === 'Enter') {
            event.preventDefault()
            // The rows still on the screen are for what was typed before.
            if (busy) return
            if (rows[index]) pick(rows[index])
            else if (!asking && index === rows.length) {
              onClose()
              onNewThread()
            }
          }
        }}
      >
        <div className="palette-field">
          <input
            ref={field}
            autoFocus
            role="combobox"
            aria-expanded="true"
            aria-controls="palette-list"
            aria-activedescendant={rows[index] ? `palette-${index}` : undefined}
            value={query}
            placeholder={t('Chercher dans les fils, les tickets, les documents, les rapports…')}
            onChange={(event) => {
              setQuery(event.target.value)
              setIndex(0)
            }}
          />
          {busy && <Spinner />}
        </div>
        <ul id="palette-list" role="listbox" ref={list} aria-label={t('Résultats')}>
          {rows.map((hit, row) => (
            <li key={`${hit.href}-${row}`} id={`palette-${row}`} role="option" aria-selected={row === index} className={row === index ? 'on' : ''} onClick={() => pick(hit)} onMouseMove={() => row !== index && setIndex(row)}>
              <span className="palette-kind">{asking ? WORDS[hit.kind] : '→'}</span>
              <span className="palette-text">
                <strong>{hit.title}</strong>
                <small>{localize(hit.detail)}</small>
              </span>
            </li>
          ))}
          {!asking && (
            <li
              id={`palette-${rows.length}`}
              role="option"
              aria-selected={index === rows.length}
              className={index === rows.length ? 'on' : ''}
              onClick={() => {
                onClose()
                onNewThread()
              }}
              onMouseMove={() => index !== rows.length && setIndex(rows.length)}
            >
              <span className="palette-kind">+</span>
              <span className="palette-text">
                <strong>{t('Nouveau fil')}</strong>
                <small>{t('écrire')}</small>
              </span>
            </li>
          )}
          {asking && !busy && !failure && found?.length === 0 && <li className="palette-none">{t('Rien trouvé sur ce poste.')}</li>}
          {failure && <li className="palette-none inline-error">{failure}</li>}
        </ul>
      </div>
    </div>
  )
}
