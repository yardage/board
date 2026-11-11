import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import type { BoardOptions } from '../../src/server/board/board.ts'
import { defaultConfig, type EnvironmentConfig } from '../../src/server/environment/config.ts'
import { BoardGit } from '../../src/server/environment/git.ts'
import { formatMessage, parseMessage, setAliases, Store } from '../../src/server/environment/store.ts'
import { checkNames, createIssues, forAgents, type IssueApi, issueBody, issueMark, parseSynthesis, readAnswer, stateOf, stringsOf, synthesisBody, synthesisTask, withStrings } from '../../src/server/ai/synthesis.ts'
import { safeForGithub } from '../../src/server/ai/tools.ts'
import { startTestBoard as startBoard, testConfig } from '../support/helpers.ts'

const temp: string[] = []
beforeEach(() => setAliases(testConfig().aliases))
afterEach(() => {
  setAliases({})
  for (const dir of temp.splice(0)) rmSync(dir, { recursive: true, force: true })
})
const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), 'board-synthesis-'))
  temp.push(dir)
  return dir
}

const ITEM = { title: 'Read the hosts', owner: 'rodolphebarbanneau', repo: '', what: 'Place a reader.', why: 'To see memory.', done: ['A host reports'], area: 'area:infra', type: 'Task', milestone: 'M5 · Production readiness', after: [] }
const GOOD = { decisions: ['A read-only reader on each host.', 'Refresh every 5 minutes.'], open: [], work: [ITEM, { ...ITEM, title: 'Show the hosts', owner: 'vbarbanneau', area: 'area:docs', after: [0] }] }
const NAMES = { members: ['rodolphebarbanneau', 'vbarbanneau'], repos: ['acme/app'], areas: ['area:docs', 'area:infra'], milestones: ['M5 · Production readiness'] }
const ACCESS = { code: false, issues: { create: true, comment: true, edit: false, close: false }, pulls: { comment: false, edit: false, review: false } }
const CONFIG: EnvironmentConfig = { ...defaultConfig('test'), repos: [{ name: 'acme/app', ...ACCESS }, { name: 'acme/infra', ...ACCESS }] }

