import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, it } from 'node:test'
import { startTestBoard as startBoard } from '../support/helpers.ts'
import { type Catalog, cleanSegment, draftText, type EngineOptions, programOf, type VoiceApi, VoiceDrafts, VoiceEngine, type VoiceStatus, wavOf } from '../../src/server/voice/engine.ts'
import { RATE, type Passage, Segmenter, toPcm16 } from '../../src/client/features/voice/voice-segments.ts'

const temp: string[] = []
const servers: Server[] = []
const boards: { stop: () => Promise<void> }[] = []
afterEach(async () => {
  for (const running of boards.splice(0)) await running.stop()
  for (const server of servers.splice(0)) {
    server.closeAllConnections()
    server.close()
  }
  for (const dir of temp.splice(0)) rmSync(dir, { recursive: true, force: true })
})
const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), 'board-voice-'))
  temp.push(dir)
  return dir
}

const tone = (ms: number, level = 0.2) => Float32Array.from({ length: (RATE * ms) / 1000 }, (_, i) => Math.sin(i / 8) * level)
const quiet = (ms: number) => new Float32Array((RATE * ms) / 1000)

describe('cutting speech into passages', () => {
  const run = (...parts: Float32Array[]) => {
    const passages: Passage[] = []
    const segmenter = new Segmenter((passage) => passages.push(passage))
    for (const part of parts) segmenter.feed(part)
    return { passages, segmenter }
  }

  it('hands over nothing for silence', () => {
    const { passages, segmenter } = run(quiet(5000))
    segmenter.flush()
    assert.equal(passages.length, 0)
  })

  it('cuts at a pause, and keeps the moment before the first word', () => {
    const { passages } = run(quiet(1000), tone(1000), quiet(900), tone(800), quiet(900))
    assert.equal(passages.length, 2)
    assert.ok(passages[0].at >= 650 && passages[0].at <= 1000, `starts at ${passages[0].at}`)
    assert.ok(passages[1].at >= 2500 && passages[1].at <= 2900, `starts at ${passages[1].at}`)
    assert.ok(passages[0].samples.length >= RATE, 'the whole of what was said')
  })

  it('gives text regularly to someone who never pauses', () => {
    const { passages } = run(tone(50_000))
    assert.equal(passages.length, 2)
    assert.ok(passages.every(({ samples }) => samples.length <= (RATE * 20_100) / 1000))
  })

  it('drops a click, which is no speech', () => {
    const { passages, segmenter } = run(quiet(500), tone(60), quiet(1000))
    segmenter.flush()
    assert.equal(passages.length, 0)
  })

  it('gives what is left when the listening ends', () => {
    const { passages, segmenter } = run(quiet(200), tone(600))
    assert.equal(passages.length, 0)
    segmenter.flush()
    assert.equal(passages.length, 1)
  })

  it('takes the sizes a microphone sends, whatever they are', () => {
    const whole = run(quiet(400), tone(1000), quiet(900)).passages
    const passages: Passage[] = []
    const segmenter = new Segmenter((passage) => passages.push(passage))
    const samples = Float32Array.from([...quiet(400), ...tone(1000), ...quiet(900)])
    for (let i = 0; i < samples.length; i += 137) segmenter.feed(samples.subarray(i, i + 137))
    assert.equal(passages.length, whole.length)
    assert.equal(passages[0].samples.length, whole[0].samples.length)
  })

  it('does not join words on either side of a pause in the listening', () => {
    const { passages, segmenter } = run(tone(600))
    segmenter.breakHere()
    assert.equal(passages.length, 1)
    segmenter.feed(tone(600))
    segmenter.flush()
    assert.equal(passages.length, 2)
  })

  it('makes 16-bit samples, without overflowing', () => {
    const out = new Int16Array(toPcm16(Float32Array.from([0, 1, -1, 2, -2])))
    assert.deepEqual([...out], [0, 32767, -32768, 32767, -32768])
  })
})

