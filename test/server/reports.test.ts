import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, it } from 'node:test'
import { BoardGit } from '../../src/server/environment/git.ts'
import type { History, HistoryItem, HistoryRun, OpenPull } from '../../src/server/github/copy.ts'
import { buildReport, dayBefore, dueSlot, idOf, parisOf, parisTime, parseReport, type Report, type ReportInput, ReportWriter, searchText, setReportZone, type ThreadActivity } from '../../src/server/environment/reports.ts'

setReportZone('Europe/Paris', [{ login: 'vbarbanneau', name: 'Victor' }, { login: 'rodolphebarbanneau', name: 'Rodolphe' }])
import { setLanguage } from '../../src/shared/i18n/i18n.ts'
import { parseMermaid } from '../../src/client/lib/mermaid.ts'
import { latestGenerated, mergeReportDays, setZone } from '../../src/shared/metrics.ts'
import { daySections, keyPoints, sinceWords } from '../../src/client/features/reports/report-text.ts'
import { reportLine } from '../../src/client/features/reports/report-words.ts'

// The words of a report are put on its figures where it is read, in the environment's zone.
setZone('Europe/Paris')

const temp: string[] = []
afterEach(() => {
  for (const dir of temp.splice(0)) rmSync(dir, { recursive: true, force: true })
})
const folder = () => {
  const dir = mkdtempSync(join(tmpdir(), 'board-reports-'))
  temp.push(dir)
  return dir
}

const HOUR = 3_600_000
const NOW = parisTime('2026-11-06', 13) + 5 * 60_000
const iso = (time: number) => new Date(time).toISOString()
const ticket = (number: number, created: number, closed: number | null = null, more: Partial<HistoryItem> = {}): HistoryItem => ({ number, kind: 'issue', title: `Ticket ${number}`, author: 'vbarbanneau', created: iso(created), closed: closed === null ? null : iso(closed), merged: null, milestone: 'M0 · Foundation', labels: [], ...more })
const merged = (number: number, when: number, author = 'vbarbanneau', title = `PR ${number}`): HistoryItem => ({ number, kind: 'pull', title, author, created: iso(when - HOUR), closed: iso(when), merged: iso(when), milestone: null, labels: [] })
const run = (id: number, start: number, state: HistoryRun['state'] = 'success', branch = 'main'): HistoryRun => ({ id, branch, pr: null, event: 'push', state, start: iso(start), end: iso(start + 10 * 60_000), updated: iso(start + 10 * 60_000) })
const open = (number: number, more: Partial<OpenPull> = {}): OpenPull => ({ number, title: `Open ${number}`, author: 'rodolphebarbanneau', branch: 'x', draft: false, ci: 'success', created: iso(NOW - 5 * HOUR), labels: [], review: 'none', ...more }) as OpenPull
const history = (more: Partial<History> = {}): History => ({ at: iso(NOW - 60_000), since: null, items: [], runs: [], pulls: [], itemsAt: iso(NOW - 60_000), pullsAt: iso(NOW - 60_000), lines: {}, project: null, projectTriedAt: 0, fullAt: 0, runsFrom: null, ...more })
type Repository = NonNullable<ReportInput['repository']>
const repo = (more: Partial<Repository> = {}): Repository => ({ name: 'acme/app', history: history(), milestones: [{ title: 'M0 · Foundation', closed: 0, total: 0, due: '2026-11-07' }], waiting: [], ...more })
const input = (more: Partial<ReportInput> = {}): ReportInput => ({ kind: 'update', day: '2026-11-06', slot: 13, at: NOW, from: NOW - 3 * HOUR, to: NOW, threads: [], repository: repo(), by: 'victor', ...more })
const thread = (id: string, at: number, more: Partial<ThreadActivity> = {}): ThreadActivity => ({ id, title: `Thread ${id}`, createdAt: iso(at), createdBy: 'vbarbanneau', status: 'open', messages: [{ author: 'vbarbanneau', createdAt: iso(at) }], polls: [], ...more })
const said = (report: Report) => keyPoints(report).join('\n')
const github = (report: Report) => {
  assert.ok(report.repository, 'a repository is followed')
  return report.repository
}

describe('the time of reports', () => {
  it('reads the day and the hour in Paris, whatever the machine says', () => {
    assert.deepEqual(parisOf(Date.UTC(2026, 10, 6, 23, 30)), { day: '2026-11-07', hour: 0, minute: 30, label: '00:30' })
    assert.equal(parisOf(Date.UTC(2026, 6, 1, 10)).hour, 12, 'summer time')
    assert.equal(new Date(parisTime('2026-11-06', 13)).toISOString(), '2026-11-06T12:00:00.000Z')
    assert.equal(new Date(parisTime('2026-07-01')).toISOString(), '2026-06-30T22:00:00.000Z')
  })

  it('knows a day can have 23 or 25 hours', () => {
    assert.equal((parisTime('2026-03-29', 24) - parisTime('2026-03-29')) / HOUR, 23)
    assert.equal((parisTime('2026-10-25', 24) - parisTime('2026-10-25')) / HOUR, 25)
  })

  it('gives each three hours a report, and none before the first of the day', () => {
    assert.equal(dueSlot(parisTime('2026-11-06') + 30 * 60_000), null)
    assert.deepEqual(dueSlot(parisTime('2026-11-06', 1)), { day: '2026-11-06', slot: 1 })
    assert.deepEqual(dueSlot(parisTime('2026-11-06', 3) + 59 * 60_000), { day: '2026-11-06', slot: 1 })
    assert.deepEqual(dueSlot(parisTime('2026-11-06', 23)), { day: '2026-11-06', slot: 22 })
    assert.equal(idOf('2026-11-06', 7), '2026-11-06-0700')
    assert.equal(idOf('2026-11-06', null), '2026-11-06-day')
    assert.equal(dayBefore('2026-11-01'), '2026-10-31')
  })
})

