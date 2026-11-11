import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { createReadStream, createWriteStream, existsSync } from 'node:fs'
import { copyFile, mkdir, readdir, readFile, rename, rm, stat, statfs } from 'node:fs/promises'
import { createServer } from 'node:net'
import { availableParallelism, homedir, setPriority } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { ReadableStream as WebStream } from 'node:stream/web'
import { writeWhole } from '../ai/translate.ts'

/**
 * A person's own voice, transcribed on their own computer, and read by them before anyone else sees it.
 *
 * The engine is whisper.cpp behind its local server, on the choices made by speak (MIT, Rodolphe
 * Barbanneau), rewritten here. Audio stays in memory: this process hands it to the local server over
 * the loopback, and neither writes it down. What is on disk is only the text, under `.cache/voice`,
 * which is never committed and which agents can't read, until the person publishes it.
 *
 * The engine is a program downloaded from someone else's releases: each file is pinned here by
 * size and SHA-256, and nothing unchecked is ever started.
 */

export const WHISPER_TAG = 'b5454'
const RELEASE = `https://github.com/ggml-org/whisper.cpp/releases/download/${WHISPER_TAG}`
const HUGGING_FACE = 'https://huggingface.co'

export type EngineVariant = 'cuda12' | 'cuda11' | 'cpu'
export interface Pinned {
  file: string
  url: string
  size: number
  sha256: string
}
export interface Catalog {
  engines: Record<EngineVariant, Pinned & { label: string }>
  models: (Pinned & { id: string; label: string; note: string })[]
  vad: Pinned
}

const whisperModel = (file: string) => `${HUGGING_FACE}/ggerganov/whisper.cpp/resolve/main/${file}`

export const CATALOG: Catalog = {
  engines: {
    cuda12: {
      label: 'Carte NVIDIA (CUDA 12)',
      file: 'whisper-bin-win-cuda-12.4.0-x64.zip',
      url: `${RELEASE}/whisper-bin-win-cuda-12.4.0-x64.zip`,
      size: 684_913_404,
      sha256: 'afef0b881c500958921c3f5523b50e59ee2ec9b6f5cbd25b324c51ed308a957a',
    },
    cuda11: {
      label: 'Carte NVIDIA, pilote ancien (CUDA 11.8)',
      file: 'whisper-bin-win-cuda-11.8.0-x64.zip',
      url: `${RELEASE}/whisper-bin-win-cuda-11.8.0-x64.zip`,
      size: 284_761_231,
      sha256: 'e81c86c542be6e3d7b7245392d4e1c52ab6e5c61dbe38721754bc0ab59d4d027',
    },
    cpu: {
      label: 'Processeur',
      file: 'whisper-blas-bin-x64.zip',
      url: `${RELEASE}/whisper-blas-bin-x64.zip`,
      size: 21_715_607,
      sha256: 'b1158bd10edf92c9799149a6fc5d3e58da3f495241d6fb3423088130e88ffbf3',
    },
  },
  models: [
    {
      id: 'large-v3-turbo-q8',
      label: 'Whisper large-v3-turbo · Q8',
      note: 'Le plus juste : rapide avec une carte graphique.',
      file: 'ggml-large-v3-turbo-q8_0.bin',
      url: whisperModel('ggml-large-v3-turbo-q8_0.bin'),
      size: 874_188_075,
      sha256: '317eb69c11673c9de1e1f0d459b253999804ec71ac4c23c17ecf5fbe24e259a1',
    },
    {
      id: 'large-v3-turbo-q5',
      label: 'Whisper large-v3-turbo · Q5',
      note: 'Plus léger, à peine moins juste.',
      file: 'ggml-large-v3-turbo-q5_0.bin',
      url: whisperModel('ggml-large-v3-turbo-q5_0.bin'),
      size: 574_041_195,
      sha256: '394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2',
    },
    {
      id: 'medium-q5',
      label: 'Whisper medium · Q5',
      note: 'Pour un ordinateur sans carte graphique.',
      file: 'ggml-medium-q5_0.bin',
      url: whisperModel('ggml-medium-q5_0.bin'),
      size: 539_212_467,
      sha256: '19fea4b380c3a618ec4723c3eef2eb785ffba0d0538cf43f8f235e7b3b34220f',
    },
  ],
  vad: {
    file: 'ggml-silero-v5.1.2.bin',
    url: `${HUGGING_FACE}/ggml-org/silero-v5.1.2/resolve/main/ggml-silero-v5.1.2.bin`,
    size: 885_098,
    sha256: '29940d98d42b91fbd05ce489f3ecf7c72f0a42f027e4875919a28fb4c04ea2cf',
  },
}

