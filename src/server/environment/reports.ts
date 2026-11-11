import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { activityBy, type ActivityRow, areasOf, type AreaRow, type BurnPoint, burnup, ciBy, ciSummary, type CiRow, ciWordOf, failingBranches, forecast, HOUR, DAY, isTicket, nextMilestone, pullsNow, statusCounts, type ShipRow, whoShips } from '../../shared/metrics.ts'
import type { History, HistoryItem, HistoryRun } from '../github/copy.ts'
import { liveMilestones, type Milestone, type WaitingItem } from '../infra/infra.ts'
import { LOGIN } from './config.ts'
import { looksSecret } from '../lib/secrets.ts'

/**
 * The progress reports: a few times a day for the day under way, then one for each day that ended. Whichever app
 * is running writes them, and nobody asks. A report holds figures and lists, never sentences: the screen says them
 * in the reader's language, so the same file reads in French or in English. No model runs, so a report costs
 * nobody's Claude plan, and reads the same whoever's app wrote it.
 *
 * A report tells of two things: the board itself, threads, messages and polls, which every environment has; and
 * the main repository on GitHub, when the configuration follows one. One file per report, which `claim` lets only
 * one computer write. Each is in the environment's time zone, the same for every member.
 */

/** The environment's time zone: set from its configuration when it opens. */
export let REPORT_ZONE = 'Europe/Paris'
/** The hours a report is due at: from 01:00, every so many hours, as the environment's conventions say. */
export const slotsEvery = (hours: number): number[] => {
  const slots: number[] = []
  for (let hour = 1; hour < 24; hour += Math.max(1, hours)) slots.push(hour)
  return slots
}
let SLOTS = slotsEvery(3)
/** Older than this, the ledger says less than a report would claim. The copy follows it every 5 minutes. */
const FRESH_MS = 15 * 60_000
const BACK_DAYS = 7
/** A day's report written this long after the day's end can't say what was open then: anything can have merged since. */
const LATE_MS = HOUR
/** A computer whose clock is this far from GitHub's would write under the wrong hour, or call a day over too soon, for good. */
const CLOCK_MS = 2 * 60_000
const DAYS_AT_ONCE = 2
const FORECAST_DAYS = 3
const LIST_MAX = 60
const QUEUE_MAX = 40
const TITLE_MAX = 160

export const REPORT_ID = /^\d{4}-\d{2}-\d{2}-(\d{4}|day)$/
const REPORT_FILE = /^(\d{4}-\d{2}-\d{2}-(?:\d{4}|day))\.json$/

const formatIn = (zone: string) => new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
let FORMAT = formatIn(REPORT_ZONE)

/** Members have a name in a report; anyone else's login stays out of a permanent history. */
let MEMBERS: { login: string; name: string }[] = []

/** Slots and days are cut in the environment's zone, the same for every member, as often as its conventions say. */
export function setReportZone(zone: string, members: { login: string; name: string }[] = MEMBERS, everyHours = 3): void {
  REPORT_ZONE = zone
  FORMAT = formatIn(zone)
  MEMBERS = members
  SLOTS = slotsEvery(everyHours)
}

export function parisOf(time: number): { day: string; hour: number; minute: number; label: string } {
  const found = Object.fromEntries(FORMAT.formatToParts(new Date(time)).map((part) => [part.type, part.value]))
  return { day: `${found.year}-${found.month}-${found.day}`, hour: Number(found.hour), minute: Number(found.minute), label: `${found.hour}:${found.minute}` }
}

/** The moment an hour of a day begins in the zone. A day can have 23 or 25 hours; 24 is the start of the next one. */
export function parisTime(day: string, hour = 0): number {
  const [year, month, date] = day.split('-').map(Number)
  const wanted = Date.UTC(year, month - 1, date, hour)
  let guess = wanted
  for (let turn = 0; turn < 2; turn += 1) {
    const seen = parisOf(guess)
    const [y, m, d] = seen.day.split('-').map(Number)
    guess += wanted - Date.UTC(y, m - 1, d, seen.hour, seen.minute)
  }
  return guess
}

export const dayBefore = (day: string, back = 1) => new Date(Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10)) - back)).toISOString().slice(0, 10)

/** The report due now, if any: none before the day's first. */
export function dueSlot(now: number): { day: string; slot: number } | null {
  const { day, hour } = parisOf(now)
  const slot = [...SLOTS].reverse().find((one) => one <= hour)
  return slot === undefined ? null : { day, slot }
}

export const idOf = (day: string, slot: number | null) => (slot === null ? `${day}-day` : `${day}-${String(slot).padStart(2, '0')}00`)

export interface ReportPull {
  number: number
  title: string
  who: string
}

export interface ReportQueueRow extends ReportPull {
  hours: number
  ci: string
  review: string
}

