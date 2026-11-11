import { useState } from 'react'
import { t } from '../../../shared/i18n/i18n.ts'
import { Group, Row } from './settings-parts.tsx'
import type { EnvironmentEditor } from './environment-draft.tsx'
import { MAX } from './environment-config.ts'
import { ListBlock, Problem, RemoveButton, TextBox, Tick } from './environment-fields.tsx'

/** The GitHub projects the board reads, and what makes an issue or a pull request wait for someone's answer. */
export function ProjectsPart({ editor }: { editor: EnvironmentEditor }) {
  const { draft, editable, set, problems, view } = editor
  const [added, setAdded] = useState<number | null>(null)
  const projects = draft.projects
  const put = (index: number, change: Partial<(typeof projects)[number]>) => set({ projects: projects.map((one, at) => (at === index ? { ...one, ...change } : one)) })
  const owner = (draft.repos[0]?.name ?? view.repo).split('/')[0]
  const waiting = (change: Partial<typeof draft.waiting>) => set({ waiting: { ...draft.waiting, ...change } })
  return (
    <>
      <Group title={t('Projets GitHub')} note={t('Le premier donne ses statuts à la vue d’ensemble, et ses champs disent qui attend quoi.')}>
        <ListBlock
          count={projects.length}
          editable={editable}
          full={projects.length >= MAX.projects}
          onAdd={() => {
            setAdded(projects.length)
            set({ projects: [...projects, { owner, number: 0, edit: false }] })
          }}
          addLabel={t('Ajouter un projet')}
          empty={editable ? t('Aucun projet. Ajoutez le projet GitHub où l’équipe suit son travail : son propriétaire et son numéro, dans son adresse.') : t('Aucun projet pour l’instant.')}
        >
          <table className="set-table">
            <thead>
              <tr>
                <th>{t('Propriétaire')}</th>
                <th>{t('Numéro')}</th>
                <th className="tick">{t('le board change ses champs')}</th>
                {editable && <th className="end" />}
              </tr>
            </thead>
            <tbody>
              {projects.map((project, index) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: a row is its place in the list, its owner being typed.
                <tr key={index}>
                  <td>
                    <TextBox value={project.owner} editable={editable} label={t('Propriétaire')} placeholder="org" width="medium" problem={problems[`projects.${index}.owner`]} autoFocus={added === index} onChange={(next) => put(index, { owner: next.trim() })} />
                    <Problem text={problems[`projects.${index}.owner`]} />
                  </td>
                  <td>
                    <TextBox value={project.number || ''} type="number" min={1} editable={editable} label={t('Numéro')} placeholder="1" width="short" problem={problems[`projects.${index}.number`]} onChange={(next) => put(index, { number: Number(next) })} />
                    <Problem text={problems[`projects.${index}.number`]} />
                  </td>
                  <td className="tick">
                    <Tick on={project.edit} editable={editable} label={t('Le board change les champs du projet {0}', { 0: `${project.owner} #${project.number}` })} onFlip={() => put(index, { edit: !project.edit })} />
                  </td>
                  {editable && (
                    <td className="end">
                      <RemoveButton what={`${project.owner} #${project.number}`} onRemove={() => set({ projects: projects.filter((_, at) => at !== index) })} />
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </ListBlock>
      </Group>
      <Group title={t('À valider')} note={t('Un ticket ou une PR attend quelqu’un quand il porte cette étiquette, et le projet dit qui et quoi.')}>
        <Row label={t('Étiquette')} hint={problems['waiting.label'] ? <Problem text={problems['waiting.label']} /> : t('Sur le dépôt principal : elle met un ticket ou une PR en attente.')}>
          <TextBox value={draft.waiting.label} editable={editable} label={t('Étiquette')} placeholder="needs-answer" problem={problems['waiting.label']} onChange={(label) => waiting({ label })} />
        </Row>
        <Row label={t('Champ « qui » du projet')} hint={problems['waiting.who'] ? <Problem text={problems['waiting.who']} /> : t('Le champ du projet qui nomme la personne attendue.')}>
          <TextBox value={draft.waiting.who} editable={editable} label={t('Champ « qui » du projet')} placeholder="Waiting on" problem={problems['waiting.who']} onChange={(who) => waiting({ who })} />
        </Row>
        <Row label={t('Champ « question »')} hint={problems['waiting.question'] ? <Problem text={problems['waiting.question']} /> : t('Le champ du projet qui dit ce qu’on lui demande.')}>
          <TextBox value={draft.waiting.question} editable={editable} label={t('Champ « question »')} placeholder="Question" problem={problems['waiting.question']} onChange={(question) => waiting({ question })} />
        </Row>
      </Group>
    </>
  )
}
