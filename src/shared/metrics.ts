import type { HistoryItem, HistoryRun, OpenPull } from './ledger.ts'
import { dateLocale, t } from './i18n/i18n.ts'

/**
 * What the overview's charts say, worked out from the ledger in the person's own time. Nothing here is
 * estimated or written by a model: a figure is a count of what GitHub lists, and what isn't known says so.
 */

export type OverviewTab = 'global' | 'equipe' | 'avancement' | 'activite' | 'ci' | 'hotes'
export const OVERVIEW_TABS: [OverviewTab, string][] = [
  ['global', t('En bref')],
  ['equipe', t('Qui fait quoi')],
  ['avancement', t('Avancement')],
  ['activite', t('Activité')],
  ['ci', 'CI'],
  ['hotes', t('Environnement')],
]
export const toTab = (tab: OverviewTab) => (tab === 'global' ? '#vue' : `#vue/${tab}`)

/** The screen's address, and those of the two screens it replaced, which links in threads still carry. */
export function readOverviewHash(hash: string): OverviewTab | null {
  if (hash === 'vue' || hash === 'infra') return 'global'
  if (hash === 'now') return 'equipe'
  if (hash === 'infra/chemin' || hash === 'vue/chemin') return 'global'
  if (hash === 'infra/hotes') return 'hotes'
  if (hash === 'infra/jobs') return 'ci'
  const match = hash.match(/^vue\/(.+)$/)
  return match && OVERVIEW_TABS.some(([id]) => id === match[1]) ? (match[1] as OverviewTab) : null
}

/** What "Ouvrir un fil" links to on each tab: the copy agents read for it. */
export function subjectOfTab(tab: OverviewTab): { label: string; doc: string } {
  if (tab === 'equipe') return { label: t('Qui fait quoi'), doc: 'github/pulls/open.md' }
  if (tab === 'avancement') return { label: t('Avancement'), doc: 'github/milestones.md' }
  if (tab === 'activite') return { label: t('Activité'), doc: 'github/pulls/merged.md' }
  return { label: t('Infra'), doc: 'github/ci/status.md' }
}

export const HOUR = 3_600_000
export const DAY = 24 * HOUR

export type Range = 'today' | 'week' | 'fortnight'
export const RANGES: [Range, string][] = [
  ['today', t('Aujourd\'hui')],
  ['week', t('7 jours')],
  ['fortnight', t('14 jours')],
]

export interface Bucket {
  from: number
  to: number
  label: string
}

export const startOfDay = (time: number) => {
  const date = new Date(time)
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
}

const dayLabel = (time: number) => new Date(time).toLocaleDateString(dateLocale(), { day: 'numeric', month: 'short' })

/** Hours since midnight for today, whole days otherwise, built from the calendar: a day can have 23 or 25 hours. */
export function bucketsFor(range: Range, now: number): Bucket[] {
  const buckets: Bucket[] = []
  const today = new Date(startOfDay(now))
  if (range === 'today') {
    for (let hour = 0; ; hour += 1) {
      const from = new Date(today.getFullYear(), today.getMonth(), today.getDate(), hour).getTime()
      if (from > now) break
      const to = new Date(today.getFullYear(), today.getMonth(), today.getDate(), hour + 1).getTime()
      buckets.push({ from, to, label: `${String(hour).padStart(2, '0')}h` })
      if (hour === 23) break
    }
    return buckets
  }
  const days = range === 'week' ? 7 : 14
  for (let back = days - 1; back >= 0; back -= 1) {
    const from = new Date(today.getFullYear(), today.getMonth(), today.getDate() - back).getTime()
    const to = new Date(today.getFullYear(), today.getMonth(), today.getDate() - back + 1).getTime()
    buckets.push({ from, to, label: dayLabel(from) })
  }
  return buckets
}

const inside = (iso: string | null | undefined, from: number, to: number) => {
  if (!iso) return false
  const time = Date.parse(iso)
  return time >= from && time < to
}

/** The label of issues that are headings over work: set from the environment's conventions. */
let epicLabel = 'epic'
export const setEpicLabel = (label: string) => {
  epicLabel = label
}

/** The reports count work, and an epic is a heading over work. */
export const isTicket = (item: HistoryItem) => item.kind === 'issue' && (!epicLabel || !item.labels.includes(epicLabel))

export interface ActivityRow {
  label: string
  merged: number
  closed: number
  opened: number
}