const SERVER_FILE = 'whisper-server.exe'
/** Windows' antivirus holds a new program for a moment after it appears. */
const RENAME_TRIES = 7
const RENAME_WAIT_MS = 500
/** An engine takes more room unpacked than as an archive. */
const UNPACKED_FACTOR = 2.5
const READY_MARK = '.complete'
const SERVER_START_MS = 180_000
const TRANSCRIBE_TIMEOUT_MS = 180_000
/** The model leaves memory and the graphics card this long after its last words. */
const UNLOAD_AFTER_MS = 5 * 60_000
const DISK_MARGIN = 1.1
const SAMPLE_RATE = 16_000

/** What whisper writes for what isn't speech, always a whole line in brackets, so a spoken "silence" stays. And what it invents on silence, from the films it learnt on. */
const NOT_SPEECH = /^[[(*♪][^\])*♪]*[\])*♪]\.?$/
const INVENTED =
  /^\s*(sous-titr(es|age).*(amara|communauté|société radio|st'? ?\d+).*|merci d['’]avoir regardé( cette vidéo)?\s*[.!]*|thanks? (you )?for watching\s*[.!]*|please subscribe( to (the|my|our) channel)?\s*[.!]*|abonnez-vous( à (la|ma|notre) chaîne)?\s*[.!]*)\s*$/i

/** Null when there is nothing a person said. */
export function cleanSegment(text: string): string | null {
  const line = text.replace(/\s+/g, ' ').trim()
  if (!line || NOT_SPEECH.test(line) || INVENTED.test(line) || /^[\s.,…!?♪*-]+$/.test(line)) return null
  return line
}

/** Samples as the server wants them, in memory: signed 16-bit, 16 kHz, mono. */
export function wavOf(pcm: Buffer): Buffer {
  const head = Buffer.alloc(44)
  head.write('RIFF', 0, 'ascii')
  head.writeUInt32LE(36 + pcm.length, 4)
  head.write('WAVEfmt ', 8, 'ascii')
  head.writeUInt32LE(16, 16)
  head.writeUInt16LE(1, 20)
  head.writeUInt16LE(1, 22)
  head.writeUInt32LE(SAMPLE_RATE, 24)
  head.writeUInt32LE(SAMPLE_RATE * 2, 28)
  head.writeUInt16LE(2, 32)
  head.writeUInt16LE(16, 34)
  head.write('data', 36, 'ascii')
  head.writeUInt32LE(pcm.length, 40)
  return Buffer.concat([head, pcm])
}

export interface VoiceProgress {
  label: string
  received: number
  total: number
}

export interface VoiceStatus {
  supported: boolean
  gpu: string | null
  recommended: { engine: EngineVariant; model: string }
  engines: { id: EngineVariant; label: string; size: number; installed: boolean }[]
  models: { id: string; label: string; note: string; size: number; installed: boolean; inSpeak: boolean }[]
  /** Both an engine and a model are here. */
  ready: boolean
  chosen: { engine: EngineVariant | null; model: string | null }
  installing: VoiceProgress | null
  installError: string | null
  running: boolean
}

/** What the app needs. Replaced in tests: a real one downloads gigabytes and uses the graphics card. */
export interface VoiceApi {
  status: () => Promise<VoiceStatus>
  install: (choice: { engine: EngineVariant; model: string }) => Promise<void>
  cancelInstall: () => void
  remove: () => Promise<void>
  transcribe: (pcm: Buffer) => Promise<string>
  stop: () => Promise<void>
  /** For good: the app is quitting, and nothing may start the engine again. */
  close: () => Promise<void>
  /** Ends an engine that a crash of the app left behind, holding its memory. */
  clearLeftover: () => Promise<void>
}

