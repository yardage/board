import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, it } from 'node:test'
import { BADGE_SIZE, badgeBitmap, badgeText, trayText, withDot } from '../../src/desktop/badge.ts'
import { startTestBoard as startBoard } from '../support/helpers.ts'
import { dependents, dependsOn } from '../../src/server/github/dependencies.ts'
import type { History, HistoryItem, HistoryRun, OpenPull } from '../../src/server/github/copy.ts'
import { itemFromGithub, itemView } from '../../src/server/github/item.ts'
import { Search, snippetOf, wordsOf, type SearchSources } from '../../src/server/environment/search.ts'
import { retriedRuns, dailyCounts, deliveryTimes, forecastRange, itemsOfBucket, oldestUnreviewed, percentile, queueWait, runsOfBucket, ticketsOfArea, ticketsOfStatus, versusYesterday } from '../../src/shared/metrics.ts'
import { itemOfUrl, setRepository } from '../../src/client/lib/subject.ts'
import { ageWords, firstNew, isUnread, readStored, rememberScroll, threadCounts, threadRows, trimEmptyStart, waitingOrder } from '../../src/client/lib/lists.ts'

const temp: string[] = []
afterEach(() => {
  for (const dir of temp.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('search', () => {
  const sources = (more: Partial<SearchSources> = {}): SearchSources => ({
    repository: () => 'https://example.invalid/repo',
    threads: async () => [],
    items: async () => [],
    docs: async () => [],
    reports: async () => [],
    ...more,
  })
  const doc = (path: string, text: string, name = path) => ({ path, name, stamp: async () => 1, text: async () => text })
  const thread = (id: string, title: string, bodies: string[], lastAt = 'x', count?: { reads: number }) => ({
    id,
    title,
    status: 'open',
    lastAt,
    messageCount: bodies.length,
    messages: async () => {
      if (count) count.reads += 1
      return bodies.map((body, index) => ({ id: String(index), who: 'Victor', body }))
    },
  })

  it('ignores case and accents, and needs every word', async () => {
    assert.deepEqual(wordsOf('  Décision  ÉTÉ '), ['decision', 'ete'])
    const search = new Search(sources({ threads: async () => [thread('a', 'La décision prise', [])] }))
    assert.equal((await search.find('DECISION')).length, 1)
    assert.equal((await search.find('decision absente')).length, 0)
    assert.deepEqual(await search.find('   '), [])
  })

  it('finds a message, and says where in it', async () => {
    const long = `${'avant '.repeat(40)}le mot cherché ${'après '.repeat(40)}`
    const [hit] = await new Search(sources({ threads: async () => [thread('a b', 'Titre', [long])] })).find('cherche')
    assert.equal(hit.kind, 'message')
    assert.equal(hit.href, '#t/a%20b')
    assert.match(hit.detail, /^Victor : …/)
    assert.match(hit.detail, /le mot cherché/)
    assert.ok(hit.detail.length < 180)
  })

  it('keeps the same place in the text after folding it', () => {
    const text = 'ééééé mot'
    assert.match(snippetOf(text, 'eeeee mot', ['mot']), /mot/)
  })

  it('finds a ticket by its number or its title, and links to it', async () => {
    const items = async () => [{ number: 12, kind: 'pull' as const, title: 'Ajoute le cache', closed: null }, { number: 120, kind: 'issue' as const, title: 'Le journal', closed: 'x' }]
    const search = new Search(sources({ items }))
    const [hit] = await search.find('#12')
    assert.equal(hit.title, '#12 Ajoute le cache')
    assert.equal(hit.href, 'https://example.invalid/repo/pull/12')
    assert.equal((await search.find('12')).length, 1, 'the number alone, not those that contain it')
    assert.equal((await search.find('journal'))[0].href, 'https://example.invalid/repo/issues/120')
  })

  it('finds a document by its name or inside, and leaves pages of charts out', async () => {
    const docs = async () => [doc('a/decisions.md', 'rien', 'Décisions'), doc('b/notes.md', 'le mot décisions ici'), doc('r/page.html', '<script>decisions</script>')]
    const hits = await new Search(sources({ docs })).find('decisions')
    assert.deepEqual(hits.map((hit) => hit.href), ['#d/a/decisions.md', '#d/b/notes.md'])
  })

  it('finds what a report says', async () => {
    const reports = async () => [{ id: '2026-11-06-1300', title: 'Point de 13:00', text: async () => 'CI : 95 % de réussite' }]
    const hits = await new Search(sources({ reports })).find('reussite')
    assert.equal(hits[0].href, '#rapports/2026-11-06-1300')
  })

  it('shows what is named so before what mentions it, and at most forty', async () => {
    const many = Array.from({ length: 60 }, (_, index) => doc(`d${index}.md`, 'cache'))
    const threads = async () => [thread('t', 'Le cache', [])]
    const hits = await new Search(sources({ threads, docs: async () => many })).find('cache')
    assert.equal(hits[0].kind, 'thread')
    assert.equal(hits.length, 40)
  })

  it('reads a thread again only when it has changed', async () => {
    const count = { reads: 0 }
    let current = thread('t', 'Titre', ['un'], 'first', count)
    const search = new Search(sources({ threads: async () => [current] }))
    await search.find('un')
    await search.find('un')
    assert.equal(count.reads, 1)
    current = thread('t', 'Titre', ['un', 'deux'], 'second', count)
    const later = new Search(sources({ threads: async () => [current] }))
    assert.equal((await later.find('deux')).length, 1)
    assert.equal(count.reads, 2)
  })

  it('matches accents however they are written, and tells emoji apart', async () => {
    const threads = async () => [thread('a', 'x', ['e\u0301cran', '\u{1F600}'])]
    assert.equal((await new Search(sources({ threads })).find('écran')).length, 1)
    assert.equal((await new Search(sources({ threads })).find('\u{1F60E}')).length, 0)
  })

  it('does not let a folder every document shares hide the rest', async () => {
    const docs = async () => Array.from({ length: 60 }, (_, index) => doc(`acme/d${index}.md`, 'rien', `d${index}`))
    const items = async () => [{ number: 1, kind: 'issue' as const, title: 'acme', closed: null }]
    assert.deepEqual((await new Search(sources({ docs, items })).find('acme')).map((hit) => hit.kind), ['item'])
    const named = async () => Array.from({ length: 60 }, (_, index) => doc(`y/cache${index}.md`, 'rien'))
    const hits = await new Search(sources({ docs: named, items: async () => [{ number: 1, kind: 'issue' as const, title: 'cache', closed: null }] })).find('cache')
    assert.ok(hits.some((hit) => hit.kind === 'item'), 'past a number of documents, the rest still shows')
  })

  it('shares one reading of the lists among a burst of keystrokes', async () => {
    let reads = 0
    const threads = async () => {
      reads += 1
      return []
    }
    const search = new Search(sources({ threads }))
    await Promise.all([search.find('a'), search.find('ab'), search.find('abc')])
    assert.equal(reads, 1)
  })

  it('stays quick on a long query', async () => {
    const search = new Search(sources({ docs: async () => [doc('a.md', 'x'.repeat(100_000))] }))
    const started = Date.now()
    await search.find('x '.repeat(1000))
    assert.ok(Date.now() - started < 2000)
  })
})

describe('what a ticket holds up', () => {
  it('reads only the list under its heading', () => {
    assert.deepEqual(dependsOn('# T\n\nSee #5.\n\n## Depends on\n\n- #28\n- #64 and #64\n\n## After\n\n- #99\n'), [28, 64])
    assert.deepEqual(dependsOn('# T\n\nDepends on #5.\n'), [])
    assert.deepEqual(dependsOn('## depends on\r\n- #7\r\n'), [7])
  })

  it('turns those lists around', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'board-deps-'))
    temp.push(dir)
    writeFileSync(join(dir, '10.md'), '## Depends on\n- #1\n- #10\n')
    writeFileSync(join(dir, '9.md'), '## Depends on\n- #1\n')
    writeFileSync(join(dir, 'README.md'), '## Depends on\n- #1\n')
    const found = await dependents(dir)
    assert.deepEqual(found.get(1), [9, 10])
    assert.equal(found.get(10), undefined, 'not itself')
    assert.equal((await dependents(join(dir, 'missing'))).size, 0)
  })
})

