import { useState } from 'react'
import { t } from '../../../shared/i18n/i18n.ts'
import type { EnvironmentEditor } from './environment-draft.tsx'
import { blankRepo, MAX, type RepoAccess } from './environment-config.ts'
import { ListBlock, Problem, RemoveButton, TextBox, Tick } from './environment-fields.tsx'

type Flag = { key: string; name: string; hint: string; get: (repo: RepoAccess) => boolean; put: (repo: RepoAccess, on: boolean) => RepoAccess }

/** What the board may do in a repository, column by column, under the heading of what it is done to. */
const COLUMNS: { title: string; flags: Flag[] }[] = [
  {
    title: t('Agents'),
    flags: [{ key: 'code', name: t('lire le code'), hint: t('Les agents lisent sa branche principale.'), get: (repo) => repo.code, put: (repo, code) => ({ ...repo, code }) }],
  },
  {
    title: t('Tickets'),
    flags: [
      { key: 'issues.create', name: t('créer'), hint: t('Créer des tickets'), get: (repo) => repo.issues.create, put: (repo, create) => ({ ...repo, issues: { ...repo.issues, create } }) },
      { key: 'issues.comment', name: t('commenter'), hint: t('Commenter les tickets'), get: (repo) => repo.issues.comment, put: (repo, comment) => ({ ...repo, issues: { ...repo.issues, comment } }) },
      { key: 'issues.edit', name: t('modifier'), hint: t('Changer le titre, le texte, les étiquettes, les personnes et le jalon des tickets'), get: (repo) => repo.issues.edit, put: (repo, edit) => ({ ...repo, issues: { ...repo.issues, edit } }) },
      { key: 'issues.close', name: t('fermer'), hint: t('Fermer ou rouvrir des tickets'), get: (repo) => repo.issues.close, put: (repo, close) => ({ ...repo, issues: { ...repo.issues, close } }) },
    ],
  },
  {
    title: t('Pull requests'),
    flags: [
      { key: 'pulls.comment', name: t('commenter'), hint: t('Commenter les pull requests'), get: (repo) => repo.pulls.comment, put: (repo, comment) => ({ ...repo, pulls: { ...repo.pulls, comment } }) },
      { key: 'pulls.edit', name: t('modifier'), hint: t('Changer le titre, le texte, les étiquettes et les personnes des pull requests, et les fermer'), get: (repo) => repo.pulls.edit, put: (repo, edit) => ({ ...repo, pulls: { ...repo.pulls, edit } }) },
      { key: 'pulls.review', name: t('relire'), hint: t('Les membres approuvent ou demandent des changements depuis le board'), get: (repo) => repo.pulls.review, put: (repo, review) => ({ ...repo, pulls: { ...repo.pulls, review } }) },
    ],
  },
]

/**
 * The repositories the environment follows, and what the board may do in each, as a grid: one row per repository,
 * one column per permission. The first is the main one.
 */
export function RepositoriesPart({ editor }: { editor: EnvironmentEditor }) {
  const { draft, editable, set, problems } = editor
  const [added, setAdded] = useState<number | null>(null)
  const repos = draft.repos
  const put = (index: number, repo: RepoAccess) => set({ repos: repos.map((one, at) => (at === index ? repo : one)) })
  const add = () => {
    setAdded(repos.length)
    set({ repos: [...repos, blankRepo()] })
  }
  const toMain = (index: number) => set({ repos: [repos[index], ...repos.filter((_, at) => at !== index)] })
  return (
    <>
      <p className="set-note">{t('Le premier dépôt est le principal : la vue d’ensemble, les rapports et « À valider » le suivent. Le board n’y fait que ce qui est coché, et ne touche jamais au code.')}</p>
      <ListBlock
        count={repos.length}
        editable={editable}
        full={repos.length >= MAX.repos}
        onAdd={add}
        addLabel={t('Ajouter un dépôt')}
        empty={editable ? t('Aucun dépôt suivi. Ajoutez celui où l’équipe travaille : la vue d’ensemble, les rapports et « À valider » le suivront.') : t('Aucun dépôt suivi pour l’instant.')}
      >
        <div className="set-grid-wrap">
          <table className="set-table set-grid">
            <thead>
              <tr>
                <th rowSpan={2} className="name">
                  {t('Dépôt')}
                </th>
                {COLUMNS.map((column) => (
                  <th key={column.title} colSpan={column.flags.length} className="group">
                    {column.title}
                  </th>
                ))}
              </tr>
              <tr>
                {COLUMNS.flatMap((column) =>
                  column.flags.map((flag, at) => (
                    <th key={flag.key} className={`tick ${at === 0 ? 'first' : ''}`} title={flag.hint}>
                      {flag.name}
                    </th>
                  )),
                )}
              </tr>
            </thead>
            <tbody>
              {repos.map((repo, index) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: a row is its place in the list, its name being typed.
                <tr key={index}>
                  <td className="name">
                    {editable ? (
                      <TextBox value={repo.name} editable label={t('Dépôt')} placeholder={t('org/depot')} width="full" problem={problems[`repos.${index}.name`]} autoFocus={added === index} onChange={(name) => put(index, { ...repo, name: name.trim() })} />
                    ) : (
                      <a className="set-text" href={`https://github.com/${repo.name}`} target="_blank" rel="noreferrer" data-outside>
                        {repo.name}
                      </a>
                    )}
                    <Problem text={problems[`repos.${index}.name`]} />
                    <span className="set-row-note">
                      {index === 0 ? (
                        <span className="set-badge">{t('principal')}</span>
                      ) : (
                        editable && (
                          <button type="button" className="link" onClick={() => toMain(index)}>
                            {t('en faire le principal')}
                          </button>
                        )
                      )}
                      {editable && <RemoveButton what={repo.name} onRemove={() => set({ repos: repos.filter((_, at) => at !== index) })} />}
                    </span>
                  </td>
                  {COLUMNS.flatMap((column) =>
                    column.flags.map((flag, at) => (
                      <td key={flag.key} className={`tick ${at === 0 ? 'first' : ''}`}>
                        <Tick on={flag.get(repo)} editable={editable} label={`${repo.name || t('nouveau dépôt')} · ${column.title} · ${flag.name}`} onFlip={() => put(index, flag.put(repo, !flag.get(repo)))} />
                      </td>
                    )),
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </ListBlock>
      <dl className="set-legend">
        <dt>{t('lire le code')}</dt>
        <dd>{t('Les agents lisent sa branche principale, sans son historique.')}</dd>
        <dt>{t('modifier')}</dt>
        <dd>{t('Le titre, le texte, les étiquettes, les personnes et le jalon. Pour une pull request, aussi la fermer. Jamais le code.')}</dd>
        <dt>{t('relire')}</dt>
        <dd>{t('Les membres approuvent ou demandent des changements depuis le board, avec leur propre compte. Jamais un agent.')}</dd>
      </dl>
    </>
  )
}