const sha256Of = (path: string) =>
  new Promise<string>((done, fail) => {
    const hash = createHash('sha256')
    createReadStream(path)
      .on('data', (chunk) => hash.update(chunk))
      .on('error', fail)
      .on('end', () => done(hash.digest('hex')))
  })

const freePort = () =>
  new Promise<number>((done, fail) => {
    const server = createServer()
    server.once('error', fail)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number }
      server.close(() => done(port))
    })
  })

/** Windows' own `tar`, which reads zip and stays inside its target: the one Git puts on the path reads no zip. */
const windowsTar = () => join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe')

const askNvidia = () =>
  new Promise<string | null>((done) => {
    execFile('nvidia-smi', ['--query-gpu=name', '--format=csv,noheader'], { encoding: 'utf8', timeout: 5000, windowsHide: true }, (error, stdout) => {
      done(error ? null : stdout.trim().split('\n')[0]?.trim() || null)
    })
  })

export interface EngineOptions {
  /** `.cache/voice`. */
  dir: string
  catalog?: Catalog
  /** Where speak keeps the same models: a pinned file found there needs no download. */
  speakModels?: string
  gpu?: () => Promise<string | null>
  extract?: (archive: string, target: string, signal: AbortSignal) => Promise<void>
  supported?: boolean
  /** The program a process runs, if it exists. */
  programOf?: (pid: number) => Promise<string | null>
  kill?: (pid: number) => void
}

export const programOf = (pid: number) =>
  new Promise<string | null>((done) => {
    execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command', `(Get-Process -Id ${pid} -ErrorAction SilentlyContinue).Path`], { encoding: 'utf8', timeout: 15_000, windowsHide: true }, (error, stdout) => {
      done(error ? null : stdout.trim() || null)
    })
  })

export class VoiceEngine implements VoiceApi {
  private readonly options: EngineOptions
  private readonly catalog: Catalog
  private readonly speakModels: string
  private abort: AbortController | null = null
  private progress: VoiceProgress | null = null
  private installError: string | null = null
  private gpuName: string | null | undefined
  private server: ChildProcess | null = null
  private port = 0
  private starting: Promise<void> | null = null
  private idle: NodeJS.Timeout | null = null
  private closed = false
  /** Moves at each stop: an engine still starting from before it must not appear after it. */
  private generation = 0
  /**
   * The local server answers any page in a browser, with no login: only this address, which nothing
   * else knows, lets one in. It also proves that what answers on the port is what this app started.
   */
  private readonly secretPath = `/${randomBytes(16).toString('hex')}`
  /** One at a time: speech comes in order, and the server does one anyway. */
  private queue: Promise<unknown> = Promise.resolve()

  constructor(options: EngineOptions) {
    this.options = options
    this.catalog = options.catalog ?? CATALOG
    this.speakModels = options.speakModels ?? join(process.env.SPEAK_HOME ?? join(homedir(), '.speak'), 'models', 'whisper')
  }

  private get engineDir() {
    return join(this.options.dir, 'engine')
  }
  private get modelDir() {
    return join(this.options.dir, 'models')
  }
  private engineFolder = (id: EngineVariant) => join(this.engineDir, `${id}-${WHISPER_TAG}`)

  private async gpu() {
    if (this.gpuName === undefined) this.gpuName = await (this.options.gpu ?? askNvidia)()
    return this.gpuName
  }

  private engineInstalled(id: EngineVariant) {
    return existsSync(join(this.engineFolder(id), READY_MARK))
  }

  private async modelInstalled(model: Pinned) {
    return (await stat(join(this.modelDir, model.file)).catch(() => null))?.size === model.size
  }

  private get pidFile() {
    return join(this.options.dir, 'engine.pid')
  }

  /** Only a process running this app's own copy of the engine: a pid can go to anything, speak's engine included. */
  async clearLeftover(): Promise<void> {
    const text = await readFile(this.pidFile, 'utf8').catch(() => null)
    if (text === null) return
    const pid = Number(text)
    const program = Number.isInteger(pid) && pid > 0 ? await (this.options.programOf ?? programOf)(pid) : null
    if (program && resolve(program).toLowerCase().startsWith(resolve(this.engineDir).toLowerCase() + sep)) {
      try {
        ;(this.options.kill ?? ((target: number) => process.kill(target)))(pid)
      } catch {
        // Already gone.
      }
    }
    await rm(this.pidFile, { force: true })
  }