/** How a milestone stands against its date, by arithmetic: the screen puts the word on it. */
export type MilestoneState = 'done' | 'no-pace' | 'no-due' | 'on-schedule' | 'at-risk' | 'late'
export const MILESTONE_STATES: MilestoneState[] = ['done', 'no-pace', 'no-due', 'on-schedule', 'at-risk', 'late']

/** What happened in the board itself during the period: every environment has this, repository or not. */
export interface BoardFacts {
  threadsOpened: { id: string; title: string; who: string }[]
  threadsClosed: { id: string; title: string }[]
  /** Messages from members, drafts their agents prepared and they sent, and agents by themselves. */
  messages: { members: number; drafts: number; agents: number }
  byMember: { who: string; messages: number }[]
  pollsOpened: { threadId: string; messageId: string; question: string }[]
  pollsClosed: { threadId: string; messageId: string; question: string; leading: string | null; voters: number }[]
  syntheses: number
}

/** What happened in the main repository on GitHub, when the environment follows one. */
export interface RepositoryFacts {
  name: string
  today: { merged: number; closed: number; opened: number }
  since: { merged: number; closed: number; opened: number }
  all: { closed: number; total: number }
  /** Merged pull requests by who wrote them, numbers only, for a line. */
  mergedBy: { who: string; numbers: number[] }[]
  /** Open pull requests whose CI is red, or null when they weren't read. */
  redPulls: number[] | null
  /** When the last run on the default branch failed, if it did. */
  mainRed: string | null
  waiting: { number: number; who: string }[]
  milestone: { title: string; closed: number; total: number; due: string | null; daysLeft: number | null; pace: number; state: MilestoneState } | null
  nextMilestone: { title: string; due: string | null } | null
  ci: { rate: number | null; finished: number; failure: number; other: number; medianMinutes: number | null }
  pulls: { open: number; draft: number; red: number; stale: number } | null
  merged: ReportPull[]
  burnup: { title: string; points: BurnPoint[] }[]
  activity: ActivityRow[]
  milestones: Milestone[]
  statuses: { status: string; count: number }[] | null
  ships: ShipRow[]
  areas: AreaRow[]
  queue: ReportQueueRow[] | null
  ciRows: CiRow[]
  failing: { branch: string; failure: number; total: number; pr: number | null }[]
}

export interface Report {
  v: 2
  id: string
  kind: 'update' | 'day'
  day: string
  /** The hour it is for, null for a day's report. */
  slot: number | null
  /** When it was written, by whose app. */
  at: string
  by: string
  /** What it covers. */
  from: string
  to: string
  /** Nothing happened: only its figures. */
  quiet: boolean
  /** Written long after: what was open at the time isn't known, so it isn't said. */
  late: boolean
  board: BoardFacts
  repository: RepositoryFacts | null
}

/** A report written by a version before this one: its sentences are kept as they were. */
export interface LegacyReport {
  v: 1
  id: string
  kind: 'update' | 'day'
  day: string
  slot: number | null
  at: string
  by: string
  from: string
  to: string
  sinceWord: string
  quiet: boolean
  late: boolean
  sections: { title: string; lines: string[] }[]
  figures: {
    today: { merged: number; closed: number; opened: number }
    since: { merged: number; closed: number; opened: number }
    all: { closed: number; total: number }
    milestone: { title: string; closed: number; total: number; due: string | null; daysLeft: number | null; pace: number; word: string } | null
    ci: { rate: number | null; finished: number; failure: number; other: number; medianMinutes: number | null }
    pulls: { open: number; draft: number; red: number } | null
  }
  merged: ReportPull[]
  burnup: { title: string; points: BurnPoint[] }[]
  activity: ActivityRow[]
  milestones: Milestone[]
  board: { status: string; count: number }[] | null
  ships: ShipRow[]
  areas: AreaRow[]
  queue: ReportQueueRow[] | null
  ci: CiRow[]
  failing: { branch: string; failure: number; total: number; pr: number | null }[]
}

/** The history these go into is shared and permanent, and these all come from what someone typed. */
const safe = (text: string) => (looksSecret(text) ? '(masqué)' : text)
const safeTitle = (title: string) => safe(title).slice(0, TITLE_MAX)
/** Only members have a name here: anyone else's login stays out of a permanent history. */
const nameOf = (login: string) => MEMBERS.find((member) => member.login.toLowerCase() === login.toLowerCase())?.name ?? ''
/** A project field names a person in its own words: a member's login or name, or their first name when only one member has it. */
const personWord = (who: string) => {
  const wanted = who.trim().toLowerCase()
  const exact = MEMBERS.find((member) => member.login.toLowerCase() === wanted || member.name.toLowerCase() === wanted)
  if (exact) return exact.name
  const byFirstName = MEMBERS.filter((member) => member.name.split(' ')[0].toLowerCase() === wanted)
  return byFirstName.length === 1 ? byFirstName[0].name : ''
}

