import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import { briefOf, type InfraSnapshot } from '../../src/server/infra/infra.ts'
import { localize, localizeData, setLanguage } from '../../src/shared/i18n/i18n.ts'
import { lowestMemoryOf } from '../../src/shared/metrics.ts'
import { hostReadings, type HostReading, parseReading, type ProbeReading, recentOomKills, signalsOf } from '../../src/server/infra/probes.ts'
import { HOST_PREFIX, MEMBER_PREFIX, parseHost, parseMember, variableOf } from '../../src/server/environment/live.ts'

const AT = 1_794_020_978
/** What a CI runner's probe sends, as tools/probe writes it. */
const sent = (change: Record<string, unknown> = {}) => ({
  v: 1,
  at: AT,
  uptime_s: 143_423,
  cpus: 4,
  cpu_busy_pct: 37,
  load1: 2.5,
  load5: 1.25,
  memory_total_mib: 7746,
  memory_available_mib: 4100,
  memory_available_lowest_mib: 2900,
  memory_pressure_avg60: 0.0,
  oom_kills: 0,
  disk_total_mib: 73_000,
  disk_free_mib: 40_000,
  points: [
    [AT - 120, 3000, 20, 40_100, 0],
    [AT - 60, 1800, 90, 40_050, 0],
    [AT, 2900, 37, 40_000, 0],
  ],
  ...change,
})
const text = (change?: Record<string, unknown>) => JSON.stringify(sent(change))
const read = (change?: Record<string, unknown>, hostNow = (AT + 30) * 1000) => {
  const parsed = parseReading(text(change), hostNow)
  if ('problem' in parsed) throw new Error(parsed.problem)
  return parsed
}
const refused = (body: string) => {
  const parsed = parseReading(body, (AT + 30) * 1000)
  assert.ok('problem' in parsed, `accepted: ${body.slice(0, 120)}`)
  return parsed.problem
}

describe("a host's reading", () => {
  it('keeps every figure, and its age by the host’s own clock', () => {
    const { reading, age } = read()
    assert.equal(age, 30)
    assert.equal(reading.memoryLowest, 2900)
    assert.equal(reading.cpus, 4)
    assert.equal(reading.pressure, 0)
    assert.deepEqual(reading.points[1], { at: AT - 60, lowest: 1800, cpu: 90, diskFree: 40_050, oomKills: 0 })
    assert.equal(read({ memory_pressure_avg60: null }).reading.pressure, null, 'a kernel without pressure')
  })

  it('leaves out a field it doesn’t know, and sorts the points', () => {
    const { reading } = read({ hostname: '<img src=x onerror=alert(1)>', points: [[AT, 2900, 37, 40_000, 0], [AT - 60, 1800, 90, 40_050, 0]] })
    assert.equal('hostname' in reading, false)
    assert.deepEqual(
      reading.points.map((point) => point.at),
      [AT - 60, AT],
    )
  })

  it('refuses anything that isn’t a reading in range, falsified or not', () => {
    assert.equal(refused('<html>'), 'pas du JSON')
    assert.equal(refused('[1,2]'), 'pas un relevé')
    assert.equal(refused('null'), 'pas un relevé')
    assert.equal(refused(text({ v: 2 })), 'format inconnu')
    assert.equal(refused(text({ cpus: '<img src=x onerror=alert(1)>' })), 'valeur refusée (cpus)')
    assert.equal(refused(text({ cpus: '4' })), 'valeur refusée (cpus)', 'a number as text')
    assert.equal(refused(text({ cpu_busy_pct: 101 })), 'valeur refusée (cpuBusy)')
    assert.equal(refused(text({ memory_available_lowest_mib: -1 })), 'valeur refusée (memoryLowest)')
    assert.equal(refused(text({ memory_available_lowest_mib: 9000 })), 'valeur refusée (memoryLowest)', 'more free than there is')
    assert.equal(refused(text({ disk_free_mib: 80_000 })), 'valeur refusée (diskFree)')
    assert.equal(refused(text({ memory_total_mib: 7746.5 })), 'valeur refusée (memoryTotal)')
    assert.equal(refused(text({ at: 'now' })), 'valeur refusée (at)')
    assert.equal(refused(text({ oom_kills: undefined })), 'valeur refusée (oomKills)', 'a missing field')
    assert.equal(refused(text({ memory_pressure_avg60: 'high' })), 'valeur refusée (pressure)')
    assert.equal(refused(text().replace('"load1":2.5', '"load1":1e999')), 'valeur refusée (load1)', 'infinity')
    assert.equal(refused(text({ points: 'many' })), 'historique refusé')
    assert.equal(refused(text({ points: [[AT, 2900, 37, 40_000]] })), 'historique refusé')
    assert.equal(refused(text({ points: [[AT, 9000, 37, 40_000, 0]] })), 'historique refusé')
    assert.equal(refused(text({ points: Array.from({ length: 401 }, () => [AT, 2900, 37, 40_000, 0]) })), 'historique refusé')
    assert.equal(refused(text({ at: AT + 3600 })), 'daté du futur')
  })

  it('never repeats what a host sent in its reason', () => {
    for (const body of [text({ cpus: 'SECRET-WORD' }), text({ v: 'SECRET-WORD' }), 'SECRET-WORD', text({ points: [['SECRET-WORD']] })]) {
      assert.doesNotMatch(refused(body), /SECRET/)
    }
  })
})

