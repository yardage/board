import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { mkdir, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, normalize, posix, resolve, win32 } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { EFFORTS, isProvider, MODELS, type Provider, PROVIDER_NAMES, PROVIDERS } from '../../shared/ai-uses.ts'
import { type AiStatus, aiStatus, codexCatalogue, DEFAULT_HOME, onRead, startLogin, useHome, usePath, useProvider } from './harness.ts'
import { HttpError, readJson, send } from '../lib/http.ts'
import { writeWhole } from './translate.ts'

/**
 * Which program answers for the member on this computer, and for each program the two things the member may set:
 * its account folder, which the program is given under the variable it names itself, and where the program is.
 * Both empty is the program as a terminal would run it. The board keeps them in `~/.board/settings.json`, for
 * every environment opened here, and nothing of them goes in an environment. It never looks for folders, never
 * reads what is in one, and the login stays in the folder.
 *
 * Each window of the app is its own process, with its own copy of these: a window writes only what it changed,
 * in the file as it is then, and takes what another wrote when the file has changed since it last read it.
 *
 * A program's state (installed, signed in) costs two runs of it: it is asked per program, kept a minute, and
 * never awaited by a screen that can do without it.
 */

const STATUS_KEPT_MS = 60_000
const PATH_MAX = 260
// Control characters, and the quote a Windows command line could split on.
const UNSAFE = /[\u0000-\u001f\u007f"]/
/** What the settings file said before: a list of accounts per program, and the one in use. */
const LEGACY = ['claudeAccounts', 'claudeAccount', 'codexAccounts', 'codexAccount']
const WINDOWS = process.platform === 'win32'
/** Two slashes first: on Windows, a network share (`\\server\share`, `\\localhost\C$`) or a device (`\\?\`, `\\.\`). */
const NOT_LOCAL = /^[\\/]{2}/
const NOT_PLAIN = 'Un chemin de cet ordinateur : ni partage réseau, ni chemin spécial.'
const DOTTED = 'Aucun nom de ce chemin ne peut finir par un point ou une espace.'
const UNFOLLOWED = 'Ce chemin passe par un lien ou un dossier qui ne s’ouvre pas.'

export interface ProgramSetup {
  /** Null for the program's usual folder: no variable is set, so it uses the one it would in a terminal. */
  home: string | null
  /** Null to find it in its usual places. */
  path: string | null
}

export interface AiProgramsState {
  provider: Provider
  programs: Record<Provider, ProgramSetup>
}

/** What `/api/ai` says of the programs: nothing in it runs one. */
export interface AiProgramsView {
  provider: Provider
  programs: Record<Provider, ProgramSetup & { models: string[]; efforts: string[] }>
}

const UNSET: ProgramSetup = { home: null, path: null }

/** `~/x` as the person writes it, and the same on every system. */
export function expandHome(path: string, home = homedir()): string {
  if (path === '~') return home
  if (path.startsWith('~/') || path.startsWith('~\\')) return join(home, path.slice(2))
  return path
}

const foldsCase = (system: NodeJS.Platform) => system === 'win32' || system === 'darwin'

/**
 * Whether `child` is `parent` or in it, as the system reads names: Windows and macOS take `.Board` for `.board`
 * on their usual disks, and `..x` is a name in `parent`, not a way out of it.
 */
export function within(child: string, parent: string, system: NodeJS.Platform = process.platform): boolean {
  const path = system === 'win32' ? win32 : posix
  const fold = (one: string) => (foldsCase(system) ? one.toLowerCase() : one)
  const between = path.relative(fold(parent), fold(child))
  return between === '' || (between !== '..' && !between.startsWith(`..${path.sep}`) && !path.isAbsolute(between))
}
const same = (a: string, b: string) => (foldsCase(process.platform) ? a.toLowerCase() === b.toLowerCase() : a === b)

const there = (path: string) => {
  try {
    lstatSync(path)
    return true
  } catch {
    return false
  }
}

/**
 * Where a path leads: its nearest part that exists, through links, junctions and short names, then the rest as
 * written. Null when a part is there but can't be followed, as a link to nowhere.
 */
function followed(path: string): string | null {
  const rest: string[] = []
  for (let current = path; ; ) {
    try {
      return join(realpathSync.native(current), ...rest)
    } catch (error) {
      if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '') || there(current)) return null
      const parent = dirname(current)
      if (parent === current) return path
      rest.unshift(basename(current))
      current = parent
    }
  }
}

