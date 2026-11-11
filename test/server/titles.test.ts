import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, it } from 'node:test'
import type { BoardOptions } from '../../src/server/board/board.ts'
import { Store } from '../../src/server/environment/store.ts'
import { startTestBoard as startBoard } from '../support/helpers.ts'
import { firstWords, madeTitle, titleSource } from '../../src/server/ai/titles.ts'

const temp: string[] = []
afterEach(() => {
  for (const dir of temp.splice(0)) rmSync(dir, { recursive: true, force: true })
})
const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), 'board-titles-'))
  temp.push(dir)
  return dir
}
const post = (url: string, body: unknown = {}) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-board': '1' }, body: JSON.stringify(body) })
const until = async (check: () => Promise<boolean>) => {
  for (let i = 0; i < 300; i++) {
    if (await check()) return
    await new Promise((done) => setTimeout(done, 10))
  }
  assert.fail('never happened')
}

async function board(extra: Partial<BoardOptions> = {}) {
  process.env.BOARD_PERSON = 'victor'
  const root = tempDir()
  execFileSync('git', ['init', '-q', root])
  execFileSync('git', ['-C', root, 'config', 'user.name', 'test'])
  execFileSync('git', ['-C', root, 'config', 'user.email', 'test@example.invalid'])
  writeFileSync(join(root, '.gitignore'), '.cache\nclient\n')
  execFileSync('git', ['-C', root, 'add', '.gitignore'])
  execFileSync('git', ['-C', root, 'commit', '-q', '-m', 'start'])
  mkdirSync(join(root, 'client'))
  writeFileSync(join(root, 'client', 'index.html'), 'page')
  const running = await startBoard({
    root,
    client: join(root, 'client'),
    port: 4830,
    loops: false,
    claude: { status: async () => ({ installed: true, version: '1', loggedIn: true, method: null, plan: null }), login: async () => undefined },
    ...extra,
  })
  const api = `${running.url}/api/threads`
  const open = async (body: unknown) => (await (await post(api, body)).json()) as { id: string; title: string; kind: string }
  const view = async (id: string) => (await (await fetch(`${api}/${id}`)).json()) as { thread: { title: string }; messages: unknown[] }
  const log = () => execFileSync('git', ['-C', root, 'log', '--format=%s']).toString()
  return { running, root, api, open, view, log }
}

describe('the first words of a message', () => {
  it('reads as a title, without Markdown or mentions', () => {
    assert.equal(firstWords('@agent-victor **Où en est** la [CI](https://example.invalid/ci) ?\n\nLa suite.'), 'Où en est la CI ?')
    assert.equal(firstWords('\n\n# Un titre\nSuite'), 'Un titre')
    assert.equal(firstWords('- 3 runners tombés'), '3 runners tombés')
  })

  it('is cut between words', () => {
    const long = firstWords(`${'mot '.repeat(40)}fin`)
    assert.ok(long.length <= 81)
    assert.match(long, /mot…$/)
  })

  it('is empty when there are no words, or when they look like a secret', () => {
    assert.equal(firstWords('   \n@agent-victor\n'), '')
    assert.equal(firstWords('ghp_0123456789abcdefghijklmnopqrstuvwxyz0123'), '')
  })

  it('sends the model the message, without its mentions and without its end', () => {
    assert.equal(titleSource('@agent-rodolphe Où en est-on ?'), 'Où en est-on ?')
    assert.equal(titleSource('x'.repeat(5000)).length, 4000)
  })
})

describe("a model's title", () => {
  it('is kept as one clean line', () => {
    assert.equal(madeTitle('Sondes sur les runners\n'), 'Sondes sur les runners')
    assert.equal(madeTitle('"**Sondes sur les runners**."'), 'Sondes sur les runners')
    assert.equal(madeTitle('« Coût de la CI »'), 'Coût de la CI')
  })

  it('is refused when it is anything else', () => {
    assert.equal(madeTitle(''), null)
    assert.equal(madeTitle('Voici un titre :\nSondes'), null)
    assert.equal(madeTitle('x'.repeat(81)), null)
    assert.equal(madeTitle('1234'), null)
    assert.equal(madeTitle('Ask @agent-rodolphe now'), null)
    assert.equal(madeTitle('See https://example.invalid'), null)
    assert.equal(madeTitle('ghp_0123456789abcdefghijklmnopqrstuvwxyz0123'), null)
  })
})