describe('the counter on the icon', () => {
  const pixel = (bitmap: Buffer, x: number, y: number) => [...bitmap.subarray((y * BADGE_SIZE + x) * 4, (y * BADGE_SIZE + x) * 4 + 4)]

  it('draws nothing for nothing', () => {
    assert.equal(badgeBitmap(0), null)
    assert.equal(badgeBitmap(-1), null)
    assert.equal(badgeBitmap(1.5), null)
  })

  it('draws a round counter with different digits', () => {
    const one = badgeBitmap(1)
    const two = badgeBitmap(2)
    assert.equal(one?.length, BADGE_SIZE * BADGE_SIZE * 4)
    assert.deepEqual(pixel(one as Buffer, 0, 0), [0, 0, 0, 0], 'a transparent corner')
    assert.notDeepEqual(one, two)
  })

  it('stops counting at nine', () => {
    assert.equal(badgeText(9), '9')
    assert.equal(badgeText(10), '9+')
    assert.deepEqual(badgeBitmap(10), badgeBitmap(250))
  })

  it('adds a dot to the icon without touching the original', () => {
    const icon = Buffer.alloc(BADGE_SIZE * BADGE_SIZE * 4)
    const marked = withDot(icon, BADGE_SIZE)
    assert.notDeepEqual(marked, icon)
    assert.ok(icon.every((byte) => byte === 0))
    assert.notDeepEqual(pixel(marked, BADGE_SIZE - 3, BADGE_SIZE - 3), [0, 0, 0, 0])
    assert.deepEqual(pixel(marked, 0, 0), [0, 0, 0, 0])
  })

  it('says it in words', () => {
    assert.equal(trayText(0, 0, false), 'Board')
    assert.equal(trayText(1, 0, false), 'Board · 1 fil non lu')
    assert.equal(trayText(2, 3, true), 'Board · à l’écoute · 2 fils non lus · 3 à valider')
  })
})