describe('what comes out of the engine', () => {
  it('keeps what was said', () => {
    assert.equal(cleanSegment('  On part sur  le VPS.\n'), 'On part sur le VPS.')
    assert.equal(cleanSegment('Merci pour ton retour.'), 'Merci pour ton retour.')
  })

  it('drops what is not speech, and what it invents on silence', () => {
    for (const noise of ['', '   ', '[BLANK_AUDIO]', '[Musique]', '[Bruit de moteur]', '(applaudissements)', '*rires*', '...', 'Sous-titres réalisés par la communauté d’Amara.org', "Merci d'avoir regardé cette vidéo !", 'Thank you for watching.', '♪']) {
      assert.equal(cleanSegment(noise), null, noise)
    }
  })

  it('keeps a word someone really said', () => {
    for (const said of ['Silence.', 'Musique', 'Bruit', 'Oui.', 'Abonnez-vous à ce service plutôt qu’à l’autre.']) assert.equal(cleanSegment(said), said)
  })

  it('writes a sound file the server can read', () => {
    const wav = wavOf(Buffer.alloc(3200))
    assert.equal(wav.length, 3244)
    assert.equal(wav.toString('ascii', 0, 4), 'RIFF')
    assert.equal(wav.readUInt32LE(24), 16_000)
    assert.equal(wav.readUInt16LE(22), 1)
    assert.equal(wav.readUInt32LE(40), 3200)
  })
})

describe('what is heard and not yet published', () => {
  it('reads as what was said, in order, and says where a passage is missing', async () => {
    const drafts = new VoiceDrafts(tempDir())
    const draft = await drafts.start('thread')
    await drafts.addSegment(draft.id, { seq: 1, at: 2000, text: 'deux' })
    await drafts.addSegment(draft.id, { seq: 0, at: 0, text: 'un' })
    await drafts.addSegment(draft.id, { seq: 2, at: 4000, text: '', lost: true })
    const read = await drafts.get(draft.id)
    assert.equal(draftText(read!), '[00:00] un\n[00:02] deux\n[00:04] [passage non transcrit]')
  })

  it('prefers what the person corrected', async () => {
    const drafts = new VoiceDrafts(tempDir())
    const draft = await drafts.start('thread')
    await drafts.addSegment(draft.id, { seq: 0, at: 0, text: 'mal entendu' })
    await drafts.setText(draft.id, 'bien corrigé')
    assert.equal(draftText((await drafts.get(draft.id))!), 'bien corrigé')
  })

  it('keeps nothing when nothing was said', async () => {
    const dir = tempDir()
    const drafts = new VoiceDrafts(dir)
    const draft = await drafts.start('thread')
    assert.equal(await drafts.stop(draft.id), null)
    assert.deepEqual(await drafts.list(), [])
  })

  it('refuses a name that would leave its folder', async () => {
    const drafts = new VoiceDrafts(tempDir())
    assert.equal(await drafts.get('../../settings'), null)
    await drafts.remove('../../settings')
  })

  it('keeps words that come in after the listening has ended', async () => {
    const drafts = new VoiceDrafts(tempDir())
    const draft = await drafts.start('thread')
    await drafts.addSegment(draft.id, { seq: 0, at: 0, text: 'un' })
    await drafts.stop(draft.id)
    await drafts.addSegment(draft.id, { seq: 1, at: 1000, text: 'deux' })
    assert.equal(draftText((await drafts.get(draft.id))!), '[00:00] un\n[00:01] deux')
  })

  it('does not bring back what was removed, whatever order changes come in', async () => {
    const drafts = new VoiceDrafts(tempDir())
    const draft = await drafts.start('thread')
    await drafts.addSegment(draft.id, { seq: 0, at: 0, text: 'un' })
    await drafts.stop(draft.id)
    await Promise.all([drafts.setText(draft.id, 'avant'), drafts.remove(draft.id), drafts.setText(draft.id, 'après')])
    assert.equal(await drafts.get(draft.id), null)
    assert.deepEqual(await drafts.list(), [])
  })

  it('counts as listening from the first moment', async () => {
    const drafts = new VoiceDrafts(tempDir())
    const first = drafts.start('thread')
    assert.ok(drafts.listening)
    await first
  })

  it('cleans a save cut short by a crash', async () => {
    const dir = tempDir()
    const drafts = new VoiceDrafts(dir)
    await drafts.start('thread')
    writeFileSync(join(dir, 'transcripts', 'abc.json.1234.partial'), 'words')
    await new VoiceDrafts(dir).closeInterrupted()
    assert.deepEqual(allFiles(dir), [])
  })

  it('ignores a damaged file', async () => {
    const dir = tempDir()
    const drafts = new VoiceDrafts(dir)
    await drafts.start('thread')
    writeFileSync(join(dir, 'transcripts', 'damaged.json'), '{ not json')
    assert.equal((await drafts.list()).length, 1)
  })

  it('does not stay listening across a restart', async () => {
    const dir = tempDir()
    const first = new VoiceDrafts(dir)
    const heard = await first.start('thread')
    await first.addSegment(heard.id, { seq: 0, at: 0, text: 'coupé' })
    const silent = await first.start('other')
    const second = new VoiceDrafts(dir)
    await second.closeInterrupted()
    assert.equal(second.listening, null)
    const left = await second.list()
    assert.deepEqual(left.map((draft) => draft.id), [heard.id])
    assert.ok(left[0].stoppedAt)
    assert.equal(await second.get(silent.id), null)
  })
})

