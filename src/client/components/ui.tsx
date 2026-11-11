import { type ReactNode, useEffect, useState } from 'react'
import { call } from '../lib/api.ts'
import { t } from '../../shared/i18n/i18n.ts'

/**
 * The board's small moving parts. The look (block bar on a dotted shade, braille spinner, `[ action ]`)
 * comes from speak's src/renderer/src/components/ui.tsx (MIT, Rodolphe Barbanneau), rewritten for here.
 */

const FRAMES = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏'

export function Spinner() {
  const [frame, setFrame] = useState(0)
  useEffect(() => {
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) return
    const timer = setInterval(() => setFrame((current) => (current + 1) % FRAMES.length), 80)
    return () => clearInterval(timer)
  }, [])
  return (
    <span className="spin" aria-hidden>
      {FRAMES[frame]}
    </span>
  )
}

/** A block bar. With no `ratio`, a block travels along it: something is happening, how long isn't known. */
export function Blocks({ ratio, cells = 24 }: { ratio?: number; cells?: number }) {
  const known = ratio !== undefined
  const shown = known ? Math.max(0, Math.min(1, ratio)) : 0
  return (
    <span
      className={`blocks ${known ? '' : 'running'}`}
      style={{ width: `${cells}ch` }}
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={known ? Math.round(shown * 100) : undefined}
    >
      <span className="fill" style={known ? { width: `${shown * 100}%` } : undefined} />
    </span>
  )
}

export function Loading({ children }: { children: ReactNode }) {
  return (
    <span className="loading">
      <Blocks />
      <span>{children}</span>
    </span>
  )
}

export const percent = (ratio: number) => t('{0} %', { 0: Math.round(Math.max(0, Math.min(1, ratio)) * 100) })

const PROGRESS_POLL_MS = 400

/** How far the update's download has gone, while there is one. */
export function useUpdateProgress(active: boolean): number | null {
  const [ratio, setRatio] = useState<number | null>(null)
  useEffect(() => {
    if (!active) {
      setRatio(null)
      return
    }
    // At once: a screen opened during a download shows it from the start.
    call<{ ratio: number | null }>('update/progress')
      .then((found) => setRatio(found.ratio))
      .catch(() => undefined)
    const timer = setInterval(() => {
      call<{ ratio: number | null }>('update/progress')
        .then((found) => setRatio(found.ratio))
        .catch(() => undefined)
    }, PROGRESS_POLL_MS)
    return () => clearInterval(timer)
  }, [active])
  return ratio
}
