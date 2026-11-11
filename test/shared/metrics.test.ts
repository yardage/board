import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, it } from 'node:test'
import { startTestBoard as startBoard } from '../support/helpers.ts'
import { GithubContext, type GhRequest, type HistoryItem, type HistoryRun, itemOf, normaliseHistory, type OpenPull, reviewOf as reviewWith, runState } from '../../src/server/github/copy.ts'
import { liveMilestones } from '../../src/server/infra/infra.ts'
import {
  activityBy,
  areasOf,
  bucketsFor,
  burnup,
  pullsNow,
  ciBy,
  dayTicks,
  ciSummary,
  failingBranches,
  forecast,
  headline,
  inkOn,
  isTicket,
  nextMilestone,
  niceTicks,
  readOverviewHash,
  recentMerges,
  statusCounts,
  subjectOfTab,
  tickIndexes,
  toTab,
  whoShips,
} from '../../src/shared/metrics.ts'

const temp: string[] = []
afterEach(() => {
  for (const dir of temp.splice(0)) rmSync(dir, { recursive: true, force: true })
})

// In local time, as the screen works: these hold in any time zone.
const NOW = new Date(2026, 10, 5, 15, 30).getTime()
const at = (day: number, hour: number, minute = 0) => new Date(2026, 10, day, hour, minute).toISOString()

const ticket = (number: number, more: Partial<HistoryItem> = {}): HistoryItem => ({
  number,
  kind: 'issue',
  author: 'vbarbanneau',
  title: `Ticket ${number}`,
  created: at(1, 9),
  closed: null,
  merged: null,
  milestone: 'M0 · Foundation',
  labels: [],
  ...more,
})
const merged = (number: number, when: string, more: Partial<HistoryItem> = {}) => ticket(number, { kind: 'pull', closed: when, merged: when, milestone: null, ...more })
const run = (id: number, state: HistoryRun['state'], start: string, minutes = 10, branch = 'area/x', pr: number | null = 7): HistoryRun => ({
  id,
  branch,
  pr,
  event: 'pull_request',
  state,
  start,
  end: state === 'running' || state === 'queued' ? null : new Date(Date.parse(start) + minutes * 60_000).toISOString(),
  updated: start,
})
const open = (number: number, more: Partial<OpenPull> = {}): OpenPull => ({ number, title: `Pull ${number}`, author: 'vbarbanneau', branch: 'area/x', draft: false, ci: 'success', created: at(5, 9), labels: [], review: 'none', ...more })

const reviewOf = (reviews: any[], comments: any[], head: string) => reviewWith(reviews, comments, head, 'Review agent:')