describe('reading a synthesis', () => {
  it('takes a good answer, even with a fence around it', () => {
    assert.equal(readAnswer(`Here it is:\n\`\`\`json\n${JSON.stringify(GOOD)}\n\`\`\``).work.length, 2)
  })

  it('refuses what it could not create', () => {
    assert.throws(() => readAnswer('Nothing to say.'), /synthèse/)
    assert.throws(() => parseSynthesis({ decisions: [], open: [], work: [] }), /vide/)
    assert.throws(() => parseSynthesis({ work: [{ ...ITEM, owner: 'not a login!' }] }), /personne inconnue/)
    assert.throws(() => parseSynthesis({ work: [{ ...ITEM, type: 'Epic' }] }), /type inconnu/)
    assert.throws(() => parseSynthesis({ work: [{ ...ITEM, repo: '../evil' }] }), /dépôt inconnu/)
    assert.throws(() => parseSynthesis({ work: [{ ...ITEM, done: [] }] }), /critères/)
    assert.throws(() => parseSynthesis({ work: [{ ...ITEM, after: [0] }] }), /élément précédent/)
    assert.throws(() => parseSynthesis({ decisions: Array(13).fill('Yes.') }), /plus de 12/)
  })

  it('reads a synthesis from before environments, its owners by their old names', () => {
    const old = parseSynthesis({ work: [{ ...ITEM, owner: 'victor', repo: undefined }] })
    assert.equal(old.work[0].owner, 'vbarbanneau')
    assert.equal(old.work[0].repo, '')
  })

  it('leaves out a label, a type or a milestone the repository has none of', () => {
    const plain = parseSynthesis({ work: [{ ...ITEM, area: '', type: '', milestone: '' }] })
    assert.deepEqual([plain.work[0].area, plain.work[0].type, plain.work[0].milestone], ['', '', ''])
  })

  it('never lets its text mention anyone', () => {
    assert.deepEqual(parseSynthesis({ decisions: ['Ask @vbarbanneau about it.'] }).decisions, ['Ask vbarbanneau about it.'])
  })

  it('checks the names against the environment and the repository', () => {
    const synthesis = parseSynthesis(GOOD)
    assert.throws(() => checkNames(synthesis, { ...NAMES, areas: ['area:docs'] }), /area:infra/)
    assert.throws(() => checkNames(synthesis, { ...NAMES, milestones: ['M0'] }), /jalon/)
    assert.throws(() => checkNames(synthesis, { ...NAMES, members: ['vbarbanneau'] }), /membre/)
    assert.throws(() => checkNames(synthesis, { ...NAMES, repos: [] }), /ne peut pas y créer/)
    assert.throws(() => checkNames(parseSynthesis({ work: [{ ...ITEM, repo: 'acme/web' }] }), NAMES), /acme\/web/)
    assert.doesNotThrow(() => checkNames(synthesis, NAMES))
    assert.doesNotThrow(() => checkNames(parseSynthesis({ work: [{ ...ITEM, repo: 'acme/infra', area: 'area:unknown', milestone: 'Nope' }] }), { ...NAMES, repos: ['acme/app', 'acme/infra'] }), 'labels and milestones are known for the main repository only')
  })

  it('goes through a message file and back, and a bad one stays a message', () => {
    const synthesis = parseSynthesis(GOOD)
    const base = { author: 'vbarbanneau', agent: 'auto' as const, createdAt: '2026-11-05T10:00:00Z', mentions: [], sources: [], attachments: [], body: synthesisBody(synthesis) }
    assert.deepEqual(parseMessage('t', 'm', formatMessage({ ...base, synthesis }))?.synthesis, synthesis)
    const bad = parseMessage('t', 'm', `---\nauthor: vbarbanneau\ncreatedAt: 2026-11-05T10:00:00Z\nsynthesis: {"work":[{}]}\n---\nHello\n`)
    assert.equal(bad?.body, 'Hello')
    assert.equal(bad?.synthesis, undefined)
  })

  it('translates every text and keeps the rest', () => {
    const synthesis = parseSynthesis(GOOD)
    const upper = withStrings(synthesis, stringsOf(synthesis).map((text) => text.toUpperCase()))
    assert.equal(upper.decisions[1], 'REFRESH EVERY 5 MINUTES.')
    assert.equal(upper.work[1].title, 'SHOW THE HOSTS')
    assert.equal(upper.work[1].done[0], 'A HOST REPORTS')
    assert.equal(upper.work[1].owner, 'vbarbanneau')
  })
})

describe('what a synthesis waits for', () => {
  it('nothing once there is work and nothing is open: GitHub approves the work itself', () => {
    assert.equal(stateOf(parseSynthesis(GOOD), []).waiting, null)
  })

  it('a member to settle what is open, and work to create', () => {
    assert.equal(stateOf(parseSynthesis({ ...GOOD, open: ['Every 5 or 10 minutes?'] }), []).waiting, 'open')
    assert.equal(stateOf(parseSynthesis({ decisions: ['Yes.'] }), []).waiting, 'no-work')
  })

  it('tells agents which issues it became', () => {
    assert.equal(forAgents(stateOf(parseSynthesis(GOOD), [{ index: 0, number: 7 }, { index: 1, number: 3, repo: 'acme/infra' }])), 'Issues created from the latest synthesis: #7, acme/infra#3.')
    assert.equal(forAgents(stateOf(parseSynthesis(GOOD), [])), '')
  })

  it('tells the model the members, the repositories and the limits', () => {
    const task = synthesisTask(NAMES)
    assert.match(task, /at most 400 characters/)
    assert.match(task, /at most 90 for each title/)
    assert.match(task, /rodolphebarbanneau, vbarbanneau/)
    assert.match(task, /one of: acme\/app/)
    assert.match(synthesisTask({ ...NAMES, repos: [] }), /create no issue, so leave it empty/)
  })
})

