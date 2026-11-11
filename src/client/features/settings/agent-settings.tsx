import { useEffect, useRef, useState } from 'react'
import { call } from '../../lib/api.ts'
import { t } from '../../../shared/i18n/i18n.ts'
import { Choices, Row } from './settings-parts.tsx'
import { members, type ReplyMode } from '../../lib/people.tsx'

/** The member's agent: when it answers others, for whom, and what it may do on GitHub. Saved on this computer. */

export interface AgentPolicy {
  reply: ReplyMode
  people: 'everyone' | 'only' | 'except'
  logins: string[]
  mutedThreads: string[]
  act: 'nobody' | 'me' | 'everyone' | 'only'
  actLogins: string[]
}

/** Beyond this many members, the list gets a search, and a way to take everyone or nobody. */
const PEOPLE_SEARCH_FROM = 8

/**
 * Members to pick: every one for a small team; with a search and "all" and "none" for a large one. Each click is saved,
 * after a moment, so that ten clicks are one request.
 */
function Others({ me, chosen, onChange, disabled }: { me: string; chosen: string[]; onChange: (logins: string[]) => void; disabled?: boolean }) {
  const [query, setQuery] = useState('')
  const [draft, setDraft] = useState<string[] | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => clearTimeout(timer.current), [])
  const current = draft ?? chosen
  const others = members().filter((member) => member.login.toLowerCase() !== me.toLowerCase())
  const wanted = query.trim().toLowerCase()
  const shown = wanted ? others.filter((member) => member.login.toLowerCase().includes(wanted) || member.name.toLowerCase().includes(wanted)) : others
  const change = (next: string[]) => {
    setDraft(next)
    clearTimeout(timer.current)
    timer.current = setTimeout(() => {
      onChange(next)
      setDraft(null)
    }, 600)
  }
  const toggle = (login: string) => change(current.includes(login) ? current.filter((one) => one !== login) : [...current, login])
  return (
    <div className="set-people-box">
      {others.length >= PEOPLE_SEARCH_FROM && (
        <div className="set-people-tools">
          <input value={query} placeholder={t('Chercher un membre…')} aria-label={t('Chercher un membre…')} onChange={(event) => setQuery(event.target.value)} />
          <button type="button" className="link" disabled={disabled} onClick={() => change([...new Set([...current, ...shown.map((member) => member.login.toLowerCase())])])}>
            {t('Tous')}
          </button>
          <button type="button" className="link" disabled={disabled} onClick={() => change(current.filter((login) => !shown.some((member) => member.login.toLowerCase() === login)))}>
            {t('Aucun')}
          </button>
          <small className="dim">{t('{0} choisis', { 0: current.length })}</small>
        </div>
      )}
      <span className="set-people">
        {shown.slice(0, 200).map((member) => {
          const login = member.login.toLowerCase()
          return (
            <label key={member.login} className="check">
              <input type="checkbox" checked={current.includes(login)} disabled={disabled} onChange={() => toggle(login)} />
              {member.name}
            </label>
          )
        })}
        {shown.length === 0 && <small className="dim">{t('Aucun membre.')}</small>}
        {shown.length > 200 && <small className="dim">{t('et {0} autres : précisez la recherche', { 0: shown.length - 200 })}</small>}
      </span>
    </div>
  )
}

/** How this member's agent answers others, and what it may do when it does. Saved on this computer. */
export function AgentSettings({ policy, me, onSaved }: { policy: AgentPolicy; me: string; onSaved: () => void }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const save = async (change: Partial<AgentPolicy>) => {
    setBusy(true)
    setError(null)
    try {
      await call('settings/policy', change)
      onSaved()
    } catch (failure) {
      setError((failure as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <>
      <p className="set-note">{t('Quand on vous mentionne, votre agent peut répondre pour vous ou vous préparer un brouillon, seulement quand votre app est ouverte.')}</p>
      <Row label={t('Quand on me demande')}>
        <Choices<ReplyMode>
          value={policy.reply}
          disabled={busy}
          onPick={(reply) => void save({ reply })}
          options={[
            ['off', t('Je réponds moi-même')],
            ['draft', t('Brouillon à relire')],
            ['auto', t('Réponse automatique')],
          ]}
        />
        <p>{policy.reply === 'auto' ? t('Votre agent répond en votre nom, et le message dit qu\'il vient de lui.') : policy.reply === 'draft' ? t('Votre agent prépare une réponse que vous lisez, changez et envoyez, ou jetez.') : t('Votre agent ne fait rien tant que vous ne le lui demandez pas.')}</p>
      </Row>
      {policy.reply !== 'off' && (
        <Row label={t('Pour qui')}>
          <Choices<AgentPolicy['people']>
            value={policy.people}
            disabled={busy}
            onPick={(people) => void save({ people })}
            options={[
              ['everyone', t('Tout le monde')],
              ['only', t('Seulement')],
              ['except', t('Tous sauf')],
            ]}
          />
          {policy.people !== 'everyone' && <Others me={me} chosen={policy.logins} disabled={busy} onChange={(logins) => void save({ logins })} />}
          {policy.mutedThreads.length > 0 && (
            <p>
              {t('En silence dans {0} fil(s).', { 0: policy.mutedThreads.length })}{' '}
              <button type="button" className="link" disabled={busy} onClick={() => void save({ mutedThreads: [] })}>
                {t('Réactiver partout')}
              </button>
            </p>
          )}
        </Row>
      )}
      <Row label={t('Agir sur GitHub')}>
        <Choices<AgentPolicy['act']>
          value={policy.act}
          disabled={busy}
          onPick={(act) => void save({ act })}
          options={[
            ['nobody', t('Jamais')],
            ['me', t('Quand je le demande')],
            ['only', t('Aussi pour')],
            ['everyone', t('Pour tout le monde')],
          ]}
        />
        {policy.act === 'only' && <Others me={me} chosen={policy.actLogins} disabled={busy} onChange={(actLogins) => void save({ actLogins })} />}
        <p>{t('Créer un ticket, commenter, changer une étiquette ou un champ de projet, là où l’environnement l’autorise. Jamais de fichier, de commande ni de code sur votre ordinateur.')}</p>
      </Row>
      {error && <div className="inline-error">{error}</div>}
    </>
  )
}
