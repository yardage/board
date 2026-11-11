import { type RefObject, useCallback, useEffect, useState } from 'react'
import { readStored, rememberScroll } from './lists.ts'

/** A choice on a screen that outlives the screen, on this computer. */
export function useRemembered<T>(key: string, initial: T, valid: (value: unknown) => value is T): [T, (value: T) => void] {
  const [value, setValue] = useState<T>(() => readStored(localStorage.getItem(key), valid) ?? initial)
  const set = useCallback(
    (next: T) => {
      setValue(next)
      localStorage.setItem(key, JSON.stringify(next))
    },
    [key],
  )
  return [value, set]
}

const SCROLLS = 'report-scrolls'
const isPositions = (value: unknown): value is Record<string, number> => Boolean(value) && typeof value === 'object' && !Array.isArray(value)

/** Puts a page back where it was read up to, once it is there, and keeps track of it after that. */
export function useScrollMemory(id: string, zone: RefObject<HTMLElement | null>, ready: boolean): void {
  useEffect(() => {
    const element = zone.current
    if (!ready || !element) return
    const top = readStored(localStorage.getItem(SCROLLS), isPositions)?.[id]
    const wanted = typeof top === 'number' && top > 0 ? top : 0
    let timer: ReturnType<typeof setTimeout> | undefined
    let frame = 0
    let tries = 0
    const save = () => {
      clearTimeout(timer)
      timer = setTimeout(() => {
        const found = readStored(localStorage.getItem(SCROLLS), isPositions) ?? {}
        localStorage.setItem(SCROLLS, JSON.stringify(rememberScroll(found, id, Math.round(element.scrollTop))))
      }, 300)
    }
    // Charts take their height a little after the page: too soon, this would stop short, and that place would then be saved.
    const restore = () => {
      element.scrollTo(0, wanted)
      if (element.scrollTop >= wanted - 1 || tries >= 60) {
        element.addEventListener('scroll', save, { passive: true })
        return
      }
      tries += 1
      frame = requestAnimationFrame(restore)
    }
    frame = requestAnimationFrame(restore)
    return () => {
      cancelAnimationFrame(frame)
      clearTimeout(timer)
      element.removeEventListener('scroll', save)
    }
  }, [id, zone, ready])
}
