// Draws the app's icons: a rounded dark tile with the board's mark, three rounded lines and a dot, in the default
// theme's colours. `node scripts/icon.mjs` writes build/icon.png, 512 px (the installer, the window and the tray),
// and src/logo.png, 64 px (the mark alone, used as a mask, so only its shape counts). Edges are anti-aliased by
// sampling each pixel 16 times.
import { writeFileSync } from 'node:fs'
import { crc32, deflateSync } from 'node:zlib'

const BG = [0x0a, 0x0a, 0x12]
const ACCENT = [0x00, 0xff, 0xbf]
const INK = [0xf5, 0xf5, 0xf5]
const SAMPLES = 4

function png(size, paint) {
  const raw = Buffer.alloc(size * (size * 4 + 1))
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0
    for (let x = 0; x < size; x++) raw.set(paint(x, y), y * (size * 4 + 1) + 1 + x * 4)
  }
  const chunk = (type, data) => {
    const length = Buffer.alloc(4)
    length.writeUInt32BE(data.length)
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(body))
    return Buffer.concat([length, body, crc])
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(size, 0)
  header.writeUInt32BE(size, 4)
  header.set([8, 6, 0, 0, 0], 8)
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))])
}

/** Signed distance to a rounded rectangle, negative inside. Coordinates in units of the icon's side (0 to 1). */
const roundedRect = (px, py, [left, top, width, height], radius) => {
  const cx = left + width / 2
  const cy = top + height / 2
  const dx = Math.abs(px - cx) - (width / 2 - radius)
  const dy = Math.abs(py - cy) - (height / 2 - radius)
  const outside = Math.hypot(Math.max(dx, 0), Math.max(dy, 0))
  return outside + Math.min(Math.max(dx, dy), 0) - radius
}
const circle = (px, py, cx, cy, radius) => Math.hypot(px - cx, py - cy) - radius

/**
 * The mark: three lines of a board, left-aligned, the first the longest, and a dot that ends the second, as the
 * member who is there. Everything is in units of the side.
 */
const MARK = {
  lines: [
    [0.24, 0.3, 0.52, 0.09],
    [0.24, 0.455, 0.3, 0.09],
    [0.24, 0.61, 0.42, 0.09],
  ],
  dot: [0.655, 0.5, 0.055],
}
const LINE_RADIUS = 0.045
const TILE_RADIUS = 0.22

/** How much of a pixel the shape covers, from 0 to 1, sampled on a grid. */
function coverage(size, x, y, distance) {
  let inside = 0
  for (let sy = 0; sy < SAMPLES; sy++) {
    for (let sx = 0; sx < SAMPLES; sx++) {
      const px = (x + (sx + 0.5) / SAMPLES) / size
      const py = (y + (sy + 0.5) / SAMPLES) / size
      if (distance(px, py) <= 0) inside += 1
    }
  }
  return inside / (SAMPLES * SAMPLES)
}

const markDistance = (px, py) => Math.min(...MARK.lines.map((line) => roundedRect(px, py, line, LINE_RADIUS)), circle(px, py, ...MARK.dot))
const mix = (a, b, share) => a.map((value, index) => Math.round(value * (1 - share) + b[index] * share))

const icon = (size) =>
  png(size, (x, y) => {
    const tile = coverage(size, x, y, (px, py) => roundedRect(px, py, [0.04, 0.04, 0.92, 0.92], TILE_RADIUS))
    if (tile === 0) return [0, 0, 0, 0]
    const mark = coverage(size, x, y, markDistance)
    const colour = mix(BG, ACCENT, mark)
    return [...colour, Math.round(255 * tile)]
  })

const mask = (size) =>
  png(size, (x, y) => {
    const mark = coverage(size, x, y, markDistance)
    return [...INK, Math.round(255 * mark)]
  })

writeFileSync(new URL('../build/icon.png', import.meta.url), icon(512))
writeFileSync(new URL('../src/client/assets/logo.png', import.meta.url), mask(64))