describe('claiming with Git', () => {
  it('gives one winner on two computers, and leaves both able to pull', async () => {
    const origin = tempDir()
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin])
    const clone = () => {
      const dir = tempDir()
      execFileSync('git', ['clone', '-q', origin, dir])
      execFileSync('git', ['-C', dir, 'config', 'user.name', 'test'])
      execFileSync('git', ['-C', dir, 'config', 'user.email', 'test@example.invalid'])
      return dir
    }
    const first = clone()
    execFileSync('git', ['-C', first, 'commit', '-q', '--allow-empty', '-m', 'start'])
    execFileSync('git', ['-C', first, 'branch', '-M', 'main'])
    execFileSync('git', ['-C', first, 'push', '-q', '-u', 'origin', 'main'])
    const second = clone()
    for (let round = 0; round < 5; round++) {
      const path = `threads/t/issues-${round}.claim`
      const [a, b] = [new BoardGit(first), new BoardGit(second)]
      const results = await Promise.all([a.claim(path, 'a'), b.claim(path, 'b')])
      assert.equal(results[0], results[1], 'both are told the same winner')
      await a.pull()
      await b.pull()
      assert.equal(a.lastError, null)
      assert.equal(b.lastError, null)
      assert.equal(execFileSync('git', ['-C', first, 'status', '--porcelain']).toString(), '')
      assert.equal(execFileSync('git', ['-C', second, 'status', '--porcelain']).toString(), '')
    }
  })

  it('keeps the first claim when asked again', async () => {
    const dir = tempDir()
    execFileSync('git', ['init', '-q', dir])
    execFileSync('git', ['-C', dir, 'config', 'user.name', 'test'])
    execFileSync('git', ['-C', dir, 'config', 'user.email', 'test@example.invalid'])
    execFileSync('git', ['-C', dir, 'commit', '-q', '--allow-empty', '-m', 'start'])
    const git = new BoardGit(dir)
    assert.equal(await git.claim('threads/t/x.claim', 'one'), 'one')
    assert.equal(await git.claim('threads/t/x.claim', 'two'), 'one')
  })

  it('skips the network when the remote has not moved', async () => {
    const origin = tempDir()
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin])
    const dir = tempDir()
    execFileSync('git', ['clone', '-q', origin, dir])
    execFileSync('git', ['-C', dir, 'config', 'user.name', 'test'])
    execFileSync('git', ['-C', dir, 'config', 'user.email', 'test@example.invalid'])
    execFileSync('git', ['-C', dir, 'commit', '-q', '--allow-empty', '-m', 'start'])
    execFileSync('git', ['-C', dir, 'branch', '-M', 'main'])
    execFileSync('git', ['-C', dir, 'push', '-q', '-u', 'origin', 'main'])
    const head = execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD']).toString().trim()
    let asked = 0
    const git = new BoardGit(dir, {
      remoteHead: async () => {
        asked++
        return head
      },
    })
    // The remote can't be reached: only skipping the pull lets this succeed.
    execFileSync('git', ['-C', dir, 'remote', 'set-url', 'origin', join(dir, 'no-such-remote')])
    assert.equal(await git.pull(), false)
    assert.equal(git.lastError, null)
    assert.equal(asked, 1)
  })
})

