import { useState } from 'react'
import { call } from '../../lib/api.ts'
import { t } from '../../../shared/i18n/i18n.ts'
import { Group, Row, Saved, Switch } from './settings-parts.tsx'
import { members, personOf } from '../../lib/people.tsx'
import type { EnvironmentEditor } from './environment-draft.tsx'
import { MAX } from './environment-config.ts'
import { ListBlock, Pick, Problem, RemoveButton, TextBox, Tick } from './environment-fields.tsx'

/** Who is in the environment: a few names in full, a longer list folded under its count. */
function MembersList() {
  const [open, setOpen] = useState(false)
  const all = members()
  const admins = all.filter((member) => member.admin).length
  const line = (member: { name: string; admin?: boolean }) => `${member.name}${member.admin ? ` (${t('admin')})` : ''}`
  if (all.length <= 12) return <span>{all.map(line).join(', ')}</span>
  return (
    <span>
      {t('{0} membres, dont {1} administrateur{2}.', { 0: all.length, 1: admins, 2: admins > 1 ? 's' : '' })}{' '}
      <button type="button" className="link" onClick={() => setOpen(!open)}>
        {open ? t('Masquer la liste') : t('Voir la liste')}
      </button>
      {open && <span className="set-members">{all.map(line).join(', ')}</span>}
    </span>
  )
}

/** Whether GitHub itself keeps the configuration to admins, and, for an admin, the rule that makes it so. */
function Protection({ editor }: { editor: EnvironmentEditor }) {
  const { view } = editor
  const [state, setState] = useState<'idle' | 'saving' | 'saved'>('idle')
  const [error, setError] = useState<string | null>(null)
  const protect = async () => {
    setState('saving')
    setError(null)
    try {
      const { protected: done } = await call<{ protected: boolean }>('environment/protect', {})
      if (!done) throw new Error(t('GitHub n’a pas posé la règle : le plan de ce dépôt ne le permet peut-être pas.'))
      setState('saved')
      editor.onChange()
    } catch (failure) {
      setState('idle')
      setError((failure as Error).message)
    }
  }
  return (
    <Row
      label={t('Protection')}
      hint={view.protected ? t('Sa configuration est protégée par GitHub : seul un administrateur peut la changer.') : t('La configuration n’est pas verrouillée sur GitHub : le board n’applique que les changements des administrateurs.')}
      actions={
        view.admin &&
        !view.protected && (
          <>
            <Saved state={state} error={error} />
            <button type="button" className="ghost" disabled={state === 'saving'} onClick={() => void protect()}>
              {t('Protéger avec une règle GitHub')}
            </button>
          </>
        )
      }
    >
      {view.protected ? <span className="set-ok">{t('✓ Protégée')}</span> : <span className="set-warn">{t('▲ Non verrouillée')}</span>}
    </Row>
  )
}

