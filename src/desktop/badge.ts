import { t } from '../shared/i18n/i18n.ts'

/**
 * The counter on the taskbar icon and the dot on the tray icon, as raw bitmaps. No Electron here, so tests can read them.
 * Bitmaps are BGRA, which is what `nativeImage` takes on Windows.
 */

export const BADGE_SIZE = 16

/** The accent colour, and the page's background for the digits: both from the board's palette. */
const ACCENT = [0xf7, 0xa2, 0x7a, 0xff]
const INK = [0x26, 0x1b, 0x1a, 0xff]
const AMBER = [0x68, 0xaf, 0xe0, 0xff]

/** Five columns by seven rows. */
const DIGITS: Record<string, string[]> = {
  '0': ['01110', '10001', '10011', '10101', '11001', '10001', '01110'],
  '1': ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
  '2': ['01110', '10001', '00001', '00010', '00100', '01000', '11111'],
  '3': ['11110', '00001', '00001', '01110', '00001', '00001', '11110'],
  '4': ['00010', '00110', '01010', '10010', '11111', '00010', '00010'],
  '5': ['11111', '10000', '11110', '00001', '00001', '10001', '01110'],
  '6': ['00110', '01000', '10000', '11110', '10001', '10001', '01110'],
  '7': ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
  '8': ['01110', '10001', '10001', '01110', '10001', '10001', '01110'],
  '9': ['01110', '10001', '10001', '01111', '00001', '00010', '01100'],
  '+': ['00000', '00100', '00100', '11111', '00100', '00100', '00000'],
}

/** What the counter shows. Past nine, the exact number wouldn't fit, and wouldn't change what anyone does. */
export const badgeText = (count: number) => (count > 9 ? '9+' : String(count))

const put = (bitmap: Buffer, size: number, x: number, y: number, colour: number[]) => {
  if (x >= 0 && y >= 0 && x < size && y < size) bitmap.set(colour, (y * size + x) * 4)
}

/** A round counter. Nothing to count, nothing to draw. */
export function badgeBitmap(count: number): Buffer | null {
  if (!Number.isInteger(count) || count <= 0) return null
  const size = BADGE_SIZE
  const bitmap = Buffer.alloc(size * size * 4)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if ((x - 7.5) ** 2 + (y - 7.5) ** 2 <= 64) put(bitmap, size, x, y, ACCENT)
    }
  }
  const text = badgeText(count)
  const wide = text.length * 5 + (text.length - 1)
  const left = Math.floor((size - wide) / 2)
  const top = Math.floor((size - 7) / 2)
  ;[...text].forEach((char, index) => {
    DIGITS[char].forEach((row, y) => {
      ;[...row].forEach((cell, x) => {
        if (cell === '1') put(bitmap, size, left + index * 6 + x, top + y, INK)
      })
    })
  })
  return bitmap
}

/** The tray icon with a small dot in its corner, so that something waiting shows even with the window closed. */
export function withDot(icon: Buffer, size: number): Buffer {
  const bitmap = Buffer.from(icon)
  const radius = Math.max(3, Math.round(size / 4))
  const centre = size - radius
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if ((x - centre) ** 2 + (y - centre) ** 2 <= radius ** 2) put(bitmap, size, x, y, AMBER)
    }
  }
  return bitmap
}

/** What the tray says on hover, in words. */
export function trayText(unread: number, waiting: number, listening: boolean): string {
  const parts = [
    listening ? t('à l’écoute') : '',
    unread > 0 ? t('{0} fil{1} non lu{1}', { 0: unread, 1: unread > 1 ? 's' : '' }) : '',
    waiting > 0 ? t('{0} à valider', { 0: waiting }) : '',
  ].filter(Boolean)
  return ['Board', ...parts].join(' · ')
}
