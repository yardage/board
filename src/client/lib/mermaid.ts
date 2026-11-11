/**
 * The coordinator's old reports hold Mermaid charts, which GitHub draws and this app doesn't load: they would show as
 * code. Only the two shapes those reports use are understood. Anything else stays as code, which is honest and readable.
 */

export interface MermaidChart {
  kind: 'chart'
  title: string
  labels: string[]
  /** In the order written, with their kind and colour. */
  series: { type: 'line' | 'bar'; color: string; values: number[] }[]
}

export interface MermaidFlow {
  kind: 'flow'
  nodes: { id: string; name: string; count: string }[]
  edges: { from: string; to: string; label: string }[]
}

const COLOUR = /^#[0-9a-f]{6}$/i
const DEFAULT_COLOURS = ['#8957e5', '#3fb950', '#2f81f7', '#d29922']
/** Anyone can post a block like this in a thread, which stays for good. Far beyond any real report's; past it, it stays as code. */
const SOURCE_MAX = 20_000
const LINE_MAX = 4_000
const POINTS_MAX = 200
const SERIES_MAX = 8
const NODES_MAX = 30
const EDGES_MAX = 60

function parseChart(lines: string[]): MermaidChart | null {
  let palette: string[] = []
  let title = ''
  let labels: string[] | null = null
  const series: MermaidChart['series'] = []
  for (const line of lines) {
    const colours = /^plotColorPalette:\s*"([^"]*)"/.exec(line)
    if (colours) palette = colours[1].split(',').map((one) => one.trim()).filter((one) => COLOUR.test(one))
    title = /^title\s+"([^"]*)"/.exec(line)?.[1] ?? title
    const axis = /^x-axis\s+\[([^\]]*)\]/.exec(line)
    if (axis) labels = axis[1].split(',').map((one) => one.trim().replace(/^"|"$/g, ''))
    const values = /^(line|bar)\s+\[([^\]]*)\]/.exec(line)
    if (!values) continue
    const numbers = values[2].split(',').map((one) => Number(one.trim()))
    if (numbers.some((value) => !Number.isFinite(value))) return null
    series.push({ type: values[1] as 'line' | 'bar', color: palette[series.length] ?? DEFAULT_COLOURS[series.length % DEFAULT_COLOURS.length], values: numbers })
  }
  if (!labels || labels.length > POINTS_MAX || !series.length || series.length > SERIES_MAX || series.some((one) => one.values.length !== labels?.length)) return null
  return { kind: 'chart', title, labels, series }
}

function parseFlow(lines: string[]): MermaidFlow | null {
  const nodes: MermaidFlow['nodes'] = []
  const edges: MermaidFlow['edges'] = []
  for (const line of lines) {
    const node = /^(\w+)\["([^"<]*)(?:<br\/?><b>([^<]*)<\/b>)?"\]/.exec(line)
    if (node) nodes.push({ id: node[1], name: node[2].trim(), count: node[3]?.trim() ?? '' })
    const edge = /^(\w+) -- (.+) --> (\w+)$/.exec(line)
    if (edge) edges.push({ from: edge[1], label: edge[2], to: edge[3] })
  }
  return nodes.length && nodes.length <= NODES_MAX && edges.length <= EDGES_MAX ? { kind: 'flow', nodes, edges } : null
}

/** Line by line, on trimmed lines of a bounded size: nothing here can take long, whatever a block holds. */
export function parseMermaid(source: string): MermaidChart | MermaidFlow | null {
  if (source.length > SOURCE_MAX) return null
  const lines = source.split('\n').map((line) => line.slice(0, LINE_MAX).trim())
  if (lines.includes('xychart-beta')) return parseChart(lines)
  if (lines.some((line) => /^flowchart\b/.test(line))) return parseFlow(lines)
  return null
}