describe('what a reading means', () => {
  const reading = (change?: Record<string, unknown>) => read(change).reading
  const points = (...oom: number[]) => oom.map((oomKills, index) => ({ at: AT + 60 * index, lowest: 2000, cpu: 10, diskFree: 40_000, oomKills }))

  it('counts the OOM kills the points saw, not a reboot', () => {
    assert.equal(recentOomKills(points(0, 0, 0)), 0)
    assert.equal(recentOomKills(points(2, 2, 3, 5)), 3)
    assert.equal(recentOomKills(points(4, 0, 1)), 1, 'down to 0 is a reboot')
    assert.equal(recentOomKills(points(7)), 0, 'before the points, the count says nothing about when')
  })

  it('applies the thresholds', () => {
    const ok = signalsOf('ci', reading(), 30)
    assert.deepEqual(ok, { memory: 'ok', disk: 'ok', age: 'ok', oomRecent: 0, memoryLowest6h: 1800, memoryFloor: 1536 })
    assert.equal(signalsOf('ci', reading({ memory_available_lowest_mib: 1500 }), 30).memory, 'amber', 'under 1.5 GB on a CI host')
    assert.equal(signalsOf('dev', reading({ memory_available_lowest_mib: 1500 }), 30).memory, 'ok', '1.5 GB is a lot of 7.7 elsewhere')
    assert.equal(signalsOf('dev', reading({ memory_available_lowest_mib: 700 }), 30).memory, 'amber', 'under 10% elsewhere')
    assert.equal(signalsOf('ci', reading({ points: [[AT - 60, 1800, 90, 40_050, 0], [AT, 2900, 37, 40_000, 1]], oom_kills: 1 }), 30).memory, 'red')
    assert.equal(signalsOf('ci', reading({ disk_free_mib: 10_000, points: [] }), 30).disk, 'amber')
    assert.equal(signalsOf('ci', reading({ disk_free_mib: 3000, points: [] }), 30).disk, 'red')
    assert.equal(signalsOf('ci', reading(), 200).age, 'amber')
    assert.equal(signalsOf('ci', reading(), 1000).age, 'red')
  })

})

describe('readings that hosts write to the environment', () => {
  const written = (name: string, value: string, updatedAt = new Date((AT + 15) * 1000).toISOString()) => ({ name, value, updatedAt })

  it('reads a reading, and dates it by the host’s clock when it wrote it, then by GitHub’s', () => {
    // Written 10 seconds after the reading by the host's clock, received 15 seconds after: 25 seconds old in all.
    const [host] = hostReadings([{ name: 'ci-2', role: 'ci' }], [written('ci-2', text(), new Date((AT + 10) * 1000).toISOString())], (AT + 25) * 1000)
    assert.equal(host.state, 'ok')
    assert.equal(host.age, 25)
    assert.equal(host.role, 'ci')
    assert.equal(host.reading?.memoryLowest, 2900)
    assert.equal(host.signals?.memory, 'ok')
  })

  it('shows the configured hosts first, CI first, and any other that writes', () => {
    const hosts = hostReadings(
      [{ name: 'dev-x', role: 'dev' }, { name: 'ci-10', role: 'ci' }, { name: 'ci-2', role: 'ci' }],
      [written('ci-2', text()), written('lab-1', text())],
      (AT + 30) * 1000,
    )
    assert.deepEqual(hosts.map((host) => [host.name, host.role, host.state]), [['ci-2', 'ci', 'ok'], ['ci-10', 'ci', 'none'], ['dev-x', 'dev', 'none'], ['lab-1', 'other', 'ok']])
    assert.equal(hosts[1].problem, "n'a encore rien écrit")
  })

  it('says why a reading is refused, in its own words', () => {
    const [host] = hostReadings([], [written('ci-1', text({ v: 2 }))])
    assert.deepEqual([host.state, host.problem, host.reading], ['unreadable', 'format inconnu', null])
  })

  it('names a variable after a login or a host, and reads only those names back', () => {
    assert.equal(variableOf(MEMBER_PREFIX, 'v-barbanneau'), 'BOARD_MEMBER_V_BARBANNEAU')
    assert.equal(variableOf(HOST_PREFIX, 'ci-1'), 'BOARD_HOST_CI_1')
    assert.equal(parseHost('BOARD_HOST_CI_1', '{}', 'x')?.name, 'ci-1')
    assert.equal(parseHost('BOARD_HOST_', '{}', 'x'), null)
    assert.equal(parseHost('BOARD_HOST_CI_1', 'x'.repeat(70_000), 'x'), null, 'more than a variable holds is not a reading')
  })

  it('reads who is online, and nothing from the future', () => {
    const now = Date.parse('2026-11-07T12:00:00Z')
    const member = (value: object, name = 'BOARD_MEMBER_VBARBANNEAU') => parseMember(name, JSON.stringify(value), ['vbarbanneau'], now)
    assert.deepEqual(member({ v: 1, at: '2026-11-07T11:58:00Z', reply: 'auto' }), { login: 'vbarbanneau', at: '2026-11-07T11:58:00.000Z', online: true, reply: 'auto' })
    assert.equal(member({ v: 1, at: '2026-11-07T11:30:00Z', reply: 'auto' })?.online, false, 'gone after 12 minutes')
    assert.equal(member({ v: 1, at: '2026-11-08T12:00:00Z', reply: 'auto' }), null)
    assert.equal(member({ v: 1, at: '2026-11-07T11:58:00Z', reply: 'rm -rf' })?.reply, 'off')
    assert.equal(member({ v: 1, at: '2026-11-07T11:58:00Z' }, 'BOARD_MEMBER_SOMEONE'), null, 'only members')
  })
})