describe("the overview's figures", () => {
  it('counts pull requests the way the 5-minute copy does', () => {
    assert.deepEqual(pullsNow([open(1, { draft: true }), open(2, { ci: 'failure' }), open(3, { ci: 'timed_out' }), open(4, { ci: 'cancelled' })]), { open: 4, draft: 1, red: 2 })
  })

  it('cuts today into hours since midnight, and other ranges into whole days', () => {
    const hours = bucketsFor('today', NOW)
    assert.equal(hours.length, 16)
    assert.equal(hours[0].label, '00h')
    assert.equal(hours[15].label, '15h')
    assert.equal(hours[0].from, new Date(2026, 10, 5).getTime())
    const days = bucketsFor('week', NOW)
    assert.equal(days.length, 7)
    assert.equal(days[6].from, new Date(2026, 10, 5).getTime())
    assert.equal(days[6].to, new Date(2026, 10, 6).getTime())
    assert.equal(bucketsFor('fortnight', NOW).length, 14)
  })

  it('counts neither epics nor pull requests as tickets', () => {
    assert.ok(isTicket(ticket(1)))
    assert.ok(!isTicket(ticket(1, { labels: ['epic'] })))
    assert.ok(!isTicket(merged(1, at(5, 9))))
  })

  it('puts each event in its hour', () => {
    const items = [
      merged(10, at(5, 9, 20)),
      ticket(1, { closed: at(5, 9, 40) }),
      ticket(2, { created: at(5, 10, 5) }),
      ticket(3, { created: at(5, 10, 6), labels: ['epic'] }),
      merged(11, at(4, 9)),
    ]
    const rows = activityBy(bucketsFor('today', NOW), items)
    assert.deepEqual(rows[9], { label: '09h', merged: 1, closed: 1, opened: 0 })
    assert.deepEqual(rows[10], { label: '10h', merged: 0, closed: 0, opened: 1 })
    assert.equal(rows.reduce((sum, row) => sum + row.merged, 0), 1)
  })

  it('gives CI a rate only once a run has finished, and leaves a period empty rather than at zero', () => {
    assert.equal(ciSummary([], 0, NOW).rate, null)
    assert.equal(ciSummary([], 0, NOW).medianMinutes, null)
    const runs = [run(1, 'success', at(5, 9), 10), run(2, 'failure', at(5, 9, 30), 20), run(3, 'other', at(5, 9, 40)), run(4, 'running', at(5, 15))]
    const summary = ciSummary(runs, new Date(2026, 10, 5).getTime(), NOW + 1)
    assert.equal(summary.rate, 50)
    assert.equal(summary.finished, 2)
    assert.equal(summary.other, 1)
    assert.equal(summary.active, 1)
    assert.equal(summary.medianMinutes, 15)
    assert.equal(summary.longestMinutes, 20)
    const rows = ciBy(bucketsFor('today', NOW), runs)
    assert.deepEqual(rows[9], { label: '09h', success: 1, failure: 1, medianMinutes: 15 })
    assert.equal(rows[8].medianMinutes, null)
  })

  it('ranks where CI fails, without counting what passed', () => {
    const runs = [run(1, 'failure', at(5, 9), 5, 'a', 1), run(2, 'failure', at(5, 9), 5, 'a', 1), run(3, 'success', at(5, 9), 5, 'a', 1), run(4, 'failure', at(5, 9), 5, 'b', null), run(5, 'success', at(5, 9), 5, 'c', 3)]
    assert.deepEqual(failingBranches(runs, 0, NOW + 1), [
      { branch: 'a', failure: 2, total: 3, pr: 1 },
      { branch: 'b', failure: 1, total: 1, pr: null },
    ])
  })

  it('draws a burn-up that ends on what is true now, for a milestone or for all', () => {
    const items = [ticket(1, { created: at(1, 9), closed: at(3, 9) }), ticket(2, { created: at(2, 9) }), ticket(3, { created: at(4, 9), milestone: 'M1', closed: at(5, 9) }), ticket(4, { labels: ['epic'] })]
    const all = burnup(items, null, NOW)
    assert.equal(all.length, 60)
    assert.deepEqual([all[59].total, all[59].closed], [3, 2])
    assert.deepEqual([all[0].total, all[0].closed], [1, 0])
    const m1 = burnup(items, 'M1', NOW)
    assert.deepEqual([m1[59].total, m1[59].closed], [1, 1])
    assert.deepEqual(burnup(items, 'absent', NOW), [])
    for (let index = 1; index < all.length; index += 1) assert.ok(all[index].total >= all[index - 1].total && all[index].closed >= all[index - 1].closed)
  })

  it('does arithmetic on the pace, and says nothing when there is none', () => {
    const items = [ticket(1, { closed: at(5, 9) }), ticket(2, { closed: at(4, 9) }), ticket(3, { closed: at(4, 10) }), ticket(4), ticket(5), ticket(6)]
    const result = forecast(items, 'M0 · Foundation', '2026-11-07T00:00:00Z', NOW)
    assert.equal(result.remaining, 3)
    assert.equal(result.pace, 1)
    assert.equal(result.daysLeft, 3)
    assert.equal(result.daysToDue, 2)
    assert.equal(forecast([ticket(1)], null, null, NOW).daysLeft, null)
    assert.equal(forecast([ticket(1)], null, null, NOW).daysToDue, null)
    assert.equal(forecast([ticket(1, { closed: at(5, 9) })], null, null, NOW).daysLeft, 0)
    assert.equal(forecast([], null, null, NOW).total, 0)
  })

  it('counts areas and statuses on tickets only', () => {
    const items = [
      ticket(1, { labels: ['area:core', 'migration'], closed: at(5, 9) }),
      ticket(2, { labels: ['area:core', 'migration'] }),
      ticket(3, { labels: ['area:infra', 'security'], milestone: 'M1' }),
      ticket(4, { labels: ['area:infra', 'epic'] }),
      merged(5, at(5, 9), { labels: ['area:core'] }),
    ]
    assert.deepEqual(areasOf(items, null), [
      { area: 'core', closed: 1, open: 1 },
      { area: 'infra', closed: 0, open: 1 },
    ])
    assert.deepEqual(areasOf(items, 'M1'), [{ area: 'infra', closed: 0, open: 1 }])
    const statuses = { 1: 'Done', 2: 'Ready', 3: 'In review', 4: 'Backlog', 5: 'Done' }
    const counts = statusCounts(items, statuses, null)
    assert.deepEqual(counts, [{ status: 'Ready', count: 1 }, { status: 'In review', count: 1 }, { status: 'Done', count: 1 }], 'an epic and a pull request are not tickets, and a status nobody has is not listed')
    assert.deepEqual(statusCounts(items, { 1: 'Shipped', 2: 'Backlog' }, null).map((row) => row.status), ['Backlog', 'Shipped'], "a status of the project's own comes after the usual ones")
  })

  it('says who ships, and how many lines it has not read yet', () => {
    const items = [merged(10, at(5, 9)), merged(11, at(5, 10)), merged(12, at(1, 10)), ticket(1, { created: at(5, 8), author: 'rodolphebarbanneau' })]
    const name = (login: string) => ({ vbarbanneau: 'Victor', rodolphebarbanneau: 'Rodolphe' })[login] ?? login
    const rows = whoShips(items, [open(20), open(21, { author: 'rodolphebarbanneau' })], { 10: { added: 5, deleted: 2 } }, new Date(2026, 10, 5).getTime(), NOW + 1, name)
    assert.deepEqual(rows[0], { who: 'Victor', open: 1, merged: 2, added: 5, deleted: 2, unread: 1, opened: 0 })
    assert.deepEqual(rows[1], { who: 'Rodolphe', open: 1, merged: 0, added: 0, deleted: 0, unread: 0, opened: 1 })
  })

  it('lists merges newest first and sums up the day', () => {
    const items = [merged(10, at(5, 9)), merged(11, at(5, 10)), ticket(1, { closed: at(5, 9) })]
    assert.deepEqual(recentMerges(items).map((item) => item.number), [11, 10])
    const head = headline(items, [run(1, 'success', at(5, 9))], NOW)
    assert.deepEqual([head.merged, head.closed, head.ci.rate], [2, 1, 100])
  })

  it('finds the milestone that matters next', () => {
    const list = [
      { title: 'done', closed: 2, total: 2, due: '2026-01-01' },
      { title: 'later', closed: 0, total: 2, due: '2026-12-01' },
      { title: 'soon', closed: 0, total: 2, due: '2026-11-07' },
      { title: 'undated', closed: 0, total: 2, due: null },
    ]
    assert.equal(nextMilestone(list)?.title, 'soon')
    assert.equal(nextMilestone([list[3]])?.title, 'undated')
    assert.equal(nextMilestone([list[0]]), null)
  })
})

