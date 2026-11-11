import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, it } from 'node:test'
import { type GhRequest } from '../../src/server/github/copy.ts'
import { briefOf, Infra, type InfraJob, type InfraSnapshot, jobState } from '../../src/server/infra/infra.ts'
import { edgeWidth, hostLevel, mapModel } from '../../src/client/features/overview/environment-map-data.ts'

const temp: string[] = []
afterEach(() => {
  for (const dir of temp.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const job = (state: InfraJob['state'], end: string | null = '2026-11-05T10:00:00Z', branch = 'area/x'): InfraJob => ({
  id: 1,
  branch,
  pr: null,
  state,
  start: '2026-11-05T09:50:00Z',
  end,
  runner: 'ci-1',
})
const base: Omit<InfraSnapshot, 'brief'> = {
  at: '2026-11-05T15:00:00.000Z',
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

describe('the situation in plain sentences', () => {
  it('says CI is red only when its last jobs failed', () => {
    const red = briefOf({ ...base, jobs: [job('failure'), job('failure'), job('failure')] })
    assert.match(red[0], /La CI est rouge/)
    const mixed = briefOf({ ...base, jobs: [job('success', '2026-11-05T11:00:00Z'), job('failure'), job('failure')] })
    assert.match(mixed[0], /La CI a 2 échecs sur ses 3 derniers jobs/)
    const green = briefOf({ ...base, jobs: [job('success'), job('success')] })
    assert.match(green[0], /La CI est verte/)
  })

  it('says main is red, and what runs', () => {
    const text = briefOf({ ...base, main: { at: '', ci: 'failure' }, jobs: [job('success'), job('running', null), job('queued', null)] })
    assert.match(text[0], /La CI de main est rouge\. 1 job en cours, 1 en file\./)
  })

  it('names who a decision waits for', () => {
    const text = briefOf({ ...base, waiting: [{ number: 523, title: 't', who: 'Rodolphe', question: 'q' }] })
    assert.deepEqual(text, ['Une décision attend Rodolphe : #523.'])
    assert.match(briefOf({ ...base, waiting: [{ number: 1, title: '', who: '', question: '' }, { number: 2, title: '', who: '', question: '' }] })[0], /2 décisions/)
  })

  it("doesn't say nothing waits when it doesn't know yet", () => {
    assert.deepEqual(briefOf({ ...base, waiting: null }), [])
  })

  it('never rounds a milestone up to done', () => {
    assert.match(briefOf({ ...base, milestones: [{ title: 'M0 · x', closed: 499, total: 500, due: '2026-11-05T00:00:00Z' }] })[0], /à 99 %/)
  })

  it('warns about the next milestone only when it is close', () => {
    const milestone = (due: string) => [{ title: 'M0 · Foundation', closed: 71, total: 100, due }]
    assert.match(briefOf({ ...base, milestones: milestone('2026-11-05T00:00:00Z') })[0], /M0 arrive à échéance aujourd'hui, à 71 %/)
    assert.match(briefOf({ ...base, milestones: milestone('2026-11-04T00:00:00Z') })[0], /M0 a dépassé son échéance/)
    assert.match(briefOf({ ...base, milestones: milestone('2026-11-07T00:00:00Z') })[0], /dans 2 jours/)
    assert.deepEqual(briefOf({ ...base, milestones: milestone('2026-12-01T00:00:00Z') }), [])
  })

  it('says when an endpoint stops answering, and is quiet otherwise', () => {
    const endpoint = (ok: boolean, status: number | null) => [{ name: 'Production', url: 'https://x.example', ok, status, ms: 1 }]
    assert.deepEqual(briefOf({ ...base, endpoints: endpoint(false, null) }), ['Production ne répond pas.'])
    assert.deepEqual(briefOf({ ...base, endpoints: endpoint(false, 503) }), ['Production répond en erreur (503).'])
    assert.deepEqual(briefOf({ ...base, endpoints: endpoint(true, 200) }), [])
  })
})

describe('a window nobody can see', () => {
  it('answers from the last picture, however old, and asks nothing', async () => {
    const asked: string[] = []
    let time = 1_000_000
    const ask: GhRequest = async (args) => {
      asked.push(args.join(' '))
      return args.join(' ').includes('runners') ? JSON.stringify({ runners: [] }) : JSON.stringify({ workflow_runs: [] })
    }
    const root = mkdtempSync(join(tmpdir(), 'board-infra-'))
    temp.push(root)
    const infra = new Infra({ knowledgeRoot: root, repo: 'acme/app', ask, endpoints: () => [], probe: async () => ({ ok: true, status: 200, ms: 1 }), hosts: async () => [], clock: () => time })
    assert.equal(infra.last(), null, 'nothing read yet')
    assert.equal(asked.length, 0, 'and nothing asked')
    const first = await infra.snapshot()
    const count = asked.length
    time += 3_600_000
    assert.equal(infra.last(), first)
    assert.equal(asked.length, count)
    await infra.snapshot()
    assert.ok(asked.length > count)
  })

  it('remembers for an hour that this login may not list runners', async () => {
    const asked: string[] = []
    let time = 1_000_000
    const ask: GhRequest = async (args) => {
      asked.push(args.join(' '))
      if (args.join(' ').includes('runners')) throw new Error('GitHub 403: Must have admin rights')
      return JSON.stringify({ workflow_runs: [] })
    }
    const root = mkdtempSync(join(tmpdir(), 'board-infra-'))
    temp.push(root)
    const infra = new Infra({ knowledgeRoot: root, repo: 'acme/app', ask, endpoints: () => [], probe: async () => ({ ok: true, status: 200, ms: 1 }), hosts: async () => [], clock: () => time })
    assert.equal((await infra.snapshot()).runners, null)
    const runners = () => asked.filter((line) => line.includes('runners')).length
    assert.equal(runners(), 1)
    time += 60_000
    assert.equal((await infra.snapshot()).runners, null)
    assert.equal(runners(), 1)
    time += 3_600_000
    await infra.snapshot()
    assert.equal(runners(), 2)
  })
})

describe('what can go wrong reading runners and copies', () => {
  const reader = (ask: GhRequest, root: string, clock = () => 1_000_000) => new Infra({ knowledgeRoot: root, repo: 'acme/app', ask, endpoints: () => [], probe: async () => ({ ok: true, status: 200, ms: 1 }), hosts: async () => [], clock })

  it('says a spent quota is a failure, not a lack of rights', async () => {
    const root = mkdtempSync(join(tmpdir(), 'board-infra-'))
    temp.push(root)
    let limited = true
    const ask: GhRequest = async (args) => {
      if (args.join(' ').includes('runners')) {
        if (limited) throw new Error('gh: API rate limit exceeded for user (HTTP 403)')
        return JSON.stringify({ runners: [{ name: 'ci-1', status: 'online', busy: false }] })
      }
      return JSON.stringify({ workflow_runs: [] })
    }
    let time = 1_000_000
    const infra = reader(ask, root, () => time)
    await assert.rejects(infra.snapshot(), /rate limit/)
    limited = false
    time += 60_000
    assert.deepEqual((await infra.snapshot()).runners, [{ name: 'ci-1', online: true, busy: false }])
  })

  it('does not take a passing 404 for a refusal', async () => {
    const root = mkdtempSync(join(tmpdir(), 'board-infra-'))
    temp.push(root)
    let times = 0
    const ask: GhRequest = async (args) => {
      if (args.join(' ').includes('runners')) {
        times += 1
        throw new Error('gh: Not Found (HTTP 404)')
      }
      return JSON.stringify({ workflow_runs: [] })
    }
    let time = 1_000_000
    const infra = reader(ask, root, () => time)
    assert.equal((await infra.snapshot()).runners, null)
    time += 60_000
    await infra.snapshot()
    assert.equal(times, 2)
  })

  it('draws without a copy that is damaged', async () => {
    for (const damaged of ['{not json', 'null', '3', '[]']) {
      const root = mkdtempSync(join(tmpdir(), 'board-infra-'))
      temp.push(root)
      mkdirSync(join(root, 'github'), { recursive: true })
      mkdirSync(join(root, 'roadmap'), { recursive: true })
      writeFileSync(join(root, 'github', 'state.json'), damaged)
      writeFileSync(join(root, 'github', 'history.json'), damaged)
      writeFileSync(join(root, 'github', 'milestones.json'), damaged === '[]' ? '{}' : damaged)
      const snapshot = await reader(async (args) => (args.join(' ').includes('runners') ? JSON.stringify({ runners: [] }) : JSON.stringify({ workflow_runs: [] })), root).snapshot()
      assert.equal(snapshot.pulls, null, damaged)
      assert.deepEqual(snapshot.milestones, [], damaged)
    }
  })
})

describe('reading the infrastructure', () => {
  const setup = () => {
    const root = mkdtempSync(join(tmpdir(), 'board-infra-'))
    temp.push(root)
    mkdirSync(join(root, 'github'))
    mkdirSync(join(root, 'roadmap'))
    writeFileSync(join(root, 'github', 'state.json'), JSON.stringify({ pulls: { open: 13, draft: 2, red: 0 }, waiting: [{ number: 523, title: 't', who: 'Rodolphe', question: 'q' }] }))
    writeFileSync(join(root, 'github', 'milestones.json'), JSON.stringify([{ title: 'M1 · Core', closed: 3, total: 26, due: '2027-01-01T00:00:00Z' }]))
    const asked: string[] = []
    const world = { runnersError: '' as string, runs: [
      { id: 1, run_attempt: 1, status: 'completed', conclusion: 'success', event: 'pull_request', head_branch: 'area/x', run_started_at: '2026-11-05T14:00:00Z', updated_at: '2026-11-05T14:05:00Z', pull_requests: [{ number: 7 }] },
      { id: 2, run_attempt: 1, status: 'in_progress', conclusion: null, event: 'push', head_branch: 'main', run_started_at: '2026-11-05T14:30:00Z', updated_at: '2026-11-05T14:30:30Z', pull_requests: [] },
      { id: 3, run_attempt: 1, status: 'completed', conclusion: 'success', event: 'push', head_branch: 'main', run_started_at: '2026-11-05T09:00:00Z', updated_at: '2026-11-05T09:10:00Z', pull_requests: [] },
    ] as any[] }
    const ask: GhRequest = async (args) => {
      const line = args.join(' ')
      asked.push(line)
      if (line.includes('actions/runners')) {
        if (world.runnersError) throw new Error(world.runnersError)
        return JSON.stringify({ runners: [{ name: 'ci-1', status: 'online', busy: true }] })
      }
      if (line.includes('actions/runs/1/jobs')) return JSON.stringify({ jobs: [{ id: 10, status: 'completed', conclusion: 'success', started_at: '2026-11-05T14:00:10Z', completed_at: '2026-11-05T14:05:00Z', runner_name: 'GitHub Actions 3' }] })
      if (line.includes('actions/runs/2/jobs')) return JSON.stringify({ jobs: [{ id: 20, status: 'in_progress', conclusion: null, started_at: '2026-11-05T14:30:10Z', completed_at: null, runner_name: 'ci-1' }] })
      if (line.includes('actions/runs?')) return JSON.stringify({ workflow_runs: world.runs })
      throw new Error(`unexpected: ${line}`)
    }
    let probes = 0
    const probed: string[][] = []
    let time = Date.parse('2026-11-05T14:31:00Z')
    const infra = new Infra({
      knowledgeRoot: root,
      ask,
      probe: async () => {
        probes++
        return { ok: true, status: 200, ms: 50 }
      },
      repo: 'acme/app',
      endpoints: () => [{ name: 'Old production', url: 'https://app.example.com' }],
      hosts: async () => {
        probed.push(['asked'])
        return []
      },
      clock: () => time,
    })
    return { infra, asked, world, probes: () => probes, probed, advance: (ms: number) => (time += ms) }
  }

  it('brings together what GitHub and the board know', async () => {
    const { infra, probed } = setup()
    const found = await infra.snapshot()
    assert.deepEqual(probed, [['asked']], 'the hosts, from the variables')
    assert.deepEqual(found.hosts, [])
    assert.deepEqual(found.runners, [{ name: 'ci-1', online: true, busy: true }])
    assert.equal(found.jobs.length, 2, 'a run idle for over two hours stays out')
    assert.equal(found.jobs[0].pr, 7)
    assert.equal(found.jobs[0].state, 'success')
    assert.equal(found.jobs[1].end, null)
    assert.deepEqual(found.live, { pull: false, main: true })
    assert.deepEqual(found.main, { at: '2026-11-05T14:30:00Z', ci: 'running' })
    assert.equal(found.pulls?.open, 13)
    assert.equal(found.waiting?.[0].who, 'Rodolphe')
    assert.equal(found.milestones[0].closed, 3)
    assert.deepEqual(found.endpoints.map((one) => [one.name, one.ok]), [['Old production', true]])
    assert.ok(found.brief.some((line) => line.includes('Rodolphe')))
  })

  it('shows a run started again as running, then its new result', async () => {
    const { infra, world, asked, advance } = setup()
    await infra.snapshot()
    asked.length = 0
    world.runs[0] = { ...world.runs[0], status: 'in_progress', conclusion: null, run_attempt: 2, updated_at: '2026-11-05T14:31:00Z' }
    advance(31_000)
    await infra.snapshot()
    assert.ok(asked.some((line) => line.includes('runs/1/jobs')), 'while it runs')
    asked.length = 0
    world.runs[0] = { ...world.runs[0], status: 'completed', conclusion: 'failure' }
    advance(31_000)
    await infra.snapshot()
    assert.ok(asked.some((line) => line.includes('runs/1/jobs')), 'its new result')
    asked.length = 0
    advance(31_000)
    await infra.snapshot()
    assert.ok(!asked.some((line) => line.includes('runs/1/jobs')), 'then never again')
  })

  it('answers from memory for 30 seconds, and asks one finished run once', async () => {
    const { infra, asked, advance, probes } = setup()
    await infra.snapshot()
    const first = asked.length
    await infra.snapshot()
    assert.equal(asked.length, first, 'nothing new within 30 seconds')
    advance(31_000)
    asked.length = 0
    await infra.snapshot()
    assert.ok(!asked.some((line) => line.includes('runs/1/jobs')), 'a finished run is not asked again')
    assert.ok(asked.some((line) => line.includes('runs/2/jobs')), 'a running one is')
    assert.equal(probes(), 1, 'the public probe stays at once a minute')
    advance(31_000)
    await infra.snapshot()
    assert.equal(probes(), 2)
  })

  it('makes one request at a time, however many ask', async () => {
    const { infra, asked } = setup()
    await Promise.all([infra.snapshot(), infra.snapshot()])
    assert.equal(asked.filter((line) => line.includes('actions/runs?')).length, 1)
  })

  it('works with a login that may not list the runners', async () => {
    const { infra, world } = setup()
    world.runnersError = 'GitHub 403: Must have admin rights'
    assert.equal((await infra.snapshot()).runners, null)
  })

  it("doesn't blame the login when GitHub simply fails", async () => {
    const { infra, world } = setup()
    world.runnersError = 'HTTP 502: Bad Gateway'
    await assert.rejects(infra.snapshot(), /502/)
  })

  it('reads the state of a job', () => {
    assert.equal(jobState({ status: 'completed', conclusion: 'success' }), 'success')
    assert.equal(jobState({ status: 'completed', conclusion: 'failure' }), 'failure')
    assert.equal(jobState({ status: 'completed', conclusion: 'cancelled' }), 'other')
    assert.equal(jobState({ status: 'completed', conclusion: 'startup_failure' }), 'failure')
    assert.equal(jobState({ status: 'completed', conclusion: 'timed_out' }), 'failure')
    assert.equal(jobState({ status: 'in_progress' }), 'running')
    assert.equal(jobState({ status: 'queued' }), 'queued')
  })
})

describe('the map of the environment', () => {
  const snapshot = (more: Partial<InfraSnapshot> = {}): InfraSnapshot => ({ ...base, brief: [], ...more })
  const reading = (name: string, role: 'ci' | 'dev' | 'server' | 'other', signals: { memory: 'ok' | 'amber' | 'red'; disk: 'ok' | 'amber' | 'red'; age: 'ok' | 'amber' | 'red' } | null) =>
    ({ name, role, state: signals ? 'ok' : 'none', age: signals ? 10 : null, reading: null, signals: signals ? { ...signals, oomRecent: 0, memoryLowest6h: 4000, memoryFloor: 1536 } : null, problem: null }) as any

  it('draws what was read, and nothing else', () => {
    const data = snapshot({
      runners: [{ name: 'ci-1', online: true, busy: true }, { name: 'ci-2', online: false, busy: false }],
      jobs: [{ ...job('running'), runner: 'ci-1', pr: 1093 }, job('success'), job('success'), job('failure')],
      pulls: { open: 5, draft: 2, red: 1 },
      main: { at: '2026-11-05T15:00:00.000Z', ci: 'success' },
      endpoints: [{ name: 'Production', url: 'https://example.invalid', ok: true, status: 200, ms: 65 }],
      hosts: [reading('ci-1', 'ci', { memory: 'ok', disk: 'ok', age: 'ok' }), reading('dev-a', 'dev', { memory: 'amber', disk: 'ok', age: 'ok' }), reading('srv', 'server', null)],
      live: { pull: true, main: false },
    })
    const model = mapModel(data, [{ online: true }, { online: false }, { online: false }], 'acme/app')
    assert.deepEqual(model.repository, { name: 'acme/app', main: 'success', pulls: 5, merging: false, running: 1, queued: 0 })
    assert.deepEqual(model.members, { online: 1, total: 3, faces: [] })
    assert.deepEqual(model.runners, [
      { name: 'ci-1', state: 'busy', jobs: 4, running: '#1093', since: '2026-11-05T09:50:00Z' },
      { name: 'ci-2', state: 'offline', jobs: 0, running: null, since: null },
    ])
    assert.deepEqual(model.hosts, [
      { name: 'dev-a', role: 'dev', level: 'amber', cpu: null, memory: null, disk: null },
      { name: 'srv', role: 'server', level: 'none', cpu: null, memory: null, disk: null },
    ])
    assert.deepEqual(model.endpoints, [{ name: 'Production', ok: true, ms: 65, status: 200 }])
  })

  it('names the runners from the jobs when this login cannot list them, and knows nobody when nobody is known', () => {
    const model = mapModel(snapshot({ runners: null, jobs: [job('success'), { ...job('success'), runner: 'ci-9' }] }), null, 'acme/app')
    assert.deepEqual(model.runners.map((runner) => [runner.name, runner.state, runner.jobs]), [['ci-1', 'idle', 1], ['ci-9', 'idle', 1]])
    assert.equal(model.members, null)
    assert.equal(model.repository.pulls, null)
  })

  it('thickens a line with its jobs, up to a point', () => {
    assert.deepEqual([0, 1, 2, 5, 10, 40].map(edgeWidth), [1, 1, 2, 3, 5, 5])
    assert.equal(hostLevel(reading('x', 'dev', { memory: 'ok', disk: 'red', age: 'amber' })), 'red')
    assert.equal(hostLevel(reading('x', 'dev', null)), 'none')
  })
})