export function activityBy(buckets: Bucket[], items: HistoryItem[]): ActivityRow[] {
  return buckets.map(({ from, to, label }) => ({
    label,
    merged: items.filter((item) => item.kind === 'pull' && inside(item.merged, from, to)).length,
    closed: items.filter((item) => isTicket(item) && inside(item.closed, from, to)).length,
    opened: items.filter((item) => isTicket(item) && inside(item.created, from, to)).length,
  }))
}

const median = (values: number[]) => {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

const minutes = (run: HistoryRun) => (Date.parse(run.end ?? run.start) - Date.parse(run.start)) / 60_000

export interface CiRow {
  label: string
  success: number
  failure: number
  /** Null for a period where nothing finished: no line goes through it. */
  medianMinutes: number | null
}

export function ciBy(buckets: Bucket[], runs: HistoryRun[]): CiRow[] {
  return buckets.map(({ from, to, label }) => {
    const here = runs.filter((run) => inside(run.start, from, to))
    const counted = here.filter((run) => run.state === 'success' || run.state === 'failure')
    return {
      label,
      success: counted.filter((run) => run.state === 'success').length,
      failure: counted.filter((run) => run.state === 'failure').length,
      medianMinutes: median(counted.map(minutes)),
    }
  })
}

export interface CiSummary {
  finished: number
  success: number
  failure: number
  other: number
  active: number
  /** Null until a run finishes: "0 %" would say every run failed. */
  rate: number | null
  medianMinutes: number | null
  longestMinutes: number | null
}

export function ciSummary(runs: HistoryRun[], from: number, to: number): CiSummary {
  const here = runs.filter((run) => inside(run.start, from, to))
  const counted = here.filter((run) => run.state === 'success' || run.state === 'failure')
  const success = counted.filter((run) => run.state === 'success').length
  const lengths = counted.map(minutes)
  return {
    finished: counted.length,
    success,
    failure: counted.length - success,
    other: here.filter((run) => run.state === 'other').length,
    active: here.filter((run) => run.state === 'running' || run.state === 'queued').length,
    rate: counted.length ? Math.round((100 * success) / counted.length) : null,
    medianMinutes: median(lengths),
    longestMinutes: lengths.length ? Math.max(...lengths) : null,
  }
}

/** Where CI fails most, with what it ran, so that one failure on a quiet branch doesn't top a busy one. */
export function failingBranches(runs: HistoryRun[], from: number, to: number, limit = 6): { branch: string; failure: number; total: number; pr: number | null }[] {
  const byBranch = new Map<string, { branch: string; failure: number; total: number; pr: number | null }>()
  for (const run of runs) {
    if (!inside(run.start, from, to) || (run.state !== 'success' && run.state !== 'failure')) continue
    const row = byBranch.get(run.branch) ?? { branch: run.branch, failure: 0, total: 0, pr: run.pr }
    row.total += 1
    if (run.state === 'failure') row.failure += 1
    row.pr ??= run.pr
    byBranch.set(run.branch, row)
  }
  return [...byBranch.values()].filter((row) => row.failure).sort((a, b) => b.failure - a.failure || a.branch.localeCompare(b.branch)).slice(0, limit)
}

export interface BurnPoint {
  time: number
  total: number
  closed: number
}

/**
 * Tickets that exist and tickets closed, through time. By each ticket's current milestone: GitHub's list doesn't
 * say which milestone it had before.
 */
export function burnup(items: HistoryItem[], milestone: string | null, now: number, points = 60): BurnPoint[] {
  const tickets = items.filter((item) => isTicket(item) && (milestone === null || item.milestone === milestone))
  if (!tickets.length) return []
  const created = tickets.map((item) => Date.parse(item.created)).sort((a, b) => a - b)
  const closed = tickets.flatMap((item) => (item.closed ? [Date.parse(item.closed)] : [])).sort((a, b) => a - b)
  const start = created[0]
  if (now <= start) return [{ time: now, total: tickets.length, closed: closed.length }]
  const out: BurnPoint[] = []
  let c = 0
  let d = 0
  for (let index = 0; index < points; index += 1) {
    const time = start + ((now - start) * index) / (points - 1)
    while (c < created.length && created[c] <= time) c += 1
    while (d < closed.length && closed[d] <= time) d += 1
    out.push({ time, total: c, closed: d })
  }
  return out
}

/** Which points of a line begin a day, thinned out to fit. Regular steps would name one day twice. */
export function dayTicks(times: number[], fits: number): number[] {
  const starts = times.flatMap((time, index) => (index === 0 || startOfDay(time) !== startOfDay(times[index - 1]) ? [index] : []))
  if (starts.length <= fits) return starts
  const step = Math.ceil(starts.length / Math.max(fits, 1))
  return starts.filter((_, index) => index % step === 0)
}

export interface Forecast {
  total: number
  remaining: number
  /** Closed each day over the last days. */
  pace: number
  /** Days of work left at that pace. Null when nothing was closed: no date can be said. */
  daysLeft: number | null
  /** Whole days until the due date, in the person's calendar. Null without one. */
  daysToDue: number | null
}

/** What the last days' pace would give if nothing changed: a line of arithmetic, which the screen calls that. */
export function forecast(items: HistoryItem[], milestone: string | null, due: string | null, now: number, days = 3): Forecast {
  const tickets = items.filter((item) => isTicket(item) && (milestone === null || item.milestone === milestone))
  const remaining = tickets.filter((item) => !item.closed).length
  const closedLately = tickets.filter((item) => inside(item.closed, now - days * DAY, now + 1)).length
  const pace = closedLately / days
  const here = new Date(now)
  return {
    total: tickets.length,
    remaining,
    pace,
    daysLeft: remaining === 0 ? 0 : pace > 0 ? remaining / pace : null,
    daysToDue: due ? Math.round((Date.parse(`${due.slice(0, 10)}T00:00:00Z`) - Date.UTC(here.getFullYear(), here.getMonth(), here.getDate())) / DAY) : null,
  }
}

export interface AreaRow {
  area: string
  closed: number
  open: number
}

export function areasOf(items: HistoryItem[], milestone: string | null): AreaRow[] {
  const rows = new Map<string, AreaRow>()
  for (const item of items) {
    if (!isTicket(item) || (milestone !== null && item.milestone !== milestone)) continue
    for (const label of item.labels) {
      if (!label.startsWith('area:')) continue
      const area = label.slice(5)
      const row = rows.get(area) ?? { area, closed: 0, open: 0 }
      if (item.closed) row.closed += 1
      else row.open += 1
      rows.set(area, row)
    }
  }
  return [...rows.values()].sort((a, b) => b.closed + b.open - (a.closed + a.open) || a.area.localeCompare(b.area))
}

/** The usual order of a project's statuses, so that a ramp can follow it. A project's own statuses come as they are. */
export const STATUSES = ['To triage', 'Backlog', 'Ready', 'In progress', 'In review', 'Done']

/** Tickets by project status: every status the project gave a ticket, in the usual order, then the others by name. */
export function statusCounts(items: HistoryItem[], statuses: Record<string, string>, milestone: string | null): { status: string; count: number }[] {
  const counts = new Map<string, number>()
  for (const item of items) {
    if (!isTicket(item) || (milestone !== null && item.milestone !== milestone)) continue
    const status = statuses[item.number]
    if (status) counts.set(status, (counts.get(status) ?? 0) + 1)
  }
  const rank = (status: string) => {
    const at = STATUSES.indexOf(status)
    return at < 0 ? STATUSES.length : at
  }
  return [...counts.entries()].sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b)).map(([status, count]) => ({ status, count }))
}