describe('creating the issues', () => {
  const thread = { id: 'thread-1', title: 'Hosts' }
  const fake = (failAt = Infinity, known: Record<string, number> = {}) => {
    const payloads: (Record<string, any> & { repo: string })[] = []
    const api: IssueApi = {
      milestones: async () => [{ number: 6, title: 'M5 · Production readiness' }],
      create: async (repo, payload) => {
        if (payloads.length >= failAt) throw new Error('HTTP 502')
        payloads.push({ ...payload, repo })
        return 100 + payloads.length
      },
      find: async (_repo, mark) => known[mark] ?? null,
    }
    return { api, payloads }
  }
  const create = (api: IssueApi, more: Partial<Parameters<typeof createIssues>[0]> = {}) => createIssues({ synthesis: parseSynthesis(GOOD), existing: [], thread, message: 'm', api, config: CONFIG, ...more })

  it('lays each one out like the forms, assigned, with its dependency numbered', async () => {
    const { api, payloads } = fake()
    const saved: number[] = []
    const { issues, error } = await create(api, { onCreated: async (list) => void saved.push(list.length) })
    assert.deepEqual(saved, [1, 2])
    assert.equal(error, null)
    assert.deepEqual(issues, [{ index: 0, number: 101 }, { index: 1, number: 102 }])
    assert.equal(payloads[0].repo, 'acme/app', 'the main repository by default')
    assert.deepEqual(payloads[0].assignees, ['rodolphebarbanneau'])
    assert.deepEqual(payloads[1].assignees, ['vbarbanneau'])
    assert.deepEqual(payloads[1].labels, ['area:docs'])
    assert.equal(payloads[1].milestone, 6)
    assert.equal(payloads[1].type, 'Task')
    for (const section of ['### Area', '### What', '### Why', '### Done when\n\n- [ ] A host reports', '### Depends on\n\n#101']) assert.ok(payloads[1].body.includes(section), section)
    assert.ok(!payloads[0].body.includes('### Depends on'))
  })

  it('creates in each item’s repository, and numbers a dependency only within one', async () => {
    const { api, payloads } = fake()
    const synthesis = parseSynthesis({ work: [ITEM, { ...ITEM, title: 'Elsewhere', repo: 'acme/infra', area: '', milestone: '', type: '', after: [0] }] })
    const { issues } = await create(api, { synthesis })
    assert.deepEqual(issues, [{ index: 0, number: 101 }, { index: 1, number: 102, repo: 'acme/infra' }])
    assert.equal(payloads[1].repo, 'acme/infra')
    assert.ok(!payloads[1].body.includes('### Depends on'), 'a number of another repository would point at the wrong issue')
    assert.equal(payloads[1].labels, undefined)
  })

  it('creates nothing where the environment does not allow it', async () => {
    const { api, payloads } = fake()
    const closed = { ...CONFIG, repos: [{ name: 'acme/app', ...ACCESS, issues: { ...ACCESS.issues, create: false } }] }
    const { error } = await create(api, { config: closed })
    assert.match(error ?? '', /ne permet pas de créer/)
    assert.equal(payloads.length, 0)
  })

  it('stops at a failure and never creates one twice', async () => {
    const first = fake(1)
    const partial = await create(first.api)
    assert.equal(partial.error, 'HTTP 502')
    assert.deepEqual(partial.issues, [{ index: 0, number: 101 }])
    const second = fake()
    const rest = await create(second.api, { existing: partial.issues })
    assert.equal(second.payloads.length, 1)
    assert.equal(second.payloads[0].title, 'Show the hosts')
    assert.ok(second.payloads[0].body.includes('#101'))
    assert.equal(rest.issues.length, 2)
  })

  it('creates nothing under a milestone that is gone', async () => {
    const { api, payloads } = fake()
    const { error } = await create(api, { synthesis: parseSynthesis({ work: [ITEM, { ...ITEM, milestone: 'M9' }] }) })
    assert.match(error ?? '', /M9/)
    assert.equal(payloads.length, 0)
  })

  it('says nothing about a dependency it has no number for', () => {
    assert.ok(!issueBody(parseSynthesis(GOOD).work[1], new Map(), thread, 'mark').includes('### Depends on'))
  })

  it('finds what a run cut short had already created', async () => {
    const { api, payloads } = fake(Infinity, { [issueMark('m', 0)]: 77 })
    const { issues } = await create(api, { resume: true })
    assert.deepEqual(issues, [{ index: 0, number: 77 }, { index: 1, number: 101 }])
    assert.equal(payloads.length, 1)
    assert.ok(payloads[0].body.includes('#77'))
    assert.ok(payloads[0].body.includes(issueMark('m', 1)))
  })

  it('notifies nobody, and hides nothing', () => {
    assert.equal(safeForGithub('Ask @someone, not me@example.invalid'), 'Ask @\u2060someone, not me@example.invalid')
    assert.equal(safeForGithub('<!-- hidden ![x](http://a/b.png)'), '&lt;!-- hidden [x](http://a/b.png)')
    assert.ok(!issueBody(parseSynthesis(GOOD).work[0], new Map(), { id: 't', title: '@someone <!--' }, 'mark').includes('<!--'))
  })
})

