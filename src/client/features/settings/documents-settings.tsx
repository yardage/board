import { t } from '../../../shared/i18n/i18n.ts'
import { Row } from './settings-parts.tsx'
import type { EnvironmentEditor } from './environment-draft.tsx'
import { Problem, TextBox } from './environment-fields.tsx'

/** A folder of a branch that members read under Knowledge and agents read too, such as a roadmap. */
export function DocumentsPart({ editor }: { editor: EnvironmentEditor }) {
  const { draft, editable, set, problems, view } = editor
  const documents = draft.documents
  const tracked = draft.repos.map((repo) => repo.name).filter(Boolean)
  if (!documents)
    return (
      <>
        <p className="set-note">{t('Des documents que les membres et les agents lisent, comme une feuille de route.')}</p>
        <div className="set-list">
          <p className="set-empty">{editable ? t('Aucun dossier suivi. Choisissez un dossier d’un dépôt : ses fichiers s’ouvrent sous Connaissance, et les agents les lisent.') : t('Aucun dossier suivi pour l’instant.')}</p>
          {editable && (
            <div className="set-list-add">
              <button type="button" className="ghost" onClick={() => set({ documents: { repo: tracked[0] ?? '', branch: 'main', path: 'docs' } })}>
                {t('Suivre un dossier')}
              </button>
            </div>
          )}
        </div>
      </>
    )
  const put = (change: Partial<typeof documents>) => set({ documents: { ...documents, ...change } })
  const saved = view.config.documents
  const hint = (key: string, text: string) => (problems[key] ? <Problem text={problems[key]} /> : text)
  return (
    <>
      <p className="set-note">{t('Des documents que les membres et les agents lisent, comme une feuille de route.')}</p>
      <Row label={t('Dépôt')} hint={hint('documents.repo', t('Un des dépôts suivis, ou un autre que ce compte GitHub peut lire.'))}>
        <TextBox value={documents.repo} editable={editable} label={t('Dépôt')} placeholder={t('org/depot')} list="set-documents-repos" problem={problems['documents.repo']} onChange={(repo) => put({ repo: repo.trim() })} />
        <datalist id="set-documents-repos">
          {tracked.map((name) => (
            <option key={name} value={name} />
          ))}
        </datalist>
      </Row>
      <Row label={t('Branche')} hint={hint('documents.branch', t('Celle dont les documents sont lus, souvent main.'))}>
        <TextBox value={documents.branch} editable={editable} label={t('Branche')} placeholder="main" width="short" problem={problems['documents.branch']} onChange={(branch) => put({ branch: branch.trim() })} />
      </Row>
      <Row
        label={t('Dossier')}
        hint={
          problems['documents.path'] ? (
            <Problem text={problems['documents.path']} />
          ) : (
            <>
              {t('Le dossier dans ce dépôt, et tout ce qu’il contient.')}{' '}
              {saved && JSON.stringify(saved) === JSON.stringify(documents) && (
                <a className="link" href={`https://github.com/${saved.repo}/tree/${saved.branch}/${saved.path}`} target="_blank" rel="noreferrer" data-outside>
                  {t('Voir sur GitHub')}
                </a>
              )}
            </>
          )
        }
      >
        <TextBox value={documents.path} editable={editable} label={t('Dossier')} placeholder="docs" problem={problems['documents.path']} onChange={(path) => put({ path: path.trim() })} />
      </Row>
      {editable && (
        <div className="set-list-add">
          <button type="button" className="link" onClick={() => set({ documents: null })}>
            {t('Ne plus suivre ce dossier')}
          </button>
        </div>
      )}
    </>
  )
}