  private get choiceFile() {
    return join(this.options.dir, 'choice.json')
  }

  /** What the person last chose, if it is still here. Otherwise whatever is: one can always be used. */
  private async chosen(): Promise<{ engine: EngineVariant | null; model: Catalog['models'][number] | null }> {
    const saved = await readFile(this.choiceFile, 'utf8')
      .then((text) => JSON.parse(text) as { engine?: unknown; model?: unknown })
      .catch(() => null)
    const order: EngineVariant[] = (await this.gpu()) ? ['cuda12', 'cuda11', 'cpu'] : ['cpu', 'cuda12', 'cuda11']
    const engines = [...order.filter((id) => id === saved?.engine), ...order]
    const models = [...this.catalog.models.filter((candidate) => candidate.id === saved?.model), ...this.catalog.models]
    const engine = engines.find((id) => this.engineInstalled(id)) ?? null
    let model: Catalog['models'][number] | null = null
    for (const candidate of models) {
      if (await this.modelInstalled(candidate)) {
        model = candidate
        break
      }
    }
    return { engine, model }
  }

  async status(): Promise<VoiceStatus> {
    const gpu = await this.gpu()
    const supported = this.options.supported ?? (process.platform === 'win32' && process.arch === 'x64')
    const models = await Promise.all(
      this.catalog.models.map(async (model) => ({
        id: model.id,
        label: model.label,
        note: model.note,
        size: model.size,
        installed: await this.modelInstalled(model),
        inSpeak: (await stat(join(this.speakModels, model.file)).catch(() => null))?.size === model.size,
      })),
    )
    const chosen = await this.chosen()
    return {
      supported,
      gpu,
      recommended: { engine: gpu ? 'cuda12' : 'cpu', model: gpu ? 'large-v3-turbo-q8' : 'medium-q5' },
      engines: (Object.keys(this.catalog.engines) as EngineVariant[]).map((id) => ({ id, label: this.catalog.engines[id].label, size: this.catalog.engines[id].size, installed: this.engineInstalled(id) })),
      models,
      ready: Boolean(chosen.engine && chosen.model),
      chosen: { engine: chosen.engine, model: chosen.model?.id ?? null },
      installing: this.progress,
      installError: this.installError,
      running: Boolean(this.server),
    }
  }

  /** Runs by itself: the screen follows it through `status`. */
  async install(choice: { engine: EngineVariant; model: string }): Promise<void> {
    if (this.abort) throw new Error('Une installation est déjà en cours.')
    const engine = this.catalog.engines[choice.engine]
    const model = this.catalog.models.find((candidate) => candidate.id === choice.model)
    if (!engine || !model) throw new Error('Moteur ou modèle inconnu.')
    this.abort = new AbortController()
    this.installError = null
    // At once: the screen only follows an install it can see.
    this.progress = { label: 'Préparation', received: 0, total: 0 }
    const { signal } = this.abort
    void this.runInstall(choice.engine, engine, model, signal)
      .catch((error) => {
        this.installError = signal.aborted ? null : (error as Error).message
      })
      .finally(() => {
        this.abort = null
        this.progress = null
      })
  }