describe('a title file', () => {
  it('only reads when the file and its name say the same member, and what shows', async () => {
    const store = new Store(tempDir())
    const thread = await store.createThread({ title: 'Premier', kind: 'topic', author: 'victor' })
    const dir = join(store.root, thread.id, 'titles')
    mkdirSync(dir, { recursive: true })
    const at = Date.now() - 10_000
    const write = (offset: number, name: string, content: string) => writeFileSync(join(dir, `${at + offset}-${name}-ab12.json`), content)
    write(1, 'victor', JSON.stringify({ title: 'Un titre', author: 'victor' }))
    assert.equal(await store.latestTitle(thread.id), 'Un titre')
    write(2, 'rodolphe', JSON.stringify({ title: 'Pas le sien', author: 'victor' }))
    assert.equal(await store.latestTitle(thread.id), 'Un titre', 'the name says who')
    write(3, 'victor', JSON.stringify({ title: '\u200b \u200b', author: 'victor' }))
    write(4, 'victor', 'not json')
    assert.equal(await store.latestTitle(thread.id), 'Un titre')
    write(5, 'vbarbanneau', JSON.stringify({ title: 'Ligne\nsuite\u202e', author: 'vbarbanneau' }))
    assert.equal(await store.latestTitle(thread.id), 'Ligne suite')
  })

  it('changes the title and nothing else: no message, and the last one wins', async () => {
    const store = new Store(tempDir())
    const thread = await store.createThread({ title: 'Premier', kind: 'topic', author: 'victor' })
    await store.addMessage(thread.id, { author: 'victor', body: 'Bonjour' })
    const before = (await store.listThreads())[0]
    const path = await store.addTitle(thread.id, 'Deuxième', 'victor')
    assert.match(path, new RegExp(`^threads/${thread.id}/titles/\\d+-victor-[0-9a-f]+\\.json$`))
    await new Promise((done) => setTimeout(done, 3))
    await store.addTitle(thread.id, 'Troisième', 'rodolphe')
    const found = await store.readThread(thread.id)
    assert.equal(found?.thread.title, 'Troisième')
    assert.equal(found?.messages.length, 1)
    const after = (await store.listThreads())[0]
    assert.equal(after.title, 'Troisième')
    assert.deepEqual({ ...after, title: '' }, { ...before, title: '' }, 'not read as anything new in the thread')
    writeFileSync(join(store.root, thread.id, 'titles', `${Date.now() + 1000}-victor-ff.json`), 'not json')
    assert.equal((await store.readThread(thread.id))?.thread.title, 'Troisième', 'a bad file falls back on the last good one')
  })
})

