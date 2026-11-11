import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, symlinkSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { AiPrograms, expandHome, parsePrograms, readHome, readPath, updateSettings, within } from '../../src/server/ai/programs.ts'
import { aiEnv, type AiStatus, currentProvider, findProgram, homeOf, pathOf, useHome, usePath, useProvider } from '../../src/server/ai/harness.ts'

let home: string
let board: string

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'board-programs-'))
  board = join(home, '.board')
  await mkdir(board, { recursive: true })
})

afterEach(async () => {
  for (const provider of ['claude', 'codex'] as const) {
    useHome(provider, null)
    usePath(provider, null)
  }
  useProvider('claude')
  await rm(home, { recursive: true, force: true })
})

const status = (loggedIn: boolean): AiStatus => ({ installed: true, version: '2.0.0', loggedIn, method: null, plan: null })
const settings = async () => JSON.parse(await readFile(join(board, 'settings.json'), 'utf8'))

/** Never the real program: a status reads the person's login, and a login would replace it. */
const fakeAi = () => {
  const asked: string[] = []
  const logins: string[] = []
  let gate: Promise<void> = Promise.resolve()
  const stub = (provider: string) => ({
    status: async (folder: string | null) => {
      asked.push(`${provider}:${folder}`)
      await gate
      return status(folder === null)
    },
    login: async (folder: string | null) => {
      logins.push(`${provider}:${folder}`)
    },
  })
  return {
    asked,
    logins,
    hold: () => {
      let open = () => undefined as void
      gate = new Promise((done) => (open = done))
      return () => {
        open()
        gate = Promise.resolve()
      }
    },
    ai: { claude: stub('claude'), codex: stub('codex') },
  }
}

