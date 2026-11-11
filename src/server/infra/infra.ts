import { readFile } from 'node:fs/promises'
import { isTicket } from '../../shared/metrics.ts'
import { join } from 'node:path'
import type { GhRequest } from '../github/client.ts'
import { type HistoryItem, runState } from '../github/copy.ts'
import type { HostReading } from './probes.ts'

/**
 * The live view of the environment's infrastructure: GitHub for the runners and the jobs of the main
 * repository, the hosts' own readings from the environment's variables (`live.ts`, `probes.ts`), and one
 * public HEAD request per configured endpoint. It is asked for only while the screen is open, and answers
 * from memory for 30 seconds, so it costs nothing the rest of the time.
 * What isn't built yet stays out of this data: the interface says so, and no figure is ever invented.
 */

const FRESH_MS = 30_000
const PROBE_FRESH_MS = 60_000
const PROBE_TIMEOUT_MS = 8_000
const WINDOW_MS = 2 * 60 * 60 * 1000
const RUNS = 100
const AT_ONCE = 5
const RUNNERS_REFUSED_MS = 60 * 60_000

export type JobState = 'success' | 'failure' | 'other' | 'running' | 'queued'

export interface InfraJob {
  id: number
  branch: string
  pr: number | null
  state: JobState
  start: string
  end: string | null
  /** When GitHub queued it: from there to `start`, it waited for a runner. */
  queuedAt?: string
  /** The runner's name, or null when GitHub has none yet. */
  runner: string | null
}

export type { WaitingItem } from '../github/waiting.ts'
import type { WaitingItem } from '../github/waiting.ts'

export interface EndpointState {
  name: string
  url: string
  ok: boolean
  status: number | null
  ms: number
}

export interface Milestone {
  title: string
  closed: number
  total: number
  due: string | null
}

export interface InfraSnapshot {
  at: string
  /** Null when this login may not list them. */
  runners: { name: string; online: boolean; busy: boolean }[] | null
  jobs: InfraJob[]
  /** The list of runs was full, so the oldest jobs of the window may be missing. */
  truncated: boolean
  pulls: { open: number; draft: number; red: number } | null
  /** Null until the copy of GitHub exists: "not known yet" isn't "nothing waits". */
  waiting: WaitingItem[] | null
  /** When the pull requests and what waits were read: they refresh every 5 minutes. */
  stateAt: string | null
  milestones: Milestone[]
  main: { at: string; ci: JobState } | null
  /** Each configured endpoint, from one public HEAD request, as anyone's browser makes. */
  endpoints: EndpointState[]
  /** Each host, CI first. Its figures are displayed, never acted on. */
  hosts: HostReading[]
  /** What runs now, on which side of the merge. */
  live: { pull: boolean; main: boolean }
  brief: string[]
}

export const jobState = runState

/**
 * Milestones as they are now, from the ledger when there is one: the roadmap's file gives their dates and order,
 * and is only regenerated every 5 minutes, with GitHub's counts. Epics and pull requests aren't counted, as in the reports.
 */
export function liveMilestones(items: HistoryItem[] | undefined, known: Milestone[]): Milestone[] {
  if (!items?.length) return known
  const counts = new Map<string, { closed: number; total: number }>()
  for (const item of items) {
    if (!isTicket(item) || !item.milestone) continue
    const count = counts.get(item.milestone) ?? { closed: 0, total: 0 }
    count.total += 1
    if (item.closed) count.closed += 1
    counts.set(item.milestone, count)
  }
  // The roadmap's file lists the open ones. A ticket can stay in a milestone that has been closed: that isn't one to come.
  return known.map((milestone) => ({ ...milestone, ...(counts.get(milestone.title) ?? { closed: 0, total: 0 }) }))
}

const plural = (count: number, word: string) => `${count} ${word}${count > 1 ? 's' : ''}`
const DAY = 86_400_000