const sha = (data: Buffer) => createHash('sha256').update(data).digest('hex')

/** A web server for what would come from GitHub and Hugging Face. */
async function files(contents: Record<string, Buffer>) {
  const asked: string[] = []
  const server = createServer((req, res) => {
    const name = (req.url ?? '').slice(1)
    asked.push(name)
    if (!contents[name]) {
      res.writeHead(404)
      res.end()
      return
    }
    res.writeHead(200, { 'content-length': contents[name].length })
    res.end(contents[name])
  })
  servers.push(server)
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  return { base: `http://127.0.0.1:${(server.address() as { port: number }).port}`, asked }
}

const pinned = (base: string, file: string, data: Buffer) => ({ file, url: `${base}/${file}`, size: data.length, sha256: sha(data) })

function catalogOf(base: string, sets: { engine: Buffer; model: Buffer; vad: Buffer }): Catalog {
  const engine = { label: 'Processeur', ...pinned(base, 'engine.zip', sets.engine) }
  return {
    engines: { cuda12: { ...engine, label: 'A' }, cuda11: { ...engine, label: 'B' }, cpu: engine },
    models: [{ id: 'small', label: 'Petit', note: '', ...pinned(base, 'model.bin', sets.model) }],
    vad: pinned(base, 'vad.bin', sets.vad),
  }
}

const ZIP = Buffer.from('a pretend archive')
const MODEL = Buffer.from('a pretend model')
const VAD = Buffer.from('a pretend detector')
/** Extraction is Windows' `tar`: what matters here is what happens around it. */
const unpackInto = (subfolder: string, hasServer = true) => async (_archive: string, target: string) => {
  mkdirSync(join(target, subfolder), { recursive: true })
  if (hasServer) writeFileSync(join(target, subfolder, 'whisper-server.exe'), 'pretend')
}

async function engineOn(contents: Record<string, Buffer>, sets = { engine: ZIP, model: MODEL, vad: VAD }, extract: NonNullable<EngineOptions['extract']> = unpackInto('Release')) {
  const web = await files(contents)
  const dir = tempDir()
  const speakModels = tempDir()
  const engine = new VoiceEngine({ dir, catalog: catalogOf(web.base, sets), speakModels, gpu: async () => null, extract, supported: true })
  return { engine, dir, speakModels, web }
}

async function settled(engine: VoiceEngine): Promise<VoiceStatus> {
  for (let i = 0; i < 400; i++) {
    const status = await engine.status()
    if (!status.installing && !(engine as unknown as { abort: unknown }).abort) return status
    await new Promise((done) => setTimeout(done, 10))
  }
  throw new Error('the install never ended')
}

const allFiles = (dir: string): string[] => readdirSync(dir, { withFileTypes: true, recursive: true }).filter((entry) => entry.isFile()).map((entry) => entry.name)

