import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, it } from 'node:test'
import type { AiStatus } from '../../src/server/ai/harness.ts'
import type { BoardOptions } from '../../src/server/board/board-context.ts'
import { cliCommand, platformName } from '../../src/server/board/routes/about.ts'
import type { VoiceApi, VoiceStatus } from '../../src/server/voice/engine.ts'
import { startTestBoard } from '../support/helpers.ts'

const temp: string[] = []
const running: { stop: () => Promise<void> }[] = []
afterEach(async () => {
  for (const board of running.splice(0)) await board.stop()
  for (const dir of temp.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const CLAUDE: AiStatus = { installed: true, version: '2.1.318', loggedIn: true, method: 'claude.ai', plan: 'max' }
const MISSING: AiStatus = { installed: false, version: null, loggedIn: null, method: null, plan: null }

const NOT_INSTALLED: VoiceStatus = {
  supported: true,
  gpu: null,
  recommended: { engine: 'cpu', model: 'medium-q5' },
  engines: [{ id: 'cpu', label: 'Processeur', size: 21_715_607, installed: false }],
  models: [{ id: 'medium-q5', label: 'Whisper medium · Q5', note: '', size: 539_212_467, installed: false, inSpeak: false }],
  ready: false,
  chosen: { engine: null, model: null },
  installing: null,
  installError: null,
  running: false,
}

/** A voice that downloads nothing and never starts an engine. */
const voiceOf = (status: VoiceStatus): VoiceApi => ({
  status: async () => status,
  install: async () => assert.fail('the About part never installs the dictation'),
  cancelInstall: () => undefined,
  remove: async () => undefined,
  transcribe: async () => '',
  stop: async () => undefined,
  close: async () => undefined,
  clearLeftover: async () => undefined,
})

const post = (url: string, body: unknown = {}) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-board': '1' }, body: JSON.stringify(body) })
const get = (url: string) => fetch(url, { headers: { 'x-board': '1' } })

/** A board as a browser opens it from a clone, unless the test passes what the installed app does. */
async function board(extra: Partial<BoardOptions> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'board-about-'))
  temp.push(root)
  mkdirSync(join(root, 'client'))
  writeFileSync(join(root, 'client', 'index.html'), 'page')
  const asked = { claude: 0, codex: 0 }
  const started = await startTestBoard({
    root,
    client: join(root, 'client'),
    version: '1.2.0',
    claude: {
      status: async () => {
        asked.claude++
        return CLAUDE
      },
      login: async () => assert.fail('the About part never logs in'),
    },
    codex: {
      status: async () => {
        asked.codex++
        return MISSING
      },
      login: async () => assert.fail('the About part never logs in'),
    },
    voice: voiceOf(NOT_INSTALLED),
    ...extra,
  })
  running.push(started)
  return { url: started.url, root, asked }
}

describe('what the About part says of the app', () => {
  it('names the system as a person knows it', () => {
    assert.equal(platformName('win32', '10.0.26300', 'x64'), 'Windows 11 · x64 · 10.0.26300')
    assert.equal(platformName('win32', '10.0.19045', 'x64'), 'Windows 10 · x64 · 10.0.19045')
    assert.equal(platformName('darwin', '24.1.0', 'arm64'), 'macOS · arm64')
  })

  it('gives the command line the installed app put in the data folder, or the clone’s', () => {
    const home = mkdtempSync(join(tmpdir(), 'board-about-home-'))
    temp.push(home)
    assert.equal(cliCommand(null), 'npm run -s board --')
    assert.equal(cliCommand(home), 'npm run -s board --', 'nothing installed there yet')
    mkdirSync(join(home, 'bin'))
    writeFileSync(join(home, 'bin', 'board.mjs'), '')
    assert.match(cliCommand(home), /^node .+[/\\]bin[/\\]board\.mjs$/)
  })

  it('in a browser: the version, the system, the data folder, no updates and nothing it cannot do', async () => {
    const home = root_()
    const { url } = await board({ home })
    const found = await (await get(`${url}/api/about`)).json()
    assert.equal(found.version, '1.2.0')
    assert.equal(typeof found.platform, 'string')
    assert.ok(found.platform.length > 0)
    assert.equal(found.home, home)
    assert.equal(found.canOpenData, false)
    assert.equal(found.canRestart, false)
    assert.equal(found.cli, 'npm run -s board --')
    assert.deepEqual(found.update, { can: false, available: null, checkedAt: null, progress: null, error: null })
  })

  it('refuses to restart or open a folder where there is no installed app, with a 404 the page understands', async () => {
    const { url } = await board()
    const restart = await post(`${url}/api/app/restart`)
    assert.equal(restart.status, 404)
    assert.match((await restart.json()).error, /installée/)
    assert.equal((await post(`${url}/api/app/open-data`)).status, 404)
    assert.equal((await post(`${url}/api/update`)).status, 404)
    assert.equal((await post(`${url}/api/update/check`)).status, 404)
  })

  it('in the installed app: restarts and opens the data folder through what the window gave, and says so', async () => {
    let restarts = 0
    let opened = 0
    const { url } = await board({
      home: root_(),
      restart: () => {
        restarts++
      },
      openData: async () => {
        opened++
      },
    })
    const found = await (await get(`${url}/api/about`)).json()
    assert.equal(found.canRestart, true)
    assert.equal(found.canOpenData, true)
    assert.equal((await post(`${url}/api/app/open-data`)).status, 200)
    assert.equal(opened, 1)
    assert.equal(restarts, 0, 'a GET restarts nothing')
    assert.equal((await get(`${url}/api/app/restart`)).status, 404, 'only a POST restarts')
    const answer = await post(`${url}/api/app/restart`)
    assert.equal(answer.status, 200)
    assert.deepEqual(await answer.json(), { restarting: true })
    assert.equal(restarts, 1)
  })

  it('says why the folder did not open', async () => {
    const { url } = await board({
      home: root_(),
      openData: async () => {
        throw new Error('Accès refusé')
      },
    })
    const answer = await post(`${url}/api/app/open-data`)
    assert.equal(answer.status, 502)
    assert.match((await answer.json()).error, /Accès refusé/)
  })

  it('follows an update: available, its download, why it failed, and no restart while it downloads', async () => {
    let ratio: number | null = 0.4
    let installs = 0
    let restarts = 0
    const { url } = await board({
      updates: {
        available: () => '1.3.0',
        check: async () => undefined,
        checkedAt: () => '2026-11-09T08:00:00.000Z',
        install: async () => {
          installs++
        },
        progress: () => ratio,
        error: () => (ratio === null ? 'Installateur introuvable.' : null),
      },
      restart: () => {
        restarts++
      },
    })
    const during = (await (await get(`${url}/api/about`)).json()).update
    assert.deepEqual(during, { can: true, available: '1.3.0', checkedAt: '2026-11-09T08:00:00.000Z', progress: 0.4, error: null })
    assert.equal((await (await get(`${url}/api/update/progress`)).json()).ratio, 0.4)
    assert.equal((await post(`${url}/api/app/restart`)).status, 409)
    assert.equal(restarts, 0)
    ratio = null
    assert.equal((await (await get(`${url}/api/about`)).json()).update.error, 'Installateur introuvable.')
    assert.equal((await post(`${url}/api/update`)).status, 200)
    assert.equal(installs, 1, 'only the install route installs')
  })
})

describe('the components', () => {
  it('says each program’s version, or where to get it', async () => {
    const { url } = await board()
    const claude = await (await get(`${url}/api/about/components/claude`)).json()
    assert.deepEqual(claude, { id: 'claude', installed: true, version: '2.1.318', install: false, page: claude.page })
    assert.match(claude.page, /^https:\/\//)
    const codex = await (await get(`${url}/api/about/components/codex`)).json()
    assert.equal(codex.installed, false)
    assert.equal(codex.install, false, 'only Git and the GitHub CLI install from a screen')
    assert.match(codex.page, /^https:\/\//)
    // Git runs the tests' own boards: it is here, and only its version is asked.
    const git = await (await get(`${url}/api/about/components/git`)).json()
    assert.equal(git.id, 'git')
    assert.equal(git.installed, true)
    assert.match(git.version, /^\d+\.\d+/)
    assert.equal(git.install, false)
    assert.equal((await get(`${url}/api/about/components/node`)).status, 404)
  })

  it('keeps a program’s answer a minute, and asks again when the person refreshes', async () => {
    const { url, asked } = await board()
    await get(`${url}/api/about/components/claude`)
    await get(`${url}/api/about/components/claude`)
    await get(`${url}/api/about/components/codex`)
    assert.deepEqual(asked, { claude: 1, codex: 1 })
    await get(`${url}/api/about/components/claude?fresh=1`)
    assert.deepEqual(asked, { claude: 2, codex: 1 })
    await get(`${url}/api/about/components/claude`)
    assert.equal(asked.claude, 2, 'the fresh answer is kept in its turn')
  })

  it('says what the dictation would download, and what is installed', async () => {
    const { url } = await board()
    const missing = await (await get(`${url}/api/about/components/voice`)).json()
    assert.deepEqual(missing, {
      id: 'voice',
      supported: true,
      installing: false,
      engine: { label: 'Processeur', installed: false, size: 21_715_607 },
      model: { label: 'Whisper medium · Q5', installed: false, size: 539_212_467 },
    })
    const ready = await board({
      voice: voiceOf({
        ...NOT_INSTALLED,
        engines: [{ ...NOT_INSTALLED.engines[0], installed: true }],
        models: [{ ...NOT_INSTALLED.models[0], installed: true }],
        ready: true,
        chosen: { engine: 'cpu', model: 'medium-q5' },
      }),
    })
    const installed = await (await get(`${ready.url}/api/about/components/voice`)).json()
    assert.deepEqual(installed.engine, { label: 'Processeur', installed: true, size: 0 })
    assert.deepEqual(installed.model, { label: 'Whisper medium · Q5', installed: true, size: 0 })
    const elsewhere = await board({ voice: voiceOf({ ...NOT_INSTALLED, supported: false }) })
    assert.equal((await (await get(`${elsewhere.url}/api/about/components/voice`)).json()).supported, false)
  })
})

/** A data folder of the test's own. */
function root_(): string {
  const home = mkdtempSync(join(tmpdir(), 'board-about-data-'))
  temp.push(home)
  return home
}