/** The names a check must see of a path: as written, and where it leads. A string says why it can't be used. */
function namesOf(path: string): string[] | string {
  const real = followed(path)
  if (real === null) return UNFOLLOWED
  // A drive that is a network share.
  if (NOT_LOCAL.test(real)) return NOT_PLAIN
  return real === path ? [path] : [path, real]
}

/** Whether one of a path's names is in the board's folder, under any of its own, or, with `around`, holds it. */
function touchesBoard(names: string[], boardHome: string, around: boolean): boolean {
  const board = resolve(boardHome)
  const real = followed(board)
  const boards = real && real !== board ? [board, real] : [board]
  return names.some((name) => boards.some((folder) => within(name, folder) || (around && within(folder, name))))
}

/** What a field says, or why it can't be read. Null `value`: the field is empty, which means the program's own. */
export interface Field {
  value: string | null
  problem: string | null
}
const ok = (value: string | null): Field => ({ value, problem: null })
const bad = (problem: string): Field => ({ value: null, problem })

/**
 * A path as given, full: quotes around it, as a file manager copies one, are dropped. Only a plain path of this
 * computer: the other ways Windows has of naming a folder would pass any comparison with the board's.
 */
function fullPath(raw: unknown, home: string, what: string): Field {
  if (raw === null || raw === undefined) return ok(null)
  if (typeof raw !== 'string') return bad(what)
  const text = raw.trim().replace(/^(["'])(.*)\1$/, '$2').trim()
  if (!text) return ok(null)
  if (text.length > PATH_MAX || UNSAFE.test(text)) return bad(`Un chemin d’au plus ${PATH_MAX} caractères, sans guillemets.`)
  if (NOT_LOCAL.test(text)) return bad(NOT_PLAIN)
  const full = expandHome(text, home)
  if (!isAbsolute(full)) return bad('Le chemin doit être complet, ou commencer par ~.')
  const value = normalize(resolve(full))
  // A colon past the drive names a stream of a file or a folder, as `.board::$INDEX_ALLOCATION` is the folder.
  if (NOT_LOCAL.test(value) || (WINDOWS && (/[<>|?*]/.test(value) || value.indexOf(':', 2) !== -1))) return bad(NOT_PLAIN)
  // Windows drops a dot or a space at the end of a name: `.board.` is `.board`.
  if (value.split(WINDOWS ? /[\\/]/ : '/').some((name) => /[. ]$/.test(name))) return bad(DOTTED)
  return ok(value)
}

/**
 * The account folder a member gives a program. Its usual folder is stored as none: given under the variable even
 * as itself, Claude Code would look for its login elsewhere. The board's folder is refused, and anything in or
 * around it, under any name of either: a login there could end up in an environment's clone, which is pushed for
 * good. Where the path leads is always followed; `onDisk` also looks at what is there, when the member saves it.
 * A folder that doesn't exist yet is fine, and made then.
 */
export function readHome(provider: Provider, raw: unknown, boardHome: string, home = homedir(), onDisk = true): Field {
  const read = fullPath(raw, home, 'Indiquez un dossier, ou laissez vide.')
  if (read.problem || !read.value) return read
  const folder = read.value
  const usual = resolve(join(home, DEFAULT_HOME[provider]))
  if (same(folder, usual) || same(followed(folder) ?? folder, followed(usual) ?? usual)) return ok(null)
  const names = namesOf(folder)
  if (typeof names === 'string') return bad(names)
  if (touchesBoard(names, boardHome, true)) return bad('Ce dossier touche celui du board : une connexion y serait publiée avec lui.')
  if (onDisk && existsSync(folder) && !statSync(folder).isDirectory()) return bad('Ce chemin est un fichier, pas un dossier.')
  return ok(folder)
}

/**
 * Where a member says the program is. Never in the board's folder, under any of its names, where the files of
 * others arrive. On Windows, a `.cmd` can't start without a shell: the program itself is asked for. `onDisk`: it
 * must be there, as a file.
 */
export function readPath(provider: Provider, raw: unknown, boardHome: string, home = homedir(), onDisk = true): Field {
  const read = fullPath(raw, home, 'Indiquez un programme, ou laissez vide.')
  if (read.problem || !read.value) return read
  const file = read.value
  const names = namesOf(file)
  if (typeof names === 'string') return bad(names)
  if (touchesBoard(names, boardHome, false)) return bad('Ce programme est dans le dossier du board, où arrivent les fichiers des autres.')
  if (/\.(cmd|bat|ps1)$/i.test(file)) return bad('Indiquez le programme lui-même, pas le script qui le lance, ou laissez vide pour qu’il soit trouvé.')
  if (!onDisk) return ok(file)
  if (!existsSync(file)) return bad(`Introuvable : ${file}`)
  if (statSync(file).isDirectory()) return bad(`C’est un dossier : indiquez le programme ${PROVIDER_NAMES[provider]} lui-même. Pour un autre compte, changez plutôt le dossier du compte.`)
  return ok(file)
}

const record = (value: unknown): Record<string, unknown> => (value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {})

/** Before, a program had a list of accounts and one in use: the folder of the one in use becomes its account folder. */
function legacyHome(found: Record<string, unknown>, provider: Provider): unknown {
  const list = found[`${provider}Accounts`]
  const active = found[`${provider}Account`]
  if (!Array.isArray(list) || typeof active !== 'string') return null
  return record(list.find((one) => record(one).id === active)).home ?? null
}

/**
 * What the settings file says, checked: anyone could have edited it, and a damaged one is no reason not to start.
 * Where a path leads is followed, as when it was given; nothing else on disk is looked at: a program uninstalled
 * since says so in its state, and its field stays as written.
 */
export function parsePrograms(saved: unknown, boardHome: string, home = homedir()): AiProgramsState {
  const found = record(saved)
  const stored = record(found.aiPrograms)
  const programs = {} as Record<Provider, ProgramSetup>
  for (const provider of PROVIDERS) {
    const own = provider in stored ? record(stored[provider]) : { home: legacyHome(found, provider), path: null }
    programs[provider] = { home: readHome(provider, own.home, boardHome, home, false).value, path: readPath(provider, own.path, boardHome, home, false).value }
  }
  return { provider: isProvider(found.aiProvider) ? found.aiProvider : 'claude', programs }
}

/** One change at a time to each settings file in this process. */
const writing = new Map<string, Promise<void>>()

/**
 * Changes the member's settings file: it is read again, `change` says what to write from what it holds, and the
 * whole goes in one piece. Every writer of the file, the programs here and an environment's own settings, goes
 * through this and changes only its own keys: what another window or another part wrote since stays as it is.
 */
export function updateSettings(file: string, change: (found: Record<string, unknown>) => Record<string, unknown>): Promise<void> {
  const key = resolve(file)
  const run = (writing.get(key) ?? Promise.resolve()).then(async () => {
    const found = record(await readFile(file, 'utf8').then((raw) => JSON.parse(raw)).catch(() => ({})))
    await mkdir(dirname(file), { recursive: true })
    await writeWhole(file, JSON.stringify(change(found)))
  })
  const settled = run.then(
    () => undefined,
    () => undefined,
  )
  writing.set(key, settled)
  void settled.then(() => {
    if (writing.get(key) === settled) writing.delete(key)
  })
  return run
}

/** A status and a login for a program, replaced in tests: a real one reads the person's login, and a login would replace it. */
export interface AiStub {
  status: (home: string | null) => Promise<AiStatus>
  login: (home: string | null) => Promise<void>
}

export interface ProgramsOptions {
  /** `~/.board`: where no account folder and no program may be. */
  boardHome: string
  /** `settings.json` in `boardHome`, unless said otherwise. */
  settingsFile?: string
  /** Replaced in tests, by program. */
  ai?: Partial<Record<Provider, AiStub>>
  /** Replaced in tests: the person's home, where `~` and each program's usual folder are. */
  home?: string
}

interface Look {
  /** The folder and the program it was asked of: either changed, and it is asked again. */
  key: string
  at: number
  running: boolean
  value: Promise<AiStatus>
  /** The last answer for this key, kept while another look runs. */
  done: AiStatus | null
}

export class AiPrograms {
  private readonly file: string
  private readonly options: ProgramsOptions
  private state: AiProgramsState = { provider: 'claude', programs: { claude: UNSET, codex: UNSET } }
  private readonly looks = new Map<Provider, Look>()
  /** The models Codex's catalogue named when last read. */
  private known: string[] = []
  /** The settings file as this window last read or wrote it: which file, when, how long. Null: there was none. */
  private seen: string | null = null

  constructor(options: ProgramsOptions) {
    this.options = options
    this.file = options.settingsFile ?? join(options.boardHome, 'settings.json')
  }

  private get home() {
    return this.options.home ?? homedir()
  }

  private async readFile(): Promise<Record<string, unknown>> {
    return record(await readFile(this.file, 'utf8').then((raw) => JSON.parse(raw)).catch(() => ({})))
  }

  /** Writing the file replaces it, so a new one is another file to the system, even within the same instant. */
  private stamp(): string | null {
    try {
      const found = statSync(this.file, { bigint: true })
      return `${found.ino}:${found.mtimeNs}:${found.size}`
    } catch {
      return null
    }
  }

  /** Reads the file and starts every run on the program, the folder and the location it names. */
  async load(): Promise<AiProgramsState> {
    const stamp = this.stamp()
    this.adopt(parsePrograms(await this.readFile(), this.options.boardHome, this.home), stamp)
    // A run reads the program chosen first: what another window chose since is taken then.
    onRead(() => this.freshen())
    return this.state
  }

  private adopt(state: AiProgramsState, stamp: string | null) {
    this.state = state
    this.seen = stamp
    useProvider(state.provider)
    for (const provider of PROVIDERS) {
      useHome(provider, state.programs[provider].home)
      usePath(provider, state.programs[provider].path)
    }
  }

  /**
   * What another window chose since this one last read the file: taken when a page or a run reads the program.
   * Only the file's stamp is asked otherwise, which costs nothing; a file that can't be read changes nothing.
   */
  freshen(): void {
    const stamp = this.stamp()
    if (stamp === null || stamp === this.seen) return
    let saved: unknown
    try {
      saved = JSON.parse(readFileSync(this.file, 'utf8'))
    } catch {
      return
    }
    this.adopt(parsePrograms(saved, this.options.boardHome, this.home), stamp)
  }

  get provider(): Provider {
    return this.state.provider
  }

  setup(provider: Provider = this.state.provider): ProgramSetup {
    return this.state.programs[provider]
  }

  /**
   * Changes in the file only what `change` changes, from what the file holds now: another window may have changed
   * the rest since, and an environment's board writes its own settings in the same file. This window then has
   * what the file has.
   */
  private async save(change: (found: AiProgramsState) => AiProgramsState): Promise<AiProgramsState> {
    let next = this.state
    await updateSettings(this.file, (found) => {
      next = change(parsePrograms(found, this.options.boardHome, this.home))
      for (const key of LEGACY) delete found[key]
      return { ...found, aiProvider: next.provider, aiPrograms: next.programs }
    })
    this.adopt(next, this.stamp())
    return next
  }

  async choose(provider: unknown): Promise<Provider> {
    if (!isProvider(provider)) throw new HttpError(400, 'Programme inconnu.')
    await this.save((found) => ({ ...found, provider }))
    return provider
  }

  /** Changes what is given, `home`, `path` or both: an empty one goes back to the program's own. */
  async set(provider: Provider, input: { home?: unknown; path?: unknown }): Promise<ProgramSetup> {
    const change: Partial<ProgramSetup> = {}
    if ('home' in input) {
      const read = readHome(provider, input.home, this.options.boardHome, this.home)
      if (read.problem) throw new HttpError(400, read.problem)
      change.home = read.value
    }
    if ('path' in input) {
      const read = readPath(provider, input.path, this.options.boardHome, this.home)
      if (read.problem) throw new HttpError(400, read.problem)
      change.path = read.value
    }
    // Codex refuses a folder that isn't there; the program's login writes in it.
    if (change.home) await mkdir(change.home, { recursive: true })
    const next = await this.save((found) => ({ ...found, programs: { ...found.programs, [provider]: { ...found.programs[provider], ...change } } }))
    return next.programs[provider]
  }

  private keyOf(provider: Provider) {
    const { home, path } = this.state.programs[provider]
    return `${home ?? ''}\n${path ?? ''}`
  }

  /** The program's state, kept a minute. `fresh` asks again, unless a look is already under way: it answers both. */
  status(provider: Provider = this.state.provider, fresh = false): Promise<AiStatus> {
    const key = this.keyOf(provider)
    const found = this.looks.get(provider)
    if (found && found.key === key && (found.running || (!fresh && Date.now() - found.at < STATUS_KEPT_MS))) return found.value
    const ask = this.options.ai?.[provider]?.status ?? ((folder: string | null) => aiStatus(provider, folder))
    const home = this.state.programs[provider].home
    const look: Look = { key, at: Date.now(), running: true, value: Promise.resolve(null as never), done: found?.key === key ? found.done : null }
    let asked: Promise<AiStatus>
    try {
      asked = ask(home)
    } catch (error) {
      asked = Promise.reject(error)
    }
    look.value = asked.then(
      (status) => {
        Object.assign(look, { at: Date.now(), running: false, done: status })
        return status
      },
      (error) => {
        if (this.looks.get(provider) === look) this.looks.delete(provider)
        throw error
      },
    )
    this.looks.set(provider, look)
    return look.value
  }

  /** What is known of a program's state now, never waiting: null until a first look ends. A look due is started. */
  lastStatus(provider?: Provider): AiStatus | null {
    this.freshen()
    const which = provider ?? this.state.provider
    const found = this.looks.get(which)
    const known = found && found.key === this.keyOf(which) ? found : null
    if (!known || (!known.running && Date.now() - known.at >= STATUS_KEPT_MS)) void this.status(which).catch(() => undefined)
    return known?.done ?? null
  }

  /** Something changed outside, an install or a login: the next look at the program asks it again. */
  forget(provider?: Provider): void {
    for (const one of provider ? [provider] : PROVIDERS) {
      const found = this.looks.get(one)
      if (found) found.at = 0
    }
  }

  /** The program's own login, in its own window or browser, on the folder given: the next look asks again. */
  async login(provider: Provider = this.state.provider): Promise<void> {
    this.forget(provider)
    const start = this.options.ai?.[provider]?.login ?? ((folder: string | null) => startLogin(provider, folder))
    try {
      await start(this.state.programs[provider].home)
    } catch (error) {
      throw new HttpError(500, `${PROVIDER_NAMES[provider]} n'a pas pu démarrer : ${(error as Error).message}`)
    }
  }

  /** The models Codex's own catalogue names, in the folder it is given here. Reading it runs nothing. */
  async catalogue(): Promise<string[]> {
    this.known = await codexCatalogue(this.state.programs.codex.home, this.options.home)
    return [...this.known]
  }

  /** The models a program offers, Codex's from its own catalogue when it has one. */
  async models(provider: Provider): Promise<string[]> {
    if (provider === 'claude') return [...MODELS.claude]
    const found = await this.catalogue()
    return found.length ? found : [...MODELS.codex]
  }

  /** The models a program's catalogue named when last read, which a choice may then name. */
  knownModels(provider: Provider): string[] {
    return provider === 'codex' ? this.known : []
  }

  async view(): Promise<AiProgramsView> {
    this.freshen()
    const programs = {} as AiProgramsView['programs']
    for (const provider of PROVIDERS) programs[provider] = { ...this.state.programs[provider], models: await this.models(provider), efforts: [...EFFORTS[provider]] }
    return { provider: this.state.provider, programs }
  }

  /**
   * Answers `/api/ai…`, whether an environment is open or not: `GET /api/ai`, `GET /api/ai/status?provider=…`
   * (`fresh=1` to ask again), and `POST /api/ai/provider`, `/api/ai/program` and `/api/ai/login`. A page names
   * the folder and location it shows in its question (`home`, `path`), only so that two questions of different
   * ones are never taken for one; the answer says which it is of, which a page that shows others leaves.
   */
  async route(req: IncomingMessage, res: ServerResponse, parts: string[], method: string): Promise<void> {
    this.freshen()
    if (method === 'GET' && parts.length === 1) return send(res, 200, await this.view())
    if (method === 'GET' && parts.length === 2 && parts[1] === 'status') {
      const query = new URL(req.url ?? '/', 'http://board').searchParams
      const provider = query.get('provider') ?? this.state.provider
      if (!isProvider(provider)) throw new HttpError(400, 'Programme inconnu.')
      // Taken as the look starts: it is the folder and location it asks.
      const { home, path } = this.setup(provider)
      return send(res, 200, { ...(await this.status(provider, query.get('fresh') === '1')), home, path })
    }
    if (method !== 'POST' || parts.length !== 2) throw new HttpError(404, 'Introuvable.')
    const input = record(await readJson(req, 4000))
    if (parts[1] === 'provider') {
      await this.choose(input.provider)
      return send(res, 200, await this.view())
    }
    const provider: unknown = input.provider ?? this.state.provider
    if (!isProvider(provider)) throw new HttpError(400, 'Programme inconnu.')
    if (parts[1] === 'program') {
      await this.set(provider, input)
      return send(res, 200, await this.view())
    }
    if (parts[1] === 'login') {
      await this.login(provider)
      return send(res, 200, { started: true })
    }
    throw new HttpError(404, 'Introuvable.')
  }
}