export interface ShipRow {
  who: string
  open: number
  merged: number
  added: number
  deleted: number
  /** Merged pull requests whose lines aren't read yet: the two figures above say less than they should. */
  unread: number
  opened: number
}

export function whoShips(items: HistoryItem[], pulls: OpenPull[], lines: Record<string, { added: number; deleted: number }>, from: number, to: number, nameOf: (login: string) => string): ShipRow[] {
  const rows = new Map<string, ShipRow>()
  // Two members can share a display name: rows are one per login, named for the screen.
  const row = (login: string) => {
    const key = login.toLowerCase()
    const found = rows.get(key) ?? { who: nameOf(login), open: 0, merged: 0, added: 0, deleted: 0, unread: 0, opened: 0 }
    rows.set(key, found)
    return found
  }
  for (const pull of pulls) row(pull.author).open += 1
  for (const item of items) {
    if (item.kind === 'pull' && inside(item.merged, from, to)) {
      const found = row(item.author)
      found.merged += 1
      const counted = lines[item.number]
      if (counted) {
        found.added += counted.added
        found.deleted += counted.deleted
      } else found.unread += 1
    }
    if (isTicket(item) && inside(item.created, from, to)) row(item.author).opened += 1
  }
  return [...rows.values()].sort((a, b) => b.merged - a.merged || b.open - a.open || a.who.localeCompare(b.who))
}