/** Names from before the environment, read as the member they stand for. A new one is checked before it joins the list. */
function Aliases({ editor }: { editor: EnvironmentEditor }) {
  const { draft, editable, set, problems } = editor
  const entries = Object.entries(draft.aliases)
  const [name, setName] = useState('')
  const [login, setLogin] = useState('')
  const [agent, setAgent] = useState(false)
  const people = members()
  const choices = (current: string): [string, string][] => {
    const listed = people.map((member) => [member.login, member.name === member.login ? member.login : `${member.name} (${member.login})`] as [string, string])
    return current && !listed.some(([one]) => one.toLowerCase() === current.toLowerCase()) ? [[current, personOf(current).name], ...listed] : listed
  }
  const wanted = name.trim().toLowerCase()
  const nameProblem = !wanted ? undefined : !/^[a-z0-9-]{1,40}$/.test(wanted) ? t('Des lettres, des chiffres et des tirets.') : Object.hasOwn(draft.aliases, wanted) ? t('Ce nom est déjà un alias.') : undefined
  const add = () => {
    if (!wanted || nameProblem || !login) return
    set({ aliases: { ...draft.aliases, [wanted]: { login, agent } } })
    setName('')
    setAgent(false)
  }
  const change = (alias: string, change: Partial<{ login: string; agent: boolean }>) => set({ aliases: Object.fromEntries(entries.map(([one, target]) => [one, one === alias ? { ...target, ...change } : target])) })
  return (
    <Group title={t('Alias')} note={t('Des noms écrits avant l’environnement, dans les fils repris d’avant : chacun se lit comme le membre qu’il désigne.')}>
      <ListBlock count={entries.length} editable={false} onAdd={() => undefined} addLabel="" empty={t('Aucun alias : les fils ne nomment que des membres.')}>
        <table className="set-table">
          <thead>
            <tr>
              <th>{t('Nom d’avant')}</th>
              <th>{t('Membre')}</th>
              <th className="tick">{t('son agent')}</th>
              {editable && <th className="end" />}
            </tr>
          </thead>
          <tbody>
            {entries.map(([alias, target]) => (
              <tr key={alias}>
                <td>
                  <span className="set-text">{alias}</span>
                  <Problem text={problems[`aliases.${alias}`]} />
                </td>
                <td>
                  <Pick value={target.login} editable={editable} label={t('Membre que {0} désigne', { 0: alias })} options={choices(target.login)} onPick={(next) => change(alias, { login: next })} />
                </td>
                <td className="tick">
                  <Tick on={target.agent} editable={editable} label={t('{0} désigne l’agent du membre', { 0: alias })} onFlip={() => change(alias, { agent: !target.agent })} />
                </td>
                {editable && (
                  <td className="end">
                    <RemoveButton what={alias} onRemove={() => set({ aliases: Object.fromEntries(entries.filter(([one]) => one !== alias)) })} />
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </ListBlock>
      {editable && (
        <form
          className="set-add-row"
          onSubmit={(event) => {
            event.preventDefault()
            add()
          }}
        >
          <span>
            <TextBox value={name} editable label={t('Nom d’avant')} placeholder={t('nom d’avant')} width="short" problem={nameProblem} onChange={setName} />
            <Problem text={nameProblem} />
          </span>
          <span className="set-arrow" aria-hidden>
            →
          </span>
          <Pick value={login} editable label={t('Membre')} options={[['', t('choisir un membre')], ...choices('')]} onPick={setLogin} />
          <Switch on={agent} label={t('son agent')} onFlip={() => setAgent(!agent)} />
          <button type="submit" className="ghost" disabled={!wanted || Boolean(nameProblem) || !login || entries.length >= MAX.aliases}>
            {t('Ajouter l’alias')}
          </button>
        </form>
      )}
    </Group>
  )
}

/** The environment itself: its repository, whether GitHub protects its configuration, its members, and old names. */
export function EnvironmentPart({ editor }: { editor: EnvironmentEditor }) {
  const { view } = editor
  return (
    <>
      {view.warning && (
        <div className="set-alert" role="alert">
          <strong>{t('Configuration refusée')}</strong>
          <span>{view.warning}</span>
        </div>
      )}
      <Group title={t('Le dépôt')}>
        <Row label={t('Dépôt de l’environnement')} hint={t('Il garde les fils, les sondages, les rapports et cette configuration, et rien d’autre.')}>
          <a className="set-text" href={`https://github.com/${view.repo}`} target="_blank" rel="noreferrer" data-outside>
            {view.repo} ↗
          </a>
        </Row>
        <Protection editor={editor} />
        <Row
          label={t('Membres')}
          hint={
            <>
              {t('Les membres sont les collaborateurs du dépôt sur GitHub : on les invite, et on règle leurs droits, sur GitHub.')}{' '}
              {view.admin && (
                <a className="link" href={`https://github.com/${view.repo}/settings/access`} target="_blank" rel="noreferrer" data-outside>
                  {t('Inviter sur GitHub')}
                </a>
              )}
            </>
          }
        >
          <MembersList />
        </Row>
      </Group>
      <Aliases editor={editor} />
    </>
  )
}