describe('the small pieces of a chart', () => {
  it('rounds an axis to clean steps that reach the highest value', () => {
    assert.deepEqual(niceTicks(0), [0, 1])
    assert.deepEqual(niceTicks(4), [0, 1, 2, 3, 4])
    assert.deepEqual(niceTicks(455), [0, 100, 200, 300, 400, 500])
    for (const max of [1, 3, 7, 19, 101, 999]) {
      const ticks = niceTicks(max)
      assert.ok(ticks[ticks.length - 1] >= max, String(max))
      assert.ok(ticks.length <= 6, String(max))
    }
  })

  it('shows labels that fit, always with the last', () => {
    assert.deepEqual(tickIndexes(0, 100, 10), [])
    assert.deepEqual(tickIndexes(3, 600, 50), [0, 1, 2])
    const some = tickIndexes(60, 300, 60)
    assert.equal(some[some.length - 1], 59)
    assert.ok(some.length <= 5)
  })

  it('picks the ink that reads on a fill', () => {
    assert.equal(inkOn('#184f95'), '#ffffff')
    assert.equal(inkOn('#cde2fb'), '#0b0b0b')
  })
})

describe('the days on an axis', () => {
  it('marks the first point of each day, and thins them out to fit', () => {
    const times = [new Date(2026, 10, 3, 18).getTime(), new Date(2026, 10, 3, 23).getTime(), new Date(2026, 10, 4, 5).getTime(), new Date(2026, 10, 4, 20).getTime(), new Date(2026, 10, 5, 1).getTime()]
    assert.deepEqual(dayTicks(times, 8), [0, 2, 4])
    assert.deepEqual(dayTicks(times, 2), [0, 4])
    assert.deepEqual(dayTicks([], 8), [])
  })
})

describe('addresses', () => {
  it('opens each tab, and the old screens still lead somewhere', () => {
    assert.equal(readOverviewHash('vue'), 'global')
    assert.equal(readOverviewHash('vue/ci'), 'ci')
    assert.equal(readOverviewHash('now'), 'equipe')
    assert.equal(readOverviewHash('infra'), 'global')
    assert.equal(readOverviewHash('infra/jobs'), 'ci')
    assert.equal(readOverviewHash('infra/hotes'), 'hotes')
    assert.equal(readOverviewHash('vue/nothing'), null)
    assert.equal(readOverviewHash('valider'), null)
    assert.equal(toTab('global'), '#vue')
    assert.equal(toTab('ci'), '#vue/ci')
  })

  it('keeps the subject older threads on the infra screen are linked to', () => {
    assert.deepEqual(subjectOfTab('ci'), { label: 'Infra', doc: 'github/ci/status.md' })
    assert.deepEqual(subjectOfTab('global'), { label: 'Infra', doc: 'github/ci/status.md' })
    assert.equal(subjectOfTab('avancement').doc, 'github/milestones.md')
  })

})

