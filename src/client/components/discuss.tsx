import { createContext, useContext } from 'react'
import type { Subject } from '../lib/subject.ts'
import { t } from '../../shared/i18n/i18n.ts'

/** The ways to open a thread on what is on the screen, and to see the threads already on it. */

interface Linked {
  id: string
  title: string
  status?: string
  subject?: Subject
}

const toDoc = (path: string) => `#d/${encodeURI(path)}`
const toThread = (id: string) => `#t/${encodeURIComponent(id)}`

const sameSubject = (a: Subject, b: Subject) => (a.doc && a.doc === b.doc) || (a.url && a.url === b.url)

export const DiscussContext = createContext<{ threads: Linked[]; discuss: (subject: Subject) => void }>({ threads: [], discuss: () => undefined })

/** Opens a new thread beside what it is about, so that it stays under the person's eyes. */
export function Discuss({ subject, children = t('Ouvrir un fil'), className = 'link' }: { subject: Subject; children?: string; className?: string }) {
  const { discuss } = useContext(DiscussContext)
  return (
    <button type="button" className={className} title={t('Ouvrir un fil lié à {0}, en le gardant sous les yeux', { 0: subject.label })} onClick={() => discuss(subject)}>
      {children}
    </button>
  )
}

/** The threads already opened on it: a question may have been asked. */
export function LinkedThreads({ subject }: { subject: Subject }) {
  const { threads } = useContext(DiscussContext)
  const found = threads.filter((thread) => thread.subject && sameSubject(thread.subject, subject))
  if (!found.length) return null
  // Only an open thread is worth a word here: a closed one is history, found in the threads.
  const open = found.filter((thread) => thread.status !== 'closed')
  if (!open.length) return null
  const shown = open.slice(0, 2)
  const rest = open.length - shown.length
  return (
    <span className="linked-threads">
      {shown.map((thread) => (
        <a key={thread.id} href={toThread(thread.id)} title={thread.title}>
          {t('Fil : {0}', { 0: thread.title })}
        </a>
      ))}
      {rest > 0 && <small>{t('et {0} autres', { 0: rest })}</small>}
    </span>
  )
}

/** What it is about, as a thread's header and the new thread's panel show it. */
export function SubjectLinks({ subject }: { subject: Subject }) {
  return (
    <>
      {subject.doc && <a href={toDoc(subject.doc)}>{subject.label}</a>}
      {!subject.doc && !subject.url && <span>{subject.label}</span>}
      {subject.url && (
        <a href={subject.url} target="_blank" rel="noreferrer">
          {subject.doc ? 'GitHub' : subject.label}
        </a>
      )}
    </>
  )
}