/** The situation in plain sentences. Rules decide what it says, never a model. */
export function briefOf(snapshot: Omit<InfraSnapshot, 'brief'>): string[] {
  const out: string[] = []
  const done = snapshot.jobs.filter((job) => job.end && job.state !== 'other').sort((a, b) => (b.end ?? '').localeCompare(a.end ?? ''))
  const lastThree = done.slice(0, 3)
  const running = snapshot.jobs.filter((job) => job.state === 'running').length
  const queued = snapshot.jobs.filter((job) => job.state === 'queued').length
  const activity = running || queued ? ` ${plural(running, 'job')} en cours${queued ? `, ${queued} en file` : ''}.` : ''
  const failed = lastThree.filter((job) => job.state === 'failure').length
  if (lastThree.length === 3 && failed === 3) out.push(`La CI est rouge : ses 3 derniers jobs ont échoué.${activity}`)
  else if (snapshot.main?.ci === 'failure') out.push(`La CI de main est rouge.${activity}`)
  else if (failed) out.push(`La CI a ${plural(failed, 'échec')} sur ses ${lastThree.length} derniers jobs.${activity}`)
  else if (lastThree.length) out.push(`La CI est verte sur ses derniers jobs.${activity}`)
  else if (activity) out.push(activity.trim())
  if (!snapshot.waiting) {
    // Nothing to say yet: the copy of GitHub is on its way.
  } else if (snapshot.waiting.length === 1) {
    const [item] = snapshot.waiting
    out.push(`Une décision attend${item.who ? ` ${item.who}` : ''} : #${item.number}.`)
  } else if (snapshot.waiting.length) out.push(`${snapshot.waiting.length} décisions attendent une réponse.`)
  const open = snapshot.milestones.filter((milestone) => milestone.due && milestone.closed < milestone.total)
  const next = open.sort((a, b) => (a.due ?? '').localeCompare(b.due ?? ''))[0]
  if (next?.due) {
    // The due date is a day, and "today" is the person's.
    const here = new Date(snapshot.at)
    const days = Math.round((Date.parse(`${next.due.slice(0, 10)}T00:00:00Z`) - Date.UTC(here.getFullYear(), here.getMonth(), here.getDate())) / DAY)
    const share = Math.floor((100 * next.closed) / next.total)
    const code = next.title.split(' ')[0]
    if (days < 0) out.push(`Le jalon ${code} a dépassé son échéance, à ${share} %.`)
    else if (days === 0) out.push(`Le jalon ${code} arrive à échéance aujourd'hui, à ${share} %.`)
    else if (days <= 2) out.push(`Le jalon ${code} arrive à échéance dans ${plural(days, 'jour')}, à ${share} %.`)
  }
  // Only what is red: an amber figure is on the hosts' tab.
  for (const host of snapshot.hosts) {
    const { reading, signals } = host
    if (!reading || !signals) continue
    if (signals.oomRecent) out.push(`${host.name} a eu ${signals.oomRecent} OOM ces 6 dernières heures.`)
    if (signals.disk === 'red') out.push(`${host.name} n'a plus que ${Math.floor((100 * reading.diskFree) / reading.diskTotal)} % de disque libre.`)
    if (signals.age === 'red') out.push(`${host.name} ne donne plus de relevé depuis ${Math.floor((host.age ?? 0) / 60)} min.`)
  }
  for (const endpoint of snapshot.endpoints) {
    if (!endpoint.ok) out.push(endpoint.status ? `${endpoint.name} répond en erreur (${endpoint.status}).` : `${endpoint.name} ne répond pas.`)
  }
  return out
}

type Probe = (url: string) => Promise<{ ok: boolean; status: number | null; ms: number }>

const probeEndpoint: Probe = async (url) => {
  const started = Date.now()
  try {
    const answer = await fetch(url, { method: 'HEAD', redirect: 'manual', signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) })
    return { ok: answer.status < 500, status: answer.status, ms: Date.now() - started }
  } catch {
    return { ok: false, status: null, ms: Date.now() - started }
  }
}

export class Infra {
  private readonly knowledgeRoot: string
  private readonly ask: GhRequest
  private readonly repo: string
  private readonly probe: Probe
  private readonly endpoints: () => { name: string; url: string }[]
  private readonly hosts: () => Promise<HostReading[]>
  private readonly clock: () => number
  private readonly onRuns: (runs: any[]) => void
  /** Jobs of a finished attempt never change. A run started again keeps its id, not its attempt. */
  private readonly finished = new Map<string, InfraJob[]>()
  private cached: { at: number; snapshot: InfraSnapshot } | null = null
  private probed: { at: number; result: EndpointState[] } | null = null
  private running: Promise<InfraSnapshot> | null = null
  /** Listing runners needs admin rights, which don't come back in 30 seconds. */
  private runnersRefusedAt: number | null = null

  constructor(options: {
    knowledgeRoot: string
    repo: string
    ask: GhRequest
    endpoints: () => { name: string; url: string }[]
    /** The hosts' readings, from the environment's variables. */
    hosts: () => Promise<HostReading[]>
    /** Tests replace it: never ask a real endpoint from a test. */
    probe?: Probe
    clock?: () => number
    /** Who else can use the list of runs instead of asking for it. */
    onRuns?: (runs: any[]) => void
  }) {
    this.knowledgeRoot = options.knowledgeRoot
    this.repo = options.repo
    this.ask = options.ask
    this.probe = options.probe ?? probeEndpoint
    this.endpoints = options.endpoints
    this.hosts = options.hosts
    this.clock = options.clock ?? Date.now
    this.onRuns = options.onRuns ?? (() => undefined)
  }

  private async json(path: string): Promise<any> {
    return JSON.parse(await this.ask(['api', `repos/${this.repo}/${path}`]))
  }