const inside = (iso: string | null | undefined, from: number, to: number) => {
  if (!iso) return false
  const time = Date.parse(iso)
  return time >= from && time < to
}

/** The ledger as it stood at a moment: a report for a past day counts what was known by its end. */
function asOf(items: HistoryItem[], to: number): HistoryItem[] {
  const late = (iso: string | null) => (iso && Date.parse(iso) >= to ? null : iso)
  return items.filter((item) => Date.parse(item.created) < to).map((item) => ({ ...item, closed: late(item.closed), merged: late(item.merged) }))
}

/** How a milestone stands, from its date and the recent pace: arithmetic, which the screen calls that. */
export function milestoneState(daysLeft: number | null, due: string | null, to: number, remaining: number): MilestoneState {
  if (remaining === 0) return 'done'
  if (daysLeft === null) return 'no-pace'
  if (!due) return 'no-due'
  const eta = to + daysLeft * DAY
  const end = parisTime(due.slice(0, 10), 24)
  if (eta <= end) return 'on-schedule'
  return eta <= end + DAY ? 'at-risk' : 'late'
}

const lastOnMain = (runs: HistoryRun[]) => [...runs].reverse().find((run) => run.branch === 'main' && (run.state === 'success' || run.state === 'failure')) ?? null

/** A thread as the store gives it to the report: what was said, by whom, when. */
export interface ThreadActivity {
  id: string
  title: string
  createdAt: string
  createdBy: string
  status: 'open' | 'closed'
  messages: { author: string; createdAt: string; agent?: 'auto' | 'draft'; status?: 'open' | 'closed'; poll?: string; synthesis?: boolean }[]
  polls: { messageId: string; question: string; createdAt: string; closedAt: string | null; closesAt: string | null; voters: number; leading: string | null }[]
}

export interface ReportInput {
  kind: 'update' | 'day'
  day: string
  slot: number | null
  /** When it is being written. */
  at: number
  from: number
  to: number
  /** The board's threads, as they stand. */
  threads: ThreadActivity[]
  /** The main repository's ledger, when one is followed. */
  repository: { name: string; history: History; milestones: Milestone[]; waiting: WaitingItem[] } | null
  by: string
}

/** What the board itself saw between two moments. */
export function boardFacts(threads: ThreadActivity[], from: number, to: number): BoardFacts {
  const facts: BoardFacts = { threadsOpened: [], threadsClosed: [], messages: { members: 0, drafts: 0, agents: 0 }, byMember: [], pollsOpened: [], pollsClosed: [], syntheses: 0 }
  const byMember = new Map<string, number>()
  for (const thread of threads) {
    if (inside(thread.createdAt, from, to)) facts.threadsOpened.push({ id: thread.id, title: safeTitle(thread.title), who: nameOf(thread.createdBy) })
    const closing = thread.messages.findLast((message) => message.status)
    if (thread.status === 'closed' && closing && inside(closing.createdAt, from, to)) facts.threadsClosed.push({ id: thread.id, title: safeTitle(thread.title) })
    for (const message of thread.messages) {
      if (message.status || !inside(message.createdAt, from, to)) continue
      if (message.synthesis) facts.syntheses += 1
      if (message.agent === 'auto') facts.messages.agents += 1
      else if (message.agent === 'draft') facts.messages.drafts += 1
      else facts.messages.members += 1
      if (message.agent !== 'auto') {
        const who = nameOf(message.author)
        if (who) byMember.set(who, (byMember.get(who) ?? 0) + 1)
      }
    }
    for (const poll of thread.polls) {
      if (inside(poll.createdAt, from, to)) facts.pollsOpened.push({ threadId: thread.id, messageId: poll.messageId, question: safeTitle(poll.question) })
      const ended = poll.closedAt ?? (poll.closesAt && Date.parse(poll.closesAt) <= to ? poll.closesAt : null)
      if (ended && inside(ended, from, to)) facts.pollsClosed.push({ threadId: thread.id, messageId: poll.messageId, question: safeTitle(poll.question), leading: poll.leading && safeTitle(poll.leading), voters: poll.voters })
    }
  }
  facts.byMember = [...byMember.entries()].map(([who, messages]) => ({ who, messages })).sort((a, b) => b.messages - a.messages || a.who.localeCompare(b.who))
  return facts
}