describe('an account folder', () => {
  it('reads ~ as the person writes it', () => {
    assert.equal(expandHome('~', '/h'), '/h')
    assert.equal(expandHome('~/.claude_bis', '/h'), join('/h', '.claude_bis'))
    assert.equal(expandHome('/elsewhere', '/h'), '/elsewhere')
  })

  it('takes a folder of its own, in full, with ~ or in quotes, and empty for the usual one', () => {
    assert.deepEqual(readHome('claude', '~/.claude_work', board, home), { value: join(home, '.claude_work'), problem: null })
    assert.equal(readHome('codex', `"${join(home, '.codex-work')}"`, board, home).value, join(home, '.codex-work'))
    assert.deepEqual(readHome('claude', '', board, home), { value: null, problem: null })
    assert.deepEqual(readHome('claude', null, board, home), { value: null, problem: null })
  })

  it('stores the program’s usual folder as none', () => {
    assert.deepEqual(readHome('claude', '~/.claude', board, home), { value: null, problem: null })
    assert.deepEqual(readHome('codex', join(home, '.codex'), board, home), { value: null, problem: null })
    assert.equal(readHome('codex', '~/.claude', board, home).value, join(home, '.claude'), 'another program’s is only a folder')
  })

  it('refuses the board’s folder and anything in or around it, where a login could be published', () => {
    assert.match(readHome('claude', board, board, home).problem ?? '', /touche celui du board/)
    assert.match(readHome('claude', join(board, 'environments', 'x'), board, home).problem ?? '', /touche celui du board/)
    assert.match(readHome('claude', '~', board, home).problem ?? '', /touche celui du board/)
  })

  it('refuses the other ways of writing a path, which name the board’s folder under names no comparison knows', () => {
    const inClone = join(board, 'environments', 'o', 'n', 'threads', 'acct')
    const share = inClone.replace(/^([A-Za-z]):/, '$1$$')
    for (const raw of [`\\\\?\\${inClone}`, `\\\\.\\${inClone}`, `//?/${inClone}`, `\\\\localhost\\${share}`, `\\\\server\\share\\acct`, `//server/share/acct`]) {
      assert.deepEqual(readHome('claude', raw, board, home), { value: null, problem: 'Un chemin de cet ordinateur : ni partage réseau, ni chemin spécial.' }, raw)
      assert.ok(readPath('codex', `${raw}${sep}codex.exe`, board, home, false).problem, raw)
    }
  })

  it('refuses a name that ends in a dot or a space, which Windows reads without it', () => {
    for (const raw of [`${board}.${sep}environments${sep}x`, `${board} ${sep}x`, join(home, 'work.'), join(home, 'work ', 'x')]) {
      assert.match(readHome('claude', raw, board, home).problem ?? '', /point ou une espace/, raw)
    }
    assert.match(readPath('codex', `${board}.${sep}codex.exe`, board, home, false).problem ?? '', /point ou une espace/)
  })

  it('takes a name starting with two dots for a name in the board’s folder, not a way out of it', () => {
    assert.match(readHome('claude', '~/.board/..x', board, home).problem ?? '', /touche celui du board/)
    assert.match(readPath('codex', '~/.board/..x/codex.exe', board, home, false).problem ?? '', /dossier du board/)
    assert.equal(within('/h/.board/..x', '/h/.board', 'linux'), true)
    assert.equal(within('/h/.board/..', '/h/.board', 'linux'), false)
    assert.equal(within('/h/..board', '/h/.board', 'linux'), false)
  })

  it('reads names as the system does: .Board is .board on Windows and macOS', () => {
    assert.equal(within('/Users/x/.Board/acct', '/Users/x/.board', 'darwin'), true)
    assert.equal(within('/Users/x/.board', '/Users/x/.Board/acct', 'darwin'), false)
    assert.equal(within('C:\\Users\\x\\.Board\\acct', 'c:\\users\\x\\.board', 'win32'), true)
    assert.equal(within('/Users/x/.Board/acct', '/Users/x/.board', 'linux'), false, 'another folder there')
    const upper = join(home, '.Board', 'acct')
    if (process.platform === 'linux') assert.equal(readHome('claude', upper, board, home).problem, null)
    else assert.match(readHome('claude', upper, board, home).problem ?? '', /touche celui du board/)
  })

  it('follows links and junctions to where they lead, for the folder and for the board’s', () => {
    symlinkSync(board, join(home, 'shortcut'), 'junction')
    assert.match(readHome('claude', '~/shortcut/environments/o/n/threads/acct', board, home).problem ?? '', /touche celui du board/)
    assert.match(readPath('codex', '~/shortcut/codex.exe', board, home, false).problem ?? '', /dossier du board/)
    assert.match(readHome('claude', join(board, 'acct'), join(home, 'shortcut'), home).problem ?? '', /touche celui du board/, 'the board named by a link')
    symlinkSync(join(home, 'gone'), join(home, 'dangling'), 'junction')
    assert.match(readHome('claude', '~/dangling/acct', board, home).problem ?? '', /lien/, 'where a link to nowhere leads can’t be told')
    assert.equal(readHome('claude', '~/elsewhere/acct', board, home).problem, null, 'a folder not made yet is fine')
  })

  it('knows the board’s folder by its short name', { skip: process.platform !== 'win32' }, (t) => {
    const short = spawnSync('cmd', ['/d', '/c', `for %I in ("${board}") do @echo %~sI`], { encoding: 'utf8', windowsVerbatimArguments: true, windowsHide: true }).stdout.trim()
    if (!short || short.toLowerCase() === board.toLowerCase()) return t.skip('this disk keeps no short names')
    assert.match(readHome('claude', join(short, 'environments', 'o', 'n', 'threads'), board, home).problem ?? '', /touche celui du board/)
    assert.match(readPath('codex', join(short, 'codex.exe'), board, home, false).problem ?? '', /dossier du board/)
  })

  it('refuses what isn’t a full folder, could split a command line, or is a file', async () => {
    await writeFile(join(home, '.claude_file'), 'x')
    assert.match(readHome('claude', 'relative/x', board, home).problem ?? '', /complet/)
    assert.match(readHome('claude', '~/.claude"bis', board, home).problem ?? '', /guillemets/)
    assert.match(readHome('claude', `~/${'x'.repeat(300)}`, board, home).problem ?? '', /guillemets/)
    assert.match(readHome('claude', 7, board, home).problem ?? '', /dossier/)
    assert.match(readHome('claude', '~/.claude_file', board, home).problem ?? '', /fichier/)
    assert.equal(readHome('claude', '~/.claude_file', board, home, false).problem, null, 'nothing on disk is looked at when the file is read')
  })
})

describe('a program location', () => {
  it('is found automatically when empty, and must be the program itself when given', async () => {
    const program = join(home, 'bin', 'claude.exe')
    await mkdir(join(home, 'bin'))
    await writeFile(program, '')
    assert.deepEqual(readPath('claude', '', board, home), { value: null, problem: null })
    assert.deepEqual(readPath('claude', program, board, home), { value: program, problem: null })
    assert.match(readPath('claude', join(home, 'bin'), board, home).problem ?? '', /C’est un dossier.*Claude Code.*dossier du compte/)
    assert.match(readPath('claude', join(home, 'none.exe'), board, home).problem ?? '', /Introuvable/)
    assert.equal(readPath('claude', join(home, 'none.exe'), board, home, false).value, join(home, 'none.exe'), 'gone since: it says so in its state')
    assert.match(readPath('claude', 'claude.exe', board, home).problem ?? '', /complet/)
  })

  it('refuses a script that needs a shell, and anything in the board’s folder', async () => {
    await writeFile(join(home, 'claude.cmd'), '')
    assert.match(readPath('claude', join(home, 'claude.cmd'), board, home).problem ?? '', /script/)
    assert.match(readPath('codex', join(board, 'environments', 'a', 'b', 'codex.exe'), board, home).problem ?? '', /dossier du board/)
  })
})