describe('what a report says of the repository', () => {
  it('names what was merged since the last one, by whom, and what waits on a person', () => {
    const report = buildReport(
      input({
        repository: repo({
          history: history({ items: [merged(1, NOW - HOUR), merged(2, NOW - 2 * HOUR, 'rodolphebarbanneau'), merged(3, NOW - 4 * HOUR), ticket(4, NOW - HOUR), ticket(5, NOW - 40 * HOUR, NOW - HOUR)], runs: [run(1, NOW - HOUR, 'failure')], pulls: [open(9, { ci: 'failure' })] }),
          waiting: [{ number: 12, title: 'x', who: 'victor', question: 'y' }],
        }),
      }),
    )
    const text = said(report)
    assert.match(text, /2 PR mergées depuis 10:05/)
    assert.match(text, /#2 \(Rodolphe\)/)
    assert.match(text, /#1 \(Victor\)/)
    assert.ok(!text.includes('#3'), 'before this report covers')
    assert.match(text, /1 ticket fermé, 1 ouvert depuis 10:05/)
    assert.match(text, /La branche principale est rouge/)
    assert.match(text, /1 PR ouverte en rouge : #9\./)
    assert.match(text, /1 point attend une personne : #12 \(Victor\)\./)
    assert.deepEqual(github(report).today, { merged: 3, closed: 1, opened: 1 })
    assert.deepEqual(github(report).pulls, { open: 1, draft: 0, red: 1, stale: 0 })
    assert.deepEqual(github(report).mergedBy, [{ who: 'Rodolphe', numbers: [2] }, { who: 'Victor', numbers: [1] }])
  })

  it('says one line for a quiet night, and carries no chart', () => {
    const report = buildReport(input({ repository: repo({ history: history({ items: [ticket(1, NOW - 40 * HOUR)] }) }) }))
    assert.equal(report.quiet, true)
    assert.equal(said(report), 'Rien de neuf depuis 10:05.')
    assert.deepEqual([github(report).burnup, github(report).activity, github(report).ciRows, github(report).merged], [[], [], [], []])
    assert.equal(github(report).queue, null)
  })

  it('invents nothing about pull requests not read yet', () => {
    const report = buildReport(input({ repository: repo({ history: history({ pullsAt: null, items: [merged(1, NOW - HOUR)] }) }) }))
    assert.equal(github(report).pulls, null)
    assert.equal(github(report).queue, null)
  })

  it('counts a past day as it stood at its end', () => {
    const day = '2026-11-05'
    const end = parisTime(day, 24)
    const report = buildReport(input({ kind: 'day', day, slot: null, from: parisTime(day), to: end, at: end + 5 * 60_000, repository: repo({ history: history({ items: [ticket(1, end - 40 * HOUR, end + HOUR), ticket(2, end + HOUR), merged(3, end - HOUR), merged(4, end + HOUR)] }) }) }))
    assert.equal(report.id, '2026-11-05-day')
    assert.deepEqual(github(report).all, { closed: 0, total: 1 }, 'closed after, and opened after, do not count')
    assert.deepEqual(github(report).merged.map((pull) => pull.number), [3])
    assert.equal(report.late, false)
    assert.deepEqual(daySections(report).map((section) => section.title), ['Résumé', 'Fait', 'En cours', 'Cap'])
  })

  it('does not say what was open on a day told long after', () => {
    const day = '2026-11-03'
    const end = parisTime(day, 24)
    const report = buildReport(input({ kind: 'day', day, slot: null, from: parisTime(day), to: end, at: end + 7 * HOUR, repository: repo({ history: history({ items: [merged(3, end - HOUR)], pulls: [open(9)], project: { at: iso(NOW), statuses: {} } }), waiting: [{ number: 12, title: 'x', who: 'victor', question: 'y' }] }) }))
    assert.equal(report.late, true)
    assert.equal(github(report).pulls, null)
    assert.equal(github(report).queue, null)
    assert.equal(github(report).statuses, null)
    assert.deepEqual(github(report).waiting, [])
    assert.ok(!said(report).includes('#12'))
    assert.ok(!daySections(report).some((section) => section.title === 'En cours'))
  })

  it('says how a milestone stands, by arithmetic', () => {
    const day = '2026-11-06'
    const tickets = (open: number, closed: number) => [...Array.from({ length: open }, (_, index) => ticket(index + 1, NOW - 50 * HOUR)), ...Array.from({ length: closed }, (_, index) => ticket(index + 500, NOW - 50 * HOUR, NOW - 2 * HOUR))]
    const state = (open: number, closed: number, due: string) => github(buildReport(input({ day, repository: repo({ history: history({ items: tickets(open, closed) }), milestones: [{ title: 'M0 · Foundation', closed: 0, total: 0, due }] }) }))).milestone?.state
    assert.equal(state(3, 30, '2026-11-07'), 'on-schedule')
    assert.equal(state(60, 30, '2026-11-06'), 'late')
    assert.equal(state(10, 0, '2026-11-07'), 'no-pace')
    assert.equal(state(0, 30, '2026-11-07'), undefined, 'a finished milestone is no longer the next one')
    const report = buildReport(input({ day, repository: repo({ history: history({ items: tickets(3, 30) }), milestones: [{ title: 'M0 · Foundation', closed: 0, total: 0, due: '2026-11-07' }] }) }))
    assert.match(said(report), /M0 · Foundation : 30 \/ 33, échéance le 7 nov\. Au rythme des 3 derniers jours, 10 par jour, il reste 0,3 jours : dans les temps\./)
  })

  it('never writes a title that looks like a secret into a shared history', () => {
    const report = buildReport(
      input({
        repository: repo({
          milestones: [{ title: 'password=hunter22', closed: 0, total: 0, due: null }],
          history: history({
            items: [merged(1, NOW - HOUR, 'vbarbanneau', 'password=hunter22'), ticket(2, NOW - HOUR, null, { milestone: 'password=hunter22', labels: ['area:password=hunter22'] }), merged(3, NOW - HOUR, 'someone-outside')],
            runs: [run(1, NOW - HOUR, 'failure', 'token=hunter22')],
            pulls: [open(9, { title: 'password=hunter22' })],
          }),
        }),
      }),
    )
    const written = JSON.stringify(report)
    assert.ok(!written.includes('hunter22'))
    assert.ok(!written.includes('someone-outside'), "an outsider's login stays out")
  })

  it('counts a run in the report during which it ended, once', () => {
    const started = NOW - HOUR
    const running = { ...run(1, started), state: 'running' as const, end: null }
    const here = buildReport(input({ repository: repo({ history: history({ items: [merged(1, NOW - HOUR)], runs: [running] }) }) }))
    assert.equal(github(here).ci.finished, 0)
    const later = buildReport(input({ at: NOW + 3 * HOUR, from: NOW, to: NOW + 3 * HOUR, repository: repo({ history: history({ items: [merged(1, NOW + HOUR)], runs: [{ ...run(1, started), end: iso(NOW + HOUR) }] }) }) }))
    assert.equal(github(later).ci.finished, 1)
  })

  it('gives no rate for a period whose runs are not all there', () => {
    const report = buildReport(input({ repository: repo({ history: history({ runsFrom: iso(NOW - HOUR), items: [merged(1, NOW - HOUR)], runs: [run(1, NOW - 30 * 60_000)] }) }) }))
    assert.equal(github(report).ci.rate, null)
    assert.match(said(report), /CI : 1 run terminé depuis 10:05, dont 0 en échec\. Des runs manquent, donc pas de taux\./)
  })

  it('reads properly for one run and for several', () => {
    const one = buildReport(input({ repository: repo({ history: history({ items: [merged(1, NOW - HOUR)], runs: [run(1, NOW - HOUR)] }) }) }))
    assert.match(said(one), /100 % de réussite sur 1 run depuis/)
    const two = buildReport(input({ repository: repo({ history: history({ items: [merged(1, NOW - HOUR)], runs: [run(1, NOW - HOUR), run(2, NOW - HOUR)] }) }) }))
    assert.match(said(two), /100 % de réussite sur 2 runs depuis/)
  })

  it('still counts the tickets of a milestone whose title is masked', () => {
    const title = 'password=hunter22'
    const report = buildReport(input({ repository: repo({ milestones: [{ title, closed: 0, total: 0, due: null }], history: history({ items: [ticket(1, NOW - 40 * HOUR, null, { milestone: title }), ticket(2, NOW - 40 * HOUR, NOW - 30 * HOUR, { milestone: title }), merged(3, NOW - HOUR)] }) }) }))
    assert.ok(!JSON.stringify(report).includes('hunter22'))
    assert.ok(!said(report).includes('tout est fermé'))
    assert.equal(github(report).milestone?.total, 2)
    assert.ok((github(report).burnup[1]?.points.length ?? 0) > 0, 'with its curve')
  })

  it('says when it starts from the day before', () => {
    const from = parisTime('2026-11-05', 22)
    const report = buildReport(input({ slot: 1, at: parisTime('2026-11-06', 1), to: parisTime('2026-11-06', 1), from, repository: repo({ history: history({ items: [merged(1, parisTime('2026-11-05', 23))] }) }) }))
    assert.equal(sinceWords(report), 'depuis hier 22:00')
    assert.match(said(report), /1 PR mergée depuis hier 22:00/)
    assert.equal(github(report).today.merged, 0)
  })

  it('says "since midnight" for a report that starts the day', () => {
    const report = buildReport(input({ slot: 7, from: parisTime('2026-11-06'), at: parisTime('2026-11-06', 7), to: parisTime('2026-11-06', 7) }))
    assert.equal(sinceWords(report), 'depuis minuit')
  })

  it('leaves out a pull request opened after the day it reports on', () => {
    const day = '2026-11-05'
    const end = parisTime(day, 24)
    const report = buildReport(input({ kind: 'day', day, slot: null, from: parisTime(day), to: end, at: end + 5 * 60_000, repository: repo({ history: history({ items: [merged(1, end - HOUR)], pulls: [open(2, { created: iso(end - HOUR) }), open(3, { created: iso(end + 60_000) })] }) }) }))
    assert.deepEqual(github(report).queue?.map((pull) => pull.number), [2])
  })
})

describe('what a report says of the board itself', () => {
  const POLL = '1700000000000-vbarbanneau-abcd'
  const OTHER = '1700000000001-vbarbanneau-abce'
  const opened = () =>
    thread('t-1', NOW - HOUR, {
      messages: [
        { author: 'vbarbanneau', createdAt: iso(NOW - HOUR) },
        { author: 'rodolphebarbanneau', createdAt: iso(NOW - 50 * 60_000), agent: 'draft' },
        { author: 'vbarbanneau', createdAt: iso(NOW - 40 * 60_000), agent: 'auto' },
        { author: 'rodolphebarbanneau', createdAt: iso(NOW - 30 * 60_000), synthesis: true },
      ],
    })
  const closed = () => thread('t-2', NOW - 30 * HOUR, { status: 'closed', messages: [{ author: 'vbarbanneau', createdAt: iso(NOW - 30 * HOUR) }, { author: 'vbarbanneau', createdAt: iso(NOW - 20 * 60_000), status: 'closed' }] })
  const old = () => thread('t-3', NOW - 40 * HOUR)
  const polls = () =>
    thread('t-4', NOW - 30 * HOUR, {
      polls: [
        { messageId: POLL, question: 'Lunch?', createdAt: iso(NOW - 2 * HOUR), closedAt: null, closesAt: null, voters: 0, leading: null },
        { messageId: OTHER, question: 'Release day?', createdAt: iso(NOW - 30 * HOUR), closedAt: iso(NOW - HOUR), closesAt: null, voters: 3, leading: 'Friday' },
      ],
    })

  it('tells of threads, messages and polls, with no repository at all', () => {
    const report = buildReport(input({ repository: null, threads: [opened(), closed(), old(), polls()] }))
    assert.equal(report.repository, null)
    assert.equal(report.quiet, false)
    assert.deepEqual(report.board.threadsOpened, [{ id: 't-1', title: 'Thread t-1', who: 'Victor' }])
    assert.deepEqual(report.board.threadsClosed, [{ id: 't-2', title: 'Thread t-2' }])
    assert.deepEqual(report.board.messages, { members: 2, drafts: 1, agents: 1 })
    assert.deepEqual(report.board.byMember, [{ who: 'Rodolphe', messages: 2 }, { who: 'Victor', messages: 1 }], 'what an agent wrote by itself is nobody\'s message')
    assert.deepEqual(report.board.pollsOpened, [{ threadId: 't-4', messageId: POLL, question: 'Lunch?' }])
    assert.deepEqual(report.board.pollsClosed, [{ threadId: 't-4', messageId: OTHER, question: 'Release day?', leading: 'Friday', voters: 3 }])
    assert.equal(report.board.syntheses, 1)
    const text = said(report)
    assert.match(text, /^1 fil ouvert depuis 10:05 : Thread t-1\.$/m)
    assert.match(text, /^1 fil clos depuis 10:05 : Thread t-2\.$/m)
    assert.match(text, /^4 messages depuis 10:05, dont 1 des agents seuls : Rodolphe \(2\), Victor \(1\)\.$/m)
    assert.match(text, /^1 sondage ouvert depuis 10:05 : Lunch\?\.$/m)
    assert.match(text, /^Sondage clos : « Release day\? », Friday en tête, 3 votants\.$/m)
    assert.match(text, /^1 synthèse écrite\.$/m)
    assert.deepEqual(daySections({ ...report, kind: 'day' }).map((section) => section.title), ['Résumé'])
  })

  it('is quiet when nothing was said and no repository is followed', () => {
    const report = buildReport(input({ repository: null, threads: [old()] }))
    assert.equal(report.quiet, true)
    assert.equal(said(report), 'Rien de neuf depuis 10:05.')
  })

  it('counts a poll as closed when its date passed, and not before', () => {
    const dated = (closesAt: number) => thread('t-5', NOW - 30 * HOUR, { polls: [{ messageId: POLL, question: 'When?', createdAt: iso(NOW - 30 * HOUR), closedAt: null, closesAt: iso(closesAt), voters: 2, leading: null }] })
    assert.equal(buildReport(input({ repository: null, threads: [dated(NOW - HOUR)] })).board.pollsClosed.length, 1)
    assert.equal(buildReport(input({ repository: null, threads: [dated(NOW + HOUR)] })).board.pollsClosed.length, 0)
    assert.match(said(buildReport(input({ repository: null, threads: [dated(NOW - HOUR)] }))), /Sondage clos sans vote : « When\? »\./)
  })

  it('names only members, and masks a title that looks like a secret', () => {
    const outside = thread('t-6', NOW - HOUR, { title: 'password=hunter22', createdBy: 'someone-outside', messages: [{ author: 'someone-outside', createdAt: iso(NOW - HOUR) }] })
    const report = buildReport(input({ repository: null, threads: [outside] }))
    assert.deepEqual(report.board.threadsOpened, [{ id: 't-6', title: '(masqué)', who: '' }])
    assert.deepEqual(report.board.messages, { members: 1, drafts: 0, agents: 0 })
    assert.deepEqual(report.board.byMember, [])
    const written = JSON.stringify(report)
    assert.ok(!written.includes('hunter22'))
    assert.ok(!written.includes('someone-outside'))
  })

  it('tells of both the board and the repository in one report', () => {
    const report = buildReport(input({ threads: [opened()], repository: repo({ history: history({ items: [merged(1, NOW - HOUR)] }) }) }))
    const text = said(report)
    assert.match(text, /1 fil ouvert depuis 10:05/)
    assert.match(text, /1 PR mergée depuis 10:05 : #1 \(Victor\)\./)
    assert.equal(report.quiet, false)
    assert.ok(searchText(report).includes('Thread t-1'))
    assert.ok(searchText(report).includes('#1 PR 1'))
  })
})

describe('reading a report', () => {
  const good = () => buildReport(input({ threads: [thread('t-1', NOW - HOUR)], repository: repo({ history: history({ items: [merged(1, NOW - HOUR)], runs: [run(1, NOW - HOUR)] }) }) }))

  it('reads what it wrote', () => {
    const report = good()
    assert.deepEqual(parseReport(JSON.stringify(report), report.id), report)
    const bare = buildReport(input({ repository: null }))
    assert.deepEqual(parseReport(JSON.stringify(bare), bare.id), bare)
  })

  it('refuses another shape, a newer version, or a file under the wrong name', () => {
    for (const raw of ['', '{half', 'null', '[]', '{}', JSON.stringify({ ...good(), v: 3 }), JSON.stringify({ ...good(), kind: 'x' }), JSON.stringify({ ...good(), kind: 'day' }), JSON.stringify({ ...good(), at: 'never' }), JSON.stringify({ ...good(), at: 5 }), JSON.stringify({ ...good(), from: [] })]) assert.equal(parseReport(raw, '2026-11-06-1300'), null, raw)
    assert.equal(parseReport(JSON.stringify(good()), '2026-11-06-1600'), null)
  })

  it('keeps only numbers and short text from a file it does not trust', () => {
    const raw = good() as any
    raw.repository.today.merged = 'x'
    raw.repository.ci.rate = { evil: 1 }
    raw.repository.merged = [{ number: 1, title: 'y'.repeat(5000), who: 7 }, 'nope', null]
    raw.repository.milestone = { title: 'M', closed: 1, total: 2, due: null, daysLeft: null, pace: 0, state: 'evil' }
    raw.repository.queue = [{ number: 1, title: 'x', who: 'y', hours: 1, ci: 'success', review: '__proto__' }]
    raw.board.threadsOpened = [{ id: '../x', title: 'bad' }, { id: 'ok-1', title: 'fine', who: 'v' }, 7]
    raw.board.pollsClosed = [{ threadId: 'ok-1', messageId: 'nope', question: 'q' }]
    raw.board.messages = { members: -1, drafts: 'x' }
    raw.extra = 'dropped'
    raw.by = '__proto__'
    const found = parseReport(JSON.stringify(raw), raw.id) as any
    assert.equal(found.repository.today.merged, 0)
    assert.equal(found.repository.ci.rate, null)
    assert.equal(found.repository.merged.length, 1)
    assert.ok(found.repository.merged[0].title.length <= 320)
    assert.equal(found.repository.merged[0].who, '')
    assert.equal(found.repository.milestone.state, 'no-due')
    assert.equal(found.repository.queue[0].review, 'none')
    assert.deepEqual(found.board.threadsOpened, [{ id: 'ok-1', title: 'fine', who: 'v' }])
    assert.deepEqual(found.board.pollsClosed, [])
    assert.deepEqual(found.board.messages, { members: -1, drafts: 0, agents: 0 })
    assert.equal(found.extra, undefined)
    assert.equal(found.by, '')
  })

  it('still reads a report written by an earlier version, sentences and all', () => {
    const legacy = {
      v: 1,
      id: '2026-11-06-1300',
      kind: 'update',
      day: '2026-11-06',
      slot: 13,
      at: iso(NOW),
      from: iso(NOW - 3 * HOUR),
      to: iso(NOW),
      sinceWord: 'depuis 10:05',
      quiet: false,
      late: false,
      sections: [{ title: 'Résumé', lines: ['**1 PR mergée depuis 10:05** : #1 (Victor).'] }],
      figures: { today: { merged: 1, closed: 0, opened: 0 }, since: { merged: 1, closed: 0, opened: 0 }, all: { closed: 0, total: 0 }, milestone: null, ci: { rate: null, finished: 0, failure: 0, other: 0, medianMinutes: null }, pulls: null },
      merged: [{ number: 1, title: 'PR 1', who: 'Victor' }],
      burnup: [],
      activity: [],
      milestones: [],
      board: null,
      ships: [],
      areas: [],
      queue: null,
      ci: [],
      failing: [],
    }
    const found = parseReport(JSON.stringify(legacy), legacy.id)
    assert.equal(found?.v, 1)
    assert.deepEqual(found?.v === 1 ? found.sections : null, legacy.sections)
    assert.equal(found && searchText(found), '**1 PR mergée depuis 10:05** : #1 (Victor).')
  })
})

describe('writing reports with nobody asking', () => {
  function world(more: Partial<History> = {}, clock = NOW) {
    const root = folder()
    const knowledgeRoot = folder()
    mkdirSync(join(root, 'reports'))
    mkdirSync(join(knowledgeRoot, 'github'), { recursive: true })
    writeFileSync(join(knowledgeRoot, 'github', 'milestones.json'), '[]')
    const claims: string[] = []
    const state = { history: history({ items: [merged(1, NOW - HOUR), ticket(2, NOW - 30 * HOUR)], ...more }) as History | null, time: clock, server: clock as number | null, threads: [] as ThreadActivity[], repo: 'acme/app' as string | null }
    const writer = new ReportWriter({
      root,
      knowledgeRoot,
      person: 'victor',
      threads: async () => state.threads,
      repository: () => state.repo,
      history: async () => state.history,
      clock: () => state.time,
      serverTime: async () => state.server,
      claim: async (path, text) => {
        claims.push(path)
        const file = join(root, path)
        if (!existsSync(file)) writeFileSync(file, text)
        return readFileSync(file, 'utf8')
      },
    })
    return { root, knowledgeRoot, writer, claims, state }
  }
  const latest = async (writer: ReportWriter, id: string) => {
    const found = await writer.read(id)
    assert.ok(found && found.v === 2, `${id} is a report of this version`)
    return found
  }

  it('writes the slot that is due, once', async () => {
    const { writer, claims } = world()
    assert.ok((await writer.pass()).includes('2026-11-06-1300'))
    assert.ok(claims.includes('reports/2026-11-06-1300.json'))
    claims.length = 0
    assert.deepEqual(await writer.pass(), [])
    assert.deepEqual(claims, [])
    assert.equal((await writer.read('2026-11-06-1300'))?.by, 'victor')
  })

  it('writes nothing from a ledger that is old or missing, and spends nothing to find out', async () => {
    const { writer, claims, state } = world({ at: iso(NOW - 20 * 60_000) })
    assert.deepEqual(await writer.pass(), [])
    state.history = null
    assert.deepEqual(await writer.pass(), [])
    assert.deepEqual(claims, [])
    assert.equal(writer.lastError, null)
  })

  it('writes from the threads alone for a board that follows no repository', async () => {
    const { writer, state } = world()
    state.repo = null
    state.history = null
    state.threads = [thread('t-1', parisTime('2026-11-04', 10)), thread('t-2', NOW - HOUR)]
    const written = await writer.pass()
    assert.ok(written.includes('2026-11-06-1300'))
    assert.ok(written.includes('2026-11-04-day'), 'a day with a thread has its report')
    assert.ok(!written.includes('2026-11-05-day'), 'a day with nothing has none')
    const report = await latest(writer, '2026-11-06-1300')
    assert.equal(report.repository, null)
    assert.equal(report.board.messages.members, 1)
    assert.equal((await latest(writer, '2026-11-04-day')).board.threadsOpened[0]?.id, 't-1')
  })

  it('starts from the last report, and leaves the gap of a computer that was off to the next one', async () => {
    const { writer, state } = world()
    await writer.pass()
    const first = await writer.read('2026-11-06-1300')
    state.time = parisTime('2026-11-06', 19) + 60_000
    state.server = state.time
    state.history = history({ at: iso(state.time - 60_000), itemsAt: iso(state.time - 2 * 60_000), items: [merged(1, NOW - HOUR), merged(5, state.time - HOUR)] })
    const written = await writer.pass()
    assert.deepEqual(written.filter((id) => !id.endsWith('day')), ['2026-11-06-1900'], 'not 16:00')
    const second = await latest(writer, '2026-11-06-1900')
    assert.equal(second.from, first?.to)
    assert.equal(first?.to, iso(NOW - 60_000), 'up to where the ledger had read, so that what follows is in the next one')
    assert.deepEqual(github(second).merged.map((pull) => pull.number), [5])
  })

  it('never tells again what the last report told, when the ledger here is behind it', async () => {
    const { writer, state, root } = world()
    await writer.pass()
    const first = await writer.read('2026-11-06-1300')
    state.time = parisTime('2026-11-06', 16) + 60_000
    state.server = state.time
    state.history = history({ at: iso(state.time - 60_000), itemsAt: iso(Date.parse(first?.to ?? '') - 60_000), items: [merged(1, NOW - HOUR)] })
    assert.deepEqual(await writer.pass(), [])
    assert.ok(!existsSync(join(root, 'reports', '2026-11-06-1600.json')))
    state.history = history({ at: iso(state.time - 60_000), itemsAt: iso(state.time - 60_000), items: [merged(1, NOW - HOUR), merged(5, state.time - 2 * 60_000)] })
    assert.deepEqual(await writer.pass(), ['2026-11-06-1600'])
    assert.deepEqual(github(await latest(writer, '2026-11-06-1600')).merged.map((pull) => pull.number), [5])
  })

  it('reads what the other app wrote, not what it tried to write, when it lost', async () => {
    const { writer, root, state } = world()
    const claim = (writer as unknown as { options: { claim: (path: string, text: string) => Promise<string> } }).options
    const real = claim.claim
    claim.claim = async (path, text) => {
      // The list reads this app's file during the claim, and the other app's replaces it.
      writeFileSync(join(root, path), text)
      await writer.list()
      const theirs = JSON.stringify({ ...JSON.parse(text), by: 'rodolphe' })
      writeFileSync(join(root, path), theirs)
      return theirs
    }
    await writer.pass()
    claim.claim = real
    state.time = NOW
    assert.equal((await writer.list()).find((one) => one.id === '2026-11-06-1300')?.by, 'rodolphe')
  })

  it('writes nothing under a clock that is wrong, or that it cannot check, and says so', async () => {
    const { writer, claims, state } = world()
    state.server = NOW + 3 * HOUR
    assert.deepEqual(await writer.pass(), [])
    assert.match(writer.lastError ?? '', /horloge/)
    state.server = null
    assert.deepEqual(await writer.pass(), [])
    assert.match(writer.lastError ?? '', /heure de GitHub/)
    assert.deepEqual(claims, [])
    state.server = NOW + 60_000
    assert.ok((await writer.pass()).length > 0)
    assert.equal(writer.lastError, null)
  })

  it('does not ask for the time when nothing is due', async () => {
    const { writer, state } = world()
    await writer.pass()
    state.server = null
    assert.deepEqual(await writer.pass(), [])
    assert.equal(writer.lastError, null)
  })

  it('waits for a ledger read after the end of a day before telling that day', async () => {
    const start = parisTime('2026-11-06')
    const { writer, state } = world({ itemsAt: iso(start - 9 * 60_000), at: iso(start - 8 * 60_000), items: [merged(1, start - HOUR)] }, start + 5 * 60_000)
    assert.deepEqual(await writer.pass(), [])
    state.history = history({ itemsAt: iso(start + 60_000), at: iso(start + 2 * 60_000), items: [merged(1, start - HOUR)] })
    assert.deepEqual(await writer.pass(), ['2026-11-05-day'])
  })

  it('writes nothing before the copy has its milestones, rather than "no milestone" for good', async () => {
    const { writer, knowledgeRoot, claims } = world()
    rmSync(join(knowledgeRoot, 'github', 'milestones.json'))
    assert.deepEqual(await writer.pass(), [])
    assert.deepEqual(claims, [])
  })

  it('reports on the days that ended, oldest first, a few at a time, and skips a day with nothing or already told', async () => {
    const day = (back: number) => parisTime(dayBefore('2026-11-06', back), 12)
    const { writer, root, state } = world({ items: [merged(1, day(1)), merged(2, day(2)), merged(3, day(3)), merged(4, day(5)), merged(6, NOW - HOUR)] })
    writeFileSync(join(root, 'reports', '2026-11-01-day.json'), '{}')
    assert.deepEqual((await writer.pass()).filter((id) => id.endsWith('day')), ['2026-11-03-day', '2026-11-04-day'])
    state.time += 5 * 60_000
    state.server = state.time
    assert.deepEqual((await writer.pass()).filter((id) => id.endsWith('day')), ['2026-11-05-day'])
    assert.deepEqual((await writer.pass()).filter((id) => id.endsWith('day')), [])
    assert.ok(!existsSync(join(root, 'reports', '2026-11-02-day.json')), 'a day with nothing has no report')
  })

  it('says why it could not write, and tries again', async () => {
    const { root, knowledgeRoot, state } = world()
    let failing = true
    const writer = new ReportWriter({
      root,
      knowledgeRoot,
      person: 'victor',
      threads: async () => [],
      repository: () => 'acme/app',
      history: async () => state.history,
      clock: () => state.time,
      serverTime: async () => state.time,
      claim: async (path, text) => {
        if (failing) throw new Error('no network')
        writeFileSync(join(root, path), text)
        return text
      },
    })
    assert.deepEqual(await writer.pass(), [])
    assert.equal(writer.lastError, 'no network')
    failing = false
    assert.ok((await writer.pass()).length > 0)
    assert.equal(writer.lastError, null)
  })

  it('keeps a file from a newer version where it is, and writes nothing over it', async () => {
    const { root, writer, claims } = world()
    writeFileSync(join(root, 'reports', '2026-11-06-1300.json'), JSON.stringify({ v: 3, id: '2026-11-06-1300' }))
    await writer.pass()
    assert.ok(!claims.includes('reports/2026-11-06-1300.json'))
    assert.deepEqual((await writer.list()).map((one) => one.id).filter((id) => id === '2026-11-06-1300'), [])
  })

  it('lets one of two apps write a report through Git, and the other one reads it', async () => {
    const remote = folder()
    execFileSync('git', ['init', '--quiet', '--bare', remote])
    const clone = () => {
      const dir = folder()
      execFileSync('git', ['clone', '--quiet', remote, dir], { stdio: 'pipe' })
      execFileSync('git', ['-C', dir, 'config', 'user.email', 'test@example.invalid'])
      execFileSync('git', ['-C', dir, 'config', 'user.name', 'Test'])
      return dir
    }
    const first = clone()
    writeFileSync(join(first, 'README.md'), 'x')
    execFileSync('git', ['-C', first, 'add', '.'])
    execFileSync('git', ['-C', first, 'commit', '--quiet', '-m', 'start'])
    execFileSync('git', ['-C', first, 'push', '--quiet', 'origin', 'HEAD'])
    const second = clone()
    const app = (root: string, person: 'victor' | 'rodolphe') => {
      const git = new BoardGit(root)
      const knowledgeRoot = folder()
      mkdirSync(join(knowledgeRoot, 'github'), { recursive: true })
      writeFileSync(join(knowledgeRoot, 'github', 'milestones.json'), '[]')
      return new ReportWriter({ root, knowledgeRoot, person, threads: async () => [], repository: () => 'acme/app', history: async () => history({ items: [merged(1, NOW - HOUR)] }), clock: () => NOW, serverTime: async () => NOW, claim: (path, text, subject) => git.claim(path, text, subject) })
    }
    const [one, two] = [app(first, 'victor'), app(second, 'rodolphe')]
    await Promise.all([one.pass(), two.pass()])
    assert.equal(one.lastError, null)
    assert.equal(two.lastError, null)
    const files = (root: string) => readdirSync(join(root, 'reports')).sort()
    assert.deepEqual(files(first), files(second))
    assert.equal(readFileSync(join(first, 'reports', '2026-11-06-1300.json'), 'utf8'), readFileSync(join(second, 'reports', '2026-11-06-1300.json'), 'utf8'), 'one wrote it, whichever')
    assert.equal(execFileSync('git', ['-C', first, 'log', '-1', '--format=%s', '--', 'reports/2026-11-06-1300.json'], { encoding: 'utf8' }).trim(), 'board: report 2026-11-06-1300')
  })
})

describe('a report that went wrong half way', () => {
  function pair() {
    const remote = folder()
    execFileSync('git', ['init', '--quiet', '--bare', remote])
    const clone = () => {
      const dir = folder()
      execFileSync('git', ['clone', '--quiet', remote, dir], { stdio: 'pipe' })
      execFileSync('git', ['-C', dir, 'config', 'user.email', 'test@example.invalid'])
      execFileSync('git', ['-C', dir, 'config', 'user.name', 'Test'])
      return dir
    }
    const mine = clone()
    writeFileSync(join(mine, 'README.md'), 'x')
    mkdirSync(join(mine, 'threads'))
    execFileSync('git', ['-C', mine, 'add', '.'])
    execFileSync('git', ['-C', mine, 'commit', '--quiet', '-m', 'start'])
    execFileSync('git', ['-C', mine, 'push', '--quiet', 'origin', 'HEAD'])
    return { mine, other: clone() }
  }
  const PATH = 'reports/2026-11-06-1300.json'
  const headOf = (dir: string) => execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()

  it('recovers from a commit that never got pushed, once the other app has written the same report', async () => {
    const { mine, other } = pair()
    mkdirSync(join(mine, 'reports'))
    writeFileSync(join(mine, PATH), 'mine')
    execFileSync('git', ['-C', mine, 'add', '.'])
    execFileSync('git', ['-C', mine, 'commit', '--quiet', '-m', 'board: report'])
    assert.equal(await new BoardGit(other).claim(PATH, 'theirs'), 'theirs')
    const git = new BoardGit(mine)
    await git.pull()
    assert.equal(git.lastError, null, 'messages keep flowing')
    assert.equal(readFileSync(join(mine, PATH), 'utf8'), 'theirs')
    assert.equal(headOf(mine), execFileSync('git', ['-C', mine, 'rev-parse', '@{u}'], { encoding: 'utf8' }).trim(), 'nothing left to push')
  })

  it('recovers from a file left on disk', async () => {
    const { mine, other } = pair()
    mkdirSync(join(mine, 'reports'))
    writeFileSync(join(mine, PATH), 'mine')
    assert.equal(await new BoardGit(other).claim(PATH, 'theirs'), 'theirs')
    const git = new BoardGit(mine)
    await git.pull()
    assert.equal(git.lastError, null)
    assert.equal(readFileSync(join(mine, PATH), 'utf8'), 'theirs')
  })

  it('recovers from a file left staged', async () => {
    const { mine, other } = pair()
    mkdirSync(join(mine, 'reports'))
    writeFileSync(join(mine, PATH), 'mine')
    execFileSync('git', ['-C', mine, 'add', '--', PATH])
    assert.equal(await new BoardGit(other).claim(PATH, 'theirs'), 'theirs')
    const git = new BoardGit(mine)
    await git.pull()
    assert.equal(git.lastError, null)
    assert.equal(readFileSync(join(mine, PATH), 'utf8'), 'theirs')
  })

  it('gives way on the report alone, and keeps a real conflict in a later commit', async () => {
    const { mine, other } = pair()
    mkdirSync(join(mine, 'reports'))
    writeFileSync(join(mine, PATH), 'mine')
    execFileSync('git', ['-C', mine, 'add', '.'])
    execFileSync('git', ['-C', mine, 'commit', '--quiet', '-m', 'board: report'])
    writeFileSync(join(mine, 'README.md'), 'mine')
    execFileSync('git', ['-C', mine, 'commit', '--quiet', '-am', 'mine'])
    mkdirSync(join(other, 'reports'))
    writeFileSync(join(other, PATH), 'theirs')
    writeFileSync(join(other, 'README.md'), 'theirs')
    execFileSync('git', ['-C', other, 'add', '.'])
    execFileSync('git', ['-C', other, 'commit', '--quiet', '-m', 'theirs'])
    execFileSync('git', ['-C', other, 'push', '--quiet'])
    const git = new BoardGit(mine)
    await git.pull()
    assert.match(git.lastError ?? '', /conflict/i)
    assert.equal(readFileSync(join(mine, 'README.md'), 'utf8'), 'mine', 'nothing is lost')
    assert.equal(execFileSync('git', ['-C', mine, 'status', '--porcelain', '--branch'], { encoding: 'utf8' }).includes('rebase'), false)
  })

  it('keeps a message committed here, and pushes it, when the report beside it gives way', async () => {
    const { mine, other } = pair()
    mkdirSync(join(mine, 'reports'))
    writeFileSync(join(mine, PATH), 'mine')
    execFileSync('git', ['-C', mine, 'add', '.'])
    execFileSync('git', ['-C', mine, 'commit', '--quiet', '-m', 'board: report'])
    writeFileSync(join(mine, 'threads', 'message.md'), 'hello')
    execFileSync('git', ['-C', mine, 'add', '.'])
    execFileSync('git', ['-C', mine, 'commit', '--quiet', '-m', 'message'])
    assert.equal(await new BoardGit(other).claim(PATH, 'theirs'), 'theirs')
    const git = new BoardGit(mine)
    await git.pull()
    assert.equal(git.lastError, null)
    assert.equal(readFileSync(join(mine, PATH), 'utf8'), 'theirs')
    assert.equal(readFileSync(join(mine, 'threads', 'message.md'), 'utf8'), 'hello')
    await new BoardGit(other).pull()
    assert.equal(readFileSync(join(other, 'threads', 'message.md'), 'utf8'), 'hello')
  })

  it("never takes back someone else's commit when it loses the race and then cannot pull", async () => {
    const { mine, other } = pair()
    const hooks = join(mine, '.git', 'hooks')
    writeFileSync(join(mine, 'base.md'), 'x')
    execFileSync('git', ['-C', mine, 'add', '.'])
    execFileSync('git', ['-C', mine, 'commit', '--quiet', '-m', 'someone else'])
    execFileSync('git', ['-C', mine, 'push', '--quiet'])
    execFileSync('git', ['-C', other, 'pull', '--quiet'])
    mkdirSync(join(other, 'reports'))
    writeFileSync(join(other, PATH), 'theirs')
    writeFileSync(join(other, 'blocked.md'), 'theirs')
    execFileSync('git', ['-C', other, 'add', '.'])
    execFileSync('git', ['-C', other, 'commit', '--quiet', '-m', 'theirs'])
    const before = headOf(mine)
    // Once this app has committed, the other one pushes first, and a file here then stops this one from pulling.
    writeFileSync(join(mine, 'blocked.md'), 'mine')
    const script = ['#!/bin/sh', 'unset GIT_DIR GIT_INDEX_FILE GIT_WORK_TREE', `git -C "${other}" push --quiet origin HEAD`, ''].join('\n')
    writeFileSync(join(hooks, 'post-commit'), script, { mode: 0o755 })
    const git = new BoardGit(mine)
    await assert.rejects(git.claim(PATH, 'mine'))
    assert.equal(headOf(mine), before, 'the commit under ours is still there')
    assert.ok(!existsSync(join(mine, PATH)), 'and ours is gone')
    rmSync(join(hooks, 'post-commit'))
    rmSync(join(mine, 'blocked.md'))
    await git.pull()
    assert.equal(git.lastError, null, 'the next pull works')
    assert.equal(readFileSync(join(mine, PATH), 'utf8'), 'theirs')
  })

  it('answers with what the other app wrote when its report arrives during the retries', async () => {
    const { mine, other } = pair()
    const hooks = join(mine, '.git', 'hooks')
    const tried = join(mine, '.git', 'tried')
    // Every push from this app fails, so it keeps retrying, and the other app's report lands somewhere among the retries.
    writeFileSync(join(hooks, 'pre-push'), `#!/bin/sh\ntouch "${tried}"\nexit 1\n`, { mode: 0o755 })
    const answer = new BoardGit(mine).claim(PATH, 'mine')
    while (!existsSync(tried)) await new Promise((done) => setTimeout(done, 20))
    assert.equal(await new BoardGit(other).claim(PATH, 'theirs'), 'theirs')
    assert.equal(await answer, 'theirs')
    assert.equal(readFileSync(join(mine, PATH), 'utf8'), 'theirs')
    assert.equal(execFileSync('git', ['-C', mine, 'rev-list', '--count', '@{u}..HEAD'], { encoding: 'utf8' }).trim(), '0', 'nothing left to push')
  })

  it('leaves anything but a report alone', async () => {
    const { mine } = pair()
    mkdirSync(join(mine, 'reports', 'sub'), { recursive: true })
    const others = ['notes.json', 'sub/deep.json', 'sub/2026-11-06-1300.json', '2026-11-05-1300.html', '2026-11-06-coordinator-notes.json']
    for (const name of others) writeFileSync(join(mine, 'reports', name), 'x')
    writeFileSync(join(mine, 'reports', '2026-11-06-1300.json'), 'stray')
    await new BoardGit(mine).pull()
    for (const name of others) assert.ok(existsSync(join(mine, 'reports', name)), name)
    assert.ok(!existsSync(join(mine, 'reports', '2026-11-06-1300.json')))
  })

  it('loses no message posted while a rebase was left open by a process that died', async () => {
    const { mine, other } = pair()
    writeFileSync(join(mine, 'README.md'), 'mine')
    execFileSync('git', ['-C', mine, 'commit', '--quiet', '-am', 'mine'])
    writeFileSync(join(other, 'README.md'), 'theirs')
    execFileSync('git', ['-C', other, 'commit', '--quiet', '-am', 'theirs'])
    execFileSync('git', ['-C', other, 'push', '--quiet'])
    assert.throws(() => execFileSync('git', ['-C', mine, 'pull', '--rebase', '--quiet'], { stdio: 'pipe' }))
    assert.ok(existsSync(join(mine, '.git', 'rebase-merge')) || existsSync(join(mine, '.git', 'rebase-apply')))
    const git = new BoardGit(mine)
    writeFileSync(join(mine, 'threads', 'message.md'), 'hello')
    await git.publish(['threads/message.md'], 'message').catch(() => undefined)
    assert.equal(execFileSync('git', ['-C', mine, 'symbolic-ref', '--short', 'HEAD'], { encoding: 'utf8' }).trim().length > 0, true, 'on a branch')
    assert.equal(execFileSync('git', ['-C', mine, 'log', '-1', '--format=%s', '--', 'threads/message.md'], { encoding: 'utf8' }).trim(), 'message', 'and the message is in it')
    assert.equal(readFileSync(join(mine, 'threads', 'message.md'), 'utf8'), 'hello')
  })

  it('stops and says so when it cannot skip a report, rather than trying for ever', async () => {
    const { mine, other } = pair()
    mkdirSync(join(mine, 'reports'))
    writeFileSync(join(mine, PATH), 'mine')
    execFileSync('git', ['-C', mine, 'add', '.'])
    execFileSync('git', ['-C', mine, 'commit', '--quiet', '-m', 'board: report'])
    assert.equal(await new BoardGit(other).claim(PATH, 'theirs'), 'theirs')
    const lock = join(mine, '.git', 'index.lock')
    // Another git, stuck: its lock appears just as the rebase stops on the report.
    const watching = setInterval(() => {
      if (existsSync(join(mine, '.git', 'REBASE_HEAD')) && !existsSync(lock)) writeFileSync(lock, '')
    }, 2)
    const git = new BoardGit(mine)
    await git.pull()
    clearInterval(watching)
    assert.match(git.lastError ?? '', /conflict|index\.lock/i)
    rmSync(lock, { force: true })
    await git.pull()
    assert.equal(git.lastError, null, 'and it recovers once the lock is gone')
    assert.equal(readFileSync(join(mine, PATH), 'utf8'), 'theirs')
  })

  it('never writes again a report that is committed and missing from the disk', async () => {
    const { mine, other } = pair()
    const git = new BoardGit(mine)
    assert.equal(await git.claim(PATH, 'first'), 'first')
    rmSync(join(mine, PATH))
    assert.equal(await git.claim(PATH, 'second'), 'first')
    assert.equal(readFileSync(join(mine, PATH), 'utf8'), 'first')
    await new BoardGit(other).pull()
    assert.equal(readFileSync(join(other, PATH), 'utf8'), 'first')
  })

  it('takes a failed commit back, and writes the file on the next try', async () => {
    const { mine } = pair()
    const hook = join(mine, '.git', 'hooks', 'pre-commit')
    writeFileSync(hook, '#!/bin/sh\nexit 1\n', { mode: 0o755 })
    const git = new BoardGit(mine)
    await assert.rejects(git.claim(PATH, 'one'))
    assert.ok(!existsSync(join(mine, PATH)))
    rmSync(hook)
    assert.equal(await git.claim(PATH, 'two'), 'two')
  })

  it('still reports a real conflict, and touches nothing else', async () => {
    const { mine, other } = pair()
    writeFileSync(join(mine, 'README.md'), 'mine')
    execFileSync('git', ['-C', mine, 'commit', '--quiet', '-am', 'mine'])
    writeFileSync(join(other, 'README.md'), 'theirs')
    execFileSync('git', ['-C', other, 'commit', '--quiet', '-am', 'theirs'])
    execFileSync('git', ['-C', other, 'push', '--quiet'])
    const git = new BoardGit(mine)
    await git.pull()
    assert.match(git.lastError ?? '', /conflict/i)
    assert.equal(readFileSync(join(mine, 'README.md'), 'utf8'), 'mine')
  })

  it('leaves the older reports written by hand alone', async () => {
    const { mine } = pair()
    mkdirSync(join(mine, 'reports'))
    writeFileSync(join(mine, 'reports', '2026-11-05-1300.html'), 'page')
    await new BoardGit(mine).pull()
    assert.ok(existsSync(join(mine, 'reports', '2026-11-05-1300.html')))
  })
})

describe('the list of reports', () => {
  const generated = [
    { id: '2026-11-06-1300', kind: 'update' as const, day: '2026-11-06', slot: 13 },
    { id: '2026-11-06-1000', kind: 'update' as const, day: '2026-11-06', slot: 10 },
    { id: '2026-11-05-1900', kind: 'update' as const, day: '2026-11-05', slot: 19 },
    { id: '2026-11-05-day', kind: 'day' as const, day: '2026-11-05', slot: null },
    { id: '2026-11-04-1900', kind: 'update' as const, day: '2026-11-04', slot: 19 },
  ]

  it('shows today by updates, and a day that ended by its report, with its updates folded', () => {
    const days = mergeReportDays(generated, NOW)
    assert.deepEqual(days.map((day) => day.day), ['2026-11-06', '2026-11-05', '2026-11-04'])
    assert.deepEqual(days[0].reports.map((one) => one.name), ['Point de 13:00', 'Point de 10:00'])
    assert.equal(days[0].folded, undefined)
    assert.deepEqual(days[1].reports.map((one) => one.path), ['auto/2026-11-05-day'])
    assert.deepEqual(days[1].folded?.map((one) => one.name), ['Point de 19:00'])
    assert.deepEqual(days[2].reports.map((one) => one.name), ['Point de 19:00'], 'its updates, until a report exists')
  })

  it('opens the latest report first, and none when there is none', () => {
    assert.equal(latestGenerated(mergeReportDays(generated, parisTime('2026-11-07', 0))), 'auto/2026-11-06-1300')
    assert.equal(latestGenerated(mergeReportDays([], NOW)), null)
  })

  it('ignores a report dated in the future, from a clock that was wrong', () => {
    const days = mergeReportDays([{ id: '2099-01-01-day', kind: 'day', day: '2099-01-01', slot: null }, ...generated], NOW)
    assert.equal(days[0].day, '2026-11-06')
  })
})

describe('the charts of old reports', () => {
  it('reads a chart, with the colours its caption names', () => {
    const chart = parseMermaid('---\nconfig:\n  themeVariables:\n    xyChart:\n      plotColorPalette: "#8957e5, #3fb950"\n---\nxychart-beta\n  title "Burn-up"\n  x-axis ["3/11", "20h"]\n  y-axis "Issues" 0 --> 361\n  line [0, 105]\n  line [0, 2]\n')
    assert.deepEqual(chart, { kind: 'chart', title: 'Burn-up', labels: ['3/11', '20h'], series: [{ type: 'line', color: '#8957e5', values: [0, 105] }, { type: 'line', color: '#3fb950', values: [0, 2] }] })
  })

  it('reads a flow of statuses', () => {
    const flow = parseMermaid('flowchart LR\n  s0["To triage<br/><b>0</b>"]\n  s1["Backlog<br/><b>110</b>"]\n  s0 -- triaged, dependencies open --> s1\n')
    assert.deepEqual(flow, { kind: 'flow', nodes: [{ id: 's0', name: 'To triage', count: '0' }, { id: 's1', name: 'Backlog', count: '110' }], edges: [{ from: 's0', to: 's1', label: 'triaged, dependencies open' }] })
  })

  it('leaves as code what it does not understand, or a chart that does not add up', () => {
    assert.equal(parseMermaid('sequenceDiagram\n  A->>B: hello'), null)
    assert.equal(parseMermaid('xychart-beta\n  x-axis ["a", "b"]\n  line [1]\n'), null)
    assert.equal(parseMermaid('xychart-beta\n  x-axis ["a"]\n  line [x]\n'), null)
    assert.equal((parseMermaid('xychart-beta\n  x-axis ["a"]\n  bar [1]\n') as { series: { color: string }[] }).series[0].color, '#8957e5')
  })

  it('stays quick and stays code on what anyone could post in a thread', () => {
    const started = Date.now()
    assert.equal(parseMermaid('xychart-beta\n' + '\n'.repeat(200_000)), null)
    assert.equal(parseMermaid(`xychart-beta\n  x-axis [${'"a",'.repeat(300)}"b"]\n  line [${'1,'.repeat(300)}1]\n`), null)
    assert.equal(parseMermaid(`flowchart LR\n  a -- ${' '.repeat(3000)} --> b\n`), null)
    assert.equal(parseMermaid(`flowchart LR\n${'  a["x"]\n'.repeat(40)}`), null)
    assert.ok(Date.now() - started < 500)
  })
})

describe('a report for someone who reads English', () => {
  const FRENCH = /[àâçéèêîïôùûœ]|\b(le|la|les|des|une|et|est|sont|dans|pour|que|qui|sur|avec|pas|aux|du|depuis|dont|fermés?|ouverts?|mergées?|attend|attendent|personne|tickets?|rien|aucun|ensuite|j|fils?|clos|sondages?|votants?|membres?|jours?|rouge|minuit|hier)\b/i
  const DAY = '2026-11-05'
  const END = parisTime(DAY, 24)
  const items = [ticket(1, NOW - 200 * HOUR), ticket(2, NOW - 200 * HOUR, NOW - 100 * HOUR, { milestone: 'M1' }), ticket(3, NOW - 300 * HOUR, NOW - HOUR, { milestone: 'M1' }), ticket(4, NOW - 90 * HOUR, null, { milestone: 'M1' }), merged(5, NOW - HOUR), merged(6, NOW - 2 * HOUR, 'rodolphebarbanneau')]
  const runs = [run(1, NOW - HOUR), run(2, NOW - 2 * HOUR, 'failure')]
  const milestones = (due: string | null) => [{ title: 'M1', closed: 0, total: 0, due }, { title: 'M2', closed: 0, total: 1, due: '2026-12-02' }]
  const talk = thread('t-1', NOW - HOUR, {
    messages: [{ author: 'vbarbanneau', createdAt: iso(NOW - HOUR) }, { author: 'vbarbanneau', createdAt: iso(NOW - 40 * 60_000), agent: 'auto' }, { author: 'rodolphebarbanneau', createdAt: iso(NOW - 30 * 60_000), synthesis: true }],
    polls: [
      { messageId: '1700000000000-vbarbanneau-abcd', question: 'Lunch?', createdAt: iso(NOW - 2 * HOUR), closedAt: null, closesAt: null, voters: 0, leading: null },
      { messageId: '1700000000001-vbarbanneau-abce', question: 'Release day?', createdAt: iso(NOW - 30 * HOUR), closedAt: iso(NOW - HOUR), closesAt: null, voters: 3, leading: 'Friday' },
      { messageId: '1700000000002-vbarbanneau-abcf', question: 'When?', createdAt: iso(NOW - 30 * HOUR), closedAt: iso(NOW - HOUR), closesAt: null, voters: 0, leading: null },
    ],
  })
  const ended = thread('t-2', NOW - 30 * HOUR, { status: 'closed', messages: [{ author: 'vbarbanneau', createdAt: iso(NOW - 30 * HOUR) }, { author: 'vbarbanneau', createdAt: iso(NOW - 20 * 60_000), status: 'closed' }] })
  const everything = [
    input({ threads: [talk, ended], repository: repo({ history: history({ items, runs, pulls: [open(9, { ci: 'failure' }), open(10, { draft: true }), open(11, { review: 'stale' })] }), milestones: milestones('2026-11-30'), waiting: [{ number: 12, title: 'x', who: 'victor', question: 'y' }, { number: 13, title: 'x', who: '', question: 'y' }] }) }),
    input({ repository: repo({ history: history({ items: items.slice(0, 5), runs: [run(1, NOW - HOUR, 'failure')] }), milestones: milestones('2026-11-06') }) }),
    input({ repository: repo({ history: history({ items: [ticket(1, NOW - 200 * HOUR), ticket(4, NOW - 90 * HOUR, null, { milestone: 'M1' })] }), milestones: milestones(null) }) }),
    input({ repository: repo({ history: history({ items: [merged(5, NOW - HOUR), ticket(7, NOW - 200 * HOUR, NOW - 2 * HOUR, { milestone: 'M1' })] }), milestones: milestones('2026-03-05') }), from: parisTime('2026-11-06') }),
    input({ repository: repo({ history: history({ items: Array.from({ length: 70 }, (_, index) => merged(100 + index, NOW - HOUR)) }), milestones: [] }) }),
    input({ repository: repo({ history: history({ runsFrom: iso(NOW - HOUR), items: [merged(1, NOW - HOUR)], runs: [run(1, NOW - 30 * 60_000)] }) }) }),
    input({ slot: 1, at: parisTime('2026-11-06', 1), to: parisTime('2026-11-06', 1), from: parisTime('2026-11-05', 22), repository: repo({ history: history({ items: [merged(1, parisTime('2026-11-05', 23))] }) }) }),
    input({ repository: repo() }),
    input({ repository: null, threads: [talk] }),
    input({ repository: null }),
    input({ kind: 'day', day: DAY, slot: null, from: parisTime(DAY), to: END, at: END + 5 * 60_000, repository: repo({ history: history({ items: [ticket(1, END - 200 * HOUR), ticket(2, END - 200 * HOUR, END - 2 * HOUR, { milestone: 'M1' }), ticket(4, END - 90 * HOUR, null, { milestone: 'M1' }), merged(5, END - HOUR), merged(6, END - 2 * HOUR, 'rodolphebarbanneau')], runs: [run(1, END - HOUR), run(2, END - 2 * HOUR, 'failure')], pulls: [open(9, { ci: 'failure', created: iso(END - 40 * HOUR) }), open(10, { draft: true, created: iso(END - 40 * HOUR) }), open(11, { created: iso(END - 40 * HOUR), review: 'stale' })], project: { at: iso(NOW), statuses: {} } }), milestones: milestones('2026-11-30'), waiting: [{ number: 12, title: 'x', who: 'victor', question: 'y' }] }) }),
    input({ kind: 'day', day: DAY, slot: null, from: parisTime(DAY), to: END, at: END + 5 * 60_000, repository: repo({ history: history(), milestones: [] }) }),
    input({ kind: 'day', day: DAY, slot: null, from: parisTime(DAY), to: END, at: END + 5 * 60_000, repository: null }),
  ]
  const lines = (one: ReportInput) => {
    const report = buildReport(one)
    return [...keyPoints(report), ...daySections(report).flatMap((section) => [section.title, ...section.lines])]
  }
  const figures = (line: string) => (line.match(/#\d+|\d+(?:[.,]\d+)?/g) ?? []).map((figure) => figure.replace(',', '.'))

  it('reads every sentence without a French word, and the figures do not change', () => {
    const french = everything.map(lines)
    setLanguage('en')
    try {
      const english = everything.map(lines)
      const distinct = new Set(english.flat())
      assert.ok(distinct.size > 30, `only ${distinct.size} sentences`)
      for (const line of distinct) assert.doesNotMatch(line, FRENCH, line)
      french.forEach((said, at) => {
        assert.equal(english[at].length, said.length)
        said.forEach((line, index) => assert.deepEqual(figures(english[at][index]), figures(line), `${line} -> ${english[at][index]}`))
      })
    } finally {
      setLanguage('fr')
    }
  })

  it('still reads the sentences of an earlier version', () => {
    setLanguage('en')
    try {
      assert.equal(reportLine('**M1** : 3 / 8, échéance le 7 nov. Au rythme des 7 derniers jours, 1,5 par jour, il reste 2,4 j : dans les temps.'), '**M1**: 3 / 8, due 7 Nov. At the pace of the last 7 days, 1.5 per day, 2.4 d remain: on schedule.')
      assert.equal(reportLine('Ensuite : **M2**, échéance le 7 nov.'), 'Next: **M2**, due 7 Nov.')
      assert.equal(reportLine('**1 ticket fermé, 2 ouverts** depuis 10:05.'), '**1 issue closed, 2 opened** since 10:05.')
    } finally {
      setLanguage('fr')
    }
    assert.equal(reportLine('**2 PR mergées depuis 10:05** : #1 (Victor).'), '**2 PR mergées depuis 10:05** : #1 (Victor).')
  })
})
