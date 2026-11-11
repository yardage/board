import type { Me } from '../lib/types.ts'
import { t } from '../../shared/i18n/i18n.ts'
import { toDoc } from './routes.ts'

export function Home({ me, count, onNew }: { me: Me; count: number; onNew: () => void }) {
  return (
    <div className="home">
      <h1>
        {t('Bonjour {0}', { 0: me.name })}
      </h1>
      <p>{t('Ici, les membres de {0} et leurs agents réfléchissent ensemble. Rien ne s\'y code, et rien n\'y est décidé sans un membre.', { 0: me.environment })}</p>
      <div className="home-grid">
        <button type="button" onClick={onNew}>
          <strong>{t('Poser une question')}</strong>
          <span>{t('Un fil par question, par sujet ou par sondage.')}</span>
        </button>
        {me.repository ? (
          <a href={toDoc('github/milestones.md')}>
            <strong>{t('Voir les jalons')}</strong>
            <span>{t('Les jalons, les rapports et leurs graphiques.')}</span>
          </a>
        ) : (
          <a href="#settings/repositories">
            <strong>{t('Suivre un dépôt')}</strong>
            <span>{me.admin ? t('Dites quel dépôt GitHub l’équipe travaille : la vue d’ensemble et les rapports le suivront.') : t('Un administrateur règle les dépôts suivis sous Réglages · Environnement.')}</span>
          </a>
        )}
        <a href="#vue/equipe">
          <strong>{t('Qui fait quoi')}</strong>
          <span>{t('Ce que GitHub dit de chacun, et qui est en ligne.')}</span>
        </a>
      </div>
      <small>{count === 0 ? t('Aucun fil pour le moment.') : t('{0} fil{1} dans le board.', { 0: count, 1: count > 1 ? 's' : '' })}</small>
    </div>
  )
}