describe('the saved programs', () => {
  it('start on Claude Code, each with its own folder and location', () => {
    const parsed = parsePrograms(null, board, home)
    assert.deepEqual(parsed, { provider: 'claude', programs: { claude: { home: null, path: null }, codex: { home: null, path: null } } })
    assert.equal(parsePrograms({ aiProvider: 'codex' }, board, home).provider, 'codex')
    assert.equal(parsePrograms({ aiProvider: 'gemini' }, board, home).provider, 'claude')
  })

  it('keep the folder of the account in use from before, so nobody loses theirs', () => {
    const saved = {
      aiProvider: 'codex',
      claudeAccounts: [
        { id: 'a-0000000a', name: 'Bis', home: join(home, '.claude_bis') },
        { id: 'a-0000000b', name: 'Other', home: join(home, '.claude_other') },
      ],
      claudeAccount: 'a-0000000a',
      codexAccounts: [{ id: 'a-0000000d', name: 'Codex work', home: '~/.codex-work' }],
      codexAccount: 'a-0000000d',
    }
    assert.deepEqual(parsePrograms(saved, board, home), { provider: 'codex', programs: { claude: { home: join(home, '.claude_bis'), path: null }, codex: { home: join(home, '.codex-work'), path: null } } })
    assert.equal(parsePrograms({ ...saved, claudeAccount: 'default' }, board, home).programs.claude.home, null, 'the program’s own account was in use')
    assert.equal(parsePrograms({ claudeAccounts: [{ id: 'a-0000000a', home: join(board, 'x') }], claudeAccount: 'a-0000000a' }, board, home).programs.claude.home, null, 'what could be published stays out')
    assert.equal(parsePrograms({ ...saved, aiPrograms: { claude: { home: null, path: null } } }, board, home).programs.claude.home, null, 'what was saved since wins')
  })

  it('leave out what someone broke by hand, and keep the rest', () => {
    const parsed = parsePrograms({ aiPrograms: { claude: { home: '~/.claude_work', path: 'relative' }, codex: 'x' } }, board, home)
    assert.deepEqual(parsed.programs, { claude: { home: join(home, '.claude_work'), path: null }, codex: { home: null, path: null } })
    assert.deepEqual(parsePrograms({ aiPrograms: { claude: { home: '~/.board', path: 7 } } }, board, home).programs.claude, { home: null, path: null })
  })
})