export function recentMerges(items: HistoryItem[], limit = 10): HistoryItem[] {
  return items
    .filter((item) => item.kind === 'pull' && item.merged)
    .sort((a, b) => (b.merged ?? '').localeCompare(a.merged ?? ''))
    .slice(0, limit)
}

export interface Headline {
  merged: number
  closed: number
  opened: number
  ci: CiSummary
}

export function headline(items: HistoryItem[], runs: HistoryRun[], now: number): Headline {
  const today = startOfDay(now)
  const [row] = activityBy([{ from: today, to: now + 1, label: '' }], items)
  return { merged: row.merged, closed: row.closed, opened: row.opened, ci: ciSummary(runs, today, now + 1) }
}

/** The next milestone that matters: the earliest due date among those not finished, then the first one not finished. */
export function nextMilestone<T extends { title: string; closed: number; total: number; due: string | null }>(milestones: T[]): T | null {
  const open = milestones.filter((milestone) => milestone.closed < milestone.total)
  return [...open].filter((milestone) => milestone.due).sort((a, b) => (a.due ?? '').localeCompare(b.due ?? ''))[0] ?? open[0] ?? null
}




const FAILED_CI = new Set(['failure', 'timed_out', 'startup_failure'])
const UNDER_WAY_CI = new Set(['in_progress', 'queued', 'waiting', 'requested', 'pending'])

/** The same count as the 5-minute copy's, from the ledger: one screen mustn't give two numbers of pull requests. */
export const pullsNow = (pulls: OpenPull[]) => ({ open: pulls.length, draft: pulls.filter((pull) => pull.draft).length, red: pulls.filter((pull) => ciWordOf(pull.ci) === 'failure').length })

/** What a commit's CI says: a run's status until it ends, then its conclusion. */
export type CiWord = 'success' | 'failure' | 'running' | 'other' | 'none'
export const ciWordOf = (ci: string): CiWord => (ci === 'success' ? 'success' : FAILED_CI.has(ci) ? 'failure' : UNDER_WAY_CI.has(ci) ? 'running' : ci ? 'other' : 'none')


/** Clean steps for an axis: at most `steps` of them, from 0 to at least `max`. */
export function niceTicks(max: number, steps = 5): number[] {
  if (max <= 0) return [0, 1]
  const rough = max / steps
  const power = 10 ** Math.floor(Math.log10(rough))
  const step = [1, 2, 5, 10].map((one) => one * power).find((one) => one >= rough) ?? 10 * power
  const whole = Math.max(step, 1)
  const ticks: number[] = []
  for (let tick = 0; tick < max + whole; tick += whole) {
    ticks.push(tick)
    if (tick >= max) break
  }
  return ticks
}

/** Which of `count` labels to show so that they don't touch, always with the last. */
export function tickIndexes(count: number, room: number, labelWidth: number): number[] {
  if (count <= 0) return []
  const fits = Math.max(2, Math.floor(room / labelWidth))
  const step = Math.max(1, Math.ceil(count / fits))
  const out: number[] = []
  for (let index = count - 1; index >= 0; index -= step) out.unshift(index)
  return out
}

export interface ReportDay {
  day: string
  reports: { name: string; path: string }[]
  /** A day that ended keeps its three-hour points, out of the way. */
  folded?: { name: string; path: string }[]
}

interface GeneratedReport {
  id: string
  kind: 'update' | 'day'
  day: string
  slot: number | null
}

/** The environment's time zone, which reports are cut in: set from the configuration when the page starts. */
let zone = 'UTC'
export const setZone = (next: string) => {
  zone = next
}
export const zoneNow = () => zone
const parisDay = (time: number) => new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(time))

/**
 * Today: its updates, latest first, as they come. A day that ended: its report, with its updates folded, or the updates
 * alone until a report exists.
 */
export function mergeReportDays(generated: GeneratedReport[], now: number): ReportDay[] {
  const today = parisDay(now)
  const days = new Map<string, ReportDay>()
  const ofDay = new Map<string, GeneratedReport[]>()
  // A file dated after today comes from a clock that was wrong, and would open first.
  for (const report of generated) if (report.day <= today) ofDay.set(report.day, [...(ofDay.get(report.day) ?? []), report])
  for (const [day, reports] of ofDay) {
    const dayReport = reports.find((report) => report.kind === 'day')
    const points = reports.filter((report) => report.kind === 'update').sort((a, b) => b.id.localeCompare(a.id))
    const entry = (report: GeneratedReport) => ({ name: report.kind === 'day' ? t('Rapport du jour') : t('Point de {0}:00', { 0: String(report.slot).padStart(2, '0') }), path: `auto/${report.id}` })
    const showPoints = day === today || !dayReport
    days.set(day, {
      day,
      reports: [...(dayReport ? [entry(dayReport)] : []), ...(showPoints ? points.map(entry) : [])],
      folded: !showPoints && points.length ? points.map(entry) : undefined,
    })
  }
  return [...days.values()].sort((a, b) => b.day.localeCompare(a.day))
}