describe('the lists', () => {
  const row = (id: string, more = {}) => ({ id, status: 'open', lastAt: '2026-11-06T10:00:00Z', lastAuthor: 'rodolphe', ...more })
  const seenOf = (seen: Record<string, string>) => (id: string) => seen[id] ?? null

  it('is unread only when someone else wrote since', () => {
    assert.equal(isUnread(row('a'), 'victor', null), true)
    assert.equal(isUnread(row('a'), 'victor', '2026-11-06T10:00:00Z'), false)
    assert.equal(isUnread(row('a', { lastAuthor: 'victor' }), 'victor', null), false)
  })

  it('filters, and puts what is pinned first', () => {
    const threads = [row('a'), row('b', { subject: { label: 'x' } }), row('c', { status: 'closed' }), row('d', { lastAuthor: 'victor' })]
    const ids = (filter: 'open' | 'unread' | 'linked' | 'closed', pinned = new Set<string>()) => threadRows(threads, filter, pinned, 'victor', seenOf({ b: '2026-11-07' })).map((one) => one.id)
    assert.deepEqual(ids('open'), ['a', 'b', 'd'])
    assert.deepEqual(ids('unread'), ['a'])
    assert.deepEqual(ids('linked'), ['b'])
    assert.deepEqual(ids('closed'), ['c'])
    assert.deepEqual(ids('open', new Set(['d', 'c'])), ['d', 'a', 'b'], 'a closed one pinned stays with the closed')
    assert.deepEqual(threadCounts(threads, 'victor', seenOf({ b: '2026-11-07' })), { open: 3, unread: 1, linked: 1, closed: 1 })
  })

  it('finds where "nouveaux" goes', () => {
    const messages = [
      { id: '1', author: 'rodolphe', createdAt: '2026-11-06T09:00:00Z' },
      { id: '2', author: 'victor', createdAt: '2026-11-06T11:00:00Z' },
      { id: '3', author: 'rodolphe', createdAt: '2026-11-06T12:00:00Z' },
    ]
    assert.equal(firstNew(messages, '2026-11-06T10:00:00Z', 'victor'), '3')
    assert.equal(firstNew(messages, null, 'victor'), null, 'a first visit opens at the end')
    assert.equal(firstNew(messages, '2026-11-07T00:00:00Z', 'victor'), null)
  })

  it('sorts what waits by age or by what it holds up', () => {
    const items = [{ number: 1, createdAt: '2026-11-05', unblocks: [] }, { number: 2, createdAt: '2026-11-01', unblocks: [7] }, { number: 3, createdAt: null, unblocks: [8, 9] }, { number: 4, createdAt: '2026-11-03', unblocks: [7] }]
    assert.deepEqual(waitingOrder(items, 'age').map((one) => one.number), [2, 4, 1, 3])
    assert.deepEqual(waitingOrder(items, 'unblocks').map((one) => one.number), [3, 2, 4, 1])
    assert.equal(items[0].number, 1, 'the list given is left as it was')
  })

  it('says an age in words', () => {
    const now = Date.parse('2026-11-06T12:00:00Z')
    assert.equal(ageWords('2026-11-06T11:30:00Z', now), "moins d'1 h")
    assert.equal(ageWords('2026-11-06T02:00:00Z', now), '10 h')
    assert.equal(ageWords('2026-11-03T12:00:00Z', now), '3 j')
    assert.equal(ageWords(null, now), null)
    assert.equal(ageWords('never', now), null)
    assert.equal(ageWords('2026-11-07T12:00:00Z', now), null)
  })

  it('drops only the empty periods at the start', () => {
    assert.deepEqual(trimEmptyStart([0, 0, 1, 0, 2], (value) => value === 0), [1, 0, 2])
    assert.deepEqual(trimEmptyStart([1, 0], (value) => value === 0), [1, 0])
    assert.deepEqual(trimEmptyStart([0, 0], (value) => value === 0), [0, 0], 'all empty stays as it is')
  })

  it('remembers the last places read, a limited number', () => {
    let found: Record<string, number> = {}
    for (let index = 0; index < 40; index++) found = rememberScroll(found, `r${index}`, index)
    assert.equal(Object.keys(found).length, 30)
    assert.equal(found.r39, 39)
    assert.equal(found.r0, undefined)
    assert.equal(rememberScroll({ a: 1 }, 'a', 5).a, 5)
  })

  it('reads storage that may hold anything', () => {
    const isString = (value: unknown): value is string => typeof value === 'string'
    assert.equal(readStored(null, isString), null)
    assert.equal(readStored('{half', isString), null)
    assert.equal(readStored('5', isString), null)
    assert.equal(readStored('"x"', isString), 'x')
  })
})

