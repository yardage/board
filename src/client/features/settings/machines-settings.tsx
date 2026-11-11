import { useState } from 'react'
import { t } from '../../../shared/i18n/i18n.ts'
import { Group, Row } from './settings-parts.tsx'
import type { EnvironmentEditor } from './environment-draft.tsx'
import { HOST_ROLES, type HostRole, MAX } from './environment-config.ts'
import { ListBlock, Pick, Problem, RemoveButton, TextBox } from './environment-fields.tsx'

const ROLE_NAMES: Record<HostRole, string> = { ci: t('CI'), dev: t('Développement'), server: t('Serveur'), other: t('Autre') }

/** The machines the overview shows, the free memory under which a CI machine shows amber, and the addresses it watches. */
export function MachinesPart({ editor }: { editor: EnvironmentEditor }) {
  const { draft, editable, set, problems } = editor
  const [added, setAdded] = useState<{ list: 'hosts' | 'endpoints'; at: number } | null>(null)
  const { hosts, endpoints } = draft
  const putHost = (index: number, change: Partial<(typeof hosts)[number]>) => set({ hosts: hosts.map((one, at) => (at === index ? { ...one, ...change } : one)) })
  const putEndpoint = (index: number, change: Partial<(typeof endpoints)[number]>) => set({ endpoints: endpoints.map((one, at) => (at === index ? { ...one, ...change } : one)) })
  const memory = problems['conventions.ciMemoryMib']
  return (
    <>
      <Group title={t('Machines')} note={t('Les machines affichées dans la vue d’ensemble, avec leur CPU, leur mémoire et leur disque. Le rôle fixe les seuils.')}>
        <ListBlock
          count={hosts.length}
          editable={editable}
          full={hosts.length >= MAX.hosts}
          onAdd={() => {
            setAdded({ list: 'hosts', at: hosts.length })
            set({ hosts: [...hosts, { name: '', role: 'ci' }] })
          }}
          addLabel={t('Ajouter une machine')}
          empty={editable ? t('Aucune machine. Ajoutez-en une sous le nom qu’elle donne à ses relevés.') : t('Aucune machine pour l’instant.')}
        >
          <table className="set-table">
            <thead>
              <tr>
                <th>{t('Nom')}</th>
                <th>{t('Rôle')}</th>
                {editable && <th className="end" />}
              </tr>
            </thead>
            <tbody>
              {hosts.map((host, index) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: a row is its place in the list, its name being typed.
                <tr key={index}>
                  <td>
                    <TextBox value={host.name} editable={editable} label={t('Nom')} placeholder="ci-1" problem={problems[`hosts.${index}.name`]} autoFocus={added?.list === 'hosts' && added.at === index} onChange={(name) => putHost(index, { name: name.trim().toLowerCase() })} />
                    <Problem text={problems[`hosts.${index}.name`]} />
                  </td>
                  <td>
                    <Pick<HostRole> value={host.role} editable={editable} label={t('Rôle de {0}', { 0: host.name || t('la machine') })} options={HOST_ROLES.map((role) => [role, ROLE_NAMES[role]])} onPick={(role) => putHost(index, { role })} />
                  </td>
                  {editable && (
                    <td className="end">
                      <RemoveButton what={host.name} onRemove={() => set({ hosts: hosts.filter((_, at) => at !== index) })} />
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </ListBlock>
        <Row label={t('Mémoire libre minimale')} hint={memory ? <Problem text={memory} /> : t('Pour les machines CI : en dessous, la machine passe en orange.')}>
          <TextBox value={Number.isFinite(draft.conventions.ciMemoryMib) ? draft.conventions.ciMemoryMib : ''} type="number" min={0} step={128} editable={editable} label={t('Mémoire libre minimale des machines CI (Mio)')} width="short" suffix={t('Mio')} problem={memory} onChange={(value) => set({ conventions: { ...draft.conventions, ciMemoryMib: value === '' ? Number.NaN : Number(value) } })} />
        </Row>
      </Group>
      <Group title={t('Adresses surveillées')} note={t('Des adresses publiques dont la vue d’ensemble dit si elles répondent, une fois par minute au plus, quand elle est ouverte.')}>
        <ListBlock
          count={endpoints.length}
          editable={editable}
          full={endpoints.length >= MAX.endpoints}
          onAdd={() => {
            setAdded({ list: 'endpoints', at: endpoints.length })
            set({ endpoints: [...endpoints, { name: '', url: 'https://' }] })
          }}
          addLabel={t('Ajouter une adresse')}
          empty={editable ? t('Aucune adresse. Ajoutez un site ou une API de l’équipe, en https.') : t('Aucune adresse pour l’instant.')}
        >
          <table className="set-table">
            <thead>
              <tr>
                <th>{t('Nom')}</th>
                <th className="wide">{t('Adresse')}</th>
                {editable && <th className="end" />}
              </tr>
            </thead>
            <tbody>
              {endpoints.map((endpoint, index) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: a row is its place in the list, its name being typed.
                <tr key={index}>
                  <td>
                    <TextBox value={endpoint.name} editable={editable} label={t('Nom')} placeholder={t('site')} problem={problems[`endpoints.${index}.name`]} autoFocus={added?.list === 'endpoints' && added.at === index} onChange={(name) => putEndpoint(index, { name })} />
                    <Problem text={problems[`endpoints.${index}.name`]} />
                  </td>
                  <td className="wide">
                    <TextBox value={endpoint.url} editable={editable} label={t('Adresse')} placeholder="https://…" width="full" problem={problems[`endpoints.${index}.url`]} onChange={(url) => putEndpoint(index, { url: url.trim() })} />
                    <Problem text={problems[`endpoints.${index}.url`]} />
                  </td>
                  {editable && (
                    <td className="end">
                      <RemoveButton what={endpoint.name} onRemove={() => set({ endpoints: endpoints.filter((_, at) => at !== index) })} />
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </ListBlock>
      </Group>
    </>
  )
}