describe('the routes of a synthesis', () => {
  const post = (url: string, body: unknown = {}) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-board': '1' }, body: JSON.stringify(body) })
  const until = async (check: () => Promise<boolean>) => {
    for (let i = 0; i < 300; i++) {
      if (await check()) return
      await new Promise((done) => setTimeout(done, 10))
    }
    assert.fail('never happened')
  }

  async function board(answer: string | ((task: string) => string), extra: Partial<BoardOptions> = {}, remote = false, createDelay = 0) {
    const root = tempDir()
    execFileSync('git', ['init', '-q', root])
    execFileSync('git', ['-C', root, 'config', 'user.name', 'test'])
    execFileSync('git', ['-C', root, 'config', 'user.email', 'test@example.invalid'])
    writeFileSync(join(root, '.gitignore'), '.cache\nclient\n')
    execFileSync('git', ['-C', root, 'add', '.gitignore'])
    execFileSync('git', ['-C', root, 'commit', '-q', '-m', 'start'])
    let origin = ''
    if (remote) {
      origin = tempDir()
      execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin])
      execFileSync('git', ['-C', root, 'branch', '-M', 'main'])
      execFileSync('git', ['-C', root, 'remote', 'add', 'origin', origin])
      execFileSync('git', ['-C', root, 'push', '-q', '-u', 'origin', 'main'])
    }
    mkdirSync(join(root, 'client'))
    writeFileSync(join(root, 'client', 'index.html'), 'page')
    const store = new Store(root)
    const thread = await store.createThread({ title: 'Hosts', kind: 'topic', author: 'vbarbanneau' })
    await store.addMessage(thread.id, { author: 'vbarbanneau', body: 'What do we read on the hosts, and how often?' })
    if (remote) {
      execFileSync('git', ['-C', root, 'add', '--all', '--force', 'threads'])
      execFileSync('git', ['-C', root, 'commit', '-q', '-m', 'thread'])
      execFileSync('git', ['-C', root, 'push', '-q'])
    }
    const created: Record<string, any>[] = []
    const tasks: string[] = []
    const running = await startBoard({
      root,
      client: join(root, 'client'),
      port: 4781,
      config: { repos: [{ name: 'acme/app', ...ACCESS }] },
      translate: async (_system, text) => {
        const list: Record<string, string> = JSON.parse(text)
        return JSON.stringify(Object.fromEntries(Object.entries(list).map(([key, value]) => [key, `FR ${value}`])))
      },
      agent: async ({ task }) => {
        tasks.push(task)
        return { body: typeof answer === 'string' ? answer : answer(task), sources: ['github/README.md'], actions: [] }
      },
      issues: {
        milestones: async () => [{ number: 6, title: 'M5 · Production readiness' }],
        create: async (_repo, payload) => {
          await new Promise((done) => setTimeout(done, createDelay))
          created.push(payload)
          return 500 + created.length
        },
        find: async () => null,
      },
      claude: { status: async () => ({ installed: true, version: '1', loggedIn: true, method: null, plan: null }), login: async () => undefined },
      ...extra,
    })
    temp.push(root)
    const url = `${running.url}/api/threads/${thread.id}`
    const view = async () => (await fetch(url)).json()
    return { running, root, url, view, created, tasks, threadId: thread.id, origin, store }
  }

  it('goes from a click to issues, by any member, once', async () => {
    const { running, root, url, view, created } = await board(JSON.stringify(GOOD))
    try {
      assert.equal((await post(`${url}/synthesis`)).status, 202)
      await until(async () => (await view()).synthesis !== null)
      const first = await view()
      const route = `${url}/synthesis/${first.synthesis.id}`
      assert.equal(first.synthesis.state.waiting, null)
      assert.equal(first.messages.at(-1).author, 'vbarbanneau')
      assert.equal(first.messages.at(-1).agent, 'auto')
      assert.match(first.messages.at(-1).body, /Proposed decisions/)
      await until(async () => execFileSync('git', ['-C', root, 'log', '--oneline', '--', 'threads']).toString().includes('synthesised'))
      assert.equal((await post(`${route}/issues`)).status, 200)
      assert.equal(created.length, 2)
      const after = await view()
      assert.deepEqual(after.synthesis.state.issues.map((issue: { number: number }) => issue.number), [501, 502])
      assert.match(after.messages.at(-1).body, /#501, #502/)
      assert.equal((await post(`${route}/issues`)).status, 200, 'twice creates nothing more')
      assert.equal(created.length, 2)
    } finally {
      await running.stop()
    }
  })

  it('creates nothing while something is still open', async () => {
    const { running, url, view, created } = await board(JSON.stringify({ ...GOOD, open: ['Every 5 or 10 minutes?'] }))
    try {
      await post(`${url}/synthesis`)
      await until(async () => (await view()).synthesis !== null)
      const id = (await view()).synthesis.id
      assert.equal((await view()).synthesis.state.waiting, 'open')
      assert.equal((await post(`${url}/synthesis/${id}/issues`)).status, 409)
      assert.equal(created.length, 0)
    } finally {
      await running.stop()
    }
  })

  it('says why on the thread when the answer is no synthesis, and publishes nothing', async () => {
    const { running, url, view } = await board('I could not find anything.')
    try {
      await post(`${url}/synthesis`)
      await until(async () => (await view()).agentError !== null)
      const found = await view()
      assert.match(found.agentError, /Synthèse impossible/)
      assert.equal(found.synthesis, null)
      assert.equal(found.messages.length, 1)
    } finally {
      await running.stop()
    }
  })

  it('translates for the reader, and remembers it', async () => {
    const { running, url, view } = await board(JSON.stringify(GOOD))
    try {
      await post(`${url}/synthesis`)
      await until(async () => (await view()).synthesis !== null)
      const first = await view()
      assert.equal(first.messages.at(-1).language, 'en')
      assert.equal(first.synthesis.translated, null)
      // The view translates for the reader's language: this reader reads French.
      await post(`${running.url}/api/settings/language`, { language: 'fr' })
      const answer = await (await post(`${url}/synthesis/${first.synthesis.id}/translate`, { to: 'fr' })).json()
      assert.equal(answer.synthesis.decisions[0], 'FR A read-only reader on each host.')
      assert.equal((await view()).synthesis.translated.work[0].title, 'FR Read the hosts')
    } finally {
      await running.stop()
    }
  })

  /** A second computer, on the same remote. */
  const otherComputer = (origin: string) => {
    const dir = tempDir()
    execFileSync('git', ['clone', '-q', origin, dir])
    execFileSync('git', ['-C', dir, 'config', 'user.name', 'other'])
    execFileSync('git', ['-C', dir, 'config', 'user.email', 'other@example.invalid'])
    return dir
  }
  const pushAll = (dir: string) => {
    execFileSync('git', ['-C', dir, 'add', '--all', '--force', 'threads'])
    execFileSync('git', ['-C', dir, 'commit', '-q', '-m', 'other'])
    execFileSync('git', ['-C', dir, 'push', '-q'])
  }

  async function proposed(remote: boolean, createDelay = 0) {
    const setup = await board(JSON.stringify(GOOD), {}, remote, createDelay)
    await post(`${setup.url}/synthesis`)
    await until(async () => (await setup.view()).synthesis !== null)
    const id: string = (await setup.view()).synthesis.id
    await until(async () => execFileSync('git', ['-C', setup.root, 'log', '--oneline', '--', 'threads']).toString().includes('synthesised'))
    return { ...setup, id, route: `${setup.url}/synthesis/${id}` }
  }

  it('creates them once when asked twice at the same moment', async () => {
    const { running, route, created } = await proposed(false, 30)
    try {
      const statuses = (await Promise.all([post(`${route}/issues`), post(`${route}/issues`)])).map((answer) => answer.status).sort()
      assert.deepEqual(statuses, [200, 409])
      assert.equal(created.length, 2)
    } finally {
      await running.stop()
    }
  })

  it('refuses from an old copy: another member closed the thread, and it only arrives by pulling', async () => {
    const { running, route, created, origin, threadId } = await proposed(true)
    try {
      const other = otherComputer(origin)
      await new Store(other).addMessage(threadId, { author: 'rodolphebarbanneau', body: 'Fil clos.', status: 'closed' })
      pushAll(other)
      assert.equal((await post(`${route}/issues`)).status, 409)
      assert.equal(created.length, 0)
    } finally {
      await running.stop()
    }
  })

  it('refuses from an old copy: a newer synthesis arrives by pulling', async () => {
    const { running, route, created, origin, threadId } = await proposed(true)
    try {
      const other = otherComputer(origin)
      await new Store(other).addMessage(threadId, { author: 'rodolphebarbanneau', agent: 'auto', body: 'Newer.', synthesis: parseSynthesis({ decisions: ['Something else.'] }) })
      pushAll(other)
      assert.equal((await post(`${route}/issues`)).status, 409)
      assert.equal(created.length, 0)
    } finally {
      await running.stop()
    }
  })

  it('creates nothing when it cannot reach the remote', async () => {
    const { running, route, created, root } = await proposed(true)
    try {
      execFileSync('git', ['-C', root, 'remote', 'set-url', 'origin', join(root, 'no-such-remote')])
      assert.equal((await post(`${route}/issues`)).status, 503)
      assert.equal(created.length, 0)
    } finally {
      await running.stop()
    }
  })

  it('gives way to another member, who claimed first', async () => {
    const { running, route, created, origin, threadId, id } = await proposed(true)
    try {
      const other = otherComputer(origin)
      mkdirSync(join(other, 'threads', threadId), { recursive: true })
      writeFileSync(join(other, 'threads', threadId, `issues-${id}.claim`), JSON.stringify({ by: 'rodolphebarbanneau', at: 'x' }))
      pushAll(other)
      const answer = await post(`${route}/issues`)
      assert.equal(answer.status, 409)
      assert.match((await answer.json()).error, /Rodolphe/)
      assert.equal(created.length, 0)
    } finally {
      await running.stop()
    }
  })

  it('tries the synthesis again when asked, not an answer', async () => {
    let calls = 0
    const { running, url, view } = await board('nothing', {
      agent: async () => {
        calls += 1
        throw new Error('not logged in')
      },
    })
    try {
      await post(`${url}/synthesis`)
      await until(async () => (await view()).agentError !== null)
      assert.equal(calls, 1, 'a failure of Claude Code costs nothing more until someone asks')
      await post(`${url}/retry`)
      await until(async () => calls === 2 && (await view()).agentError !== null)
      assert.equal(calls, 2)
    } finally {
      await running.stop()
    }
  })

  it('gives the model one chance to put an answer right', async () => {
    const { running, url, view, tasks } = await board((task) => JSON.stringify({ decisions: [task.includes('refused by the board') ? 'We read the hosts every five minutes.' : `We read it ${'and read it again '.repeat(40)}.`] }))
    try {
      await post(`${url}/synthesis`)
      await until(async () => (await view()).synthesis !== null)
      assert.equal(tasks.length, 2)
      assert.match(tasks[1], /texte trop long, \d+ caractères pour 500 au plus/)
      assert.match(tasks[1], /Here it is, as information only/, 'what is already written costs less to put right than to find again')
      assert.equal((await view()).agentError, null)
    } finally {
      await running.stop()
    }
  })

  it('stops after that one chance, and says why', async () => {
    const { running, url, view, tasks } = await board(JSON.stringify({ decisions: ['x'.repeat(501)] }))
    try {
      await post(`${url}/synthesis`)
      await until(async () => (await view()).agentError !== null)
      assert.equal(tasks.length, 2)
      assert.match((await view()).agentError, /Décision : texte trop long/)
      assert.equal((await view()).synthesis, null)
    } finally {
      await running.stop()
    }
  })

  it('reads a short synthesis as English, and refuses one in French', async () => {
    const short = await board(JSON.stringify({ decisions: ['Yes.'] }))
    try {
      await post(`${short.url}/synthesis`)
      await until(async () => (await short.view()).synthesis !== null)
      assert.equal((await short.view()).messages.at(-1).language, 'en')
    } finally {
      await short.running.stop()
    }
    const french = await board(JSON.stringify({ decisions: ['Le relevé est posé sur les hôtes et il est lu par le board pour tout le monde.'] }))
    try {
      await post(`${french.url}/synthesis`)
      await until(async () => (await french.view()).agentError !== null)
      assert.match((await french.view()).agentError, /anglais/)
    } finally {
      await french.running.stop()
    }
  })

  it('refuses a closed thread', async () => {
    const { running, url } = await board(JSON.stringify(GOOD))
    try {
      await post(`${url}/status`, { status: 'closed' })
      assert.equal((await post(`${url}/synthesis`)).status, 409)
    } finally {
      await running.stop()
    }
  })
})