describe('installing the engine', () => {
  const good = { 'engine.zip': ZIP, 'model.bin': MODEL, 'vad.bin': VAD }

  it('is ready once everything has its announced size and hash, with the server inside a subfolder', async () => {
    const { engine } = await engineOn(good)
    assert.equal((await engine.status()).ready, false)
    await engine.install({ engine: 'cpu', model: 'small' })
    const status = await settled(engine)
    assert.equal(status.installError, null)
    assert.equal(status.ready, true)
    assert.deepEqual(status.chosen, { engine: 'cpu', model: 'small' })
  })

  it('refuses a file that is not what was pinned, and starts nothing from it', async () => {
    const tampered = Buffer.from('a pretend modeL')
    assert.equal(tampered.length, MODEL.length)
    const { engine, dir } = await engineOn({ ...good, 'model.bin': tampered })
    await engine.install({ engine: 'cpu', model: 'small' })
    const status = await settled(engine)
    assert.match(status.installError ?? '', /empreinte/)
    assert.equal(status.ready, false)
    assert.ok(!allFiles(dir).some((name) => name.includes('model.bin')), 'nothing of it stays')
  })

  it('refuses a file of another size', async () => {
    const { engine, dir } = await engineOn({ ...good, 'vad.bin': Buffer.from('short') })
    await engine.install({ engine: 'cpu', model: 'small' })
    const status = await settled(engine)
    assert.match(status.installError ?? '', /incomplet/)
    assert.ok(!allFiles(dir).some((name) => name.endsWith('.part')))
  })

  it('says when the download is refused', async () => {
    const { engine } = await engineOn({ 'vad.bin': VAD })
    await engine.install({ engine: 'cpu', model: 'small' })
    assert.match((await settled(engine)).installError ?? '', /refusé \(404\)/)
  })

  it('leaves no engine installed when the archive holds no server', async () => {
    const { engine, dir } = await engineOn(good, undefined, unpackInto('Release', false))
    await engine.install({ engine: 'cpu', model: 'small' })
    const status = await settled(engine)
    assert.match(status.installError ?? '', /serveur/)
    assert.equal(status.engines.find(({ id }) => id === 'cpu')?.installed, false)
    assert.ok(!allFiles(dir).some((name) => name.endsWith('.zip')), 'the archive is not kept')
  })

  it('stops when cancelled, says nothing went wrong, and keeps no partial file', async () => {
    const big = Buffer.alloc(4 * 1024 * 1024, 1)
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'content-length': big.length })
      // Half, and then nothing: the cancel is what ends it.
      res.write(big.subarray(0, big.length / 2))
    })
    servers.push(server)
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
    const dir = tempDir()
    const engine = new VoiceEngine({ dir, catalog: catalogOf(base, { engine: ZIP, model: MODEL, vad: big }), speakModels: tempDir(), gpu: async () => null, supported: true })
    await engine.install({ engine: 'cpu', model: 'small' })
    for (let i = 0; i < 300 && !(await engine.status()).installing?.received; i++) await new Promise((done) => setTimeout(done, 10))
    assert.ok((await engine.status()).installing?.received, 'it had started')
    engine.cancelInstall()
    const status = await settled(engine)
    server.closeAllConnections()
    assert.equal(status.installError, null)
    assert.equal(status.ready, false)
    assert.ok(!allFiles(dir).some((name) => name.endsWith('.part')))
  })

  it('takes a model from speak if it is the same file, without downloading it', async () => {
    const { engine, dir, speakModels, web } = await engineOn(good)
    writeFileSync(join(speakModels, 'model.bin'), MODEL)
    assert.equal((await engine.status()).models[0].inSpeak, true)
    await engine.install({ engine: 'cpu', model: 'small' })
    assert.equal((await settled(engine)).ready, true)
    assert.ok(!web.asked.includes('model.bin'))
    assert.ok(allFiles(dir).includes('model.bin'))
  })

  it('downloads it after all if the file in speak has another hash', async () => {
    const { engine, dir, speakModels, web } = await engineOn(good)
    writeFileSync(join(speakModels, 'model.bin'), Buffer.from('a pretend modeL'))
    await engine.install({ engine: 'cpu', model: 'small' })
    assert.equal((await settled(engine)).ready, true)
    assert.ok(web.asked.includes('model.bin'))
    assert.deepEqual(readFileSync(join(dir, 'models', 'model.bin')), MODEL)
  })

  it('downloads nothing twice, and uses what was chosen last', async () => {
    const { engine, web } = await engineOn(good)
    await engine.install({ engine: 'cpu', model: 'small' })
    await settled(engine)
    await engine.install({ engine: 'cuda12', model: 'small' })
    await settled(engine)
    assert.equal((await engine.status()).chosen.engine, 'cuda12')
    assert.equal(web.asked.filter((name) => name === 'model.bin').length, 1)
    // A machine whose card fails goes back to the processor without downloading anything.
    const before = web.asked.length
    await engine.install({ engine: 'cpu', model: 'small' })
    const status = await settled(engine)
    assert.equal(status.chosen.engine, 'cpu')
    assert.equal(web.asked.length, before + 0)
  })

  it('refuses what is not in the list, and a second install at once', async () => {
    const { engine } = await engineOn(good)
    await assert.rejects(engine.install({ engine: 'cpu', model: 'other' }), /inconnu/)
    await engine.install({ engine: 'cpu', model: 'small' })
    await assert.rejects(engine.install({ engine: 'cpu', model: 'small' }), /déjà/)
    await settled(engine)
  })

  it('stops at a cancel even while unpacking, and installs nothing', async () => {
    let unpacking: () => void = () => undefined
    const reached = new Promise<void>((done) => {
      unpacking = done
    })
    const { engine } = await engineOn(good, undefined, async (_archive, _target, signal) => {
      unpacking()
      await new Promise<void>((_done, fail) => signal.addEventListener('abort', () => fail(new Error('aborted'))))
    })
    await engine.install({ engine: 'cpu', model: 'small' })
    await reached
    engine.cancelInstall()
    const status = await settled(engine)
    assert.equal(status.installError, null)
    assert.equal(status.engines.find(({ id }) => id === 'cpu')?.installed, false)
    assert.equal(status.ready, false)
  })

  it('cleans what a killed install left, and keeps no copy of a file that fails its hash', async () => {
    const { engine, dir, speakModels } = await engineOn(good)
    mkdirSync(join(dir, 'models'), { recursive: true })
    writeFileSync(join(dir, 'models', 'old.bin.part'), 'left behind')
    writeFileSync(join(speakModels, 'model.bin'), Buffer.from('a pretend modeL'))
    await engine.install({ engine: 'cpu', model: 'small' })
    assert.equal((await settled(engine)).ready, true)
    assert.ok(!allFiles(dir).some((name) => name.endsWith('.part')))
  })

  it('cuts a download that goes past its size', async () => {
    const { engine } = await engineOn({ ...good, 'vad.bin': Buffer.alloc(VAD.length * 200, 1) })
    await engine.install({ engine: 'cpu', model: 'small' })
    assert.match((await settled(engine)).installError ?? '', /plus lourd|incomplet/)
  })

  it('refuses to remove during an install', async () => {
    const { engine } = await engineOn(good)
    await engine.install({ engine: 'cpu', model: 'small' })
    await assert.rejects(engine.remove(), /en cours/)
    await settled(engine)
  })

  it('never starts again once closed', async () => {
    const { engine } = await engineOn(good)
    await engine.install({ engine: 'cpu', model: 'small' })
    await settled(engine)
    await engine.close()
    await assert.rejects(engine.transcribe(Buffer.alloc(3200)), /arrêté/)
    assert.equal((await engine.status()).running, false)
  })

  it('reads which program a process runs', { skip: process.platform !== 'win32' }, async () => {
    assert.equal((await programOf(process.pid))?.toLowerCase(), process.execPath.toLowerCase())
    assert.equal(await programOf(999_999_999), null)
  })

  it('ends what a crash left behind, and nothing else', async () => {
    const dir = tempDir()
    const killed: number[] = []
    const running = new Map<number, string>([
      [111, join(dir, 'engine', 'cpu-b5454', 'Release', 'whisper-server.exe')],
      [222, join('C:', 'speak', 'bin', 'whisper-server.exe')],
    ])
    const engine = new VoiceEngine({ dir, gpu: async () => null, supported: true, programOf: async (pid) => running.get(pid) ?? null, kill: (pid) => killed.push(pid) })
    await engine.clearLeftover()
    assert.deepEqual(killed, [], 'no file: nothing to do')
    for (const [text, expected] of [['111', [111]], ['222', []], ['333', []], ['not a pid', []]] as const) {
      killed.length = 0
      writeFileSync(join(dir, 'engine.pid'), text)
      await engine.clearLeftover()
      assert.deepEqual(killed, [...expected], text)
      assert.ok(!existsSync(join(dir, 'engine.pid')))
    }
  })

  it('gives the place back', async () => {
    const { engine, dir } = await engineOn(good)
    await engine.install({ engine: 'cpu', model: 'small' })
    await settled(engine)
    await engine.remove()
    assert.equal((await engine.status()).ready, false)
    assert.deepEqual(allFiles(dir), [])
  })
})

