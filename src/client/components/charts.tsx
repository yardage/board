import { Component, type KeyboardEvent, type ReactNode, type RefObject, useLayoutEffect, useRef, useState } from 'react'
import { inkOn, niceTicks, tickIndexes } from '../../shared/metrics.ts'
import { dateLocale, t } from '../../shared/i18n/i18n.ts'

/**
 * The overview's charts, in plain SVG and React. Their marks follow dataviz's specs: bars of at most 24 px,
 * rounded at the data end and square at the baseline, 2 px lines, end dots with a ring in the surface's colour,
 * solid hairlines, text in text colours. A tooltip adds to what is on screen, never replaces it: every chart has
 * its table, and the keyboard gets what the mouse gets.
 */

const SURFACE = 'var(--bg)'

export function useWidth(): [RefObject<HTMLDivElement | null>, number] {
  const ref = useRef<HTMLDivElement | null>(null)
  const [width, setWidth] = useState(0)
  useLayoutEffect(() => {
    const element = ref.current
    if (!element) return
    setWidth(element.clientWidth)
    const observer = new ResizeObserver(() => setWidth(element.clientWidth))
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  return [ref, width]
}

export interface Series {
  name: string
  color: string
  values: (number | null)[]
}

export interface TipState {
  x: number
  y: number
  content: ReactNode
}

export function Tip({ tip }: { tip: TipState | null }) {
  if (!tip) return null
  // Kept inside the window, whichever side of a chart it opens on.
  const left = Math.min(tip.x + 12, window.innerWidth - 280)
  return (
    <div className="viz-tip" style={{ left: Math.max(4, left), top: Math.max(4, Math.min(tip.y + 12, window.innerHeight - 140)) }} role="status">
      {tip.content}
    </div>
  )
}

export const Key = ({ color, line }: { color: string; line?: boolean }) => <i className={line ? 'viz-key line' : 'viz-key'} style={{ background: color }} />

/** A legend is there for two series or more; a word in it says what a status colour means. */
export function Legend({ items }: { items: { name: string; color: string; line?: boolean }[] }) {
  return (
    <div className="viz-legend">
      {items.map((item) => (
        <span key={item.name}>
          <Key color={item.color} line={item.line} />
          {item.name}
        </span>
      ))}
    </div>
  )
}

export function TableView({ head, rows, numeric }: { head: string[]; rows: (string | number)[][]; numeric?: number }) {
  return (
    <details className="inf-details">
      <summary>{t('Voir en tableau')}</summary>
      <table>
        <thead>
          <tr>
            {head.map((title, index) => (
              <th key={title} className={numeric !== undefined && index >= numeric ? 'n' : undefined}>
                {title}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={index}>
              {row.map((cell, column) => (
                <td key={column} className={numeric !== undefined && column >= numeric ? 'n' : undefined}>
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </details>
  )
}

const tipRows = (labels: string, series: { name: string; color: string; value: ReactNode }[]) => (
  <>
    <strong>{labels}</strong>
    {series.map((one) => (
      <span key={one.name} className="viz-tip-row">
        <Key color={one.color} /> {one.name} <b>{one.value}</b>
      </span>
    ))}
  </>
)

const number = (value: number) => value.toLocaleString(dateLocale(), { maximumFractionDigits: 1 })

/** A move through a chart's points with the arrow keys. */
function useCursor(count: number): [number | null, (index: number | null) => void, (event: KeyboardEvent) => void] {
  const [cursor, setCursor] = useState<number | null>(null)
  const onKey = (event: KeyboardEvent) => {
    if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
      event.preventDefault()
      const step = event.key === 'ArrowRight' ? 1 : -1
      setCursor((now) => Math.max(0, Math.min(count - 1, (now !== null && now < count ? now : step > 0 ? -1 : count) + step)))
    }
    if (event.key === 'Escape') setCursor(null)
  }
  // Read at each render: a refresh at midnight can leave a chart with one point under a pointer resting on the 20th.
  return [cursor !== null && cursor < count ? cursor : null, setCursor, onKey]
}

/** Keeps the labels of an axis from touching, from the last one back: the latest is the one that gets read. */
const apart = (ticks: { index: number; label: string }[], x: (index: number) => number, room: number) => {
  const kept: { index: number; label: string }[] = []
  for (const tick of [...ticks].reverse()) if (!kept.length || x(kept[0].index) - x(tick.index) >= room) kept.unshift(tick)
  return kept
}

export function LineChart({ series, labels, axis, height = 190, label, unit = '' }: { series: Series[]; labels: string[]; axis?: { index: number; label: string }[]; height?: number; label: string; unit?: string }) {
  const [ref, width] = useWidth()
  const [cursor, setCursor, onKey] = useCursor(labels.length)
  const [mouse, setMouse] = useState<{ x: number; y: number } | null>(null)
  const left = 36
  const right = 44
  const top = 12
  const bottom = 22
  const plot = Math.max(width - left - right, 1)
  const inner = height - top - bottom
  const max = Math.max(1, ...series.flatMap((one) => one.values.map((value) => value ?? 0)))
  const ticks = niceTicks(max)
  const ceiling = ticks[ticks.length - 1]
  const x = (index: number) => left + (labels.length > 1 ? (index / (labels.length - 1)) * plot : plot)
  const y = (value: number) => top + inner - (value / ceiling) * inner
  const path = (values: (number | null)[]) => {
    let line = ''
    let open = false
    values.forEach((value, index) => {
      if (value === null) {
        open = false
        return
      }
      line += `${open ? 'L' : 'M'}${x(index).toFixed(1)} ${y(value).toFixed(1)}`
      open = true
    })
    return line
  }
  const ends = series.map((one) => {
    const index = one.values.reduce<number>((last, value, at) => (value === null ? last : at), -1)
    return { one, index, value: index >= 0 ? (one.values[index] as number) : null }
  })
  // Labels too close to each other don't get pushed away from their lines: the legend, the tooltip and the table carry the rest.
  const shown = ends.filter((end, index) => end.value !== null && !ends.slice(0, index).some((other) => other.value !== null && Math.abs(y(other.value) - y(end.value as number)) < 13))
  const tip: TipState | null =
    cursor !== null && width
      ? {
          x: mouse?.x ?? (ref.current?.getBoundingClientRect().left ?? 0) + x(cursor),
          y: mouse?.y ?? (ref.current?.getBoundingClientRect().top ?? 0) + top,
          content: tipRows(
            labels[cursor],
            series.map((one) => ({ name: one.name, color: one.color, value: one.values[cursor] === null ? t('rien') : `${number(one.values[cursor] as number)}${unit}` })),
          ),
        }
      : null
  return (
    <div ref={ref} className="viz-plot">
      {width > 0 && (
        <svg
          width={width}
          height={height}
          role="img"
          aria-label={label}
          tabIndex={0}
          onKeyDown={onKey}
          onBlur={() => setCursor(null)}
          onPointerMove={(event) => {
            const box = event.currentTarget.getBoundingClientRect()
            const at = labels.length > 1 ? Math.round(((event.clientX - box.left - left) / plot) * (labels.length - 1)) : 0
            setCursor(Math.max(0, Math.min(labels.length - 1, at)))
            setMouse({ x: event.clientX, y: event.clientY })
          }}
          onPointerLeave={() => {
            setCursor(null)
            setMouse(null)
          }}
        >
          {ticks.map((tick) => (
            <g key={tick}>
              <line className="viz-grid" x1={left} x2={left + plot} y1={y(tick)} y2={y(tick)} />
              <text className="viz-ax" x={left - 6} y={y(tick) + 3} textAnchor="end">
                {number(tick)}
              </text>
            </g>
          ))}
          {apart(axis ?? tickIndexes(labels.length, plot, 76).map((index) => ({ index, label: labels[index] })), x, 62).map((tick) => (
            <text key={tick.index} className="viz-ax" x={x(tick.index)} y={height - 6} textAnchor={tick.index === labels.length - 1 ? 'end' : tick.index === 0 ? 'start' : 'middle'}>
              {tick.label}
            </text>
          ))}
          {series.length === 1 && series[0].values.every((value) => value !== null) && (
            <path d={`${path(series[0].values)}L${x(labels.length - 1)} ${y(0)}L${x(0)} ${y(0)}Z`} fill={series[0].color} fillOpacity="0.1" />
          )}
          {series.map((one) => (
            <path key={one.name} d={path(one.values)} fill="none" stroke={one.color} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
          ))}
          {ends.map(
            ({ one, index, value }) => value !== null && <circle key={one.name} cx={x(index)} cy={y(value)} r="4" fill={one.color} stroke={SURFACE} strokeWidth="2" />,
          )}
          {shown.map(({ one, index, value }) => (
            <text key={one.name} className="viz-end" x={x(index) + 9} y={y(value as number) + 4}>
              {number(value as number)}
            </text>
          ))}
          {cursor !== null && (
            <>
              <line className="viz-cross" x1={x(cursor)} x2={x(cursor)} y1={top} y2={top + inner} />
              {series.map((one) =>
                one.values[cursor] === null ? null : <circle key={one.name} cx={x(cursor)} cy={y(one.values[cursor] as number)} r="4" fill={one.color} stroke={SURFACE} strokeWidth="2" />,
              )}
            </>
          )}
        </svg>
      )}
      <Tip tip={tip} />
    </div>
  )
}

/** A column: rounded at its data end, square at the baseline. */
const column = (x: number, top: number, width: number, height: number, rounded: boolean) => {
  const radius = rounded ? Math.min(4, width / 2, height) : 0
  return `M${x} ${top + height}V${top + radius}Q${x} ${top} ${x + radius} ${top}H${x + width - radius}Q${x + width} ${top} ${x + width} ${top + radius}V${top + height}Z`
}

export function Columns({ series, labels, stacked, height = 200, label, onPick }: { series: Series[]; labels: string[]; stacked?: boolean; height?: number; label: string; onPick?: (index: number) => void }) {
  const [ref, width] = useWidth()
  const [cursor, setCursor, onKey] = useCursor(labels.length)
  const [mouse, setMouse] = useState<{ x: number; y: number } | null>(null)
  const left = 36
  const right = 8
  const top = 10
  const bottom = 22
  const plot = Math.max(width - left - right, 1)
  const inner = height - top - bottom
  const value = (one: Series, index: number) => one.values[index] ?? 0
  const heights = labels.map((_, index) => (stacked ? series.reduce((sum, one) => sum + value(one, index), 0) : Math.max(0, ...series.map((one) => value(one, index)))))
  const ticks = niceTicks(Math.max(1, ...heights))
  const ceiling = ticks[ticks.length - 1]
  const band = plot / Math.max(labels.length, 1)
  const y = (amount: number) => top + inner - (amount / ceiling) * inner
  const gap = 2
  const groupWidth = Math.min(band - 4, stacked ? 24 : series.length * 24 + (series.length - 1) * gap)
  const barWidth = stacked ? groupWidth : Math.max(1, (groupWidth - (series.length - 1) * gap) / series.length)
  const tip: TipState | null =
    cursor !== null && width
      ? {
          x: mouse?.x ?? (ref.current?.getBoundingClientRect().left ?? 0) + left + cursor * band,
          y: mouse?.y ?? (ref.current?.getBoundingClientRect().top ?? 0) + top,
          content: tipRows(
            labels[cursor],
            series.map((one) => ({ name: one.name, color: one.color, value: number(value(one, cursor)) })),
          ),
        }
      : null
  return (
    <div ref={ref} className="viz-plot">
      {width > 0 && (
        <svg
          width={width}
          height={height}
          role="img"
          aria-label={onPick ? t('{0}. Entrée ou un clic liste ce que contient la période.', { 0: label }) : label}
          tabIndex={0}
          className={onPick ? 'viz-pickable' : undefined}
          onClick={() => {
            if (onPick && cursor !== null) onPick(cursor)
          }}
          onKeyDown={(event) => {
            if (onPick && cursor !== null && event.key === 'Enter') onPick(cursor)
            else onKey(event)
          }}
          onBlur={() => setCursor(null)}
          onPointerMove={(event) => {
            const box = event.currentTarget.getBoundingClientRect()
            setCursor(Math.max(0, Math.min(labels.length - 1, Math.floor((event.clientX - box.left - left) / band))))
            setMouse({ x: event.clientX, y: event.clientY })
          }}
          onPointerLeave={() => {
            setCursor(null)
            setMouse(null)
          }}
        >
          {ticks.map((tick) => (
            <g key={tick}>
              <line className="viz-grid" x1={left} x2={left + plot} y1={y(tick)} y2={y(tick)} />
              <text className="viz-ax" x={left - 6} y={y(tick) + 3} textAnchor="end">
                {number(tick)}
              </text>
            </g>
          ))}
          {cursor !== null && <rect className="viz-band" x={left + cursor * band} y={top} width={band} height={inner} />}
          {labels.map((_, index) => {
            const start = left + index * band + (band - groupWidth) / 2
            if (stacked) {
              let base = 0
              const shown = series.filter((one) => value(one, index) > 0)
              return (
                <g key={index}>
                  {shown.map((one, at) => {
                    const amount = value(one, index)
                    const from = y(base + amount)
                    const full = y(base) - from
                    base += amount
                    // The gap goes between segments, never under the first.
                    const drawn = Math.max(1, full - (at > 0 ? gap : 0))
                    return <path key={one.name} d={column(start, from, barWidth, drawn, at === shown.length - 1)} fill={one.color} />
                  })}
                </g>
              )
            }
            return (
              <g key={index}>
                {series.map((one, at) => {
                  const amount = value(one, index)
                  if (amount <= 0) return null
                  return <path key={one.name} d={column(start + at * (barWidth + gap), y(amount), barWidth, y(0) - y(amount), true)} fill={one.color} />
                })}
              </g>
            )
          })}
          {tickIndexes(labels.length, plot, 52).map((index) => (
            <text key={index} className="viz-ax" x={left + (index + 0.5) * band} y={height - 6} textAnchor="middle">
              {labels[index]}
            </text>
          ))}
        </svg>
      )}
      <Tip tip={tip} />
    </div>
  )
}

export interface Part {
  name: string
  color: string
  value: number
}

/** One whole, at a glance: each part its own block, its amount on it where that fits, names in the legend. */
export function SegmentedBar({ parts, label }: { parts: Part[]; label: string }) {
  const [ref, width] = useWidth()
  const [tip, setTip] = useState<TipState | null>(null)
  const total = parts.reduce((sum, part) => sum + part.value, 0)
  const shown = parts.filter((part) => part.value > 0)
  const room = Math.max(width - (shown.length - 1) * 2, 0)
  const describe = (part: Part) => t('{0} : {1}', { 0: part.name, 1: `${number(part.value)} (${t('{0} %', { 0: Math.round((100 * part.value) / Math.max(total, 1)) })})` })
  return (
    <>
      <div ref={ref} className="viz-segments" role="img" aria-label={`${label}. ${shown.map(describe).join(', ')}`}>
        {width > 0 &&
          shown.map((part) => {
            const size = (part.value / total) * room
            const text = number(part.value)
            return (
              <div
                key={part.name}
                style={{ width: size, background: part.color, color: inkOn(part.color) }}
                tabIndex={0}
                onPointerMove={(event) => setTip({ x: event.clientX, y: event.clientY, content: describe(part) })}
                onPointerLeave={() => setTip(null)}
                onFocus={(event) => {
                  const box = event.currentTarget.getBoundingClientRect()
                  setTip({ x: box.left, y: box.bottom, content: describe(part) })
                }}
                onBlur={() => setTip(null)}
              >
                {/* A block too narrow for its figure prints none: the tooltip and the table have it. */}
                {size >= text.length * 8 + 12 ? text : ''}
              </div>
            )
          })}
      </div>
      <Tip tip={tip} />
      <Legend items={parts.map((part) => ({ name: part.name, color: part.color }))} />
    </>
  )
}

/** To compare parts: one baseline per row, the total in words at the end. */
export function HBars({ rows, unit, scale, onPick }: { rows: { label: string; href?: string; parts: Part[]; note?: string }[]; unit?: string; scale?: number; onPick?: (label: string) => void }) {
  const [tip, setTip] = useState<TipState | null>(null)
  // A share has its own whole: one runner at 12 % doesn't draw a full bar.
  const max = scale ?? Math.max(1, ...rows.map((row) => row.parts.reduce((sum, part) => sum + part.value, 0)))
  return (
    <div className="viz-hbars">
      {rows.map((row) => {
        const total = row.parts.reduce((sum, part) => sum + part.value, 0)
        const words = row.parts.map((part) => `${part.name} ${number(part.value)}`).join(', ')
        const content = tipRows(
          row.label,
          row.parts.map((part) => ({ name: part.name, color: part.color, value: number(part.value) })),
        )
        return (
          <div
            key={row.label}
            className={onPick ? 'viz-hbar viz-pickable' : 'viz-hbar'}
            tabIndex={0}
            aria-label={t('{0} : {1}', { 0: row.label, 1: words })}
            onClick={onPick && (() => onPick(row.label))}
            onKeyDown={onPick && ((event) => event.key === 'Enter' && onPick(row.label))}
            onPointerMove={(event) => setTip({ x: event.clientX, y: event.clientY, content })}
            onPointerLeave={() => setTip(null)}
            onFocus={(event) => {
              const box = event.currentTarget.getBoundingClientRect()
              setTip({ x: box.left, y: box.bottom, content })
            }}
            onBlur={() => setTip(null)}
          >
            <span className="name" title={row.label}>
              {row.href ? (
                <a href={row.href} target="_blank" rel="noreferrer">
                  {row.label}
                </a>
              ) : (
                row.label
              )}
            </span>
            <span className="track">
              {row.parts
                .filter((part) => part.value > 0)
                .map((part) => (
                  <i key={part.name} style={{ width: `${(100 * part.value) / max}%`, background: part.color }} />
                ))}
            </span>
            <span className="num">
              {number(total)}
              {unit ?? ''}
              {row.note ? ` ${row.note}` : ''}
            </span>
          </div>
        )
      })}
      <Tip tip={tip} />
    </div>
  )
}

/** A ratio against its limit: the track is a lighter step of the fill's own colour. */
export function Meter({ part, whole, label }: { part: number; whole: number; label: string }) {
  const share = whole ? Math.min(100, (100 * part) / whole) : 0
  return (
    <div className="viz-meter" role="img" aria-label={t('{0} : {1}', { 0: label, 1: t('{0} %', { 0: Math.floor(share) }) })}>
      <i style={{ width: `${share}%` }} />
    </div>
  )
}

export function StatTile({ label, value, detail }: { label: string; value: ReactNode; detail?: ReactNode }) {
  return (
    <div className="viz-tile">
      <b>{value}</b>
      <span>{label}</span>
      {detail && <small>{detail}</small>}
    </div>
  )
}

/** Fourteen days in the space of a word, beside a figure. Decoration for the eye: the figure and the table say it. */
export function Spark({ values }: { values: number[] }) {
  const width = 72
  const height = 16
  const peak = Math.max(1, ...values)
  const x = (index: number) => (index / Math.max(values.length - 1, 1)) * (width - 2) + 1
  const y = (value: number) => height - 2 - (value / peak) * (height - 4)
  return (
    <svg className="viz-spark" width={width} height={height} aria-hidden>
      <polyline fill="none" stroke="var(--chart-1)" strokeWidth="1.5" points={values.map((value, index) => `${x(index)},${y(value)}`).join(' ')} />
      {values.length > 0 && <circle cx={x(values.length - 1)} cy={y(values[values.length - 1])} r="2" fill="var(--chart-1)" />}
    </svg>
  )
}

/** A chart that can't draw says so, and leaves the rest of the app standing. */
export class ChartBoundary extends Component<{ children: ReactNode }, { failed: string | null }> {
  state = { failed: null as string | null }
  static getDerivedStateFromError(error: Error) {
    return { failed: error.message }
  }
  render() {
    return this.state.failed ? <div className="inline-error">{t('Cet onglet n\'a pas pu s\'afficher : {0}', { 0: this.state.failed })}</div> : this.props.children
  }
}

/** A section of charts, whose title is drawn like the rest of the app's. */
export function Section({ title, note, children }: { title: string; note?: ReactNode; children: ReactNode }) {
  return (
    <section className="viz-section">
      <h4>
        {title} {note && <span>{note}</span>}
      </h4>
      <div className="viz-body">{children}</div>
    </section>
  )
}