  private async runInstall(id: EngineVariant, engine: Pinned, model: Pinned & { label: string }, signal: AbortSignal): Promise<void> {
    await mkdir(this.modelDir, { recursive: true })
    await mkdir(this.engineDir, { recursive: true })
    const installEngine = !this.engineInstalled(id)
    // What a cancelled or killed install left: a name no other file has.
    for (const folder of [this.modelDir, this.engineDir]) {
      for (const name of await readdir(folder)) {
        if (name.endsWith('.part')) await rm(join(folder, name), { force: true })
      }
    }
    const needed = [installEngine ? engine.size * UNPACKED_FACTOR : 0, (await this.modelInstalled(model)) ? 0 : model.size, this.catalog.vad.size].reduce((sum, size) => sum + size, 0)
    const disk = await statfs(this.options.dir).catch(() => null)
    if (disk && disk.bavail * disk.bsize < needed * DISK_MARGIN) throw new Error('Pas assez de place sur le disque.')
    await this.fetchPinned(this.catalog.vad, join(this.modelDir, this.catalog.vad.file), 'Détection de la parole', signal)
    await this.fetchPinned(model, join(this.modelDir, model.file), model.label, signal)
    if (installEngine) {
      const archive = join(this.engineDir, `${id}.zip`)
      await rm(archive, { force: true })
      try {
        await this.fetchPinned(engine, archive, 'Moteur de transcription', signal)
        this.progress = { label: 'Décompression du moteur', received: 0, total: 0 }
        await this.unpack(id, archive, signal)
      } finally {
        await rm(archive, { force: true })
      }
    }
    signal.throwIfAborted()
    await writeWhole(this.choiceFile, JSON.stringify({ engine: id, model: (model as { id?: string }).id }))
    // The next words go to what was just chosen.
    await this.stop()
  }

  /** In a side folder until it is complete: an engine half unpacked never counts as installed. */
  private async unpack(id: EngineVariant, archive: string, signal: AbortSignal): Promise<void> {
    const target = this.engineFolder(id)
    const partial = `${target}.partial`
    await rm(partial, { recursive: true, force: true })
    await mkdir(partial, { recursive: true })
    const extract =
      this.options.extract ??
      ((zip: string, into: string, abort: AbortSignal) =>
        new Promise<void>((done, fail) =>
          execFile(windowsTar(), ['-xf', zip, '-C', into], { windowsHide: true, signal: abort }, (error) => {
            if (!error) done()
            else fail(abort.aborted ? error : new Error('La décompression du moteur a échoué : vérifiez la place sur le disque.'))
          }),
        ))
    try {
      await extract(archive, partial, signal)
      signal.throwIfAborted()
      // Some archives have a folder inside: the server's own folder is what counts.
      const found = await findServer(partial)
      if (!found) throw new Error('Le moteur téléchargé ne contient pas son serveur.')
      await writeWhole(join(partial, READY_MARK), WHISPER_TAG)
      await rm(target, { recursive: true, force: true })
      await renameSoon(partial, target)
    } catch (error) {
      await rm(partial, { recursive: true, force: true }).catch(() => undefined)
      throw error
    }
  }

  /** Here already, or in speak's folder if it is the same file, or downloaded. Whatever it is, its hash decides. */
  private async fetchPinned(pinned: Pinned, dest: string, label: string, signal: AbortSignal): Promise<void> {
    if ((await stat(dest).catch(() => null))?.size === pinned.size) return
    const partial = `${dest}.part`
    const inSpeak = join(this.speakModels, pinned.file)
    if ((await stat(inSpeak).catch(() => null))?.size === pinned.size) {
      this.progress = { label: `${label} : copie locale`, received: 0, total: 0 }
      // The copy is what gets checked: speak could be replacing its file meanwhile.
      try {
        await copyFile(inSpeak, partial)
        signal.throwIfAborted()
        if ((await sha256Of(partial)) === pinned.sha256) {
          await renameSoon(partial, dest)
          return
        }
      } finally {
        await rm(partial, { force: true })
      }
    }
    this.progress = { label, received: 0, total: pinned.size }
    try {
      const response = await fetch(pinned.url, { signal, redirect: 'follow' })
      if (!response.ok || !response.body) throw new Error(`Téléchargement refusé (${response.status}).`)
      const hash = createHash('sha256')
      let received = 0
      const body = Readable.fromWeb(response.body as WebStream<Uint8Array>)
      body.on('data', (chunk: Buffer) => {
        received += chunk.length
        // A server that sends more than it should doesn't get to fill the disk.
        if (received > pinned.size) body.destroy(new Error(`Fichier refusé, plus lourd qu'annoncé : ${label}.`))
        hash.update(chunk)
        this.progress = { label, received, total: pinned.size }
      })
      await pipeline(body, createWriteStream(partial), { signal })
      if (received !== pinned.size) throw new Error(`Téléchargement incomplet : ${label}.`)
      if (hash.digest('hex') !== pinned.sha256) throw new Error(`Fichier refusé, son empreinte n'est pas celle attendue : ${label}.`)
      await renameSoon(partial, dest)
    } catch (error) {
      await rm(partial, { force: true })
      throw error
    }
  }

