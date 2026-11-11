import { createContext, type ReactNode, useCallback, useEffect, useMemo, useRef } from 'react'
import { t } from '../../../shared/i18n/i18n.ts'

/**
 * What is inside the settings may hold back their closing, to ask first: `guard` answers false to keep them open.
 * `close` closes them whatever the guard says, once the person has answered.
 */
export const SettingsClosing = createContext<{ guard: { current: (() => boolean) | null }; close: () => void }>({ guard: { current: null }, close: () => undefined })

/** Settings, over the app, as a window of their own: Escape or the scrim closes them. */
export function SettingsDialog({ children, onClose }: { children: ReactNode; onClose: () => void }) {
  const guard = useRef<(() => boolean) | null>(null)
  const tryClose = useCallback(() => {
    if (guard.current && !guard.current()) return
    onClose()
  }, [onClose])
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented) {
        event.preventDefault()
        tryClose()
      }
    }
    addEventListener('keydown', onKey)
    return () => removeEventListener('keydown', onKey)
  }, [tryClose])
  const closing = useMemo(() => ({ guard, close: onClose }), [onClose])
  return (
    <div className="overlay settings-overlay" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && tryClose()}>
      <div className="dialog settings-dialog" role="dialog" aria-modal="true" aria-label={t('Réglages')}>
        <button type="button" className="link dialog-close" onClick={tryClose}>
          {t('Fermer')}
        </button>
        <SettingsClosing.Provider value={closing}>{children}</SettingsClosing.Provider>
      </div>
    </div>
  )
}