/** What the main repository saw between two moments, as the ledger stood at the end. */
export function repositoryFacts(input: NonNullable<ReportInput['repository']>, day: string, from: number, to: number, late: boolean): RepositoryFacts {
  const { history, waiting } = input
  const items = asOf(history.items, to)
  const runs = history.runs.filter((run) => Date.parse(run.start) < to)
  const tickets = items.filter(isTicket)
  const dayStart = parisTime(day)
  const counted = (start: number) => {
    const [row] = activityBy([{ from: start, to, label: '' }], items)
    return { merged: row.merged, closed: row.closed, opened: row.opened }
  }
  const today = counted(dayStart)
  const since = counted(from)
  // By when a run ended: one still going at this report is counted in the next, and not lost between the two.
  const finished = ciSummary(runs.filter((run) => run.end && inside(run.end, from, to)), 0, Infinity)
  // Runs missing from the start of this period: a rate would look like a measure of all of them.
  const partial = Boolean(history.runsFrom && Date.parse(history.runsFrom) > from)
  const summary = partial ? { ...finished, rate: null } : finished
  const live = liveMilestones(items, input.milestones)
  const upcoming = nextMilestone(live)
  const pace = upcoming ? forecast(items, upcoming.title, upcoming.due, to, FORECAST_DAYS) : null
  const milestones = live.map((one) => ({ ...one, title: safe(one.title) }))
  const known = !late && history.pullsAt ? history.pulls.filter((pull) => Date.parse(pull.created) < to) : null
  const merged = items
    .filter((item) => item.kind === 'pull' && inside(item.merged, from, to))
    .sort((a, b) => (a.merged ?? '').localeCompare(b.merged ?? ''))
    .map((item) => ({ number: item.number, title: safeTitle(item.title), who: nameOf(item.author) }))
  const quietRepo = since.merged + since.closed + since.opened + summary.finished === 0
  const statuses = !late ? history.project?.statuses : undefined
  const open = tickets.filter((item) => !item.closed).length
  const mergedBy = new Map<string, number[]>()
  for (const pull of merged) mergedBy.set(pull.who, [...(mergedBy.get(pull.who) ?? []), pull.number])
  const hourRows = () => {
    const rows: { from: number; to: number; label: string }[] = []
    for (let hour = 0; hour < 24; hour += 1) {
      const start = parisTime(day, hour)
      const end = parisTime(day, hour + 1)
      if (start >= to) break
      if (end > start) rows.push({ from: start, to: end, label: `${String(hour).padStart(2, '0')}h` })
    }
    return rows
  }
  const buckets = hourRows()
  const last = lastOnMain(runs)
  const after = milestones.filter((one) => one.closed < one.total && one.title !== safe(upcoming?.title ?? ''))[0]
  const curve = (title: string, milestone: string | null) => ({ title, points: burnup(items, milestone, to, 40) })
  const pullsFigure = known ? { ...pullsNow(known), stale: known.filter((pull) => pull.review === 'stale').length } : null
  return {
    name: input.name,
    today,
    since,
    all: { closed: tickets.length - open, total: tickets.length },
    mergedBy: [...mergedBy.entries()].map(([who, numbers]) => ({ who, numbers })),
    redPulls: known ? known.filter((pull) => ciWordOf(pull.ci) === 'failure').map((pull) => pull.number).slice(0, 20) : null,
    mainRed: last?.state === 'failure' ? last.start : null,
    waiting: late ? [] : waiting.slice(0, 20).map((item) => ({ number: item.number, who: personWord(item.who) })),
    milestone: upcoming && pace ? { title: safe(upcoming.title), closed: upcoming.closed, total: upcoming.total, due: upcoming.due, daysLeft: pace.daysLeft, pace: pace.pace, state: milestoneState(pace.daysLeft, upcoming.due, to, pace.remaining) } : null,
    nextMilestone: after ? { title: after.title, due: after.due } : null,
    ci: { rate: summary.rate, finished: summary.finished, failure: summary.failure, other: summary.other, medianMinutes: summary.medianMinutes },
    pulls: pullsFigure,
    merged: quietRepo ? [] : merged.slice(0, LIST_MAX),
    burnup: quietRepo ? [] : [curve('all', null), ...(upcoming ? [curve(safe(upcoming.title), upcoming.title)] : [])],
    activity: quietRepo ? [] : activityBy(buckets, items),
    milestones: quietRepo ? [] : milestones,
    statuses: quietRepo || !statuses ? null : statusCounts(items, statuses, null),
    ships: quietRepo ? [] : whoShips(items, known ?? [], history.lines ?? {}, from, to, nameOf).filter((row) => row.who),
    areas: quietRepo ? [] : areasOf(items, null).slice(0, 14).map((area) => ({ ...area, area: safe(area.area) })),
    queue:
      quietRepo || !known
        ? null
        : known
            .filter((pull) => !pull.draft)
            .sort((a, b) => a.created.localeCompare(b.created))
            .slice(0, QUEUE_MAX)
            .map((pull) => ({ number: pull.number, title: safeTitle(pull.title), who: nameOf(pull.author), hours: Math.round((to - Date.parse(pull.created)) / HOUR), ci: pull.ci, review: pull.review })),
    ciRows: quietRepo ? [] : ciBy(buckets, runs),
    failing: quietRepo ? [] : failingBranches(runs, from, to).map((row) => ({ ...row, branch: safe(row.branch) })),
  }
}