  cancelInstall(): void {
    this.abort?.abort()
  }

  async remove(): Promise<void> {
    if (this.abort) throw new Error('Une installation est en cours : annulez-la d’abord.')
    await this.stop()
    await rm(this.engineDir, { recursive: true, force: true })
    await rm(this.modelDir, { recursive: true, force: true })
    await rm(this.choiceFile, { force: true })
  }

  transcribe(pcm: Buffer): Promise<string> {
    const work = this.queue.then(() => this.transcribeNow(pcm))
    this.queue = work.catch(() => undefined)
    return work
  }

  private async transcribeNow(pcm: Buffer): Promise<string> {
    // First: the timer of an engine that has crashed mustn't end the one starting now.
    this.keepLoaded(false)
    await this.ensureServer()
    const form = new FormData()
    form.append('file', new Blob([new Uint8Array(wavOf(pcm))], { type: 'audio/wav' }), 'audio.wav')
    form.append('response_format', 'json')
    form.append('temperature', '0.0')
    form.append('temperature_inc', '0.2')
    // French and English mix in the same sentence here.
    form.append('language', 'auto')
    try {
      const response = await fetch(`http://127.0.0.1:${this.port}${this.secretPath}/inference`, { method: 'POST', body: form, signal: AbortSignal.timeout(TRANSCRIBE_TIMEOUT_MS) })
      const answer = (await response.json()) as { text?: unknown; error?: unknown }
      if (!response.ok || typeof answer.text !== 'string') throw new Error('bad answer')
      return answer.text
    } catch {
      throw new Error('Le moteur n’a pas pu transcrire ce passage.')
    } finally {
      this.keepLoaded(true)
    }
  }

  private keepLoaded(counting: boolean): void {
    if (this.idle) clearTimeout(this.idle)
    this.idle = null
    if (counting) this.idle = setTimeout(() => void this.stop(), UNLOAD_AFTER_MS)
  }

  private async ensureServer(): Promise<void> {
    if (this.closed) throw new Error('Le moteur est arrêté.')
    if (this.server && !this.starting) return
    this.starting ??= this.startServer().finally(() => {
      this.starting = null
    })
    return this.starting
  }

