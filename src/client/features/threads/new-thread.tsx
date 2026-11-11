import { useEffect, useRef, useState } from 'react'
import { NewThreadAi } from '../settings/ai-choice.tsx'
import type { ThreadChoices } from '../../../shared/ai-uses.ts'
import { call } from '../../lib/api.ts'
import type { Me, Thread } from '../../lib/types.ts'
import { Composer } from './composer.tsx'
import { SubjectLinks } from '../../components/discuss.tsx'
import { t } from '../../../shared/i18n/i18n.ts'
import { toThread } from '../../lib/people.tsx'
import { type Subject, subjectLink } from '../../lib/subject.ts'

/**
 * Without a subject, a window over the page. With one, a panel beside it that moves nothing out of sight: the
 * person came to ask about what is on the screen, and goes on reading it while they write.
 */

/** A thread that doesn't exist yet: the first message makes it, and its title comes from that message. */
export function NewThreadScreen({ me }: { me: Me }) {
  const zone = useRef<HTMLElement>(null)
  const [models, setModels] = useState<ThreadChoices>({})
  return (
    <section className="chat" ref={zone}>
      <header className="chat-head">
        <div>
          <h1 className="thread-title">{t('Nouveau fil')}</h1>
        </div>
      </header>
      <div className="messages">
        <div className="empty">{t('Posez votre question, ou lancez un sondage. Le titre viendra du message, et vous pourrez le changer. Mentionnez un membre pour qu\'il soit prévenu : son agent répondra s\'il l\'a choisi.')}</div>
      </div>
      <Composer
        me={me}
        autoFocus
        dropZone={zone}
        placeholder={t('Votre question, ce que vous savez déjà, ce que vous attendez…')}
        tools={<NewThreadAi choices={models} onChange={setModels} />}
        onSend={async (body, attachments, poll) => {
          const thread = await call<Thread>('threads', { body, attachments, models, ...(poll ? { poll } : {}) })
          location.hash = toThread(thread.id)
        }}
      />
    </section>
  )
}

/** A thread on something, next to it: it stays under the person's eyes. Its title comes from what it is about. */
export function DockedThread({ me, subject, onClose }: { me: Me; subject: Subject; onClose: () => void }) {
  const zone = useRef<HTMLDivElement>(null)
  const [models, setModels] = useState<ThreadChoices>({})
  // It also runs when the subject changes: another "fil" clicked meanwhile keeps what was written.
  useEffect(() => {
    zone.current?.querySelector<HTMLElement>('textarea')?.focus()
  }, [subject])
  return (
    <div className="dock-place" role="presentation">
      <div className="dialog dock" role="dialog" aria-label={t('Nouveau fil')} ref={zone}>
        <header>
          <h2>{t('Nouveau fil')}</h2>
          <button type="button" className="link" onClick={onClose}>
            {t('Fermer')}
          </button>
        </header>
        <div className="dock-subject">
          <div>
            <SubjectLinks subject={subject} />
          </div>
          {subject.title && <strong>{subject.title}</strong>}
          {subject.detail && <p>{subject.detail}</p>}
        </div>
        <Composer
          me={me}
          dropZone={zone}
          placeholder={t('Votre question sur {0}…', { 0: subject.label })}
          tools={<NewThreadAi choices={models} onChange={setModels} />}
          onSend={async (body, attachments, poll) => {
            const thread = await call<Thread>('threads', { body: `${subjectLink(subject)}\n\n${body}`, attachments, subject, models, ...(poll ? { poll } : {}) })
            onClose()
            location.hash = toThread(thread.id)
          }}
        />
      </div>
    </div>
  )
}