describe('what the brief says of the hosts', () => {
  const base: Omit<InfraSnapshot, 'brief'> = {
    at: '2026-11-07T03:00:00.000Z',
    runners: [],
    jobs: [],
    truncated: false,
    pulls: null,
    waiting: [],
    stateAt: null,
    milestones: [],
    main: null,
    endpoints: [],
    hosts: [],
    live: { pull: false, main: false },
  }
  const host = (name: string, change?: Record<string, unknown>, age = 30): HostReading => {
    const { reading } = read(change)
    const role = name.startsWith('ci-') ? 'ci' : 'dev'
    return { name, role, state: 'ok', age, reading, signals: signalsOf(role, reading, age), problem: null }
  }
  const said = (...hosts: HostReading[]) => briefOf({ ...base, hosts })

  it('says only what is red', () => {
    assert.deepEqual(said(host('ci-1'), host('ci-2', { memory_available_lowest_mib: 1000 })), [], 'amber stays on the tab')
    assert.deepEqual(said(host('ci-1', { oom_kills: 2, points: [[AT - 60, 1800, 90, 40_050, 0], [AT, 2900, 37, 40_000, 2]] })), ['ci-1 a eu 2 OOM ces 6 dernières heures.'])
    assert.deepEqual(said(host('dev-rodolphe', { disk_free_mib: 2000, points: [] })), ["dev-rodolphe n'a plus que 2 % de disque libre."])
    assert.deepEqual(said(host('ci-3', {}, 1260)), ['ci-3 ne donne plus de relevé depuis 21 min.'])
  })

  it('says an endpoint that fails', () => {
    assert.deepEqual(briefOf({ ...base, hosts: [], endpoints: [{ name: 'Production', url: 'https://x.example', ok: false, status: 502, ms: 12 }] }), ['Production répond en erreur (502).'])
  })
})

describe('the chart of the lowest free memory', () => {
  const host = (name: string, points: [number, number][]) => ({ name, reading: { points: points.map(([at, lowest]) => ({ at, lowest })) } })

  it('keeps the lowest of each step, and a gap where there is no point', () => {
    const chart = lowestMemoryOf([host('ci-1', [[AT - 900, 3000], [AT - 840, 2500], [AT, 2000]]), host('ci-2', [[AT - 60, 4000]]), { name: 'ci-3', reading: null }], 300, 1800)
    assert.ok(chart)
    assert.deepEqual(
      chart.series.map((one) => one.name),
      ['ci-1', 'ci-2'],
      'a host without points has no line',
    )
    assert.equal(chart.times[0], AT - 900, 'the steps start at the first point')
    assert.deepEqual(chart.series[0].values, [2500, null, null, 2000])
    assert.deepEqual(chart.series[1].values, [null, null, 4000, null])
  })

  it('has nothing to draw without points', () => {
    assert.equal(lowestMemoryOf([{ name: 'ci-1', reading: null }]), null)
  })
})

describe('what the server says about the probes, on a screen in English', () => {
  afterEach(() => setLanguage('fr'))

  it('reads every reason and every line of the brief, and keeps the name and figures of the host', () => {
    setLanguage('en')
    const said = ['ci-1 a eu 2 OOM ces 6 dernières heures.', "dev-rodolphe n'a plus que 2 % de disque libre.", 'ci-3 ne donne plus de relevé depuis 21 min.']
    for (const line of said) {
      const english = localize(line)
      assert.notEqual(english, line)
      assert.doesNotMatch(english, /[éèà]|sonde|disque|relevé/)
      assert.match(english, /^(ci-[123]|dev-rodolphe)[ ']/)
      for (const figure of line.match(/\d+(?= )/g) ?? []) assert.ok(english.includes(figure), `${line} -> ${english}`)
    }
    const host = localizeData({ hosts: [{ name: 'ci-1', state: 'unreadable', problem: 'valeur refusée (cpuBusy)' }] }).hosts
    assert.deepEqual(host.map((one) => [one.name, one.problem]), [['ci-1', 'value refused (cpuBusy)']])
  })
})

/** Keeps the type in use, so that a change of shape fails here too. */
export type { ProbeReading }