  private async jobsOf(run: any): Promise<InfraJob[]> {
    const key = `${run.id}:${run.run_attempt ?? 1}`
    const known = run.status === 'completed' ? this.finished.get(key) : undefined
    if (known) return known
    const { jobs } = await this.json(`actions/runs/${run.id}/jobs?per_page=50`)
    const mapped: InfraJob[] = jobs.map((job: any) => ({
      id: job.id,
      branch: String(run.head_branch ?? ''),
      pr: run.pull_requests?.[0]?.number ?? null,
      state: jobState(job),
      start: job.started_at ?? job.created_at ?? run.run_started_at,
      queuedAt: typeof job.created_at === 'string' ? job.created_at : undefined,
      end: job.status === 'completed' ? job.completed_at : null,
      runner: job.runner_name || null,
    }))
    if (run.status === 'completed') this.finished.set(key, mapped)
    return mapped
  }

  /** A copy can be damaged, or missing. It is only a copy: nothing here is worth a blank screen. */
  private async readJson<T>(path: string, otherwise: T): Promise<T> {
    try {
      const parsed = JSON.parse(await readFile(join(this.knowledgeRoot, path), 'utf8'))
      return parsed && typeof parsed === 'object' && Array.isArray(parsed) === Array.isArray(otherwise) ? (parsed as T) : otherwise
    } catch {
      return otherwise
    }
  }

  private async work(): Promise<InfraSnapshot> {
    const now = this.clock()
    // By last activity, because a run started again within the window may have been created before it.
    const { workflow_runs: listed } = await this.json(`actions/runs?per_page=${RUNS}`)
    this.onRuns(listed)
    const runs = listed.filter((run: any) => Date.parse(run.updated_at ?? run.run_started_at) >= now - WINDOW_MS)
    const jobs: InfraJob[] = []
    for (let at = 0; at < runs.length; at += AT_ONCE) {
      for (const found of await Promise.all(runs.slice(at, at + AT_ONCE).map((run: any) => this.jobsOf(run)))) jobs.push(...found)
    }
    const kept = new Set(runs.map((run: any) => String(run.id)))
    for (const key of this.finished.keys()) if (!kept.has(key.split(':')[0])) this.finished.delete(key)
    const runners =
      this.runnersRefusedAt !== null && now - this.runnersRefusedAt < RUNNERS_REFUSED_MS
        ? null
        : await this.json('actions/runners').then(
            (found) => found.runners.map((runner: any) => ({ name: runner.name, online: runner.status === 'online', busy: Boolean(runner.busy) })),
            (error: Error) => {
              // Anything else is a failure to read, which says so. A spent quota is a 403 too, and says nothing of the rights.
              if (/rate limit/i.test(error.message) || !/\b40[34]\b|Must have admin|not accessible/i.test(error.message)) throw error
              if (/\b403\b|Must have admin|not accessible/i.test(error.message)) this.runnersRefusedAt = now
              return null
            },
          )
    const hosts = this.hosts()
    if (!this.probed || now - this.probed.at > PROBE_FRESH_MS) {
      const endpoints = this.endpoints()
      const results = await Promise.all(endpoints.map((endpoint) => this.probe(endpoint.url)))
      this.probed = { at: now, result: endpoints.map((endpoint, index) => ({ ...endpoint, ...results[index] })) }
    }
    const state = await this.readJson<{ at?: string; pulls?: InfraSnapshot['pulls']; waiting?: WaitingItem[] }>('github/state.json', {})
    const mainRun = runs.find((run: any) => run.event === 'push' && run.head_branch === 'main')
    const active = jobs.filter((job) => job.state === 'running' || job.state === 'queued')
    const partial = {
      at: new Date(now).toISOString(),
      runners,
      jobs,
      truncated: listed.length === RUNS && runs.length === RUNS,
      pulls: state.pulls ?? null,
      waiting: state.waiting ?? null,
      stateAt: state.at ?? null,
      milestones: liveMilestones((await this.readJson<{ items?: HistoryItem[] }>('github/history.json', {})).items, await this.readJson<Milestone[]>('github/milestones.json', [])),
      main: mainRun ? { at: mainRun.run_started_at, ci: jobState(mainRun) } : null,
      endpoints: this.probed.result,
      hosts: await hosts,
      live: { pull: active.some((job) => job.branch !== 'main'), main: active.some((job) => job.branch === 'main') },
    }
    return { ...partial, brief: briefOf(partial) }
  }

  /** For a window nobody can see, which still runs its page: asks nothing, and is null if nothing has been read yet. */
  last(): InfraSnapshot | null {
    return this.cached?.snapshot ?? null
  }

  /** The last picture if it is recent, and at most one request to GitHub at a time. */
  snapshot(): Promise<InfraSnapshot> {
    if (this.cached && this.clock() - this.cached.at < FRESH_MS) return Promise.resolve(this.cached.snapshot)
    // Counted from when the reading started, so a screen asking every 30 seconds gets a new one each time.
    const started = this.clock()
    this.running ??= this.work()
      .then((snapshot) => {
        this.cached = { at: started, snapshot }
        return snapshot
      })
      .finally(() => {
        this.running = null
      })
    return this.running
  }
}
