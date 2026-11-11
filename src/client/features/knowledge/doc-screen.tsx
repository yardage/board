import { useEffect, useState } from 'react'
import { call } from '../../lib/api.ts'
import { Discuss, LinkedThreads } from '../../components/discuss.tsx'
import { type Language, t } from '../../../shared/i18n/i18n.ts'
import { Markdown } from '../../components/markdown.tsx'
import { subjectOfDoc } from '../../lib/subject.ts'
import { Blocks, percent } from '../../components/ui.tsx'

interface Doc {
  content: string
  kind: 'markdown' | 'html' | 'text'
  language: Language | null
}
interface Translation {
  status: 'idle' | 'running' | 'done' | 'failed'
  done: number
  total: number
  kept: number
  error: string | null
}
const LANGUAGE_NAMES: Record<Language, string> = { fr: t('français'), en: t('anglais') }
const TRANSLATION_POLL_MS = 700

export function DocScreen({ path, language }: { path: string; language: Language }) {
  const [doc, setDoc] = useState<Doc | null>(null)
  const [missing, setMissing] = useState(false)
  /** The language asked for: a report opens in the person's own, and its original costs nothing. */
  const [wanted, setWanted] = useState<Language>(language)
  /** Set once a translation is on screen: it is what the page's address carries. */
  const [shown, setShown] = useState<Language | null>(null)
  const [job, setJob] = useState<Translation | null>(null)
  /** How many times the person asked to try again: only that retries what a check refused. */
  const [attempt, setAttempt] = useState(0)
  const docPath = `doc?path=${encodeURIComponent(path)}`

  useEffect(() => {
    let closed = false
    call<Doc>(docPath)
      .then((found) => {
        if (!closed) setDoc(found)
      })
      .catch(() => {
        if (!closed) setMissing(true)
      })
    return () => {
      closed = true
    }
  }, [docPath])

  const source = doc?.language ?? null
  useEffect(() => {
    if (!source) return
    let closed = false
    const showOriginal = async () => {
      setJob(null)
      const first = await call<Doc>(docPath)
      if (closed) return
      setDoc(first)
      setShown(null)
    }
    const translate = async () => {
      let state = await call<Translation>('translate/doc', { path, to: wanted, again: attempt > 0 })
      while (!closed && state.status === 'running') {
        setJob(state)
        await new Promise((done) => setTimeout(done, TRANSLATION_POLL_MS))
        if (closed) return
        state = await call<Translation>(`translate/doc?path=${encodeURIComponent(path)}&to=${wanted}`)
      }
      if (closed) return
      setJob(state)
      if (state.status === 'failed') return
      const translated = await call<Doc>(`${docPath}&lang=${wanted}`)
      if (closed) return
      setDoc(translated)
      setShown(wanted)
    }
    ;(source === wanted ? showOriginal() : translate()).catch((failure) => {
      if (!closed) setJob({ status: 'failed', done: 0, total: 0, kept: 0, error: (failure as Error).message })
    })
    return () => {
      closed = true
      // Leaving, or going back to the original: what hasn't started won't be paid for.
      if (source !== wanted) void call('translate/doc', { path, to: wanted, cancel: true }).catch(() => undefined)
    }
  }, [path, source, wanted, attempt])

  const crumbs = path.split('/')
  return (
    <section className="doc">
      <header className="doc-head">
        <nav className="crumbs" aria-label={t('Chemin')}>
          {crumbs.map((part, index) => (
            <span key={`${part}-${index}`} className={index === crumbs.length - 1 ? 'here' : ''}>
              {part}
            </span>
          ))}
        </nav>
        <div className="doc-actions">
          {source && (
            <div className="lang" role="group" aria-label={t('Langue du rapport')}>
              {(['fr', 'en'] as const).map((code) => (
                <button key={code} type="button" className={wanted === code ? 'on' : ''} aria-pressed={wanted === code} onClick={() => setWanted(code)}>
                  {code}
                </button>
              ))}
            </div>
          )}
          <LinkedThreads subject={subjectOfDoc(path, doc?.content)} />
          <Discuss subject={subjectOfDoc(path, doc?.content)} className="ghost">
            {t('Ouvrir un fil sur ce document')}
          </Discuss>
        </div>
      </header>
      {job?.status === 'running' && (
        <div className="doc-note">
          <Blocks ratio={job.total ? job.done / job.total : 0} />
          <span>
            {t('Traduction en {0} ·', { 0: LANGUAGE_NAMES[wanted] })}{' '}{percent(job.total ? job.done / job.total : 0)}{' '}{t('· {0} sur {1} · par votre Claude Code. L\'original reste affiché en attendant.', { 0: job.done, 1: job.total })}
          </span>
        </div>
      )}
      {job?.status === 'failed' && (
        <div className="doc-note">
          <span className="bad">{t('✕ Traduction impossible : {0}. L\'original reste affiché.', { 0: job.error })}</span>
          <button type="button" className="link" onClick={() => setAttempt(attempt + 1)}>
            {t('Réessayer')}
          </button>
        </div>
      )}
      {job?.status === 'done' && job.kept > 0 && (
        <div className="doc-note">
          <span>
            {job.kept > 1 ? t('{0} parties laissées dans leur langue d’origine : {1}.', { 0: job.kept, 1: job.error }) : t('Une partie laissée dans sa langue d’origine : {0}.', { 0: job.error })}
          </span>
          <button type="button" className="link" onClick={() => setAttempt(attempt + 1)}>
            {t('Réessayer')}
          </button>
        </div>
      )}
      {missing && <div className="empty">{t('Ce document n\'est pas disponible sur ce poste.')}</div>}
      {doc?.kind === 'markdown' && (
        <div className="doc-scroll" key={path}>
          <div className="prose doc-prose" lang={shown ?? source ?? undefined}>
            <Markdown text={doc.content.replace(/^---\n[\s\S]*?\n---\n/, '')} from={path} />
          </div>
        </div>
      )}
      {doc?.kind === 'text' && (
        <div className="doc-scroll" key={path}>
          <pre className="doc-text">{doc.content}</pre>
        </div>
      )}
      {doc?.kind === 'html' && <iframe key={shown ?? t('original')} title={path} sandbox="allow-scripts" src={`/api/doc/page?path=${encodeURIComponent(path)}${shown ? `&lang=${shown}` : ''}`} />}
    </section>
  )
}