describe('what the overview adds up', () => {
  const NOW = new Date(2026, 10, 6, 12, 0).getTime()
  const HOUR = 3_600_000
  const iso = (time: number) => new Date(time).toISOString()
  const pull = (number: number, created: number, merged: number | null): HistoryItem => ({ number, kind: 'pull', author: 'a', title: `PR ${number}`, created: iso(created), closed: merged === null ? null : iso(merged), merged: merged === null ? null : iso(merged), milestone: null, labels: [] })
  const ticket = (number: number, created: number, closed: number | null, more: Partial<HistoryItem> = {}): HistoryItem => ({ number, kind: 'issue', author: 'a', title: `T ${number}`, created: iso(created), closed: closed === null ? null : iso(closed), merged: null, milestone: null, labels: [], ...more })
  const run = (id: number, start: number, state: HistoryRun['state'] = 'success', minutes = 10, attempt?: number): HistoryRun => ({ id, branch: 'b', pr: null, event: 'push', state, start: iso(start), end: iso(start + minutes * 60_000), updated: iso(start), attempt })

  it('takes percentiles by nearest rank', () => {
    assert.equal(percentile([], 0.5), null)
    assert.equal(percentile([5], 0.95), 5)
    assert.equal(percentile([1, 2, 3, 4], 0.5), 2)
    assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.9), 9)
    assert.equal(percentile([10, 1], 0.95), 10)
  })

  it('measures what ended in the period', () => {
    const items = [pull(1, NOW - 5 * HOUR, NOW - HOUR), pull(2, NOW - 100 * HOUR, NOW - 90 * HOUR), pull(3, NOW - 5 * HOUR, null), ticket(4, NOW - 3 * HOUR, NOW - HOUR), ticket(5, NOW - 3 * HOUR, NOW - HOUR, { labels: ['epic'] })]
    const found = deliveryTimes(items, NOW - 10 * HOUR, NOW)
    assert.deepEqual(found.pulls, { count: 1, median: 4, p90: 4 })
    assert.deepEqual(found.tickets, { count: 1, median: 2, p90: 2 })
    assert.deepEqual(deliveryTimes([], 0, NOW).pulls, { count: 0, median: null, p90: null })
    assert.equal(deliveryTimes([pull(1, NOW - 2 * HOUR, NOW - HOUR), pull(2, NOW - 10 * HOUR, NOW - HOUR)], NOW - 3 * HOUR, NOW).pulls.median, 5, 'halfway between two')
    assert.equal(deliveryTimes([pull(1, NOW, NOW - HOUR)], NOW - 3 * HOUR, NOW).pulls.count, 0, 'closed before it was created: not a time')
  })

  it('finds the oldest pull request nobody has reviewed', () => {
    const open = (number: number, created: string, more = {}) => ({ number, title: '', author: '', branch: '', draft: false, ci: '', created, review: 'none', ...more }) as OpenPull
    assert.equal(oldestUnreviewed([open(1, '2026-11-03'), open(2, '2026-11-01', { draft: true }), open(3, '2026-11-02', { review: 'approved' })])?.number, 1)
    assert.equal(oldestUnreviewed([]), null)
  })

  it('counts the runs started again, and not a try it does not know', () => {
    const found = retriedRuns([run(1, NOW - HOUR, 'success', 10, 1), run(2, NOW - HOUR, 'failure', 30, 2), run(3, NOW - HOUR, 'other', 99), run(4, NOW - 100 * HOUR, 'success', 500, 3)], NOW - 2 * HOUR, NOW)
    assert.equal(found.retried, 1)
    assert.equal(found.attemptsKnown, 2)
  })

  it('measures the wait for a runner, leaving out what still waits and what makes no sense', () => {
    const start = iso(NOW)
    const found = queueWait([{ queuedAt: iso(NOW - 2 * 60_000), start, state: 'success', runner: 'ci-1' }, { queuedAt: iso(NOW - 6 * 60_000), start, state: 'running', runner: 'ci-2' }, { queuedAt: iso(NOW - 60_000), start, state: 'queued', runner: null }, { start, state: 'success', runner: 'ci-1' }, { queuedAt: iso(NOW + 60_000), start, state: 'success', runner: 'ci-1' }, { queuedAt: iso(NOW - 30 * 60_000), start, state: 'other', runner: null }])
    assert.deepEqual(found, { median: 4, longest: 6, count: 2 })
  })

  it('counts by day, and compares with yesterday at the same time', () => {
    const today = new Date(2026, 10, 6, 9).toISOString()
    const yesterdayEarly = new Date(2026, 10, 5, 9).toISOString()
    const yesterdayLate = new Date(2026, 10, 5, 20).toISOString()
    assert.deepEqual(dailyCounts([today, yesterdayEarly, yesterdayLate, null], NOW, 3), [0, 2, 1])
    assert.equal(versusYesterday([today, yesterdayEarly, yesterdayLate, null], NOW), 0, 'later yesterday does not count yet')
    assert.equal(versusYesterday([today, today, yesterdayEarly], NOW), 1)
  })

  it('compares by the clock, on a day that is shorter or longer', () => {
    // Clocks change on 25 October 2026 and 29 March 2026, where the rules are Paris's. Elsewhere this holds just the same.
    const at = (month: number, day: number, hour: number, minute = 0) => new Date(2026, month, day, hour, minute)
    assert.equal(versusYesterday([at(9, 26, 0, 10).toISOString()], at(9, 26, 23, 30).getTime()), 1, "today's stays today's")
    assert.equal(versusYesterday([at(2, 29, 9, 30).toISOString()], at(2, 30, 10).getTime()), -1)
    assert.equal(versusYesterday([at(2, 29, 10, 30).toISOString()], at(2, 30, 10).getTime()), 0)
  })

  it('gives the forecast as a range, or nothing when it would not be one', () => {
    const closedIn = (days: number[]) => days.map((day, index) => ticket(index + 1, NOW - 40 * 24 * HOUR, NOW - day * 24 * HOUR, { milestone: 'M' }))
    const items = [...closedIn([1, 2, 5, 10]), ticket(50, NOW - HOUR, null, { milestone: 'M' }), ticket(51, NOW - HOUR, null, { milestone: 'M' })]
    const range = forecastRange(items, 'M', null, NOW)
    assert.deepEqual(range?.windows, [3, 7, 14])
    assert.equal(range?.low, 2 / (2 / 3))
    assert.equal(range?.high, 7)
    assert.equal(forecastRange([ticket(1, NOW, null, { milestone: 'M' })], 'M', null, NOW), null, 'nothing closed')
  })

  it('lists what a column or a bar holds', () => {
    const bucket = { from: NOW - HOUR, to: NOW, label: 'x' }
    const items = [pull(1, NOW - 10 * HOUR, NOW - 60_000), ticket(2, NOW - 60_000, null), ticket(3, NOW - 10 * HOUR, NOW - 60_000, { labels: ['area:ci'], milestone: 'M' }), ticket(4, NOW - 10 * HOUR, null, { labels: ['epic', 'area:ci'] })]
    const found = itemsOfBucket(items, bucket)
    assert.deepEqual([found.merged, found.closed, found.opened].map((list) => list.map((item) => item.number)), [[1], [3], [2]])
    assert.deepEqual(runsOfBucket([run(1, NOW - 60_000), run(2, NOW - 30_000, 'failure'), run(3, NOW - 60_000, 'other'), run(4, NOW - 10 * HOUR)], bucket).map((one) => one.id), [2, 1])
    assert.deepEqual(ticketsOfArea(items, 'ci', null).map((item) => item.number), [3], 'not an epic')
    assert.deepEqual(ticketsOfArea(items, 'ci', 'N'), [])
    assert.deepEqual(ticketsOfStatus(items, { 2: 'Ready', 3: 'Done' }, 'Ready', null).map((item) => item.number), [2])
  })
})

