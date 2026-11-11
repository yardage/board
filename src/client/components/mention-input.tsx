import { forwardRef, type KeyboardEvent, type TextareaHTMLAttributes, useImperativeHandle, useMemo, useRef, useState } from 'react'
import { t } from '../../shared/i18n/i18n.ts'
import { Avatar, members } from '../lib/people.tsx'

/**
 * A text box where "@" names a member: the few whose login or name starts like what was typed appear under the
 * caret, and Enter, Tab or a click writes the mention. The same for a hundred members as for two: nobody is listed
 * until asked for.
 */

const SHOWN = 6
/** "@vic" before the caret, or nothing. */
const MENTION_BEFORE_CARET = /(?:^|[\s(])@([A-Za-z0-9-]{0,39})$/

export interface MentionTextareaHandle {
  focus: () => void
  element: HTMLTextAreaElement | null
}

type Props = Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'value' | 'onChange'> & {
  value: string
  onChange: (value: string) => void
  /** The member writing, who isn't offered to themselves. */
  me: string
  /** Ctrl+Enter, or whatever the box is in wants on it. Runs before the mention keys. */
  onSubmitKey?: () => void
}

export const MentionTextarea = forwardRef<MentionTextareaHandle, Props>(function MentionTextarea({ value, onChange, me, onSubmitKey, onKeyDown, onSelect, ...rest }, ref) {
  const area = useRef<HTMLTextAreaElement>(null)
  const [caret, setCaret] = useState(0)
  const [picked, setPicked] = useState(0)
  useImperativeHandle(ref, () => ({ focus: () => area.current?.focus(), element: area.current }), [])

  const asking = useMemo(() => {
    const match = MENTION_BEFORE_CARET.exec(value.slice(0, caret))
    if (!match) return null
    const wanted = match[1].toLowerCase()
    const found = members()
      .filter((member) => member.login.toLowerCase() !== me.toLowerCase() && (member.login.toLowerCase().startsWith(wanted) || member.name.toLowerCase().startsWith(wanted)))
      .slice(0, SHOWN)
    return found.length ? { from: caret - match[1].length - 1, found } : null
  }, [value, caret, me])

  const complete = (login: string) => {
    if (!asking) return
    const next = `${value.slice(0, asking.from)}@${login} ${value.slice(caret)}`
    onChange(next)
    const at = asking.from + login.length + 2
    requestAnimationFrame(() => {
      area.current?.focus()
      area.current?.setSelectionRange(at, at)
      setCaret(at)
    })
  }

  const keyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && onSubmitKey) {
      event.preventDefault()
      onSubmitKey()
      return
    }
    if (asking) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault()
        setPicked((current) => (current + (event.key === 'ArrowDown' ? 1 : asking.found.length - 1)) % asking.found.length)
        return
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        event.preventDefault()
        complete(asking.found[picked]?.login ?? asking.found[0].login)
        return
      }
      if (event.key === 'Escape') {
        setCaret(-1)
        return
      }
    }
    onKeyDown?.(event)
  }

  return (
    <span className="mention-box">
      <textarea
        {...rest}
        ref={area}
        value={value}
        onChange={(event) => {
          onChange(event.target.value)
          setCaret(event.target.selectionStart ?? event.target.value.length)
          setPicked(0)
        }}
        onSelect={(event) => {
          setCaret((event.target as HTMLTextAreaElement).selectionStart ?? 0)
          onSelect?.(event)
        }}
        onKeyDown={keyDown}
      />
      {asking && (
        <ul className="mention-suggest" role="listbox" aria-label={t('Membres')}>
          {asking.found.map((member, index) => (
            <li key={member.login} role="option" aria-selected={index === picked}>
              <button type="button" className={index === picked ? 'on' : ''} onMouseDown={(event) => event.preventDefault()} onClick={() => complete(member.login)}>
                <Avatar login={member.login} size={16} /> {member.name} <small>@{member.login}</small>
              </button>
            </li>
          ))}
        </ul>
      )}
    </span>
  )
})