  private async startServer(): Promise<void> {
    const generation = this.generation
    const { engine, model } = await this.chosen()
    if (!engine || !model) throw new Error('La transcription n’est pas installée : voyez Réglages.')
    const folder = await findServer(this.engineFolder(engine))
    if (!folder) throw new Error('Le moteur est incomplet : réinstallez-le dans Réglages.')
    const threads = String(Math.max(2, Math.min(8, availableParallelism() - 1)))
    const args = ['-m', join(this.modelDir, model.file), '--host', '127.0.0.1', '--port', '', '--request-path', this.secretPath, '-t', threads, '-nt', '-l', 'auto']
    const vad = join(this.modelDir, this.catalog.vad.file)
    if (existsSync(vad)) args.push('--vad', '-vm', vad)
    this.port = await freePort()
    args[args.indexOf('--port') + 1] = String(this.port)
    if (this.closed || generation !== this.generation) throw new Error('Le moteur est arrêté.')
    // What it prints holds what was said: kept in memory only long enough to explain a failure to start.
    const child = spawn(join(folder, SERVER_FILE), args, { cwd: folder, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    if (child.pid) {
      try {
        setPriority(child.pid, 10)
      } catch {
        // Only politeness towards a call in progress.
      }
    }
    this.server = child
    let exited = false
    let failure: Error | null = null
    let tail = ''
    const collect = (chunk: Buffer) => {
      tail = (tail + chunk.toString('utf8')).slice(-1000)
    }
    child.stdout?.on('data', collect)
    child.stderr?.on('data', collect)
    child.once('error', (error) => {
      failure = error
      exited = true
    })
    child.once('exit', () => {
      exited = true
      if (this.server === child) this.server = null
    })
    if (child.pid) await writeWhole(this.pidFile, String(child.pid)).catch(() => undefined)
    const deadline = Date.now() + SERVER_START_MS
    while (Date.now() < deadline) {
      if (exited) {
        this.server = null
        throw new Error(`Le moteur n’a pas démarré. ${failure ? (failure as Error).message : /cuda|cublas|dll/i.test(tail) ? 'Essayez le moteur pour processeur, ou mettez à jour le pilote de la carte.' : ''}`.trim())
      }
      const answer = await fetch(`http://127.0.0.1:${this.port}${this.secretPath}/health`, { signal: AbortSignal.timeout(2000) }).catch(() => null)
      if (answer?.ok) {
        tail = ''
        child.stdout?.removeListener('data', collect)
        child.stderr?.removeListener('data', collect)
        child.stdout?.resume()
        child.stderr?.resume()
        return
      }
      await new Promise((done) => setTimeout(done, 200))
    }
    await this.stop()
    throw new Error('Le moteur n’a pas démarré à temps.')
  }

  /** The memory and the graphics card go back. */
  async stop(): Promise<void> {
    this.generation += 1
    this.keepLoaded(false)
    const server = this.server
    this.server = null
    if (server && server.exitCode === null) {
      await new Promise<void>((done) => {
        const timer = setTimeout(done, 3000)
        server.once('exit', () => {
          clearTimeout(timer)
          done()
        })
        server.kill()
      })
    }
    await rm(this.pidFile, { force: true }).catch(() => undefined)
  }

  async close(): Promise<void> {
    this.closed = true
    await this.stop()
  }
}

async function renameSoon(from: string, to: string): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await rename(from, to)
      return
    } catch (error) {
      const busy = ['EPERM', 'EBUSY', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')
      if (!busy || attempt >= RENAME_TRIES) throw error
      await new Promise((done) => setTimeout(done, RENAME_WAIT_MS))
    }
  }
}

async function findServer(folder: string): Promise<string | null> {
  const names = await readdir(folder, { withFileTypes: true }).catch(() => [])
  if (names.some((entry) => entry.isFile() && entry.name === SERVER_FILE)) return folder
  for (const entry of names) {
    if (!entry.isDirectory()) continue
    const inside = await findServer(join(folder, entry.name))
    if (inside) return inside
  }
  return null
}

/** One listening: what it heard, until the person publishes or discards it. */
export interface VoiceSegment {
  seq: number
  /** Where it starts, in milliseconds from the start of the listening. */
  at: number
  text: string
  /** It couldn't be transcribed. Said, rather than leaving a hole nobody sees. */
  lost?: boolean
}

export interface VoiceDraft {
  id: string
  threadId: string
  startedAt: string
  stoppedAt: string | null
  segments: VoiceSegment[]
  /** What the person has edited. Until then, the text is the segments'. */
  text: string | null
}

const DRAFT_ID = /^[0-9a-f]{16}$/
const THREAD_ID_MAX = 200

const mark = (ms: number) => {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  return `[${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}]`
}

/**
 * What the segments read as, a line for each with its time, which is what later puts two people's words
 * back in order. A hole is said, so the person knows to fill it.
 */
export const draftText = (draft: VoiceDraft) =>
  draft.text ??
  [...draft.segments]
    .sort((a, b) => a.seq - b.seq)
    .map((segment) => `${mark(segment.at)} ${segment.lost ? '[passage non transcrit]' : segment.text}`)
    .join('\n')

function parseDraft(text: string): VoiceDraft | null {
  try {
    const raw = JSON.parse(text)
    if (!DRAFT_ID.test(raw?.id) || typeof raw.threadId !== 'string' || raw.threadId.length > THREAD_ID_MAX || !Array.isArray(raw.segments)) return null
    return {
      id: raw.id,
      threadId: raw.threadId,
      startedAt: String(raw.startedAt ?? ''),
      stoppedAt: typeof raw.stoppedAt === 'string' ? raw.stoppedAt : null,
      segments: raw.segments
        .filter((segment: any) => Number.isInteger(segment?.seq) && typeof segment?.text === 'string')
        .map((segment: any) => ({ seq: segment.seq, at: Number(segment.at) || 0, text: segment.text, ...(segment.lost === true ? { lost: true } : {}) })),
      text: typeof raw.text === 'string' ? raw.text : null,
    }
  } catch {
    return null
  }
}

