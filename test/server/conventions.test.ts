import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import { DEFAULT_CONVENTIONS, parseConfig } from '../../src/server/environment/config.ts'
import { reviewOf } from '../../src/server/github/copy.ts'
import { signalsOf } from '../../src/server/infra/probes.ts'
import { dueSlot, parisTime, setReportZone, slotsEvery } from '../../src/server/environment/reports.ts'
import { isTicket, setEpicLabel } from '../../src/shared/metrics.ts'

/** A team's ways are read from its configuration, not assumed: the epic label, what counts as a review, how often reports come. */

afterEach(() => {
  setEpicLabel('epic')
  setReportZone('Europe/Paris', [], 3)
})

const item = (labels: string[]) => ({ number: 1, kind: 'issue' as const, author: 'a', title: 't', created: '', closed: null, merged: null, milestone: null, labels, assignees: [] })

describe('the conventions', () => {
  it('have defaults, and are read with care', () => {
    assert.deepEqual(parseConfig({}).conventions, DEFAULT_CONVENTIONS)
    const read = parseConfig({ conventions: { epicLabel: ' Epic ', reviewComment: 'Review agent:', reportEveryHours: 6, ciMemoryMib: 2048 } }).conventions
    assert.deepEqual(read, { epicLabel: 'Epic', reviewComment: 'Review agent:', reportEveryHours: 6, ciMemoryMib: 2048 })
    // An empty string is a choice; an odd value is the default.
    assert.equal(parseConfig({ conventions: { epicLabel: '' } }).conventions.epicLabel, '')
    assert.equal(parseConfig({ conventions: { reportEveryHours: 5, ciMemoryMib: -1 } }).conventions.reportEveryHours, 3)
    assert.equal(parseConfig({ conventions: { ciMemoryMib: -1 } }).conventions.ciMemoryMib, 1536)
    assert.equal(parseConfig({ conventions: { epicLabel: 'x\u0000y' } }).conventions.epicLabel, 'epic')
  })

  it('decide what is a ticket', () => {
    assert.ok(isTicket(item([])))
    assert.ok(!isTicket(item(['epic'])))
    setEpicLabel('Epic')
    assert.ok(isTicket(item(['epic'])), 'the label is the one configured, as written')
    assert.ok(!isTicket(item(['Epic'])))
    setEpicLabel('')
    assert.ok(isTicket(item(['epic'])), 'without one, every issue is work')
  })

  it('decide which comments count as a review', () => {
    const head = 'a'.repeat(40)
    const said = { body: `Review agent: APPROVE at ${head}` }
    assert.equal(reviewOf([], [said], head), 'none', 'no words configured: only GitHub reviews count')
    assert.equal(reviewOf([], [said], head, 'Review agent:'), 'approved')
    assert.equal(reviewOf([], [{ body: `Bot says: CHANGES at ${head}` }], head, 'Bot says:'), 'changes')
    assert.equal(reviewOf([], [{ body: `Bot says: CHANGES at ${head}` }], head, 'Review agent:'), 'none')
    assert.equal(reviewOf([], [{ body: `(ci) APPROVE at ${head}` }], head, '(ci)'), 'approved', 'the words are taken as they are, not as a pattern')
  })

  it('decide how often reports come', () => {
    assert.deepEqual(slotsEvery(3), [1, 4, 7, 10, 13, 16, 19, 22])
    assert.deepEqual(slotsEvery(6), [1, 7, 13, 19])
    assert.deepEqual(slotsEvery(24), [1])
    assert.equal(slotsEvery(1).length, 23)
    setReportZone('Europe/Paris', [], 12)
    assert.deepEqual(dueSlot(parisTime('2026-11-06', 14)), { day: '2026-11-06', slot: 13 })
    assert.deepEqual(dueSlot(parisTime('2026-11-06', 12)), { day: '2026-11-06', slot: 1 })
    assert.equal(dueSlot(parisTime('2026-11-06') + 30 * 60_000), null)
  })

  it('decide when a CI host is short of memory', () => {
    const reading = { at: 1_700_000_000, uptime: 10, cpus: 4, cpuBusy: 10, load1: 1, load5: 1, memoryTotal: 8000, memoryAvailable: 3000, memoryLowest: 1800, pressure: null, oomKills: 0, diskTotal: 100_000, diskFree: 50_000, points: [] }
    assert.equal(signalsOf('ci', reading, 30).memory, 'ok')
    assert.equal(signalsOf('ci', reading, 30, 2048).memory, 'amber')
    assert.equal(signalsOf('ci', reading, 30, 2048).memoryFloor, 2048)
    assert.equal(signalsOf('dev', reading, 30, 2048).memoryFloor, 800, 'other hosts keep a tenth of their memory')
  })
})
