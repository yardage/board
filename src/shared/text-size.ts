/**
 * How large the app is drawn, chosen in the settings of each computer. The stylesheet counts in pixels, so it is the window
 * that scales: everything grows together, and what the code measures stays right. A clone in a browser has its own zoom.
 */
export const TEXT_SIZES = ['small', 'medium', 'large', 'larger'] as const
export type TextSize = (typeof TEXT_SIZES)[number]

export const DEFAULT_TEXT_SIZE: TextSize = 'large'
export const TEXT_ZOOM: Record<TextSize, number> = { small: 0.8, medium: 0.9, large: 1, larger: 1.15 }

export const isTextSize = (value: unknown): value is TextSize => (TEXT_SIZES as readonly unknown[]).includes(value)

/** One size up or down; the ends stay where they are. */
export function stepTextSize(size: TextSize, by: 1 | -1): TextSize {
  return TEXT_SIZES[Math.min(TEXT_SIZES.length - 1, Math.max(0, TEXT_SIZES.indexOf(size) + by))]
}
