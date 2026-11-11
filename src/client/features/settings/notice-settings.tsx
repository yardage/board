import { useState } from 'react'
import { call } from '../../lib/api.ts'
import { Group, Row, Switch } from './settings-parts.tsx'
import { dateLocale, t } from '../../../shared/i18n/i18n.ts'
import { isPaused, type NoticeKind, NOTICE_KINDS, type NoticeSettings, pauseEnd } from '../../../shared/notices.ts'

const KIND_NAMES: Record<NoticeKind, [string, string]> = {
  mentions: [t('Mentions'), t('Un message qui vous mentionne, quel que soit son auteur.')],
  polls: [t('Sondages'), t('Un nouveau sondage à voter.')],
  messages: [t('Messages des membres'), t('Un nouveau message d’un autre membre, dans un fil que vous ne lisez pas.')],
  agents: [t('Messages des agents'), t('Ce qu’écrit l’agent d’un membre, dans un fil que vous ne lisez pas.')],
  waiting: [t('En attente de vous'), t('Un ticket ou une PR qui attend votre réponse sur GitHub.')],
  drafts: [t('Brouillons de votre agent'), t('Votre agent a préparé une réponse à relire avant l’envoi.')],
}

const permissionNow = () => (typeof Notification === 'undefined' ? 'unsupported' : Notification.permission)

function until(iso: string): string {
  const end = new Date(iso)
  const sameDay = end.toDateString() === new Date().toDateString()
  return end.toLocaleString(dateLocale(), sameDay ? { hour: '2-digit', minute: '2-digit' } : { weekday: 'long', hour: '2-digit', minute: '2-digit' })
}

/**
 * The member's desktop notifications, on this computer: all of them, their sound, each kind, their content, a pause,
 * and the count on the app's icon. `inApp` is false in a browser, which has no icon of the board's.
 */
export function NoticeSettingsPart({ initial, inApp, onSaved }: { initial: NoticeSettings; inApp: boolean; onSaved: () => void }) {
  const [notices, setNotices] = useState(initial)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [permission, setPermission] = useState(permissionNow)
  const [tried, setTried] = useState(false)

  const save = async (change: Partial<Omit<NoticeSettings, "kinds">> & { kinds?: Partial<Record<NoticeKind, boolean>> }) => {
    setBusy(true)
    setError(null)
    try {
      const { notices: saved } = await call<{ notices: NoticeSettings }>('settings/notifications', change)
      setNotices(saved)
      onSaved()
    } catch (failure) {
      setError((failure as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const allow = () => {
    if (typeof Notification === 'undefined') return
    void Notification.requestPermission().then(setPermission)
  }

  const tryOne = () => {
    if (permissionNow() !== 'granted') return
    new Notification(t('Notification d’essai'), { body: notices.preview ? t('Les notifications du board s’affichent ainsi.') : undefined, silent: !notices.sound })
    setTried(true)
  }

  const off = !notices.enabled
  const paused = isPaused(notices)

  return (
    <>
      <p className="set-note">{t('Une notification ne vient jamais d’un fil ouvert sous vos yeux, ni d’un message que vous avez écrit.')}</p>
      <Row label={t('Notifications')}>
        <Switch on={notices.enabled} label={t('Notifications bureau')} disabled={busy} onFlip={() => void save({ enabled: !notices.enabled })} />
        {permission === 'denied' && <p className="set-bad">{t('Windows ou le navigateur les bloque : autorisez-les dans ses réglages.')}</p>}
        {permission === 'default' && (
          <p>
            {t('Le board n’a pas encore la permission d’en afficher.')}{' '}
            <button type="button" className="link" onClick={allow}>
              {t('Autoriser')}
            </button>
          </p>
        )}
        {permission === 'unsupported' && <p className="set-bad">{t('Ce navigateur n’affiche pas de notifications.')}</p>}
      </Row>
      <Row label={t('Son')}>
        <Switch on={notices.sound} label={t('Jouer un son')} disabled={busy || off} onFlip={() => void save({ sound: !notices.sound })} />
        <p>{t('Sans son, une notification s’affiche sans bruit.')}</p>
      </Row>
      <Row
        label={t('Ne pas déranger')}
        actions={
          paused ? (
            <button type="button" className="ghost" disabled={busy || off} onClick={() => void save({ pausedUntil: null })}>
              {t('Reprendre')}
            </button>
          ) : (
            <>
              <button type="button" className="ghost" disabled={busy || off} onClick={() => void save({ pausedUntil: pauseEnd('hour') })}>
                {t('1 heure')}
              </button>
              <button type="button" className="ghost" disabled={busy || off} onClick={() => void save({ pausedUntil: pauseEnd('morning') })}>
                {t('Jusqu’à demain matin')}
              </button>
            </>
          )
        }
      >
        {paused && notices.pausedUntil ? <span className="set-new">{t('En pause jusqu’à {0}.', { 0: until(notices.pausedUntil) })}</span> : <span className="dim">{t('Aucune notification pendant la pause. Le compteur de l’icône continue.')}</span>}
      </Row>
      <Row label={t('Contenu')}>
        <Switch on={notices.preview} label={t('Montrer le texte')} disabled={busy || off} onFlip={() => void save({ preview: !notices.preview })} />
        <p>{t('Sinon, une notification dit seulement de qui elle vient : utile pour partager son écran.')}</p>
      </Row>
      {inApp && (
        <Row label={t('Compteur')}>
          <Switch on={notices.badge} label={t('Sur l’icône du board')} disabled={busy} onFlip={() => void save({ badge: !notices.badge })} />
          <p>{t('Les fils non lus et ce qui attend votre réponse, sur la barre des tâches et dans la zone de notification.')}</p>
        </Row>
      )}
      <Group title={t('Ce qui vous prévient')}>
        {NOTICE_KINDS.map((kind) => (
          <Row key={kind} label={KIND_NAMES[kind][0]} hint={KIND_NAMES[kind][1]}>
            <Switch on={notices.kinds[kind]} label={t('Prévenir')} disabled={busy || off} onFlip={() => void save({ kinds: { [kind]: !notices.kinds[kind] } })} />
          </Row>
        ))}
      </Group>
      <Row
        label={t('Essai')}
        actions={
          <button type="button" className="ghost" disabled={off || permission !== 'granted'} onClick={tryOne}>
            {t('Envoyer une notification d’essai')}
          </button>
        }
      >
        {tried ? <span className="set-ok">{t('✓ Envoyée. Rien ne s’affiche ? Regardez l’assistant de concentration de Windows.')}</span> : <span className="dim">{t('Avec le son et le contenu choisis ici.')}</span>}
      </Row>
      {error && (
        <p className="set-note">
          <span className="set-bad">✕ {error}</span>
        </p>
      )}
    </>
  )
}