describe('the program on this computer', () => {
  it('gives the chosen folder to every run of a program, and nothing for its usual one', () => {
    const base = { PATH: 'p', CLAUDE_CONFIG_DIR: '/inherited', CLAUDECODE: '1', GH_TOKEN: 'x', GITHUB_TOKEN: 'y' }
    assert.deepEqual(aiEnv('claude', base, null), { PATH: 'p', CLAUDE_CONFIG_DIR: '/inherited' })
    assert.equal(aiEnv('claude', base, '/other').CLAUDE_CONFIG_DIR, '/other')
    assert.equal(aiEnv('codex', base, '/other').CODEX_HOME, '/other')
    useHome('claude', '/chosen')
    assert.equal(aiEnv('claude', {}).CLAUDE_CONFIG_DIR, '/chosen')
    assert.equal(aiEnv('codex', {}).CODEX_HOME, undefined)
  })

  it('starts the program where the member said it is', () => {
    const forced = process.env.BOARD_CLAUDE
    delete process.env.BOARD_CLAUDE
    try {
      usePath('claude', join(home, 'claude.exe'))
      assert.deepEqual(findProgram('claude'), [join(home, 'claude.exe')])
      usePath('claude', join(home, 'cli.js'))
      assert.deepEqual(findProgram('claude'), ['node', join(home, 'cli.js')])
    } finally {
      if (forced !== undefined) process.env.BOARD_CLAUDE = forced
    }
  })

  it('saves a folder and a location, makes the folder, and keeps the other settings', async () => {
    await writeFile(join(board, 'settings.json'), JSON.stringify({ language: 'en', claudeAccounts: [{ id: 'a-0000000a', name: 'Bis', home: join(home, '.claude_bis') }], claudeAccount: 'a-0000000a' }))
    const program = join(home, 'claude.exe')
    await writeFile(program, '')
    const store = new AiPrograms({ boardHome: board, ai: fakeAi().ai, home })
    await store.load()
    assert.equal(homeOf('claude'), join(home, '.claude_bis'), 'the account in use before is the one used now')

    await store.set('claude', { home: '~/.claude_work', path: program })
    assert.ok(existsSync(join(home, '.claude_work')), 'a new folder is made, for the login to go in')
    assert.equal(homeOf('claude'), join(home, '.claude_work'))
    assert.equal(pathOf('claude'), program)
    const saved = await settings()
    assert.equal(saved.language, 'en')
    assert.deepEqual(saved.aiPrograms, { claude: { home: join(home, '.claude_work'), path: program }, codex: { home: null, path: null } })
    assert.ok(!('claudeAccounts' in saved) && !('claudeAccount' in saved), 'what came before is gone once saved')

    await store.set('claude', { home: '~/.claude' })
    assert.equal(homeOf('claude'), null, 'the usual folder is none')
    assert.equal(pathOf('claude'), program, 'only what was sent changes')
    await store.set('claude', { path: '' })
    assert.equal(pathOf('claude'), null)

    // Started again, the board is on the same folders.
    await store.set('codex', { home: '~/.codex-work' })
    useHome('codex', null)
    await new AiPrograms({ boardHome: board, home }).load()
    assert.equal(homeOf('codex'), join(home, '.codex-work'))
  })

  it('refuses what can’t be used, and writes nothing then', async () => {
    await writeFile(join(home, '.claude_file'), 'x')
    const store = new AiPrograms({ boardHome: board, ai: fakeAi().ai, home })
    await store.load()
    await assert.rejects(store.set('claude', { home: '~/.claude_file' }), /fichier/)
    await assert.rejects(store.set('claude', { home: join(board, 'x') }), /touche celui du board/)
    await assert.rejects(store.set('claude', { path: join(home, 'nothing.exe') }), /Introuvable/)
    await assert.rejects(store.choose('gemini'), /Programme inconnu/)
    assert.equal(existsSync(join(board, 'settings.json')), false)
    assert.equal(existsSync(join(board, 'x')), false)
  })

  it('starts with a damaged settings file, and writes a whole one', async () => {
    await writeFile(join(board, 'settings.json'), '{"aiProvider": "codex", ')
    const store = new AiPrograms({ boardHome: board, ai: fakeAi().ai, home })
    assert.equal((await store.load()).provider, 'claude')
    await store.choose('codex')
    assert.equal((await settings()).aiProvider, 'codex')
  })

  it('switches program, and every run follows', async () => {
    const store = new AiPrograms({ boardHome: board, ai: fakeAi().ai, home })
    await store.load()
    assert.equal(currentProvider(), 'claude')
    await store.choose('codex')
    assert.equal(currentProvider(), 'codex')
    assert.equal((await settings()).aiProvider, 'codex')
    useProvider('claude')
    await new AiPrograms({ boardHome: board, home }).load()
    assert.equal(currentProvider(), 'codex')
  })

  it('says what it offers without running anything, Codex’s models from its catalogue', async () => {
    const fake = fakeAi()
    const store = new AiPrograms({ boardHome: board, ai: fake.ai, home })
    await store.load()
    await store.set('codex', { home: '~/.codex-work' })
    await writeFile(join(home, '.codex-work', 'models_cache.json'), JSON.stringify({ models: [{ slug: 'gpt-7-new', visibility: 'list' }, { slug: 'hidden', visibility: 'hide' }, { slug: 'rm -rf', visibility: 'list' }] }))
    const view = await store.view()
    assert.equal(view.provider, 'claude')
    assert.deepEqual(view.programs.claude, { home: null, path: null, models: ['haiku', 'sonnet', 'opus', 'fable'], efforts: ['low', 'medium', 'high', 'xhigh', 'max'] })
    assert.deepEqual(view.programs.codex.models, ['gpt-7-new'])
    assert.equal(view.programs.codex.home, join(home, '.codex-work'))
    assert.deepEqual(store.knownModels('codex'), ['gpt-7-new'])
    assert.deepEqual(fake.asked, [], 'no program ran')
  })
})