describe('the ledger', () => {
  const raw = (number: number, updated: string, more: object = {}) => ({ number, title: `Item ${number}`, user: { login: 'someone' }, created_at: '2026-11-01T10:00:00Z', closed_at: null, updated_at: updated, labels: [{ name: 'area:core' }], milestone: { title: 'M0' }, ...more })
  const rawRun = (id: number, more: object = {}) => ({ id, head_branch: 'area/x', head_sha: 'aaa', event: 'pull_request', status: 'completed', conclusion: 'success', run_started_at: new Date(Date.now() - 3_600_000).toISOString(), updated_at: new Date(Date.now() - 3_000_000).toISOString(), pull_requests: [{ number: 7 }], ...more })

  function world(state: { items: any[]; runs: any[]; pulls?: any[]; fail?: boolean; project?: 'ok' | 'fail'; reviews?: any[] }) {
    const asked: string[] = []
    const ask: GhRequest = async (args) => {
      const line = args.join(' ')
      asked.push(line)
      if (state.fail) throw new Error('API rate limit exceeded')
      if (args.includes('graphql')) {
        if (state.project === 'fail') throw new Error('Your token has not been granted the required scopes')
        if (line.includes('projectV2')) {
          return JSON.stringify({
            data: {
              repositoryOwner: {
                projectV2: {
                  items: {
                    pageInfo: { hasNextPage: false, endCursor: null },
                    nodes: [
                      { content: { number: 1, repository: { nameWithOwner: 'acme/app' } }, fieldValueByName: { name: 'Ready' } },
                      { content: { number: 2, repository: { nameWithOwner: 'acme/another' } }, fieldValueByName: { name: 'Done' } },
                      { content: {}, fieldValueByName: { name: 'Done' } },
                    ],
                  },
                },
              },
            },
          })
        }
        return JSON.stringify({ data: {} })
      }
      if (line.includes('issues?state=all')) return JSON.stringify(state.items)
      if (line.includes('issues?state=open')) return JSON.stringify([])
      if (line.includes('issues?state=closed')) return JSON.stringify([])
      if (line.includes('actions/runners')) return JSON.stringify({ runners: [] })
      if (line.includes('actions/runs?')) return JSON.stringify({ workflow_runs: line.includes('page=') && !line.includes('page=1') && state.runs.length < 100 ? [] : state.runs })
      if (/actions\/runs\/\d+$/.test(line)) return JSON.stringify(rawRun(Number(line.match(/(\d+)$/)?.[1]), { run_started_at: new Date(Date.now() - 3_600_000).toISOString(), updated_at: new Date().toISOString() }))
      if (line.includes('pulls?state=open')) return JSON.stringify(state.pulls ?? [])
      if (line.includes('pulls?state=closed')) return JSON.stringify([])
      if (/issues\/\d+\/comments/.test(line)) return JSON.stringify([])
      if (/pulls\/\d+\/reviews/.test(line)) return JSON.stringify(state.reviews ?? [])
      if (/pulls\/\d+\/comments/.test(line)) return JSON.stringify([])
      if (line.includes('vnd.github.diff')) return 'diff'
      if (/pulls\/\d+$/.test(line)) return JSON.stringify({ additions: 12, deletions: 3 })
      throw new Error(`unexpected: ${line}`)
    }
    const root = mkdtempSync(join(tmpdir(), 'board-history-'))
    temp.push(root)
    return { asked, github: new GithubContext(root, ask, { repo: 'acme/app', project: { owner: 'acme', number: 2 }, waiting: { label: 'needs-answer', who: 'Waiting on', question: 'Question' } }), file: join(root, 'github', 'history.json') }
  }

  it('reads everything once, then only what changed', async () => {
    const state = { items: [raw(1, '2026-11-05T10:00:00Z'), raw(2, '2026-11-05T11:00:00Z', { pull_request: { merged_at: new Date().toISOString() }, closed_at: new Date().toISOString() })], runs: [rawRun(100)] }
    const { asked, github, file } = world(state)
    await github.refresh()
    const first = JSON.parse(readFileSync(file, 'utf8'))
    assert.equal(first.items.length, 2)
    assert.equal(first.since, '2026-11-05T11:00:00Z')
    assert.equal(first.items[1].kind, 'pull')
    assert.ok(asked.some((line) => line.includes('issues?state=all') && !line.includes('since=')))
    assert.equal(first.lines[2].added, 12)
    asked.length = 0
    state.items = [raw(1, '2026-11-05T12:00:00Z', { closed_at: '2026-11-05T12:00:00Z' })]
    state.runs = [rawRun(101, { status: 'in_progress', conclusion: null })]
    await github.refresh()
    const second = JSON.parse(readFileSync(file, 'utf8'))
    assert.equal(second.items.length, 2, 'what did not change stays')
    assert.equal(second.items[0].closed, '2026-11-05T12:00:00Z')
    assert.equal(second.since, '2026-11-05T12:00:00Z')
    assert.equal(second.runs.length, 2)
    assert.deepEqual(second.runs.map((one: HistoryRun) => one.state).sort(), ['running', 'success'])
    assert.equal(second.runs.find((one: HistoryRun) => one.state === 'running').end, null)
    assert.ok(asked.some((line) => line.includes(`since=${encodeURIComponent('2026-11-05T10:50:00.000Z')}`)), 'a little before the latest change, as a list can lag')
    assert.ok(!asked.some((line) => /pulls\/2$/.test(line)), 'a merged pull request is read once')
  })

  it('forgets runs after 14 days', async () => {
    const old = new Date(Date.now() - 15 * 86_400_000).toISOString()
    const { github, file } = world({ items: [], runs: [rawRun(1), rawRun(2, { run_started_at: old })] })
    await github.refresh()
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')).runs.map((one: HistoryRun) => one.id), [1])
  })

  it('stops a first reading of the runs at its limit, or at what it keeps', async () => {
    const full = Array.from({ length: 100 }, (_, index) => rawRun(index + 1))
    const a = world({ items: [], runs: full })
    await a.github.refresh()
    const pages = a.asked.filter((line) => /&page=\d+/.test(line)).length
    assert.equal(pages, 10)
    const old = new Date(Date.now() - 15 * 86_400_000).toISOString()
    const b = world({ items: [], runs: Array.from({ length: 100 }, (_, index) => rawRun(index + 1, { run_started_at: old })) })
    await b.github.refresh()
    assert.equal(b.asked.filter((line) => /&page=\d+/.test(line)).length, 1)
  })

  it('reads the project at most every 30 minutes, and goes on without it', async () => {
    const state = { items: [raw(1, '2026-11-05T10:00:00Z')], runs: [], project: 'ok' as 'ok' | 'fail' }
    const { asked, github, file } = world(state)
    await github.refresh()
    const history = JSON.parse(readFileSync(file, 'utf8'))
    assert.deepEqual(history.project.statuses, { 1: 'Ready' }, 'only this repository, only items with a number')
    const count = () => asked.filter((line) => line.includes('projectV2')).length
    assert.equal(count(), 1)
    await github.refresh()
    assert.equal(count(), 1)

    const other = world({ items: [], runs: [], project: 'fail' })
    await other.github.refresh()
    assert.equal(JSON.parse(readFileSync(other.file, 'utf8')).project, null)
    assert.equal(other.github.lastError, null, "a login without the project's scope isn't a failed copy")
  })

  it('reads live at most once a minute, with two requests, and uses the runs the screen read', async () => {
    const state = { items: [raw(1, '2026-11-05T10:00:00Z')], runs: [] as any[], pulls: [{ number: 7, title: 'x', user: { login: 'a' }, head: { ref: 'b', sha: 'aaa' }, labels: [], created_at: '2026-11-05T09:00:00Z' }] }
    const { asked, github } = world(state)
    await github.refresh()
    await github.live()
    asked.length = 0
    // A first pass counts for the minute: nothing more until it has passed.
    await github.live()
    assert.deepEqual(asked, [])
    github.noteRuns([rawRun(5, { head_sha: 'aaa' })])
    const { history } = await github.overview()
    assert.ok(history?.runs.some((one) => one.id === 5), 'what the screen read is drawn at once')
    assert.deepEqual(asked, [], 'and costs no request')
  })

  it('makes one live pass of two requests, keeps what it knew on failure, and says so', async () => {
    const state = { items: [raw(1, '2026-11-05T10:00:00Z')], runs: [rawRun(1)], pulls: [{ number: 7, title: 'x', user: { login: 'a' }, head: { ref: 'b', sha: 'aaa' }, labels: [], created_at: '2026-11-05T09:00:00Z' }], fail: false }
    const { asked, github } = world(state)
    await github.live()
    assert.ok(asked.length <= 3, asked.join(' ; '))
    const { history, error } = await github.overview()
    assert.equal(error, null)
    assert.equal(history?.pulls[0].number, 7)

    const late = world({ ...state, fail: true })
    await late.github.live()
    const after = await late.github.overview()
    assert.equal(after.history?.items.length ?? 0, 0)
    assert.match(after.error ?? '', /rate limit/)
  })

  it('keeps the review it read, and takes it back when the head moves', async () => {
    const pull = (sha: string, updated = '2026-11-05T10:00:00Z') => ({ number: 7, title: 'x', user: { login: 'a' }, head: { ref: 'b', sha }, labels: [], comments: 0, updated_at: updated, created_at: '2026-11-05T09:00:00Z' })
    const state = { items: [], runs: [], pulls: [pull('aaa')], reviews: [{ user: { login: 'b' }, state: 'APPROVED', commit_id: 'aaa' }] }
    const { github, asked } = world(state)
    await github.refresh()
    assert.equal((await github.overview()).history?.pulls[0].review, 'approved')
    asked.length = 0
    await github.refresh()
    assert.ok(!asked.some((line) => line.includes('/reviews')), 'nothing changed, so it is not read again')
    assert.equal((await github.overview()).history?.pulls[0].review, 'approved')
    state.pulls = [pull('bbb', '2026-11-05T11:00:00Z')]
    await github.live()
    assert.equal((await github.overview()).history?.pulls[0].review, 'stale', 'seen by the live reading, before reviews are read again')
  })

  it('survives a damaged or older file, and reads again what it cannot say', async () => {
    for (const damaged of ['', '{not json', '{}', '[]', 'null']) {
      const { github, file, asked } = world({ items: [raw(1, '2026-11-05T10:00:00Z')], runs: [] })
      mkdirSync(join(file, '..'), { recursive: true })
      writeFileSync(file, damaged)
      assert.equal((await github.overview()).history, null, damaged)
      await github.refresh()
      assert.equal(github.lastError, null, damaged)
      assert.equal(JSON.parse(readFileSync(file, 'utf8')).items.length, 1, damaged)
      assert.ok(asked.some((line) => line.includes('issues?state=all') && !line.includes('since=')), damaged)
    }
    const { github, file } = world({ items: [], runs: [] })
    mkdirSync(join(file, '..'), { recursive: true })
    writeFileSync(join(file, '..', '.seen.json'), '{half')
    await github.refresh()
    assert.equal(github.lastError, null, 'a damaged list of what was seen is only a longer refresh')
  })

  it('fills in what an older file lacks', () => {
    const history = normaliseHistory({ items: [], at: 'x' })
    assert.deepEqual([history?.runs, history?.pulls, history?.lines, history?.project, history?.runsFrom], [[], [], {}, null, null])
    assert.equal(normaliseHistory({ runs: [] }), null)
  })

  it('reads everything again each day, which drops what no longer exists', async () => {
    const state = { items: [raw(1, '2026-11-05T10:00:00Z'), raw(2, '2026-11-05T10:00:00Z')], runs: [] }
    const { github, file, asked } = world(state)
    await github.refresh()
    const saved = JSON.parse(readFileSync(file, 'utf8'))
    saved.fullAt = Date.now() - 25 * 3_600_000
    writeFileSync(file, JSON.stringify(saved))
    const later = new GithubContext(join(file, '..', '..'), (github as any).ask, { repo: 'acme/app', project: { owner: 'acme', number: 2 }, waiting: { label: 'needs-answer', who: 'Waiting on', question: 'Question' } })
    state.items = [raw(1, '2026-11-05T10:00:00Z')]
    asked.length = 0
    await later.refresh()
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')).items.map((item: HistoryItem) => item.number), [1])
    assert.ok(asked.some((line) => line.includes('issues?state=all') && !line.includes('since=')))
  })

  it('goes back when it has missed runs, and says from when it knows them all', async () => {
    const state = { items: [], runs: [rawRun(1)] as any[] }
    const { github, file, asked } = world(state)
    await github.refresh()
    assert.ok(JSON.parse(readFileSync(file, 'utf8')).runsFrom)
    // Closed for long: a full page that overlaps nothing, up to the limit.
    state.runs = Array.from({ length: 100 }, (_, index) => rawRun(index + 1000))
    asked.length = 0
    await github.refresh()
    assert.equal(asked.filter((line) => /&page=\d+/.test(line)).length, 9, 'pages 2 to 10')
    const saved = JSON.parse(readFileSync(file, 'utf8'))
    assert.equal(saved.runsFrom, state.runs[99].run_started_at, 'older runs may have holes')
    // Back in step: a page that overlaps costs nothing more.
    asked.length = 0
    state.runs = [...state.runs.slice(0, 99), rawRun(5000)]
    await github.refresh()
    assert.equal(asked.filter((line) => /&page=\d+/.test(line)).length, 0)
  })

  it('retries a first reading of the runs that failed half way', async () => {
    const full = Array.from({ length: 100 }, (_, index) => rawRun(index + 1))
    const { github, file } = world({ items: [], runs: full })
    const slow = github as any
    const ask = slow.ask
    let failing = true
    slow.ask = async (args: string[]) => {
      if (failing && args.join(' ').includes('page=2')) throw new Error('HTTP 502')
      return ask(args)
    }
    await github.refresh()
    assert.match(github.lastError ?? '', /history: HTTP 502/)
    failing = false
    await github.refresh()
    assert.equal(github.lastError, null)
    assert.ok(JSON.parse(readFileSync(file, 'utf8')).runsFrom)
  })

  it('does not let an old list put a finished run back to running', async () => {
    const started = new Date(Date.now() - 3_600_000).toISOString()
    const state = { items: [], runs: [rawRun(1, { status: 'in_progress', conclusion: null, updated_at: started })] as any[] }
    const { github, file } = world(state)
    await github.refresh()
    github.noteRuns([rawRun(1, { status: 'in_progress', conclusion: null, updated_at: started })])
    state.runs = [rawRun(1, { status: 'completed', conclusion: 'success', updated_at: new Date().toISOString() })]
    await github.refresh()
    assert.equal((await github.overview()).history?.runs[0].state, 'success')
    await github.live()
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).runs[0].state, 'success')
  })

  it('asks directly for a run that left the list unfinished', async () => {
    const old = new Date(Date.now() - 3_600_000).toISOString()
    const state = { items: [], runs: [rawRun(1, { status: 'in_progress', conclusion: null, run_started_at: old, updated_at: old })] as any[] }
    const { github, file, asked } = world(state)
    await github.refresh()
    state.runs = [rawRun(2)]
    await github.refresh()
    assert.ok(asked.some((line) => /actions\/runs\/1$/.test(line)))
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).runs.find((one: HistoryRun) => one.id === 1).state, 'success')
  })

  it('waits longer once GitHub has refused the quota, and forgets the failure once it answers', async () => {
    const state = { items: [raw(1, '2026-11-05T10:00:00Z')], runs: [rawRun(1)], fail: true }
    const { github, asked } = world(state)
    await github.live()
    assert.match((await github.overview()).error ?? '', /rate limit/)
    ;(github as any).livedAt = Date.now() - 2 * 60_000
    asked.length = 0
    await github.live()
    assert.deepEqual(asked, [], 'two minutes later it still waits')
    state.fail = false
    await github.refresh()
    assert.equal((await github.overview()).error, null, 'a refresh brought the same figures')
  })

  it('leaves the other pull requests to read when one of them fails, and stops when none can be read', async () => {
    const when = new Date().toISOString()
    const merged = (number: number) => raw(number, '2026-11-05T10:00:00Z', { pull_request: { merged_at: when }, closed_at: when })
    const { github, file } = world({ items: [merged(1), merged(2), merged(3)], runs: [] })
    const slow = github as any
    const ask = slow.ask
    const lines: string[] = []
    let refuse = (line: string) => /pulls\/3$/.test(line)
    slow.ask = async (args: string[]) => {
      const line = args.join(' ')
      if (/pulls\/\d+$/.test(line)) {
        lines.push(line)
        if (refuse(line)) throw new Error('HTTP 500')
      }
      return ask(args)
    }
    await github.refresh()
    assert.deepEqual(Object.keys(JSON.parse(readFileSync(file, 'utf8')).lines).sort(), ['1', '2'])
    lines.length = 0
    refuse = () => true
    const saved = JSON.parse(readFileSync(file, 'utf8'))
    saved.lines = {}
    writeFileSync(file, JSON.stringify(saved))
    ;(github as any).history = null
    await github.refresh()
    assert.equal(lines.length, 3)
  })

  it('gives up on a run that has been deleted, so the next ones get their turn', async () => {
    const old = new Date(Date.now() - 3_600_000).toISOString()
    const stuck = (id: number) => rawRun(id, { status: 'in_progress', conclusion: null, run_started_at: old, updated_at: old })
    const state = { items: [], runs: [1, 2, 3, 4, 5, 6, 7].map(stuck) as any[] }
    const { github, file, asked } = world(state)
    const slow = github as any
    const ask = slow.ask
    slow.ask = async (args: string[]) => {
      if (/actions\/runs\/[1-5]$/.test(args.join(' '))) throw new Error('gh: Not Found (HTTP 404)')
      return ask(args)
    }
    await github.refresh()
    state.runs = [rawRun(9)]
    await github.refresh()
    asked.length = 0
    await github.refresh()
    assert.ok(asked.some((line) => /actions\/runs\/6$/.test(line)), 'after the first five')
    const runs = JSON.parse(readFileSync(file, 'utf8')).runs.map((one: HistoryRun) => one.id)
    assert.ok(![1, 2, 3, 4, 5].some((id) => runs.includes(id)))
  })

  it('tells pull requests not read yet from none', async () => {
    const state = { items: [], runs: [], pulls: [] }
    const { github, file } = world(state)
    const slow = github as any
    const ask = slow.ask
    let failing = true
    slow.ask = async (args: string[]) => {
      if (failing && args.join(' ').includes('pulls?state=open')) throw new Error('HTTP 502')
      return ask(args)
    }
    await github.refresh()
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).pullsAt, null)
    assert.match((await github.overview()).error ?? 'none', /none|502/)
    failing = false
    ;(github as any).livedAt = 0
    await github.live()
    assert.ok(JSON.parse(readFileSync(file, 'utf8')).pullsAt)
  })

  it('does not take the list of runs from before a window was hidden', async () => {
    const started = new Date(Date.now() - 3_600_000).toISOString()
    const head = 'a'.repeat(40)
    const state = { items: [], runs: [rawRun(1)], pulls: [{ number: 7, title: 'x', user: { login: 'a' }, head: { ref: 'b', sha: head }, labels: [], created_at: '2026-11-05T09:00:00Z' }] }
    const { github, asked } = world(state)
    await github.refresh()
    github.noteRuns([rawRun(1, { status: 'in_progress', conclusion: null, head_sha: head, updated_at: started })])
    ;(github as any).notedAt = Date.now() - 10 * 60_000
    ;(github as any).livedAt = 0
    asked.length = 0
    await github.live()
    assert.ok(asked.some((line) => line.includes('actions/runs?')), 'it asks again')
    assert.notEqual((await github.overview()).history?.pulls[0].ci, 'in_progress')
    github.noteRuns([rawRun(1, { status: 'in_progress', conclusion: null, head_sha: head, updated_at: new Date().toISOString() })])
    ;(github as any).livedAt = 0
    asked.length = 0
    await github.live()
    assert.ok(!asked.some((line) => line.includes('actions/runs?')), 'a recent list is enough')
  })

  it('shows nothing until a first reading has finished', async () => {
    let release = () => {}
    const held = new Promise<void>((done) => {
      release = done
    })
    const { github, asked } = world({ items: [raw(1, '2026-11-05T10:00:00Z')], runs: [] })
    const slow = github as any
    const ask = slow.ask
    slow.ask = async (args: string[]) => {
      await held
      return ask(args)
    }
    const pass = github.live()
    assert.equal((await github.overview()).history, null, 'an empty ledger would read as "no ticket"')
    release()
    await pass
    assert.equal((await github.overview()).history?.items.length, 1)
    assert.ok(asked.length > 0)
  })

  it('does not write over itself when a refresh and a live pass meet', async () => {
    const { github, file } = world({ items: [raw(1, '2026-11-05T10:00:00Z')], runs: [rawRun(1)] })
    await Promise.all([github.live(), github.refresh(), github.live()])
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).items.length, 1)
  })

  it('reads what reviews say of a head', () => {
    const word = (login: string, state: string, commit = 'new') => ({ user: { login }, state, commit_id: commit })
    assert.equal(reviewOf([], [], 'new'), 'none')
    assert.equal(reviewOf([word('a', 'COMMENTED')], [], 'new'), 'none')
    assert.equal(reviewOf([word('a', 'APPROVED')], [], 'new'), 'approved')
    assert.equal(reviewOf([word('a', 'APPROVED', 'old')], [], 'new'), 'stale')
    assert.equal(reviewOf([word('a', 'APPROVED'), word('b', 'CHANGES_REQUESTED')], [], 'new'), 'changes')
    assert.equal(reviewOf([word('a', 'CHANGES_REQUESTED'), word('a', 'APPROVED')], [], 'new'), 'approved', 'the latest word of each person')
    assert.equal(reviewOf([word('a', 'APPROVED'), word('a', 'DISMISSED')], [], 'new'), 'none')
    assert.equal(reviewOf([word('a', 'APPROVED'), word('a', 'COMMENTED')], [], 'new'), 'approved', 'a comment changes nothing')
  })

  it("reads this repository's review comments, for the head they name", () => {
    const head = 'a'.repeat(40)
    const older = 'b'.repeat(40)
    const said = (word: string, sha: string) => ({ body: `Review agent: ${word} at ${sha}\n\nFindings.` })
    assert.equal(reviewOf([], [said('APPROVE', head)], head), 'approved')
    assert.equal(reviewOf([], [said('CHANGES', head)], head), 'changes')
    assert.equal(reviewOf([], [said('CHANGES', head), said('APPROVE', head)], head), 'approved', 'the latest one')
    assert.equal(reviewOf([], [said('APPROVE', older)], head), 'stale')
    assert.equal(reviewOf([], [said('APPROVE', older), said('CHANGES', head)], head), 'changes')
    assert.equal(reviewOf([], [{ body: `He wrote Review agent: APPROVE at ${head}` }], head), 'none', 'it has to start with it')
    assert.equal(reviewOf([], [{ body: `Review agent: APPROVE at ${head.slice(0, 8)}` }], head), 'none', 'with the full sha')
    assert.equal(reviewOf([{ user: { login: 'a' }, state: 'CHANGES_REQUESTED', commit_id: older }], [said('APPROVE', head)], head), 'approved')
    assert.equal(reviewOf([{ user: { login: 'a' }, state: 'APPROVED', commit_id: head }], [said('APPROVE', older)], head), 'approved', "GitHub's own word on this head stands")
  })

  it('answers on its route without asking GitHub', async () => {
    process.env.BOARD_PERSON = 'victor'
    const root = mkdtempSync(join(tmpdir(), 'board-route-'))
    temp.push(root)
    mkdirSync(join(root, 'client'))
    writeFileSync(join(root, 'client', 'index.html'), 'page')
    const running = await startBoard({ root, client: join(root, 'client'), port: 4791, loops: false, config: { repos: [{ name: 'acme/app', code: false, issues: { create: false, comment: false, edit: false, close: false }, pulls: { comment: false, edit: false, review: false } }] } })
    try {
      const answer = await fetch(`${running.url}/api/overview`).then((response) => response.json())
      assert.deepEqual([answer.history, answer.error], [null, null])
      assert.equal(answer.members.find((member: { login: string }) => member.login === 'vbarbanneau').name, 'Victor')
      assert.equal(answer.repository, 'https://github.com/acme/app')
    } finally {
      await running.stop()
    }
  })

  it('asks GitHub nothing for a window nobody can see, at the route', async () => {
    const root = mkdtempSync(join(tmpdir(), 'board-overview-'))
    temp.push(root)
    mkdirSync(join(root, 'client'))
    writeFileSync(join(root, 'client', 'index.html'), 'page')
    const running = await startBoard({ root, client: join(root, 'client'), port: 4792, loops: false, onScreen: () => false })
    try {
      assert.deepEqual(await fetch(`${running.url}/api/infra`).then((response) => response.json()), { unconfigured: true })
    } finally {
      await running.stop()
    }
  })

  it('maps a run and an item without guessing', () => {
    assert.equal(runState({ status: 'completed', conclusion: 'startup_failure' }), 'failure')
    assert.equal(runState({ status: 'completed', conclusion: 'cancelled' }), 'other')
    assert.equal(runState({ status: 'in_progress' }), 'running')
    assert.equal(runState({ status: 'waiting' }), 'queued')
    const pull = itemOf({ number: 3, pull_request: { merged_at: null }, closed_at: 'x', created_at: 'y', labels: [] })
    assert.deepEqual([pull.kind, pull.merged, pull.milestone], ['pull', null, null])
  })

  it('counts milestones from the ledger, with the dates of the roadmap', () => {
    const known = [{ title: 'M0', closed: 1, total: 1, due: '2026-11-07' }]
    assert.deepEqual(liveMilestones(undefined, known), known)
    const items = [ticket(1, { milestone: 'M0', closed: 'x' }), ticket(2, { milestone: 'M0' }), ticket(3, { milestone: 'M0', labels: ['epic'] }), ticket(4, { milestone: 'M9' }), merged(5, 'x', { milestone: 'M0' })]
    assert.deepEqual(liveMilestones(items, known), [{ title: 'M0', closed: 1, total: 2, due: '2026-11-07' }], 'a closed milestone is not one to come')
  })
})