/** Pure, so that every figure can be tested: what a report says follows from the ledger, the threads and the clock alone. */
export function buildReport(input: ReportInput): Report {
  const { kind, day, slot, at, from, to, by } = input
  const late = kind === 'day' && at - to > LATE_MS
  const board = boardFacts(input.threads, from, to)
  const repository = input.repository ? repositoryFacts(input.repository, day, from, to, late) : null
  const boardQuiet = board.threadsOpened.length + board.threadsClosed.length + board.messages.members + board.messages.drafts + board.messages.agents + board.pollsOpened.length + board.pollsClosed.length === 0
  const repoQuiet = !repository || repository.since.merged + repository.since.closed + repository.since.opened + repository.ci.finished === 0
  return {
    v: 2,
    id: idOf(day, slot),
    kind,
    day,
    slot,
    at: new Date(at).toISOString(),
    by,
    from: new Date(from).toISOString(),
    to: new Date(to).toISOString(),
    quiet: boardQuiet && repoQuiet,
    late,
    board,
    repository,
  }
}

const num = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : 0)
const maybeNum = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : null)
const text = (value: unknown, max = 300) => (typeof value === 'string' ? value.slice(0, max) : '')
const maybeText = (value: unknown, max = 300) => (typeof value === 'string' ? value.slice(0, max) : null)
const rows = <T>(value: unknown, max: number, one: (raw: any) => T): T[] => (Array.isArray(value) ? value.slice(0, max).filter((raw) => raw && typeof raw === 'object').map(one) : [])
const counted = (raw: any) => ({ merged: num(raw?.merged), closed: num(raw?.closed), opened: num(raw?.opened) })
const pull = (raw: any): ReportPull => ({ number: num(raw.number), title: text(raw.title, TITLE_MAX * 2), who: text(raw.who, 60) })
const REVIEWS = ['none', 'approved', 'stale', 'changes']
const moment = (value: unknown) => typeof value === 'string' && !Number.isNaN(Date.parse(value))
const numbers = (value: unknown, max: number) => (Array.isArray(value) ? value.slice(0, max).filter((one) => Number.isInteger(one) && one > 0) : []) as number[]
const THREAD_ID = /^[a-z0-9][a-z0-9-]*$/
const threadId = (value: unknown) => (typeof value === 'string' && value.length <= 120 && THREAD_ID.test(value) ? value : '')
const messageId = (value: unknown) => (typeof value === 'string' && /^\d{1,15}-[A-Za-z0-9-]{1,40}-[0-9a-f]{4}$/.test(value) ? value : '')