describe('the side panel', () => {
  const issue = { title: 'T', user: { login: 'someone' }, labels: [{ name: 'a' }, {}], milestone: { title: 'M0' }, body: 'x'.repeat(50_000), html_url: 'https://github.com/acme/app/issues/5', created_at: '2026-11-01T00:00:00Z', closed_at: null }
  const history = (more = {}) => ({ items: [{ number: 5, kind: 'pull', title: 'Ledger', author: 'b', created: '2026-11-01', closed: null, merged: null, milestone: null, labels: ['z'] }], pulls: [{ number: 5, draft: true, ci: 'success', review: 'approved' }], runs: [{ id: 1, pr: 5, state: 'success', start: '2026-11-02', end: null, branch: 'x' }, { id: 2, pr: 5, state: 'failure', start: '2026-11-03', end: null, branch: 'x' }, { id: 3, pr: 6, state: 'failure', start: '2026-11-04', end: null, branch: 'y' }], ...more }) as unknown as History

  it('reads only addresses of this repository', () => {
    setRepository('https://github.com/acme/app')
    assert.equal(itemOfUrl('https://github.com/acme/app/pull/12'), 12)
    assert.equal(itemOfUrl('https://github.com/acme/app/issues/12/'), 12)
    assert.equal(itemOfUrl('https://github.com/acme/app/issues/12#issuecomment-1'), null)
    assert.equal(itemOfUrl('https://github.com/other/app/issues/12'), null)
    assert.equal(itemOfUrl('https://github.com.evil.example/acme/app/issues/12'), null)
    assert.equal(itemOfUrl('#t/12'), null)
  })

  it('tells a merged pull request from a closed ticket and a draft, and keeps the text to a size', () => {
    assert.equal(itemFromGithub(5, { issue, pull: null }).state, 'open')
    assert.equal(itemFromGithub(5, { issue, pull: null }).kind, 'issue')
    assert.deepEqual(itemFromGithub(5, { issue, pull: null }).labels, ['a'])
    assert.equal(itemFromGithub(5, { issue, pull: null }).body.length, 40_000)
    assert.equal(itemFromGithub(5, { issue: { ...issue, closed_at: 'x' }, pull: null }).state, 'closed')
    assert.equal(itemFromGithub(5, { issue, pull: { draft: true, merged_at: null } }).state, 'draft')
    assert.equal(itemFromGithub(5, { issue: { ...issue, closed_at: 'x' }, pull: { merged_at: 'x' } }).state, 'merged')
    assert.equal(itemFromGithub(5, { issue: {}, pull: null }).title, '')
  })

  it("adds what the ledger knows, its latest runs first", () => {
    const view = itemView(5, itemFromGithub(5, { issue, pull: { draft: true, merged_at: null } }), history(), 'https://r', null)
    assert.equal(view?.title, 'T')
    assert.equal(view?.ci, 'success')
    assert.equal(view?.review, 'approved')
    assert.deepEqual(view?.runs.map((run) => run.id), [2, 1])
  })

  it('still says what it is when GitHub does not answer, and nothing when nothing knows it', () => {
    const view = itemView(5, null, history(), 'https://r', 'no network')
    assert.equal(view?.title, 'Ledger')
    assert.equal(view?.url, 'https://r/pull/5')
    assert.equal(view?.state, 'draft')
    assert.equal(view?.unread, 'no network')
    assert.equal(view?.body, '')
    assert.equal(itemView(9, null, history(), 'https://r', 'no network'), null)
    assert.equal(itemView(9, null, null, 'https://r', 'no network'), null)
  })
})