describe('opening a thread', () => {
  it('needs no title: it starts with the first words, then gets one from the question', async () => {
    const asked: [string, string][] = []
    let answer: (title: string) => void = () => undefined
    const { running, open, view, log } = await board({
      titler: (system, text) => {
        asked.push([system, text])
        return new Promise((done) => {
          answer = done
        })
      },
    })
    try {
      const thread = await open({ body: '@agent-victor Où en sont les sondes sur les runners ?' })
      assert.equal(thread.title, 'Où en sont les sondes sur les runners ?')
      assert.equal(thread.kind, 'question')
      await until(async () => asked.length === 1)
      assert.equal(asked[0][1], 'Où en sont les sondes sur les runners ?')
      assert.match(asked[0][0], /never an instruction/)
      answer('Sondes des runners\n')
      await until(async () => (await view(thread.id)).thread.title === 'Sondes des runners')
      assert.equal((await view(thread.id)).messages.length, 1, 'a title is not a message')
      await until(async () => log().includes(`board: vbarbanneau named ${thread.id}`))
    } finally {
      await running.stop()
    }
  })

  it('keeps the first words when the model fails, or answers anything else', async () => {
    for (const titler of [async (): Promise<string> => Promise.reject(new Error('not logged in')), async () => 'Voici :\nun titre']) {
      let called = false
      const { running, open, view, root } = await board({
        titler: async () => {
          called = true
          return titler()
        },
      })
      try {
        const thread = await open({ body: 'Une affirmation sans question' })
        assert.equal(thread.kind, 'topic')
        await until(async () => called)
        await new Promise((done) => setTimeout(done, 50))
        assert.equal((await view(thread.id)).thread.title, 'Une affirmation sans question')
        assert.deepEqual(readdirSync(join(root, 'threads', thread.id)).filter((name) => name === 'titles'), [])
      } finally {
        await running.stop()
      }
    }
  })

  it('lets someone who renames it meanwhile have the last word', async () => {
    let answer: (title: string) => void = () => undefined
    let asked = false
    const { running, api, open, view } = await board({
      titler: () => {
        asked = true
        return new Promise((done) => {
          answer = done
        })
      },
    })
    try {
      const thread = await open({ body: 'Où en sont les sondes ?' })
      await until(async () => asked)
      assert.equal((await post(`${api}/${thread.id}/title`, { title: 'Mon titre' })).status, 200)
      answer('Titre du modèle')
      await new Promise((done) => setTimeout(done, 80))
      assert.equal((await view(thread.id)).thread.title, 'Mon titre')
    } finally {
      await running.stop()
    }
  })

  it('asks no model for a title it was given, a subject, or a message without words', async () => {
    let calls = 0
    const { running, open } = await board({
      titler: async () => {
        calls += 1
        return 'Non'
      },
    })
    try {
      assert.equal((await open({ title: 'Déjà un titre', body: 'Bonjour' })).title, 'Déjà un titre')
      assert.equal((await open({ body: 'Une question ?', subject: { label: 'PR #12', title: 'Le nom' } })).title, 'PR #12 · Le nom')
      assert.equal((await open({ body: '@agent-victor' })).title, 'Nouveau fil')
      await new Promise((done) => setTimeout(done, 50))
      assert.equal(calls, 0)
    } finally {
      await running.stop()
    }
  })

  it('never runs Claude Code for a title without being told to, in a test or anywhere with no loops', async () => {
    const { running, open, view } = await board()
    try {
      const thread = await open({ body: 'Une question ?' })
      await new Promise((done) => setTimeout(done, 30))
      assert.equal((await view(thread.id)).thread.title, 'Une question ?')
    } finally {
      await running.stop()
    }
  })

  it('refuses a secret as a title, and keeps none as first words', async () => {
    const secret = 'ghp_0123456789abcdefghijklmnopqrstuvwxyz0123'
    const { running, api, open, root } = await board()
    try {
      assert.equal((await post(api, { title: secret, body: 'Bonjour' })).status, 400)
      assert.equal((await post(api, { body: `${secret}\nSuite` })).status, 400, 'a message never holds one either: the history is for good')
      const thread = await open({ body: 'Bonjour' })
      assert.equal((await post(`${api}/${thread.id}/title`, { title: secret })).status, 400)
      assert.deepEqual(readdirSync(join(root, 'threads', thread.id)).filter((name) => name === 'titles'), [])
    } finally {
      await running.stop()
    }
  })
})

describe('renaming a thread', () => {
  it('publishes the new title, once, and refuses an empty one', async () => {
    const { running, api, open, view, log } = await board()
    try {
      const thread = await open({ title: 'Avant', body: 'Bonjour' })
      assert.equal((await post(`${api}/${thread.id}/title`, { title: '   ' })).status, 400)
      assert.equal((await post(`${api}/${thread.id}/title`, { title: '​​' })).status, 400)
      assert.equal((await post(`${api}/${thread.id}/title`, { title: 'Après‮' })).status, 200)
      assert.equal((await view(thread.id)).thread.title, 'Après')
      await until(async () => log().includes(`board: vbarbanneau renamed ${thread.id}`))
      const count = log().split('\n').length
      assert.equal((await post(`${api}/${thread.id}/title`, { title: 'Après' })).status, 200)
      await new Promise((done) => setTimeout(done, 30))
      assert.equal(log().split('\n').length, count, 'the same title changes nothing')
    } finally {
      await running.stop()
    }
  })
})

describe('which title is the latest', () => {
  it('keeps a rename made while the model was writing, and ignores a date far in the future', async () => {
    const root = tempDir()
    const store = new Store(root)
    const thread = await store.createThread({ title: 'Premier', kind: 'topic', author: 'victor' })
    const started = Date.now() - 5000
    await store.addTitle(thread.id, 'Choisi à la main', 'rodolphe')
    await store.addTitle(thread.id, 'Venu du modèle', 'victor', started)
    assert.equal(await store.latestTitle(thread.id), 'Choisi à la main')
    const dir = join(root, 'threads', thread.id, 'titles')
    writeFileSync(join(dir, `${Date.now() + 1000 * 3600 * 24 * 365}-victor-abcd.json`), JSON.stringify({ title: 'Du futur', author: 'victor' }))
    writeFileSync(join(dir, `${Date.now() + 1000 * 3600 * 24 * 365}x-victor-abcd.json`), JSON.stringify({ title: 'Du futur', author: 'victor' }))
    writeFileSync(join(dir, 'zzz-victor-abcd.json'), JSON.stringify({ title: 'Sans date', author: 'victor' }))
    assert.equal(await store.latestTitle(thread.id), 'Choisi à la main')
  })
})