/** A report can come from another member's app, and from another version. Only the shapes below go further. */
export function parseReport(raw: string, id: string): Report | LegacyReport | null {
  let found: any
  try {
    found = JSON.parse(raw)
  } catch {
    return null
  }
  if (!found || found.id !== id || found.kind !== (id.endsWith('-day') ? 'day' : 'update')) return null
  if (!moment(found.at) || !moment(found.from) || !moment(found.to)) return null
  if (found.v === 1) return parseLegacy(found, id)
  if (found.v !== 2) return null
  const board = found.board && typeof found.board === 'object' ? found.board : {}
  const repo = found.repository && typeof found.repository === 'object' ? found.repository : null
  const milestone = repo?.milestone
  const messages = board.messages && typeof board.messages === 'object' ? board.messages : {}
  return {
    v: 2,
    id,
    kind: found.kind,
    day: text(found.day, 10),
    slot: maybeNum(found.slot),
    at: found.at,
    by: typeof found.by === 'string' && LOGIN.test(found.by) ? found.by : '',
    from: found.from,
    to: found.to,
    quiet: found.quiet === true,
    late: found.late === true,
    board: {
      threadsOpened: rows(board.threadsOpened, 60, (raw) => ({ id: threadId(raw.id), title: text(raw.title, TITLE_MAX * 2), who: text(raw.who, 60) })).filter((row) => row.id),
      threadsClosed: rows(board.threadsClosed, 60, (raw) => ({ id: threadId(raw.id), title: text(raw.title, TITLE_MAX * 2) })).filter((row) => row.id),
      messages: { members: num(messages.members), drafts: num(messages.drafts), agents: num(messages.agents) },
      byMember: rows(board.byMember, 200, (raw) => ({ who: text(raw.who, 60), messages: num(raw.messages) })).filter((row) => row.who),
      pollsOpened: rows(board.pollsOpened, 30, (raw) => ({ threadId: threadId(raw.threadId), messageId: messageId(raw.messageId), question: text(raw.question, TITLE_MAX * 2) })).filter((row) => row.threadId && row.messageId),
      pollsClosed: rows(board.pollsClosed, 30, (raw) => ({ threadId: threadId(raw.threadId), messageId: messageId(raw.messageId), question: text(raw.question, TITLE_MAX * 2), leading: maybeText(raw.leading, 200), voters: num(raw.voters) })).filter((row) => row.threadId && row.messageId),
      syntheses: num(board.syntheses),
    },
    repository: repo
      ? {
          name: text(repo.name, 140),
          today: counted(repo.today),
          since: counted(repo.since),
          all: { closed: num(repo.all?.closed), total: num(repo.all?.total) },
          mergedBy: rows(repo.mergedBy, 100, (raw) => ({ who: text(raw.who, 60), numbers: numbers(raw.numbers, 60) })),
          redPulls: Array.isArray(repo.redPulls) ? numbers(repo.redPulls, 20) : null,
          mainRed: moment(repo.mainRed) ? repo.mainRed : null,
          waiting: rows(repo.waiting, 20, (raw) => ({ number: num(raw.number), who: text(raw.who, 60) })).filter((row) => row.number > 0),
          milestone:
            milestone && typeof milestone === 'object'
              ? { title: text(milestone.title, 80), closed: num(milestone.closed), total: num(milestone.total), due: maybeText(milestone.due, 30), daysLeft: maybeNum(milestone.daysLeft), pace: num(milestone.pace), state: MILESTONE_STATES.includes(milestone.state) ? milestone.state : 'no-due' }
              : null,
          nextMilestone: repo.nextMilestone && typeof repo.nextMilestone === 'object' ? { title: text(repo.nextMilestone.title, 80), due: maybeText(repo.nextMilestone.due, 30) } : null,
          ci: { rate: maybeNum(repo.ci?.rate), finished: num(repo.ci?.finished), failure: num(repo.ci?.failure), other: num(repo.ci?.other), medianMinutes: maybeNum(repo.ci?.medianMinutes) },
          pulls: repo.pulls && typeof repo.pulls === 'object' ? { open: num(repo.pulls.open), draft: num(repo.pulls.draft), red: num(repo.pulls.red), stale: num(repo.pulls.stale) } : null,
          merged: rows(repo.merged, LIST_MAX, pull),
          burnup: rows(repo.burnup, 4, (raw) => ({ title: text(raw.title, 80), points: rows(raw.points, 120, (point) => ({ time: num(point.time), total: num(point.total), closed: num(point.closed) })) })),
          activity: rows(repo.activity, 30, (raw) => ({ label: text(raw.label, 12), ...counted(raw) })),
          milestones: rows(repo.milestones, 30, (raw) => ({ title: text(raw.title, 80), closed: num(raw.closed), total: num(raw.total), due: maybeText(raw.due, 30) })),
          statuses: Array.isArray(repo.statuses) ? rows(repo.statuses, 12, (raw) => ({ status: text(raw.status, 40), count: num(raw.count) })) : null,
          ships: rows(repo.ships, 100, (raw) => ({ who: text(raw.who, 60), open: num(raw.open), merged: num(raw.merged), added: num(raw.added), deleted: num(raw.deleted), unread: num(raw.unread), opened: num(raw.opened) })),
          areas: rows(repo.areas, 20, (raw) => ({ area: text(raw.area, 60), closed: num(raw.closed), open: num(raw.open) })),
          queue: Array.isArray(repo.queue) ? rows(repo.queue, QUEUE_MAX, (raw) => ({ ...pull(raw), hours: num(raw.hours), ci: text(raw.ci, 30), review: REVIEWS.includes(raw.review) ? raw.review : 'none' })) : null,
          ciRows: rows(repo.ciRows, 30, (raw) => ({ label: text(raw.label, 12), success: num(raw.success), failure: num(raw.failure), medianMinutes: maybeNum(raw.medianMinutes) })),
          failing: rows(repo.failing, 10, (raw) => ({ branch: text(raw.branch, 120), failure: num(raw.failure), total: num(raw.total), pr: maybeNum(raw.pr) })),
        }
      : null,
  }
}

