import { createReadStream, existsSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { stat, readFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { extname, join, resolve, sep } from 'node:path'
import { type BoardOptions, openBoard, type RunningBoard } from '../board/board.ts'
import { HttpError, readJson, send } from '../lib/http.ts'
import { readPersonal } from '../board/personal-settings.ts'
import { isProvider } from '../../shared/ai-uses.ts'
import { AiPrograms } from '../ai/programs.ts'
import { REPOSITORY } from '../environment/config.ts'
import { Github } from '../github/client.ts'
import { createEnvironment, GithubLoginFlow, install, listEnvironments, openEnvironment, owners, prerequisites, readRemembered, remember } from './setup.ts'

/**
 * The app's one server, on 127.0.0.1, for as long as the app runs. Before an environment is open it
 * answers the setup screens: programs, GitHub login, choosing or creating an environment. Once one is
 * open, it hands every other request to that environment's board (app.ts). Only one is open at a time.
 */

/**
 * The interface loads nothing from elsewhere, so an image or a frame written in a message can't send
 * anything out, and no other site can frame the board to click on it.
 */
const INTERFACE_POLICY =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self'; connect-src 'self'; frame-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'"

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.png': 'image/png',
}

/**
 * Listens on the first free port from this one: another app may hold it. A failed attempt must not leave
 * its `listening` handler behind, or the next attempt would report the wrong port. Port 0 asks the system
 * for any free port, and the one it gave is returned.
 */
export function listenFrom(server: Server, port: number): Promise<number> {
  return new Promise((done, fail) => {
    const onError = (error: NodeJS.ErrnoException) => {
      server.off('listening', onListening)
      if (error.code === 'EADDRINUSE' && port < 4800) listenFrom(server, port + 1).then(done, fail)
      else fail(error)
    }
    const onListening = () => {
      server.off('error', onError)
      const address = server.address()
      done(address && typeof address === 'object' ? address.port : port)
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(port, '127.0.0.1')
  })
}

/**
 * The server, its checks and its static files: only pages of this very address may talk to it, since it
 * holds a person's agent and GitHub login. `api` answers what is under /api/.
 */
/** What a page may reach without the token: a stream, a picture in a message, a page in a frame, the agents' bridge. */
const WITHOUT_TOKEN = /^\/api\/(events$|tools\/|doc\/page$|threads\/[^/]+\/attachments\/)/

export function appServer(client: string, port: () => number, api: (req: IncomingMessage, res: ServerResponse, url: URL, parts: string[]) => Promise<void>, token?: string): Server {
  async function serveStatic(res: ServerResponse, url: URL): Promise<void> {
    const wanted = resolve(client, `.${decodeURIComponent(url.pathname)}`)
    const inside = wanted === client || wanted.startsWith(client + sep)
    const isFile = inside && existsSync(wanted) && (await stat(wanted)).isFile()
    const file = isFile ? wanted : join(client, 'index.html')
    if (!existsSync(file)) {
      res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' })
      res.end("L'interface n'est pas construite : lancez npm start.")
      return
    }
    const page = file.endsWith('index.html')
    res.writeHead(200, {
      'content-type': TYPES[extname(file)] ?? 'application/octet-stream',
      'content-security-policy': INTERFACE_POLICY,
      // Only the board's own page: an attached file or a report never gets to ask for a microphone.
      'permissions-policy': 'microphone=(self), camera=()',
      'x-content-type-options': 'nosniff',
      // The page is read anew each time, so a new version shows at once; its hashed files never change.
      'cache-control': page ? 'no-cache' : 'public, max-age=31536000, immutable',
    })
    if (page && token) {
      // The page gets the token of this process: every call it makes carries it, and nothing else on the computer has it.
      const html = (await readFile(file, 'utf8')).replace('</head>', `<meta name="board-token" content="${token}"></head>`)
      res.end(html)
      return
    }
    createReadStream(file).on('error', () => res.destroy()).pipe(res)
  }

  return createServer(async (req, res) => {
    const host = req.headers.host ?? ''
    const own = [`127.0.0.1:${port()}`, `localhost:${port()}`]
    const origin = req.headers.origin
    const mutating = req.method !== 'GET' && req.method !== 'HEAD'
    const originOk = !origin || own.some((address) => origin === `http://${address}`)
    // An image or a script on another site sends no origin, and could spend this person's GitHub quota by asking for items.
    const site = req.headers['sec-fetch-site']
    const siteOk = !site || site === 'same-origin' || site === 'none'
    const path = (req.url ?? '/').split('?')[0]
    const marked = req.headers['x-board']
    // With a token, every call to the API carries it, except what a page can only reach by address. Without one (tests), the mark alone.
    const tokenOk = token ? !path.startsWith('/api/') || WITHOUT_TOKEN.test(path) || marked === token : !mutating || marked === '1'
    if (!own.includes(host) || !originOk || !siteOk || !tokenOk) {
      res.writeHead(403)
      res.end()
      return
    }
    try {
      const url = new URL(req.url ?? '/', `http://${host}`)
      if (!url.pathname.startsWith('/api/')) return await serveStatic(res, url)
      await api(req, res, url, url.pathname.split('/').filter(Boolean).slice(1).map(decodeURIComponent))
    } catch (error) {
      if (res.headersSent) {
        res.end()
        return
      }
      send(res, error instanceof HttpError ? error.status : 500, { error: (error as Error).message })
    }
  })
}

export interface HostOptions {
  /** Where this computer keeps the app's data: environments, settings, and what it remembers. */
  home: string
  client: string
  port?: number
  version?: string
  /** What the board needs from the window, for every environment. */
  board?: Omit<BoardOptions, 'root' | 'repo' | 'github' | 'settingsFile' | 'client' | 'version' | 'url' | 'home' | 'personHome'>
  /** The window opens what GitHub's login needs in the person's browser. */
  openExternal?: (url: string) => void
  /** Opens another window of the app, on an environment or on the choice of one. */
  newWindow?: (repo: string | null) => void
  /** The environment this window was asked to open, instead of the last one remembered. */
  environment?: string | null
  /** An environment opened or closed: the window follows its theme and language. */
  onBoard?: (board: RunningBoard | null) => void
  github?: Github
  /** Opens the last environment at start. Off in tests. */
  reopen?: boolean
  /** Replaced in tests: the person's home, where `~` and each program's usual folder are. */
  personHome?: string
}

export interface Host {
  url: string
  github: Github
  board: () => RunningBoard | null
  open: (repo: string) => Promise<RunningBoard>
  close: () => Promise<void>
  stop: () => Promise<void>
}

export async function startHost(options: HostOptions): Promise<Host> {
  const { client, home } = options
  const github = options.github ?? new Github()
  const settingsFile = join(home, 'settings.json')
  const rememberedFile = join(home, 'environments.json')
  const loginFlow = new GithubLoginFlow()
  // Before anything runs a program, setup screens included: every run uses the program and the folders the member chose.
  const programs = new AiPrograms({ boardHome: home, ai: { claude: options.board?.claude, codex: options.board?.codex }, home: options.personHome })
  await programs.load()
  let board: RunningBoard | null = null
  let opening: { repo: string; promise: Promise<RunningBoard> } | null = null
  let lastError: string | null = null
  let installing: string | null = null
  /** What the setup screens show is asked every two seconds: the programs' answers are kept a little while. */
  let needs: { at: number; value: ReturnType<typeof prerequisites> } | null = null
  const checkNeeds = (fresh = false) => {
    if (fresh || !needs || Date.now() - needs.at > 15_000) needs = { at: Date.now(), value: prerequisites() }
    return needs.value
  }
  let port = 0

  const url = () => `http://127.0.0.1:${port}`

  async function open(repo: string): Promise<RunningBoard> {
    if (!REPOSITORY.test(repo)) throw new HttpError(400, 'Un environnement se note propriétaire/nom.')
    if (board && board.repo.toLowerCase() === repo.toLowerCase()) return board
    if (opening) {
      if (opening.repo.toLowerCase() === repo.toLowerCase()) return opening.promise
      throw new HttpError(409, `${opening.repo} est en cours d’ouverture : attendez qu’il soit ouvert.`)
    }
    const promise = (async () => {
      await close()
      lastError = null
      try {
        const root = await openEnvironment(home, repo)
        const opened = await openBoard({ ...options.board, root, repo, github, settingsFile, client, version: options.version, url, home, programs })
        // Closed while it opened: what the person asked last wins.
        if (cancelled) {
          await opened.stop()
          throw new HttpError(409, 'L’ouverture a été annulée.')
        }
        board = opened
        await remember(rememberedFile, repo)
        options.onBoard?.(opened)
        return opened
      } catch (error) {
        lastError = (error as Error).message
        throw error
      } finally {
        opening = null
      }
    })()
    opening = { repo, promise }
    return promise
  }

  let cancelled = false
  async function close(): Promise<void> {
    // An opening under way is stopped when it ends, rather than left to finish after this.
    if (opening) {
      cancelled = true
      await opening.promise.catch(() => undefined)
      cancelled = false
    }
    const running = board
    board = null
    if (running) {
      options.onBoard?.(null)
      await running.stop()
    }
  }

  async function setupRoute(req: IncomingMessage, res: ServerResponse, parts: string[], method: string): Promise<void> {
    if (method === 'GET' && parts.length === 1) {
      const [found, remembered, personal] = await Promise.all([checkNeeds(), readRemembered(rememberedFile), readPersonal(settingsFile, () => programs.catalogue())])
      return send(res, 200, {
        ...found,
        update: options.board?.updates?.available() ?? null,
        login: { code: loginFlow.code, url: loginFlow.url, running: loginFlow.running, error: loginFlow.error },
        installing,
        environment: { current: board?.repo ?? null, opening: opening?.repo ?? null, error: lastError, recent: remembered.recent },
        version: options.version ?? null,
        language: personal.language,
        theme: personal.theme,
        themeColours: personal.themeColours,
      })
    }
    if (method !== 'POST' && !(method === 'GET' && parts[1] === 'environments')) throw new HttpError(404, 'Introuvable.')
    if (parts[1] === 'github' && (parts[2] === 'login' || parts[2] === 'refresh')) {
      // Another account may come back: the board open is the old one's, so it closes, and the new login opens it again.
      const started = await loginFlow.start(parts[2], () => {
        github.forget()
        needs = null
        void close()
      })
      if (started.url) options.openExternal?.(started.url)
      if (!started.code) throw new HttpError(502, loginFlow.error ?? 'GitHub n’a pas donné de code de connexion.')
      return send(res, 200, started)
    }
    if (parts[1] === 'update' && options.board?.updates) {
      await options.board.updates.install()
      return send(res, 200, { installing: true })
    }
    if (parts[1] === 'github' && parts[2] === 'cancel') {
      loginFlow.cancel()
      return send(res, 200, {})
    }
    if (parts[1] === 'install') {
      const tool = String((await readJson(req, 1000)).tool ?? '')
      if (installing) throw new HttpError(409, 'Une installation est déjà en cours.')
      installing = tool
      try {
        await install(tool)
      } catch (error) {
        throw new HttpError(502, (error as Error).message)
      } finally {
        installing = null
        needs = null
      }
      return send(res, 200, { installed: true })
    }
    if (parts[1] === 'ai' && parts[2] === 'login') {
      const input = await readJson(req, 1000)
      const provider = isProvider(input.provider) ? input.provider : programs.provider
      if (input.choose) await programs.choose(provider)
      await programs.login(provider)
      return send(res, 200, { started: true })
    }
    if (parts[1] === 'environments' && !parts[2]) {
      try {
        const [found, places] = await Promise.all([listEnvironments(github), owners(github)])
        return send(res, 200, { environments: found, owners: places })
      } catch (error) {
        throw new HttpError(502, `GitHub n'a pas répondu : ${(error as Error).message}`)
      }
    }
    if (parts[1] === 'environments' && parts[2] === 'open') {
      const repo = String((await readJson(req, 1000)).repo ?? '').trim()
      try {
        await open(repo)
      } catch (error) {
        throw new HttpError(error instanceof HttpError ? error.status : 502, (error as Error).message)
      }
      return send(res, 200, { environment: repo })
    }
    if (parts[1] === 'environments' && parts[2] === 'create') {
      const input = await readJson(req, 1000)
      const owner = String(input.owner ?? '')
      const places = await owners(github)
      const place = places.find((candidate) => candidate.login.toLowerCase() === owner.toLowerCase())
      if (!place) throw new HttpError(400, 'Choisissez votre compte ou une de vos organisations.')
      const timezone = typeof input.timezone === 'string' ? input.timezone : 'UTC'
      let created: { repo: string; protected: boolean }
      try {
        created = await createEnvironment(github, home, { owner: place.login, name: String(input.name ?? '').trim(), organization: place.organization, timezone })
      } catch (error) {
        throw new HttpError(502, `GitHub a refusé : ${(error as Error).message}`)
      }
      await open(created.repo)
      return send(res, 200, { environment: created.repo, protected: created.protected })
    }
    if (parts[1] === 'environments' && parts[2] === 'close') {
      await close()
      await remember(rememberedFile, null)
      return send(res, 200, {})
    }
    if (parts[1] === 'environments' && parts[2] === 'window') {
      if (!options.newWindow) throw new HttpError(404, 'Une seule fenêtre ici : ouvrez l’app installée pour en avoir plusieurs.')
      const repo = String((await readJson(req, 1000)).repo ?? '').trim()
      if (repo && !REPOSITORY.test(repo)) throw new HttpError(400, 'Un environnement se note propriétaire/nom.')
      options.newWindow(repo || null)
      return send(res, 200, {})
    }
    throw new HttpError(404, 'Introuvable.')
  }

  const server = appServer(client, () => port, async (req, res, url, parts) => {
    if (parts[0] === 'setup') return setupRoute(req, res, parts, req.method ?? 'GET')
    // An open environment answers these itself, with the member's choices of model: before one, the programs alone.
    if (parts[0] === 'ai' && !board) return programs.route(req, res, parts, req.method ?? 'GET')
    if (!board) throw new HttpError(409, 'Aucun environnement n’est ouvert.')
    await board.handle(req, res, url)
  }, randomBytes(24).toString('hex'))

  port = await listenFrom(server, options.port ?? 4780)

  if (options.reopen !== false) {
    // The environment asked for, or the last one, opens by itself when it can: otherwise the setup screens say why.
    void readRemembered(rememberedFile).then(async (remembered) => {
      const wanted = options.environment ?? remembered.current
      if (!wanted) return
      const needs = await prerequisites()
      if (!needs.git.installed || !needs.gh.installed || !needs.github.loggedIn) return
      await open(wanted).catch(() => undefined)
    })
  }

  return {
    url: url(),
    github,
    board: () => board,
    open,
    close,
    stop: async () => {
      loginFlow.cancel()
      await close()
      await new Promise<void>((done) => server.close(() => done()))
    },
  }
}