describe('what a web page can reach', () => {
  it('turns away a page of another site, which sends no origin, and lets the board through', async () => {
    process.env.BOARD_PERSON = 'victor'
    const dir = mkdtempSync(join(tmpdir(), 'board-site-'))
    temp.push(dir)
    mkdirSync(join(dir, 'client'))
    writeFileSync(join(dir, 'client', 'index.html'), 'page')
    const running = await startBoard({ root: dir, client: join(dir, 'client'), port: 4811, loops: false })
    try {
      const status = async (path: string, headers: Record<string, string> = {}, more: RequestInit = {}) => (await fetch(`${running.url}${path}`, { headers, ...more })).status
      assert.equal(await status('/api/search?q=x', { 'sec-fetch-site': 'cross-site' }), 403)
      assert.equal(await status('/api/item/5', { 'sec-fetch-site': 'cross-site' }), 403)
      assert.equal(await status('/api/item/5', { 'sec-fetch-site': 'same-site' }), 403)
      assert.equal(await status('/api/search?q=x', { 'sec-fetch-site': 'same-origin' }), 200)
      assert.equal(await status('/api/search?q=x'), 200, 'a tool on this computer')
      assert.equal(await status('/api/search?q=x', { 'sec-fetch-site': 'none' }), 200, 'an address typed in')
      assert.equal(await status(`/api/search?q=${'x'.repeat(300)}`), 400)
      assert.equal(await status('/api/item/abc'), 404)
      const post = (body: unknown, headers: Record<string, string> = { 'x-board': '1' }) => status('/api/badge', { 'content-type': 'application/json', ...headers }, { method: 'POST', body: JSON.stringify(body) })
      assert.equal(await post({ unread: 1, waiting: 2 }), 200)
      assert.equal(await post({ unread: 1 }, {}), 403, 'a post needs the header')
    } finally {
      await running.stop()
    }
  })
})
