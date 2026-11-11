import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, it } from 'node:test'
import { type AiStatus, homeOf, readClaudeStatus, useHome, usePath, useProvider } from '../../src/server/ai/harness.ts'
import { parseConfig } from '../../src/server/environment/config.ts'
import { mayAct, parsePolicy, replyFor } from '../../src/server/ai/policy.ts'
import { startTestBoard as startBoard } from '../support/helpers.ts'

const temp: string[] = []
afterEach(() => {
  for (const provider of ['claude', 'codex'] as const) {
    useHome(provider, null)
    usePath(provider, null)
  }
  useProvider('claude')
  for (const dir of temp.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const STATUS: AiStatus = { installed: true, version: '2.1.318', loggedIn: true, method: 'claude.ai', plan: 'max' }
const post = (url: string, body: unknown = {}) =>
  fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-board': '1' }, body: JSON.stringify(body) })

async function board(extra: Record<string, unknown> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'board-settings-'))
  temp.push(root)
  mkdirSync(join(root, 'client'))
  writeFileSync(join(root, 'client', 'index.html'), 'page')
  let logins = 0
  const running = await startBoard({
    root,
    client: join(root, 'client'),
    port: 4780,
    version: '0.3.0',
    claude: {
      status: async () => STATUS,
      login: async () => {
        logins++
      },
    },
    // Never the real one either: its state reads the person's login.
    codex: { status: async () => ({ ...STATUS, method: 'ChatGPT', plan: null }), login: async () => undefined },
    ...extra,
  })
  return { running, root, url: running.url, logins: () => logins }
}

describe("Claude Code's state", () => {
  it('keeps what the screen shows, and never who the person is', () => {
    const found = readClaudeStatus('2.1.318 (Claude Code)', JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', subscriptionType: 'max', email: 'someone@example.invalid', orgName: 'Org of someone', orgId: 'x' }))
    assert.deepEqual(found, STATUS)
    assert.ok(!JSON.stringify(found).includes('someone'))
  })

  it('tells logged out, missing and unreadable apart', () => {
    assert.equal(readClaudeStatus('2.1.318', '{"loggedIn":false}').loggedIn, false)
    assert.deepEqual(readClaudeStatus('', ''), { installed: false, version: null, loggedIn: null, method: null, plan: null })
    assert.equal(readClaudeStatus('2.1.318 (Claude Code)', 'not json').loggedIn, null)
  })
})

describe("a member's agent", () => {
  it('answers as its member chose, for whom they chose', () => {
    const policy = parsePolicy({ reply: 'auto', people: 'only', logins: ['VBarbanneau'], mutedThreads: ['quiet-thread'] })
    assert.equal(replyFor(policy, 'vbarbanneau', 'a-thread'), 'auto')
    assert.equal(replyFor(policy, 'someone', 'a-thread'), 'off', 'not on the list')
    assert.equal(replyFor(policy, 'vbarbanneau', 'quiet-thread'), 'off', 'silent in that thread')
    assert.equal(replyFor(parsePolicy({ reply: 'draft', people: 'except', logins: ['someone'] }), 'someone', 't'), 'off')
    assert.equal(replyFor(parsePolicy({ reply: 'off' }), 'vbarbanneau', 't'), 'off')
    assert.equal(parsePolicy({ reply: 'whatever' }).reply, 'draft', 'what it does not know is the default')
  })

  it('acts on GitHub only for whom its member allows', () => {
    const owner = 'rodolphebarbanneau'
    assert.equal(mayAct(parsePolicy({}), owner, owner), true, 'its member, by default')
    assert.equal(mayAct(parsePolicy({}), 'vbarbanneau', owner), false, 'nobody else, by default')
    assert.equal(mayAct(parsePolicy({ act: 'nobody' }), owner, owner), false)
    assert.equal(mayAct(parsePolicy({ act: 'only', actLogins: ['vbarbanneau'] }), 'vbarbanneau', owner), true)
    assert.equal(mayAct(parsePolicy({ act: 'only', actLogins: ['vbarbanneau'] }), 'someone', owner), false)
    assert.equal(mayAct(parsePolicy({ act: 'everyone' }), 'someone', owner), true)
  })
})

describe('the settings over HTTP', () => {
  it('reports the version, the updates, Claude Code, the agent and the environment', async () => {
    const { running, url } = await board({
      updates: { available: () => '0.9.0', check: async () => undefined, checkedAt: () => '2026-11-05T15:00:00.000Z', install: async () => undefined },
    })
    try {
      const found = await (await fetch(`${url}/api/settings`)).json()
      assert.equal(found.version, '0.3.0')
      assert.equal(found.canUpdate, true)
      assert.equal(found.update, '0.9.0')
      assert.equal(found.checkedAt, '2026-11-05T15:00:00.000Z')
      assert.deepEqual(found.ai, { provider: 'claude', status: null }, 'the program’s state is never waited for')
      assert.deepEqual(await (await fetch(`${url}/api/ai/status?provider=claude`)).json(), { ...STATUS, home: null, path: null }, 'with the folder and location it is of')
      assert.deepEqual((await (await fetch(`${url}/api/settings`)).json()).ai, { provider: 'claude', status: STATUS }, 'once known, it is said')
      assert.equal(found.policy.reply, 'draft')
      assert.equal(found.environment.repo, 'acme/agora')
      assert.equal(found.environment.admin, false, 'Victor is not an admin of the test environment')
    } finally {
      await running.stop()
    }
  })

  it('says a clone has no updates', async () => {
    const { running, url } = await board()
    try {
      const found = await (await fetch(`${url}/api/settings`)).json()
      assert.equal(found.canUpdate, false)
      assert.equal((await post(`${url}/api/update/check`)).status, 404)
    } finally {
      await running.stop()
    }
  })

  it('checks for an update when asked, and returns what it found', async () => {
    let newest: string | null = null
    const { running, url } = await board({
      updates: {
        available: () => newest,
        check: async () => {
          newest = '0.9.0'
        },
        checkedAt: () => null,
        install: async () => assert.fail('a check never installs'),
      },
    })
    try {
      const answer = await post(`${url}/api/update/check`)
      assert.equal(answer.status, 200)
      assert.equal((await answer.json()).update, '0.9.0')
    } finally {
      await running.stop()
    }
  })

  it('says why a check failed', async () => {
    const { running, url } = await board({
      updates: {
        available: () => null,
        check: async () => {
          throw new Error('HTTP 503')
        },
        checkedAt: () => null,
        install: async () => undefined,
      },
    })
    try {
      const answer = await post(`${url}/api/update/check`)
      assert.equal(answer.status, 502)
      assert.match((await answer.json()).error, /GitHub.*HTTP 503/)
    } finally {
      await running.stop()
    }
  })

  it('keeps the agent policy on this computer, and starts a login only from its own pages', async () => {
    const { running, url, logins, root } = await board()
    try {
      const saved = await (await post(`${url}/api/settings/policy`, { reply: 'auto', people: 'only', logins: ['rodolphebarbanneau'] })).json()
      assert.equal(saved.policy.reply, 'auto')
      assert.match(readFileSync(join(root, '.cache', 'agent.json'), 'utf8'), /"reply":"auto"/)
      assert.equal((await fetch(`${url}/api/ai/login`, { method: 'POST', headers: { origin: 'https://evil.example', 'x-board': '1' }, body: '{}' })).status, 403)
      assert.equal(logins(), 0)
      assert.equal((await post(`${url}/api/ai/login`)).status, 200)
      assert.equal(logins(), 1)
    } finally {
      await running.stop()
    }
  })

  it('answers the settings at once while the program is still being asked', async () => {
    let answer: (status: AiStatus) => void = () => undefined
    let asked = 0
    const { running, url } = await board({
      claude: {
        status: () => {
          asked++
          return new Promise<AiStatus>((done) => (answer = done))
        },
        login: async () => undefined,
      },
    })
    try {
      const started = Date.now()
      const found = await (await fetch(`${url}/api/settings`)).json()
      assert.deepEqual(found.ai, { provider: 'claude', status: null })
      const page = await (await fetch(`${url}/api/ai`)).json()
      assert.ok(Date.now() - started < 2000, 'neither waits for the program')
      assert.equal(page.provider, 'claude')
      assert.equal(asked, 1, 'the settings started one look, and the page none')
      const status = fetch(`${url}/api/ai/status?provider=claude`).then((response) => response.json())
      answer(STATUS)
      assert.deepEqual(await status, { ...STATUS, home: null, path: null })
      assert.deepEqual((await (await fetch(`${url}/api/settings`)).json()).ai.status, STATUS)
      assert.equal(asked, 1, 'one look answered both')
    } finally {
      answer(STATUS)
      await running.stop()
    }
  })

  it('says what each program is given and offers, and the choices for it, without running it', async () => {
    let asked = 0
    const { running, url } = await board({ claude: { status: async () => (asked++, STATUS), login: async () => undefined } })
    try {
      const page = await (await fetch(`${url}/api/ai`)).json()
      assert.equal(page.provider, 'claude')
      assert.deepEqual(page.programs.claude, { home: null, path: null, models: ['haiku', 'sonnet', 'opus', 'fable'], efforts: ['low', 'medium', 'high', 'xhigh', 'max'] })
      assert.deepEqual(Object.keys(page.programs), ['claude', 'codex'])
      assert.deepEqual(page.choices.claude.reply, { model: '', effort: '' })
      assert.equal(page.choices.codex.translation.model, 'gpt-6-luna')
      assert.equal(asked, 0)
      assert.equal((await fetch(`${url}/api/ai/status?provider=gemini`)).status, 400)
    } finally {
      await running.stop()
    }
  })

  it('reads Codex’s catalogue in the test’s own home, never the developer’s', async () => {
    const elsewhere = mkdtempSync(join(tmpdir(), 'board-codex-'))
    temp.push(elsewhere)
    writeFileSync(join(elsewhere, 'models_cache.json'), JSON.stringify({ models: [{ slug: 'gpt-of-elsewhere', visibility: 'list' }] }))
    const settingsFile = join(elsewhere, 'settings.json')
    writeFileSync(settingsFile, JSON.stringify({ models: { codex: { reply: { model: 'gpt-of-elsewhere', effort: '' } } } }))
    const before = process.env.CODEX_HOME
    process.env.CODEX_HOME = elsewhere
    try {
      const { running, url } = await board({ settingsFile })
      try {
        const page = await (await fetch(`${url}/api/ai`)).json()
        assert.ok(!page.programs.codex.models.includes('gpt-of-elsewhere'), 'the page offers only what the test’s home has')
        assert.notEqual(page.choices.codex.reply.model, 'gpt-of-elsewhere', 'nor was it known when the settings were read')
      } finally {
        await running.stop()
      }
    } finally {
      if (before === undefined) delete process.env.CODEX_HOME
      else process.env.CODEX_HOME = before
    }
  })

  it('keeps a program’s folder and location on this computer, refusing what could be published', async () => {
    const { running, url, root } = await board()
    try {
      const inClone = await post(`${url}/api/ai/program`, { provider: 'claude', home: join(root, 'threads') })
      assert.equal(inClone.status, 400)
      assert.match((await inClone.json()).error, /touche celui du board/)
      assert.equal((await post(`${url}/api/ai/program`, { provider: 'claude', path: join(root, 'nothing.exe') })).status, 400)
      const folder = join(mkdtempSync(join(tmpdir(), 'board-account-')), 'work')
      temp.push(join(folder, '..'))
      const saved = await post(`${url}/api/ai/program`, { provider: 'claude', home: folder })
      assert.equal(saved.status, 200)
      assert.equal((await saved.json()).programs.claude.home, folder)
      assert.equal(homeOf('claude'), folder, 'every run uses it from now on')
      assert.deepEqual(JSON.parse(readFileSync(join(root, '.cache', 'settings.json'), 'utf8')).aiPrograms.claude, { home: folder, path: null })
      const asked = await (await fetch(`${url}/api/ai/status?provider=claude&home=&path=`)).json()
      assert.equal(asked.home, folder, 'a page still showing the usual folder hears which one the answer is of')
      assert.equal((await post(`${url}/api/ai/provider`, { provider: 'codex' })).status, 200)
      assert.equal((await (await fetch(`${url}/api/settings`)).json()).ai.provider, 'codex')
      assert.equal((await post(`${url}/api/ai/provider`, { provider: 'gemini' })).status, 400)
    } finally {
      await running.stop()
    }
  })

  it('lets only an admin change the configuration', async () => {
    const { running, url } = await board()
    try {
      const answer = await post(`${url}/api/environment/config`, { config: { name: 'x', repos: [] } })
      assert.equal(answer.status, 403)
    } finally {
      await running.stop()
    }
  })

  it("refuses a save made from a configuration someone else has replaced since", async () => {
    const { running, url } = await board({ person: 'rodolphe' })
    try {
      const { environment } = await (await fetch(`${url}/api/settings`)).json()
      const stale = { ...environment.config, timezone: 'Asia/Tokyo' }
      const refused = await post(`${url}/api/environment/config`, { config: environment.config, base: stale })
      assert.equal(refused.status, 409)
      assert.match((await refused.json()).error, /changé entre-temps/)
      // From what the environment has, the save goes on (and fails later only because this clone has no remote).
      const current = await post(`${url}/api/environment/config`, { config: environment.config, base: environment.config })
      assert.notEqual(current.status, 409)
    } finally {
      await running.stop()
    }
  })
})

describe("an environment's configuration", () => {
  it('keeps only what is plain, once each', () => {
    const config = parseConfig({
      name: 'agora',
      repos: [{ name: 'acme/app', code: true, issues: { create: true, close: 'yes' } }, { name: 'acme/app' }, { name: '../evil' }, { name: 'a/b c' }],
      projects: [{ owner: 'acme', number: 2, edit: true }, { owner: 'acme', number: -1 }],
      hosts: [{ name: 'CI-1', role: 'ci' }, { name: 'bad name', role: 'ci' }, { name: 'dev-x', role: 'root' }],
      endpoints: [{ name: 'prod', url: 'https://app.example.com' }, { name: 'local', url: 'http://127.0.0.1' }],
      timezone: 'Not/AZone',
      aliases: { victor: { login: 'vbarbanneau' }, 'bad alias!': { login: 'x' } },
    })
    assert.deepEqual(config.repos.map((repo) => repo.name), ['acme/app'])
    assert.equal(config.repos[0].issues.create, true)
    assert.equal(config.repos[0].issues.close, false, 'only true is true')
    assert.deepEqual(config.projects, [{ owner: 'acme', number: 2, edit: true }])
    assert.deepEqual(config.hosts, [{ name: 'ci-1', role: 'ci' }, { name: 'dev-x', role: 'other' }])
    assert.deepEqual(config.endpoints, [{ name: 'prod', url: 'https://app.example.com' }], 'https only')
    assert.equal(config.timezone, 'UTC')
    assert.deepEqual(Object.keys(config.aliases), ['victor'])
  })
})