/** A report from before this version, kept readable: its French sentences are what it says. */
function parseLegacy(found: any, id: string): LegacyReport {
  const figures = found.figures && typeof found.figures === 'object' ? found.figures : {}
  const milestone = figures.milestone
  return {
    v: 1,
    id,
    kind: found.kind,
    day: text(found.day, 10),
    slot: maybeNum(found.slot),
    at: found.at,
    by: typeof found.by === 'string' && LOGIN.test(found.by) ? found.by : '',
    from: found.from,
    to: found.to,
    sinceWord: text(found.sinceWord, 40),
    quiet: found.quiet === true,
    late: found.late === true,
    sections: rows(found.sections, 8, (raw) => ({ title: text(raw.title, 60), lines: Array.isArray(raw.lines) ? raw.lines.slice(0, 20).map((line: unknown) => text(line, 600)) : [] })),
    figures: {
      today: counted(figures.today),
      since: counted(figures.since),
      all: { closed: num(figures.all?.closed), total: num(figures.all?.total) },
      milestone: milestone && typeof milestone === 'object' ? { title: text(milestone.title, 80), closed: num(milestone.closed), total: num(milestone.total), due: maybeText(milestone.due, 30), daysLeft: maybeNum(milestone.daysLeft), pace: num(milestone.pace), word: text(milestone.word, 100) } : null,
      ci: { rate: maybeNum(figures.ci?.rate), finished: num(figures.ci?.finished), failure: num(figures.ci?.failure), other: num(figures.ci?.other), medianMinutes: maybeNum(figures.ci?.medianMinutes) },
      pulls: figures.pulls && typeof figures.pulls === 'object' ? { open: num(figures.pulls.open), draft: num(figures.pulls.draft), red: num(figures.pulls.red) } : null,
    },
    merged: rows(found.merged, LIST_MAX, pull),
    burnup: rows(found.burnup, 4, (raw) => ({ title: text(raw.title, 80), points: rows(raw.points, 120, (point) => ({ time: num(point.time), total: num(point.total), closed: num(point.closed) })) })),
    activity: rows(found.activity, 30, (raw) => ({ label: text(raw.label, 12), ...counted(raw) })),
    milestones: rows(found.milestones, 30, (raw) => ({ title: text(raw.title, 80), closed: num(raw.closed), total: num(raw.total), due: maybeText(raw.due, 30) })),
    board: Array.isArray(found.board) ? rows(found.board, 12, (raw) => ({ status: text(raw.status, 40), count: num(raw.count) })) : null,
    ships: rows(found.ships, 20, (raw) => ({ who: text(raw.who, 60), open: num(raw.open), merged: num(raw.merged), added: num(raw.added), deleted: num(raw.deleted), unread: num(raw.unread), opened: num(raw.opened) })),
    areas: rows(found.areas, 20, (raw) => ({ area: text(raw.area, 60), closed: num(raw.closed), open: num(raw.open) })),
    queue: Array.isArray(found.queue) ? rows(found.queue, QUEUE_MAX, (raw) => ({ ...pull(raw), hours: num(raw.hours), ci: text(raw.ci, 30), review: REVIEWS.includes(raw.review) ? raw.review : 'none' })) : null,
    ci: rows(found.ci, 30, (raw) => ({ label: text(raw.label, 12), success: num(raw.success), failure: num(raw.failure), medianMinutes: maybeNum(raw.medianMinutes) })),
    failing: rows(found.failing, 10, (raw) => ({ branch: text(raw.branch, 120), failure: num(raw.failure), total: num(raw.total), pr: maybeNum(raw.pr) })),
  }
}

/** What a search can find in a report: the titles and questions it names, not sentences. */
export function searchText(report: Report | LegacyReport): string {
  if (report.v === 1) return report.sections.flatMap((section) => section.lines).join('\n')
  const parts = [...report.board.threadsOpened.map((thread) => thread.title), ...report.board.threadsClosed.map((thread) => thread.title), ...report.board.pollsOpened.map((poll) => poll.question), ...report.board.pollsClosed.map((poll) => poll.question)]
  if (report.repository) parts.push(...report.repository.merged.map((pull) => `#${pull.number} ${pull.title}`), ...(report.repository.queue ?? []).map((pull) => `#${pull.number} ${pull.title}`), ...(report.repository.milestone ? [report.repository.milestone.title] : []))
  return parts.join('\n')
}

export interface ReportSummary {
  id: string
  kind: 'update' | 'day'
  day: string
  slot: number | null
  at: string
  to: string
  by: string
  quiet: boolean
}

export interface ReportWriterOptions {
  /** The board's clone. */
  root: string
  knowledgeRoot: string
  person: string
  /** The board's threads, as they stand. */
  threads: () => Promise<ThreadActivity[]>
  /** The main repository followed, or null. */
  repository: () => string | null
  history: () => Promise<History | null>
  /** Writes a file only if nobody has (`BoardGit.claim`). */
  claim: (path: string, text: string, subject: string) => Promise<string>
  /** GitHub's clock, asked only when something is about to be written. */
  serverTime: () => Promise<number | null>
  clock?: () => number
}

const readJson = async <T>(file: string, otherwise: T): Promise<T> => {
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8'))
    return parsed && typeof parsed === 'object' && Array.isArray(parsed) === Array.isArray(otherwise) ? parsed : otherwise
  } catch {
    return otherwise
  }
}

export class ReportWriter {
  private readonly options: ReportWriterOptions
  /** A report is written once and never changes, so reading it once is enough. */
  private readonly known = new Map<string, ReportSummary | null>()
  /** Days with nothing to tell have no file to say so, and shouldn't be worked out again every five minutes. */
  private readonly quietDays = new Set<string>()
  private running: Promise<string[]> | null = null
  lastError: string | null = null

  constructor(options: ReportWriterOptions) {
    this.options = options
  }

  private get folder() {
    return join(this.options.root, 'reports')
  }

  private async ids(): Promise<string[]> {
    const names = await readdir(this.folder).catch(() => [] as string[])
    return names.flatMap((name) => REPORT_FILE.exec(name)?.[1] ?? [])
  }