describe('two windows on one computer', () => {
  it('write only what each changed, and take what the other chose', async () => {
    const file = join(board, 'settings.json')
    await writeFile(file, JSON.stringify({ language: 'fr' }))
    const a = new AiPrograms({ boardHome: board, ai: fakeAi().ai, home })
    const b = new AiPrograms({ boardHome: board, ai: fakeAi().ai, home })
    await a.load()
    await b.load()
    await a.choose('codex')
    assert.equal(b.provider, 'claude', 'B has not read the file since')
    await b.set('claude', { home: '~/.claude_work' })
    assert.equal((await settings()).aiProvider, 'codex', 'B never writes back the program it had')
    assert.equal(b.provider, 'codex', 'and has what the file has once it wrote')
    assert.equal((await a.view()).programs.claude.home, join(home, '.claude_work'), 'A takes B’s folder when its page reads it')
    assert.equal(homeOf('claude'), join(home, '.claude_work'))

    // B's process still has Codex: its next run reads the program, and follows A.
    await a.choose('claude')
    useProvider('codex')
    assert.equal(currentProvider(), 'claude')
    useProvider('codex')
    assert.equal(currentProvider(), 'codex', 'nothing is read again while the file stays as it was')

    // An environment's own settings go in the same file: nobody's keys are lost, even at the same moment.
    await Promise.all([a.choose('codex'), updateSettings(file, (found) => ({ ...found, language: 'en' })), b.set('codex', { home: '~/.codex-work' })])
    const saved = await settings()
    assert.equal(saved.language, 'en')
    assert.equal(saved.aiProvider, 'codex')
    assert.deepEqual(saved.aiPrograms, { claude: { home: join(home, '.claude_work'), path: null }, codex: { home: join(home, '.codex-work'), path: null } })
  })

  it('never read the developer’s own Codex catalogue in a test', async () => {
    const elsewhere = join(home, 'codex-of-the-developer')
    await mkdir(elsewhere)
    await writeFile(join(elsewhere, 'models_cache.json'), JSON.stringify({ models: [{ slug: 'gpt-of-elsewhere', visibility: 'list' }] }))
    const before = process.env.CODEX_HOME
    process.env.CODEX_HOME = elsewhere
    try {
      const store = new AiPrograms({ boardHome: board, ai: fakeAi().ai, home })
      await store.load()
      assert.ok(!(await store.models('codex')).includes('gpt-of-elsewhere'))
      assert.deepEqual(await store.catalogue(), [])
    } finally {
      if (before === undefined) delete process.env.CODEX_HOME
      else process.env.CODEX_HOME = before
    }
  })
})

describe('a program’s state', () => {
  it('is asked once a minute, again when asked to, and once for two screens at once', async () => {
    const fake = fakeAi()
    const store = new AiPrograms({ boardHome: board, ai: fake.ai, home })
    await store.load()
    assert.deepEqual(await store.status('claude'), status(true))
    await store.status('claude')
    assert.equal(fake.asked.length, 1, 'kept')
    const open = fake.hold()
    const [one, two] = [store.status('claude', true), store.status('claude', true)]
    open()
    await Promise.all([one, two])
    assert.equal(fake.asked.length, 2, 'one look answers both')
    await store.status('codex')
    assert.deepEqual(fake.asked, ['claude:null', 'claude:null', 'codex:null'], 'each program has its own')
  })

  it('is never waited for when only known is asked, and starts a look', async () => {
    const fake = fakeAi()
    const store = new AiPrograms({ boardHome: board, ai: fake.ai, home })
    await store.load()
    const open = fake.hold()
    assert.equal(store.lastStatus('claude'), null, 'not known yet')
    assert.equal(fake.asked.length, 1, 'a look started')
    assert.equal(store.lastStatus('claude'), null)
    assert.equal(fake.asked.length, 1, 'and only one')
    open()
    await store.status('claude')
    assert.deepEqual(store.lastStatus('claude'), status(true))
    store.forget('claude')
    assert.deepEqual(store.lastStatus('claude'), status(true), 'the last answer stays while the next look runs')
    assert.equal(fake.asked.length, 2)
  })

  it('is asked again of the new folder, and a login opens on it', async () => {
    const fake = fakeAi()
    const store = new AiPrograms({ boardHome: board, ai: fake.ai, home })
    await store.load()
    assert.equal((await store.status('claude')).loggedIn, true)
    await store.set('claude', { home: '~/.claude_work' })
    assert.equal(store.lastStatus('claude'), null, 'another account: nothing known of it yet')
    assert.equal((await store.status('claude')).loggedIn, false)
    await store.login('claude')
    assert.deepEqual(fake.logins, [`claude:${join(home, '.claude_work')}`])
    await store.status('claude')
    assert.equal(fake.asked.length, 3, 'after a login, the next look asks again')
  })
})