/** The value below which that share of them lie, nearest rank. */
export function percentile(values: number[], share: number): number | null {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(share * sorted.length) - 1))]
}

export interface TimeSpread {
  count: number
  /** In hours. */
  median: number | null
  p90: number | null
}

const spread = (hours: number[]): TimeSpread => ({ count: hours.length, median: median(hours), p90: percentile(hours, 0.9) })
/** An item imported or moved from elsewhere can have closed before it was created here: that says nothing about time. */
const hoursOf = (pairs: [string, string][]) => pairs.map(([start, end]) => (Date.parse(end) - Date.parse(start)) / 3_600_000).filter((hours) => hours >= 0)

/** How long work takes to get through, for what ended in this period. */
export function deliveryTimes(items: HistoryItem[], from: number, to: number): { pulls: TimeSpread; tickets: TimeSpread } {
  const pulls = items.filter((item) => item.kind === 'pull' && inside(item.merged, from, to))
  const tickets = items.filter((item) => isTicket(item) && inside(item.closed, from, to))
  return {
    pulls: spread(hoursOf(pulls.map((item) => [item.created, item.merged as string]))),
    tickets: spread(hoursOf(tickets.map((item) => [item.created, item.closed as string]))),
  }
}

/** The ready pull request that has waited longest for anyone to review it. */
export function oldestUnreviewed(pulls: OpenPull[]): OpenPull | null {
  return pulls.filter((pull) => !pull.draft && pull.review === 'none').sort((a, b) => a.created.localeCompare(b.created))[0] ?? null
}

/** Runs started again, among those whose try is known: a flaky suite shows here first. */
export function retriedRuns(runs: HistoryRun[], from: number, to: number): { retried: number; attemptsKnown: number } {
  const known = runs.filter((run) => inside(run.start, from, to) && run.attempt)
  return { retried: known.filter((run) => (run.attempt ?? 1) > 1).length, attemptsKnown: known.length }
}

/** How long jobs waited for a runner, in minutes. GitHub's list covers the last two hours only. */
export function queueWait(jobs: { queuedAt?: string; start: string; state: string; runner: string | null }[]): { median: number | null; longest: number | null; count: number } {
  const waits = jobs.flatMap((job) => {
    // A job cancelled or skipped never had a runner, and so wasn't waiting for one.
    if (!job.queuedAt || !job.runner || job.state === 'queued') return []
    const wait = (Date.parse(job.start) - Date.parse(job.queuedAt)) / 60_000
    return wait >= 0 ? [wait] : []
  })
  return { median: median(waits), longest: waits.length ? Math.max(...waits) : null, count: waits.length }
}

/** How many fall on each of the last days, today last. */
export function dailyCounts(times: (string | null)[], now: number, days = 14): number[] {
  const today = startOfDay(now)
  const starts = Array.from({ length: days + 1 }, (_, index) => {
    const date = new Date(today)
    date.setDate(date.getDate() - (days - 1 - index))
    return date.getTime()
  })
  return Array.from({ length: days }, (_, index) => times.filter((time) => inside(time, starts[index], starts[index + 1])).length)
}

/** Today so far, against yesterday at the same time of day. */
export function versusYesterday(times: (string | null)[], now: number): number {
  const today = startOfDay(now)
  const here = new Date(now)
  // By the clock, not by elapsed time: a day can last 23 or 25 hours.
  const start = new Date(here.getFullYear(), here.getMonth(), here.getDate() - 1).getTime()
  const same = new Date(here.getFullYear(), here.getMonth(), here.getDate() - 1, here.getHours(), here.getMinutes(), here.getSeconds(), here.getMilliseconds()).getTime()
  return times.filter((time) => inside(time, today, now + 1)).length - times.filter((time) => inside(time, start, Math.min(same + 1, today))).length
}

export interface ForecastRange {
  /** Days left, at the fastest and the slowest of the paces. */
  low: number
  high: number
  windows: number[]
}

