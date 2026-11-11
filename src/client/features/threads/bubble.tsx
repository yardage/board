import { memo, type ReactNode, useState } from 'react'
import { call } from '../../lib/api.ts'
import type { Attachment, Message } from '../../lib/types.ts'
import { type Language, t } from '../../../shared/i18n/i18n.ts'
import { Markdown, when } from '../../components/markdown.tsx'
import { Avatar, personOf } from '../../lib/people.tsx'
import { toDoc } from '../../app/routes.ts'
import { ActionsList } from './thread-parts.tsx'
import { Spinner } from '../../components/ui.tsx'

const isImage = (file: string) => /\.(png|jpe?g|gif|webp)$/i.test(file)
export const sizeOf = (bytes: number) => (bytes < 1024 * 1024 ? t('{0} Ko', { 0: Math.max(1, Math.round(bytes / 1024)) }) : t('{0} Mo', { 0: (bytes / (1024 * 1024)).toFixed(1).replace('.', ',') }))

function Attachments({ threadId, files }: { threadId: string; files: Attachment[] }) {
  const [shown, setShown] = useState<string | null>(null)
  const link = (file: string) => `/api/threads/${encodeURIComponent(threadId)}/attachments/${encodeURIComponent(file)}`
  return (
    <div className="attachments">
      {files.map((attachment) =>
        isImage(attachment.file) ? (
          <button key={attachment.file} type="button" className="thumb" title={attachment.name} onClick={() => setShown(attachment.file)}>
            <img src={link(attachment.file)} alt={attachment.name} loading="lazy" />
          </button>
        ) : (
          <a key={attachment.file} className="file" href={link(attachment.file)} download={attachment.name} title={t('Télécharger')}>
            <PaperclipIcon />
            <span>{attachment.name}</span>
            <small>{sizeOf(attachment.size)}</small>
          </a>
        ),
      )}
      {shown && (
        <div className="overlay lightbox" role="presentation" onClick={() => setShown(null)}>
          <img src={link(shown)} alt={t('')} />
        </div>
      )}
    </div>
  )
}

export function PaperclipIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden>
      <path d="M13.5 7.5l-5.6 5.6a3.3 3.3 0 01-4.7-4.7l6-6a2.2 2.2 0 013.1 3.1l-6 6a1.1 1.1 0 01-1.6-1.6l5.3-5.2" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

/** A spoken part is a line per passage, and a single line break means nothing in Markdown. */
const spokenLines = (message: Message, text: string) => (message.voice ? text.replace(/\n+(?=\[\d)/g, '\n\n') : text)

export const Bubble = memo(function Bubble({ message, threadId, language, saved, poll }: { message: Message; threadId: string; language: Language; saved?: string; poll?: ReactNode }) {
  const person = personOf(message.author)
  const byAgent = message.agent === 'auto'
  const [fresh, setFresh] = useState<string | null>(null)
  const [original, setOriginal] = useState(false)
  const [translating, setTranslating] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const translation = fresh ?? saved
  const foreign = Boolean(message.language && message.language !== language)
  const translate = async () => {
    setTranslating(true)
    setFailure(null)
    try {
      const found = await call<{ body: string }>(`threads/${encodeURIComponent(threadId)}/messages/${encodeURIComponent(message.id)}/translate`, { to: language })
      setFresh(found.body)
      setOriginal(false)
    } catch (error) {
      setFailure((error as Error).message)
    } finally {
      setTranslating(false)
    }
  }
  if (message.status) {
    return (
      <div className="status-line">
        {person.name} · {message.body} · {when(message.createdAt)}
      </div>
    )
  }
  return (
    <article className={`message ${byAgent ? 'from-agent' : 'from-person'}`}>
      <Avatar login={message.author} agent={byAgent} />
      <div className="message-body">
        <header>
          <strong>{person.name}</strong>
          {byAgent && <span className="tag" title={t('Écrit par l\'agent de {0}, en son nom, sans relecture.', { 0: person.name })}>{t('par son agent')}</span>}
          {message.agent === 'draft' && <span className="tag" title={t('Préparé par son agent, relu et envoyé par {0}.', { 0: person.name })}>{t('avec son agent')}</span>}
          {message.voice && <span className="tag" title={t('Transcrit de sa voix, puis relu : un mot peut rester mal entendu.')}>{t('à la voix')}</span>}
          {message.voiceSummary && <span className="tag" title={t('Résumé de ce que chacun a publié à la voix. Ce qui y semble acquis ne l\'est que si vous l\'écrivez.')}>{t('résumé de la conversation')}</span>}
          <time>{when(message.createdAt)}</time>
        </header>
        {message.body && (
          <div className="prose">
            <Markdown text={spokenLines(message, foreign && translation && !original ? translation : message.body)} />
          </div>
        )}
        {foreign && (
          <div className="message-foot">
            {translating && (
              <>
                <Spinner /> <span>{t('Traduction…')}</span>
              </>
            )}
            {!translating && !translation && (
              <button type="button" className="link" onClick={() => void translate()}>
                {t('Traduire')}
              </button>
            )}
            {!translating && translation && (
              <>
                {!original && <span>{t('Traduit par votre Claude Code')}</span>}
                <button type="button" className="link" onClick={() => setOriginal(!original)}>
                  {original ? t('Voir la traduction') : t('Voir l\'original')}
                </button>
              </>
            )}
            {failure && <span className="inline-error">{failure}</span>}
          </div>
        )}
        {poll}
        {message.attachments.length > 0 && <Attachments threadId={threadId} files={message.attachments} />}
        {message.actions && <ActionsList actions={message.actions} />}
        {message.sources.length > 0 && (
          <details className="sources">
            <summary>
              {t('{0} document', { 0: message.sources.length })}{message.sources.length > 1 ? 's' : ''}{' '}{t('consulté')}{message.sources.length > 1 ? 's' : ''}
            </summary>
            <ul>
              {message.sources.map((source) => (
                <li key={source}>
                  <a href={toDoc(source)}>{source}</a>
                </li>
              ))}
            </ul>
          </details>
        )}
      </div>
    </article>
  )
})