  async read(id: string): Promise<Report | LegacyReport | null> {
    if (!REPORT_ID.test(id)) return null
    const raw = await readFile(join(this.folder, `${id}.json`), 'utf8').catch(() => null)
    return raw === null ? null : parseReport(raw, id)
  }

  /** Every report that can be read, latest first. A file from a newer version stays, and isn't shown. */
  async list(): Promise<ReportSummary[]> {
    const ids = await this.ids()
    for (const id of ids) {
      if (this.known.get(id)) continue
      const report = await this.read(id)
      this.known.set(id, report && { id, kind: report.kind, day: report.day, slot: report.slot, at: report.at, to: report.to, by: report.by, quiet: report.quiet })
    }
    return ids
      .flatMap((id) => this.known.get(id) ?? [])
      .sort((a, b) => b.id.localeCompare(a.id))
  }

  private async write(input: Omit<ReportInput, 'threads' | 'repository' | 'by'>, history: History | null): Promise<string | null> {
    const name = this.options.repository()
    let repository: ReportInput['repository'] = null
    if (name && history) {
      const github = join(this.options.knowledgeRoot, 'github')
      const unread: Milestone[] = []
      const milestones = await readJson(join(github, 'milestones.json'), unread)
      // The copy isn't there yet, or is damaged: "no milestone" would stay written for good. An empty list that was read is fine.
      if (milestones === unread) return null
      const state = await readJson<{ waiting?: WaitingItem[] }>(join(github, 'state.json'), {})
      repository = { name, history, milestones, waiting: Array.isArray(state.waiting) ? state.waiting : [] }
    }
    const report = buildReport({ ...input, threads: await this.options.threads(), repository, by: this.options.person })
    // A day when nothing happened needs no report: the list says so by having none.
    if (report.kind === 'day' && report.quiet) {
      this.quietDays.add(report.day)
      return null
    }
    await this.options.claim(`reports/${report.id}.json`, JSON.stringify(report), `board: report ${report.id}`)
    // Another app may have got there first, and the list may have read ours in between.
    this.known.delete(report.id)
    return report.id
  }

  /**
   * Writes what is due, at most once at a time. Whichever computer gets there first writes it, the others keep theirs
   * unwritten, and a computer that was off leaves the next report to cover the gap: only the latest slot is written.
   * A report covers what the ledger has read, up to when it asked, so the next one takes over from exactly there.
   */
  pass(): Promise<string[]> {
    this.running ??= this.work()
      .then((written) => {
        this.lastError = null
        return written
      })
      .catch((error) => {
        this.lastError = (error as Error).message
        return []
      })
      .finally(() => {
        this.running = null
      })
    return this.running
  }

  private async work(): Promise<string[]> {
    const now = (this.options.clock ?? Date.now)()
    const history = await this.options.history()
    // A repository followed but not read yet, or read long ago: a report would say less than it claims.
    if (this.options.repository() && (!history?.at || now - Date.parse(history.at) > FRESH_MS)) return []
    const readUntil = history ? Date.parse(history.itemsAt ?? history.at) : now
    const ids = new Set(await this.ids())
    const today = parisOf(now).day
    const days: string[] = []
    for (let back = BACK_DAYS; back >= 1; back -= 1) {
      const day = dayBefore(today, back)
      if (readUntil < parisTime(day, 24) || this.quietDays.has(day) || ids.has(idOf(day, null))) continue
      days.push(day)
    }
    const due = dueSlot(now)
    const slotDue = Boolean(due && !ids.has(idOf(due.day, due.slot)))
    if (!days.length && !slotDue) return []
    // Each is written once and for good, so the hour on it has to be right.
    const server = await this.options.serverTime()
    if (server === null) throw new Error("l'heure de GitHub n'a pas pu être lue.")
    if (Math.abs(server - now) > CLOCK_MS) throw new Error("l'horloge de cet ordinateur n'est pas à l'heure.")
    const written: string[] = []
    for (const day of days) {
      if (written.length >= DAYS_AT_ONCE) break
      const id = await this.write({ kind: 'day', day, slot: null, at: now, from: parisTime(day), to: parisTime(day, 24) }, history)
      if (id) written.push(id)
    }
    if (due && slotDue) {
      // Since where the last report stopped, or since midnight. Past a day, the next day's report has what is between.
      const to = Math.min(now, readUntil)
      // A ledger behind the last report's waits for the next pass: starting any earlier would tell the same things twice.
      const id = idOf(due.day, due.slot)
      const earlier = (await this.list()).find((one) => one.kind === 'update' && one.id < id && now - Date.parse(one.to) < DAY)
      const from = earlier ? Date.parse(earlier.to) : parisTime(due.day)
      if (to > from) {
        if (await this.write({ kind: 'update', day: due.day, slot: due.slot, at: now, from, to }, history)) written.push(id)
      }
    }
    return written
  }
}