/** A range rather than a figure: the pace over several periods, leaving out those where nothing closed. */
export function forecastRange(items: HistoryItem[], milestone: string | null, due: string | null, now: number, windows = [3, 7, 14]): ForecastRange | null {
  const left = windows.flatMap((days) => {
    const one = forecast(items, milestone, due, now, days)
    return one.daysLeft === null || one.remaining === 0 ? [] : [{ days, left: one.daysLeft }]
  })
  if (left.length < 2) return null
  const values = left.map((one) => one.left)
  return { low: Math.min(...values), high: Math.max(...values), windows: left.map((one) => one.days) }
}

/** What a column of the activity chart holds. */
export function itemsOfBucket(items: HistoryItem[], bucket: Bucket): { merged: HistoryItem[]; closed: HistoryItem[]; opened: HistoryItem[] } {
  return {
    merged: items.filter((item) => item.kind === 'pull' && inside(item.merged, bucket.from, bucket.to)),
    closed: items.filter((item) => isTicket(item) && inside(item.closed, bucket.from, bucket.to)),
    opened: items.filter((item) => isTicket(item) && inside(item.created, bucket.from, bucket.to)),
  }
}

/** What a column of the runs chart holds, failures first. */
export function runsOfBucket(runs: HistoryRun[], bucket: Bucket): HistoryRun[] {
  const order: Record<string, number> = { failure: 0, success: 1 }
  return runs
    .filter((run) => inside(run.start, bucket.from, bucket.to) && (run.state === 'success' || run.state === 'failure'))
    .sort((a, b) => order[a.state] - order[b.state] || a.start.localeCompare(b.start))
}

export function ticketsOfArea(items: HistoryItem[], area: string, milestone: string | null): HistoryItem[] {
  return items.filter((item) => isTicket(item) && item.labels.includes(`area:${area}`) && (milestone === null || item.milestone === milestone))
}

export function ticketsOfStatus(items: HistoryItem[], statuses: Record<string, string>, status: string, milestone: string | null): HistoryItem[] {
  return items.filter((item) => isTicket(item) && statuses[item.number] === status && (milestone === null || item.milestone === milestone))
}

/** The report to open when none is asked for: never an old one, whose translation would spend the reader's quota unasked. */
export const latestGenerated = (days: ReportDay[]): string | null => days.flatMap((day) => [...day.reports, ...(day.folded ?? [])]).find((report) => report.path.startsWith('auto/'))?.path ?? null

/** White or near-black on a fill, by which reads better. */
export function inkOn(hex: string): string {
  const value = parseInt(hex.slice(1), 16)
  const channel = (shift: number) => {
    const c = ((value >> shift) & 255) / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  }
  const luminance = 0.2126 * channel(16) + 0.7152 * channel(8) + 0.0722 * channel(0)
  return (luminance + 0.05) / 0.05 > 1.05 / (luminance + 0.05) ? '#0b0b0b' : '#ffffff'
}

/** One line per host, in steps of `step` seconds over the last `span`, by each host's own clock. */
export interface LowestMemory {
  /** The start of each step, in Unix seconds. */
  times: number[]
  series: { name: string; values: (number | null)[] }[]
}

/**
 * The lowest free memory of each step, from the probes' points, in MiB. A step without a point is a gap,
 * not a zero, and steps before every host's first point are left out.
 */
export function lowestMemoryOf(hosts: { name: string; reading: { points: { at: number; lowest: number }[] } | null }[], step = 300, span = 6 * 3600): LowestMemory | null {
  const known = hosts.filter((host) => host.reading?.points.length)
  if (!known.length) return null
  const end = Math.max(...known.flatMap((host) => host.reading!.points.map((point) => point.at)))
  const start = end - span
  const count = Math.floor(span / step) + 1
  const series = known.map((host) => {
    const values: (number | null)[] = Array(count).fill(null)
    for (const point of host.reading!.points) {
      const index = Math.floor((point.at - start) / step)
      if (index < 0 || index >= count) continue
      values[index] = values[index] === null ? point.lowest : Math.min(values[index]!, point.lowest)
    }
    return { name: host.name, values }
  })
  const first = Math.min(...series.map((one) => one.values.findIndex((value) => value !== null)).filter((index) => index >= 0))
  return { times: Array.from({ length: count - first }, (_, index) => start + (first + index) * step), series: series.map((one) => ({ ...one, values: one.values.slice(first) })) }
}