/** What has been heard and not yet published: on this computer only, and gone once it is published or discarded. */
export class VoiceDrafts {
  private readonly dir: string
  listening: VoiceDraft | null = null
  /** One change at a time: a save that comes late can't bring back what was published or thrown away. */
  private changes: Promise<unknown> = Promise.resolve()

  constructor(voiceDir: string) {
    this.dir = join(voiceDir, 'transcripts')
  }

  private file = (id: string) => join(this.dir, `${id}.json`)

  private save = (draft: VoiceDraft) => writeWhole(this.file(draft.id), JSON.stringify(draft))

  private inTurn<T>(change: () => Promise<T>): Promise<T> {
    const turn = this.changes.then(change)
    this.changes = turn.catch(() => undefined)
    return turn
  }

  async list(): Promise<VoiceDraft[]> {
    await mkdir(this.dir, { recursive: true })
    const names = await readdir(this.dir)
    const found = await Promise.all(names.filter((name) => name.endsWith('.json')).map(async (name) => parseDraft(await readFile(join(this.dir, name), 'utf8').catch(() => ''))))
    return found.filter((draft): draft is VoiceDraft => draft !== null).sort((a, b) => a.startedAt.localeCompare(b.startedAt))
  }

  async get(id: string): Promise<VoiceDraft | null> {
    if (!DRAFT_ID.test(id)) return null
    return parseDraft(await readFile(this.file(id), 'utf8').catch(() => ''))
  }

  /** Nothing keeps listening across a restart: a listening still open was cut short, and is only read now. */
  async closeInterrupted(now = new Date()): Promise<void> {
    await mkdir(this.dir, { recursive: true })
    // A crash in the middle of a save leaves text under another name.
    for (const name of await readdir(this.dir)) {
      if (name.endsWith('.partial')) await rm(join(this.dir, name), { force: true })
    }
    for (const draft of await this.list()) {
      if (draft.stoppedAt) continue
      if (draft.segments.length || draft.text !== null) await this.save({ ...draft, stoppedAt: now.toISOString() })
      else await this.remove(draft.id)
    }
    this.listening = null
  }

  async start(threadId: string, now = new Date()): Promise<VoiceDraft> {
    const draft: VoiceDraft = { id: randomBytes(8).toString('hex'), threadId, startedAt: now.toISOString(), stoppedAt: null, segments: [], text: null }
    // Before anything is awaited: two starts at once can't both pass.
    this.listening = draft
    try {
      await mkdir(this.dir, { recursive: true })
      await this.inTurn(() => this.save(draft))
    } catch (error) {
      this.listening = null
      throw error
    }
    return draft
  }

  /** Words still being transcribed when a listening ends belong to it all the same. */
  addSegment(id: string, segment: VoiceSegment): Promise<void> {
    return this.inTurn(async () => {
      const draft = this.listening?.id === id ? this.listening : await this.get(id)
      if (!draft) return
      draft.segments.push(segment)
      await this.save(draft)
    })
  }

  stop(id: string, now = new Date()): Promise<VoiceDraft | null> {
    return this.inTurn(async () => {
      const draft = this.listening?.id === id ? this.listening : await this.get(id)
      if (this.listening?.id === id) this.listening = null
      if (!draft) return null
      if (!draft.stoppedAt) draft.stoppedAt = now.toISOString()
      // Nothing was said: there is nothing to read, or to throw away.
      if (!draft.segments.length && draft.text === null) {
        await rm(this.file(id), { force: true })
        return null
      }
      await this.save(draft)
      return draft
    })
  }

  setText(id: string, text: string): Promise<void> {
    return this.inTurn(async () => {
      const draft = await this.get(id)
      if (draft) await this.save({ ...draft, text })
    })
  }

  remove(id: string): Promise<void> {
    if (this.listening?.id === id) this.listening = null
    return this.inTurn(async () => {
      if (DRAFT_ID.test(id)) await rm(this.file(id), { force: true })
    })
  }
}