const READY: VoiceStatus = {
  supported: true,
  gpu: null,
  recommended: { engine: 'cpu', model: 'small' },
  engines: [{ id: 'cpu', label: 'Processeur', size: 1, installed: true }],
  models: [{ id: 'small', label: 'Petit', note: '', size: 1, installed: true, inSpeak: false }],
  ready: true,
  chosen: { engine: 'cpu', model: 'small' },
  installing: null,
  installError: null,
  running: false,
}

describe('the routes of the voice', () => {
  const gitIn = (dir: string, ...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })

  async function board(voice: Partial<VoiceApi> = {}, listening: boolean[] = []) {
    const dir = tempDir()
    const remote = join(dir, 'remote.git')
    const root = join(dir, 'root')
    gitIn(dir, 'init', '-q', '--bare', '-b', 'main', remote)
    gitIn(dir, 'init', '-q', '-b', 'main', root)
    gitIn(root, 'config', 'user.name', 'test')
    gitIn(root, 'config', 'user.email', 'test@example.invalid')
    gitIn(root, 'remote', 'add', 'origin', remote)
    writeFileSync(join(root, '.gitignore'), '.cache/\n')
    gitIn(root, 'add', '.')
    gitIn(root, 'commit', '-q', '-m', 'init')
    gitIn(root, 'push', '-q', '-u', 'origin', 'main')
    const transcribed: Buffer[] = []
    process.env.BOARD_PERSON = 'victor'
    const running = await startBoard({
      root,
      client: join(root, 'client'),
      port: 4801,
      loops: false,
      onListening: (value: boolean) => listening.push(value),
      voice: {
        status: async () => READY,
        install: async () => undefined,
        cancelInstall: () => undefined,
        remove: async () => undefined,
        transcribe: async (pcm: Buffer) => {
          transcribed.push(pcm)
          return 'Bonjour le board.'
        },
        stop: async () => undefined,
        close: async () => undefined,
        clearLeftover: async () => undefined,
        ...voice,
      },
    })
    boards.push(running)
    const call = async (path: string, body?: unknown, headers: Record<string, string> = {}) => {
      const response = await fetch(`${running.url}/api/${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { 'content-type': 'application/json', 'x-board': '1', ...headers },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
      return { status: response.status, body: (await response.json().catch(() => null)) as any }
    }
    const audio = (id: string, seq: number, bytes = 3200, headers: Record<string, string> = { 'x-board': '1' }) =>
      fetch(`${running.url}/api/voice/sessions/${id}/audio?seq=${seq}&at=${seq * 1000}`, { method: 'POST', headers, body: new Uint8Array(bytes) })
    const made = await call('threads', { title: 'Un fil', body: 'Pour parler.' })
    assert.equal(made.status, 201)
    return { running, root, remote, call, audio, thread: made.body.id as string, transcribed, gitIn }
  }

  it('starts nothing by itself', async () => {
    const started: boolean[] = []
    const { running, call } = await board({ transcribe: async () => (started.push(true), '') })
    const view = await call('voice')
    assert.equal(view.status, 200)
    assert.equal(view.body.listening, null)
    assert.deepEqual(view.body.drafts, [])
    assert.equal(started.length, 0)
  })

  it('goes from listening to reading to the thread, and the thread is the only place it ends up', async () => {
    const listening: boolean[] = []
    const { running, root, remote, call, audio, thread, transcribed, gitIn } = await board({}, listening)
    const started = await call('voice/sessions', { threadId: thread })
    assert.equal(started.status, 201)
    const { id } = started.body
    assert.equal((await call('voice')).body.listening.id, id)
    const answer = await audio(id, 0)
    assert.equal(answer.status, 200)
    assert.equal(((await answer.json()) as any).segment.text, 'Bonjour le board.')
    assert.equal(transcribed[0].length, 3200)
    assert.equal((await call(`voice/sessions/${id}/stop`, {})).status, 200)
    const read = await call('voice')
    assert.equal(read.body.listening, null)
    assert.equal(read.body.drafts[0].text, '[00:00] Bonjour le board.')
    assert.deepEqual(listening, [true, false])

    // Nothing has gone anywhere before it is published.
    const before = (await call(`threads/${thread}`)).body
    assert.equal(before.messages.length, 1)

    const published = await call(`voice/sessions/${id}/publish`, { text: 'Bonjour le board, relu.' })
    assert.equal(published.status, 201)
    assert.equal(published.body.voice, true)
    const after = (await call(`threads/${thread}`)).body
    assert.equal(after.messages.at(-1).body, 'Bonjour le board, relu.')
    assert.equal(after.messages.at(-1).voice, true)
    assert.deepEqual((await call('voice')).body.drafts, [])

    // In what was pushed: the text, and not a sound.
    const pushed = gitIn(remote, 'ls-tree', '-r', '--name-only', 'main')
    assert.ok(pushed.includes(thread))
    assert.ok(!/\.(wav|pcm|mp3|ogg|webm)\b/.test(pushed))
    assert.ok(!allFiles(join(root, '.cache')).some((name) => /\.(wav|pcm|mp3|ogg|webm)$/.test(name)), 'no sound on the disk')
  })

  it('reads the mark back from the file, for the other person and for agents', async () => {
    const { running, root, call, audio, thread } = await board()
    const { id } = (await call('voice/sessions', { threadId: thread })).body
    await audio(id, 0)
    await call(`voice/sessions/${id}/stop`, {})
    const published = await call(`voice/sessions/${id}/publish`, { text: 'Lu à voix haute.' })
    const files = readdirSync(join(root, 'threads', thread)).filter((name) => name.endsWith('.md'))
    const written = files.map((name) => readFileSync(join(root, 'threads', thread, name), 'utf8')).find((text) => text.includes('Lu à voix haute.'))
    assert.match(written ?? '', /^voice: true$/m)
    assert.equal(published.status, 201)
  })

  it('drops what is not speech, and tells nothing was said', async () => {
    const { running, call, audio, thread } = await board({ transcribe: async () => '[BLANK_AUDIO]' })
    const { id } = (await call('voice/sessions', { threadId: thread })).body
    const answer = await audio(id, 0)
    assert.equal(((await answer.json()) as any).segment, null)
    await call(`voice/sessions/${id}/stop`, {})
    assert.deepEqual((await call('voice')).body.drafts, [])
  })

  it('says where a passage was lost, so the person can say it again', async () => {
    let fail = true
    const { running, call, audio, thread } = await board({
      transcribe: async () => {
        if (fail) {
          fail = false
          throw new Error('Le moteur a lâché.')
        }
        return 'La suite.'
      },
    })
    const { id } = (await call('voice/sessions', { threadId: thread })).body
    const lost = await audio(id, 0)
    assert.equal(lost.status, 502)
    assert.equal((await audio(id, 1)).status, 200)
    await call(`voice/sessions/${id}/stop`, {})
    assert.equal((await call('voice')).body.drafts[0].text, '[00:00] [passage non transcrit]\n[00:01] La suite.')
  })

  it('listens to one thing at a time, even asked twice at once', async () => {
    const { call, thread } = await board()
    const both = await Promise.all([call('voice/sessions', { threadId: thread }), call('voice/sessions', { threadId: thread })])
    assert.deepEqual(both.map(({ status }) => status).sort(), [201, 409])
    assert.equal((await call('voice/sessions', { threadId: thread })).status, 409)
  })

  it('does not start without the engine, or in a thread that does not exist', async () => {
    const { running, call, thread } = await board({ status: async () => ({ ...READY, ready: false }) })
    assert.equal((await call('voice/sessions', { threadId: thread })).status, 400)
    assert.equal((await call('voice/sessions', { threadId: 'nothing-here' })).status, 404)
  })

  it('does not start in a closed thread', async () => {
    const open = await board()
    await open.call(`threads/${open.thread}/status`, { status: 'closed' })
    assert.equal((await open.call('voice/sessions', { threadId: open.thread })).status, 400)
  })

  it('takes no audio outside a listening, of a wrong size, or from another site', async () => {
    const { running, call, audio, thread } = await board()
    const { id } = (await call('voice/sessions', { threadId: thread })).body
    assert.equal((await audio(id, 0, 3201)).status, 400)
    assert.equal((await audio(id, 0, 0)).status, 400)
    assert.equal((await audio(id, 0, 60 * 16_000 * 2 + 2)).status, 413)
    assert.equal((await audio(id, 0, 3200, {})).status, 403)
    assert.equal((await audio(id, 0, 3200, { 'x-board': '1', origin: 'https://example.invalid' })).status, 403)
    assert.equal((await audio('0123456789abcdef', 0)).status, 409)
    await call(`voice/sessions/${id}/stop`, {})
    assert.equal((await audio(id, 1)).status, 409)
  })

  it('does not start while an install is finishing', async () => {
    const { call, thread } = await board({ status: async () => ({ ...READY, installing: { label: 'x', received: 1, total: 2 } }) })
    assert.equal((await call('voice/sessions', { threadId: thread })).status, 409)
    assert.equal((await call('voice')).body.listening, null)
  })

  it('keeps words still on their way when a stop comes from elsewhere', async () => {
    let finish: (text: string) => void = () => undefined
    const { call, audio, thread } = await board({ transcribe: () => new Promise<string>((done) => (finish = done)) })
    const { id } = (await call('voice/sessions', { threadId: thread })).body
    const passage = audio(id, 0)
    await new Promise((done) => setTimeout(done, 200))
    const stopping = call(`voice/sessions/${id}/stop`, {})
    await new Promise((done) => setTimeout(done, 100))
    finish('Encore en route.')
    await passage
    await stopping
    assert.equal((await call('voice')).body.drafts[0].text, '[00:00] Encore en route.')
  })

  it('does not change the engine under a listening', async () => {
    const { call, thread } = await board()
    await call('voice/sessions', { threadId: thread })
    assert.equal((await call('voice/install', { engine: 'cpu', model: 'small' })).status, 409)
    assert.equal((await call('voice/remove', {})).status, 409)
  })

  it('says which page holds the listening, so that another page leaves it alone', async () => {
    const { call, thread } = await board()
    await call('voice/sessions', { threadId: thread, page: 'page-one' })
    assert.equal((await call('voice')).body.listening.page, 'page-one')
  })

  it('tells the next passage to stop, if the page missed the message', async () => {
    const { running, call, audio, thread } = await board()
    const { id } = (await call('voice/sessions', { threadId: thread })).body
    assert.equal(((await (await audio(id, 0)).json()) as any).stop, undefined)
    running.stopListening()
    assert.equal(((await (await audio(id, 1)).json()) as any).stop, true)
  })

  it('takes no audio once the app is leaving', async () => {
    const { running, call, audio, thread } = await board({ close: async () => undefined })
    const { id } = (await call('voice/sessions', { threadId: thread })).body
    boards.length = 0
    const leaving = running.stop()
    const answer = await audio(id, 0).catch(() => null)
    assert.ok(!answer || answer.status === 409, String(answer?.status))
    await leaving
  })

  it('takes no starting of a listening from another site', async () => {
    const { running, call, thread } = await board()
    const refused = await call('voice/sessions', { threadId: thread }, { origin: 'https://example.invalid' })
    assert.equal(refused.status, 403)
    assert.equal((await call('voice')).body.listening, null)
  })

  it('refuses to publish what looks like a secret, and an empty text, and keeps the draft', async () => {
    const { running, call, audio, thread } = await board()
    const { id } = (await call('voice/sessions', { threadId: thread })).body
    await audio(id, 0)
    await call(`voice/sessions/${id}/stop`, {})
    assert.equal((await call(`voice/sessions/${id}/publish`, { text: 'token ghp_abcdefghijklmnopqrstuvwxyz0123456789' })).status, 400)
    assert.equal((await call(`voice/sessions/${id}/publish`, { text: '   ' })).status, 400)
    assert.equal((await call('voice')).body.drafts.length, 1)
  })

  it('does not publish while still listening, into a closed thread, or twice', async () => {
    const { running, call, audio, thread } = await board()
    const { id } = (await call('voice/sessions', { threadId: thread })).body
    await audio(id, 0)
    assert.equal((await call(`voice/sessions/${id}/publish`, { text: 'Trop tôt.' })).status, 404)
    await call(`voice/sessions/${id}/stop`, {})
    await call(`threads/${thread}/status`, { status: 'closed' })
    assert.equal((await call(`voice/sessions/${id}/publish`, { text: 'Trop tard.' })).status, 400)
    await call(`threads/${thread}/status`, { status: 'open' })
    const both = await Promise.all([call(`voice/sessions/${id}/publish`, { text: 'Une seule fois.' }), call(`voice/sessions/${id}/publish`, { text: 'Une seule fois.' })])
    const statuses = both.map(({ status }) => status).sort()
    assert.equal(statuses[0], 201)
    assert.ok(statuses[1] === 404 || statuses[1] === 409, String(statuses[1]))
    const messages = (await call(`threads/${thread}`)).body.messages as { body: string }[]
    assert.equal(messages.filter(({ body }) => body === 'Une seule fois.').length, 1)
  })

  it('throws away what the person discards, on the disk too', async () => {
    const { running, root, call, audio, thread } = await board()
    const { id } = (await call('voice/sessions', { threadId: thread })).body
    await audio(id, 0)
    await call(`voice/sessions/${id}/stop`, {})
    assert.ok(existsSync(join(root, '.cache', 'voice', 'transcripts', `${id}.json`)))
    assert.equal((await call(`voice/sessions/${id}/discard`, {})).status, 200)
    assert.ok(!existsSync(join(root, '.cache', 'voice', 'transcripts', `${id}.json`)))
    assert.deepEqual((await call(`threads/${thread}`)).body.messages.length, 1)
  })

  it('saves the corrections as they are typed', async () => {
    const { running, call, audio, thread } = await board()
    const { id } = (await call('voice/sessions', { threadId: thread })).body
    await audio(id, 0)
    await call(`voice/sessions/${id}/stop`, {})
    await call(`voice/sessions/${id}/text`, { text: 'Corrigé.' })
    assert.equal((await call('voice')).body.drafts[0].text, 'Corrigé.')
  })

  it('gives the page the microphone only for itself', async () => {
    const { running, root } = await board()
    mkdirSync(join(root, 'client'), { recursive: true })
    writeFileSync(join(root, 'client', 'index.html'), '<!doctype html>')
    const page = await fetch(running.url)
    assert.equal(page.headers.get('permissions-policy'), 'microphone=(self), camera=()')
  })

  it('tells the page to stop when the window closes to the tray', async () => {
    const { running } = await board()
    const events = await fetch(`${running.url}/api/events`)
    const reader = events.body!.getReader()
    running.stopListening()
    let seen = ''
    while (!seen.includes('voice-stop')) {
      const { value, done } = await reader.read()
      if (done) break
      seen += Buffer.from(value).toString('utf8')
    }
    assert.ok(seen.includes('voice-stop'))
    await reader.cancel()
  })
})
