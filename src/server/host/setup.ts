import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { delimiter, join } from 'node:path'
import { PROVIDERS, type Provider } from '../../shared/ai-uses.ts'
import { type AiStatus, aiStatus, currentProvider } from '../ai/harness.ts'
import { CONFIG_FILE, defaultConfig, ENVIRONMENT_TOPIC, formatConfig, LOGIN, MARK_FILE, protectConfig, REPOSITORY } from '../environment/config.ts'
import type { Github } from '../github/client.ts'
import { NO_LINKS, WITH_GH_LOGIN } from '../environment/git.ts'

/**
 * What the app needs before an environment can open, and the screens' way through it, so that nobody
 * needs a terminal: the programs it relies on, the person's GitHub login with the scopes the board uses,
 * and the environment itself, found, created or opened. The board stores no credential: `gh` keeps the
 * GitHub login and Claude Code its own.
 */

/** Read and write repositories, read the organisations, and change projects' fields. */
export const SCOPES = ['repo', 'read:org', 'project']

/** Where Windows installs put these programs: a process started before the install doesn't have them on its PATH. */
const KNOWN_DIRS =
  process.platform === 'win32'
    ? [
        join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Git', 'cmd'),
        join(process.env.ProgramFiles ?? 'C:\\Program Files', 'GitHub CLI'),
        join(process.env.LOCALAPPDATA ?? '', 'Microsoft', 'WinGet', 'Links'),
      ]
    : ['/opt/homebrew/bin', '/usr/local/bin']

export function widenPath(): void {
  const parts = (process.env.PATH ?? '').split(delimiter)
  for (const dir of KNOWN_DIRS) if (dir && existsSync(dir) && !parts.includes(dir)) parts.push(dir)
  process.env.PATH = parts.join(delimiter)
}

const run = (command: string, args: string[], options: { cwd?: string; timeout?: number } = {}) =>
  new Promise<{ ok: boolean; out: string }>((done) => {
    try {
      execFile(command, args, { cwd: options.cwd, encoding: 'utf8', windowsHide: true, timeout: options.timeout ?? 20_000, maxBuffer: 1 << 26 }, (error, stdout, stderr) =>
        done({ ok: !error, out: `${stdout ?? ''}${stderr ?? ''}`.trim() }),
      )
    } catch {
      done({ ok: false, out: '' })
    }
  })

const git = async (args: string[], cwd?: string) => {
  const found = await run('git', [...WITH_GH_LOGIN, ...NO_LINKS, ...args], { cwd, timeout: 600_000 })
  if (!found.ok) throw new Error(found.out || `git ${args[0]} a échoué.`)
  return found.out
}

export interface ToolState {
  installed: boolean
  version: string | null
}

export interface GithubLogin {
  loggedIn: boolean
  login: string | null
  scopes: string[]
  missing: string[]
}

/** `gh auth status`, as words: which account, and which scopes its token has. */
export function readGhStatus(text: string): GithubLogin {
  const login = /Logged in to github\.com (?:account|as) ([A-Za-z0-9-]+)/i.exec(text)?.[1] ?? null
  const scopes = [...(/Token scopes:\s*(.*)/i.exec(text)?.[1] ?? '').matchAll(/'([^']+)'/g)].map((match) => match[1])
  // A fine-grained token or an app has no scopes to list: it is what it is.
  const listed = /Token scopes:/i.test(text)
  const missing = login && listed ? SCOPES.filter((scope) => !scopes.includes(scope) && !(scope === 'read:org' && scopes.includes('admin:org'))) : []
  return { loggedIn: Boolean(login), login, scopes, missing }
}

export interface Prerequisites {
  git: ToolState
  gh: ToolState
  /** Which program answers for the member, and how each stands. */
  provider: Provider
  ai: Record<Provider, AiStatus>
  github: GithubLogin
  /** Programs can be installed from the screen. */
  winget: boolean
}

const version = (text: string) => /(\d+\.\d+(?:\.\d+)?)/.exec(text)?.[1] ?? null

export async function prerequisites(): Promise<Prerequisites> {
  widenPath()
  const [gitFound, ghFound, programs, winget] = await Promise.all([
    run('git', ['--version']),
    run('gh', ['--version']),
    Promise.all(PROVIDERS.map((provider) => aiStatus(provider))),
    process.platform === 'win32' ? run('winget', ['--version']) : Promise.resolve({ ok: false, out: '' }),
  ])
  const status = ghFound.ok ? await run('gh', ['auth', 'status', '--hostname', 'github.com']) : { ok: false, out: '' }
  return {
    git: { installed: gitFound.ok, version: gitFound.ok ? version(gitFound.out) : null },
    gh: { installed: ghFound.ok, version: ghFound.ok ? version(ghFound.out) : null },
    provider: currentProvider(),
    ai: Object.fromEntries(PROVIDERS.map((provider, index) => [provider, programs[index]])) as Record<Provider, AiStatus>,
    github: ghFound.ok ? readGhStatus(status.out) : { loggedIn: false, login: null, scopes: [], missing: [] },
    winget: winget.ok,
  }
}

/** One program alone, for a screen that shows each as it comes. */
export async function toolState(tool: 'git' | 'gh'): Promise<ToolState> {
  widenPath()
  const found = await run(tool, ['--version'])
  return { installed: found.ok, version: found.ok ? version(found.out) : null }
}

/** Whether Windows' own installer is here, so that `install` can run. */
export const canInstall = async () => process.platform === 'win32' && (await run('winget', ['--version'])).ok

const WINGET: Record<string, string> = { git: 'Git.Git', gh: 'GitHub.cli' }

/** Installs Git or the GitHub CLI with Windows' own installer. Its window asks for nothing more than Windows asks. */
export async function install(tool: string): Promise<void> {
  const id = WINGET[tool]
  if (!id) throw new Error('Programme inconnu.')
  const found = await run('winget', ['install', '--id', id, '--exact', '--silent', '--accept-package-agreements', '--accept-source-agreements'], { timeout: 15 * 60_000 })
  // winget says "already installed" with an error code.
  if (!found.ok && !/already installed|déjà installé/i.test(found.out)) throw new Error(found.out.split('\n').slice(-3).join(' ') || "L'installation a échoué.")
  widenPath()
}

/**
 * GitHub's device login, run by `gh` itself: it gives a one-time code, the person types it on github.com in
 * their browser, and `gh` keeps the token. The board only shows the code and the address.
 */
export class GithubLoginFlow {
  private child: ChildProcess | null = null
  code: string | null = null
  url: string | null = null
  error: string | null = null
  running = false

  start(kind: 'login' | 'refresh', onDone: () => void): Promise<{ code: string | null; url: string | null }> {
    if (this.running) return Promise.resolve({ code: this.code, url: this.url })
    this.code = null
    this.url = null
    this.error = null
    this.running = true
    const args =
      kind === 'login'
        ? ['auth', 'login', '--hostname', 'github.com', '--git-protocol', 'https', '--web', '--skip-ssh-key', '--scopes', SCOPES.join(',')]
        : ['auth', 'refresh', '--hostname', 'github.com', '--scopes', SCOPES.join(',')]
    return new Promise((resolve) => {
      let said = ''
      let answered = false
      const child = spawn('gh', args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: { ...process.env, GH_PROMPT_DISABLED: '1' } })
      this.child = child
      const read = (chunk: Buffer) => {
        said = (said + chunk.toString('utf8')).slice(-4000)
        this.code ??= /\b([A-Z0-9]{4}-[A-Z0-9]{4})\b/.exec(said)?.[1] ?? null
        this.url ??= /(https:\/\/github\.com\/login\/device)/.exec(said)?.[1] ?? (this.code ? 'https://github.com/login/device' : null)
        // gh waits for Enter before it opens the browser; the screen opens it instead.
        if (/Press Enter/i.test(said)) child.stdin?.write('\n')
        if (this.code && !answered) {
          answered = true
          resolve({ code: this.code, url: this.url })
        }
      }
      child.stdout?.on('data', read)
      child.stderr?.on('data', read)
      child.stdin?.on('error', () => undefined)
      child.on('error', (error) => {
        this.error = error.message
      })
      child.on('close', (code) => {
        this.running = false
        this.child = null
        if (code !== 0 && !this.error) this.error = said.split('\n').filter(Boolean).slice(-2).join(' ') || 'La connexion à GitHub a échoué.'
        if (!answered) resolve({ code: null, url: null })
        onDone()
      })
    })
  }

  cancel(): void {
    this.child?.kill()
  }
}

export interface EnvironmentChoice {
  repo: string
  private: boolean
  admin: boolean
  description: string
}

/** The environments this login can open: repositories with the environment's topic, where it can push. */
export async function listEnvironments(github: Github): Promise<EnvironmentChoice[]> {
  const repos = await github.all<any>('user/repos?per_page=100&affiliation=owner,collaborator,organization_member&sort=updated')
  return repos
    .filter((repo) => Array.isArray(repo?.topics) && repo.topics.includes(ENVIRONMENT_TOPIC) && repo.permissions?.push && typeof repo.full_name === 'string' && REPOSITORY.test(repo.full_name))
    .map((repo) => ({ repo: repo.full_name, private: Boolean(repo.private), admin: Boolean(repo.permissions?.admin), description: String(repo.description ?? '').slice(0, 200) }))
}

/** Where a new environment can be created: this login, and the organisations it belongs to. */
export async function owners(github: Github): Promise<{ login: string; organization: boolean }[]> {
  const user = await github.get<any>('user')
  const orgs = await github.all<any>('user/orgs?per_page=100').catch(() => [])
  return [{ login: String(user.login), organization: false }, ...orgs.filter((org) => LOGIN.test(org?.login ?? '')).map((org) => ({ login: org.login, organization: true }))]
}

/** Where an environment's clone lives on this computer. */
export const environmentDir = (home: string, repo: string) => {
  const [owner, name] = repo.toLowerCase().split('/')
  return join(home, 'environments', owner, name)
}

const README = (repo: string) => `# ${repo.split('/')[1]}

A board environment: the threads, polls and reports of a team and their agents, written by the board app. It holds no code.

- \`board.json\` marks this repository as an environment.
- \`config/environment.json\` says what the environment works on and what the board may do there. Only admins change it.
- \`threads/\` holds one folder per conversation, one file per message. Nothing is ever edited or removed.
- \`reports/\` holds progress reports, which the apps write by themselves.

Who is online, and the hosts' figures, are in the repository's variables, not in its history.
`

/** Clones the environment if needed, and checks it is one. Returns the clone's folder. */
export async function openEnvironment(home: string, repo: string): Promise<string> {
  if (!REPOSITORY.test(repo)) throw new Error('Un environnement se note propriétaire/nom.')
  const dir = environmentDir(home, repo)
  if (!existsSync(join(dir, '.git'))) {
    await mkdir(join(dir, '..'), { recursive: true })
    const partial = `${dir}.partial`
    await rm(partial, { recursive: true, force: true })
    await git(['clone', '--quiet', '--filter=blob:none', `https://github.com/${repo}.git`, partial])
    await rename(partial, dir)
  }
  await git(['config', 'core.symlinks', 'false'], dir)
  await identity(dir)
  if (!existsSync(join(dir, MARK_FILE))) throw new Error(`${repo} n'est pas un environnement du board : il n'a pas de ${MARK_FILE}.`)
  // Environments made before the .gitignore existed: this clone keeps its private folder out of commits all the same.
  const exclude = join(dir, '.git', 'info', 'exclude')
  const excluded = await readFile(exclude, 'utf8').catch(() => '')
  if (!/^\.cache\/?$/m.test(excluded)) await writeFile(exclude, `${excluded.trimEnd()}\n.cache/\n`.replace(/^\n/, '')).catch(() => undefined)
  return dir
}

/** Commits under the person's GitHub identity, with their private address on GitHub's side. */
async function identity(dir: string): Promise<void> {
  if ((await run('git', ['config', 'user.email'], { cwd: dir })).out) return
  const user = await run('gh', ['api', 'user', '--jq', '[.id, .login] | @tsv'])
  const [id, login] = user.out.split('\t')
  if (!user.ok || !LOGIN.test(login ?? '')) return
  await git(['config', 'user.email', `${id}+${login}@users.noreply.github.com`], dir)
  await git(['config', 'user.name', login], dir)
}

/**
 * Creates a private repository and makes it an environment: its mark, a configuration with nothing
 * allowed yet, and a ruleset that keeps the configuration to admins where the plan allows one.
 */
export async function createEnvironment(github: Github, home: string, input: { owner: string; name: string; organization: boolean; timezone?: string }): Promise<{ dir: string; repo: string; protected: boolean }> {
  if (!LOGIN.test(input.owner) || !/^[A-Za-z0-9._-]{1,100}$/.test(input.name) || /^\.+$/.test(input.name)) throw new Error('Nom de dépôt invalide.')
  const repo = `${input.owner}/${input.name}`
  const body = { name: input.name, private: true, description: 'Board environment: threads, polls and reports. No code.', has_issues: false, has_wiki: false, has_projects: false, auto_init: true }
  try {
    await github.send('POST', input.organization ? `orgs/${input.owner}/repos` : 'user/repos', body)
  } catch (error) {
    // A creation cut short leaves the repository without its mark: it goes on from there, and never over an environment.
    const existing = await github.get<any>(`repos/${repo}`).catch(() => null)
    if (!existing?.permissions?.admin) throw error
    const marked = await github.get(`repos/${repo}/contents/${MARK_FILE}`).then(
      () => true,
      (failure) => ((failure as { status?: number }).status === 404 ? false : Promise.reject(failure)),
    )
    if (marked) throw new Error(`${repo} est déjà un environnement : ouvrez-le.`)
    if (!existing.private) throw new Error(`${repo} existe déjà et il est public : un environnement est privé.`)
  }
  await github.send('PUT', `repos/${repo}/topics`, { names: [ENVIRONMENT_TOPIC] })
  const dir = environmentDir(home, repo)
  await rm(dir, { recursive: true, force: true })
  await mkdir(join(dir, '..'), { recursive: true })
  // GitHub may take a moment before the new repository can be cloned.
  for (let attempt = 0; ; attempt++) {
    try {
      await git(['clone', '--quiet', `https://github.com/${repo}.git`, dir])
      break
    } catch (error) {
      if (attempt >= 5) throw error
      await new Promise((done) => setTimeout(done, 2000))
    }
  }
  await identity(dir)
  await mkdir(join(dir, 'config'), { recursive: true })
  await mkdir(join(dir, 'threads'), { recursive: true })
  await mkdir(join(dir, 'reports'), { recursive: true })
  await writeFile(join(dir, MARK_FILE), `${JSON.stringify({ board: 1, name: input.name }, null, 2)}\n`)
  await writeFile(join(dir, CONFIG_FILE), formatConfig(defaultConfig(input.name, input.timezone ?? 'UTC')))
  await writeFile(join(dir, 'README.md'), README(repo))
  await writeFile(join(dir, '.gitattributes'), '* text=auto eol=lf\n*.png binary\n*.jpg binary\n*.jpeg binary\n*.gif binary\n*.webp binary\n*.pdf binary\n')
  // The app's own files beside the data: never pushed, even by hand.
  await writeFile(join(dir, '.gitignore'), '.cache/\n')
  await writeFile(join(dir, 'threads', '.gitkeep'), '')
  await writeFile(join(dir, 'reports', '.gitkeep'), '')
  await git(['add', '--all'], dir)
  await git(['commit', '--quiet', '-m', 'board: environment created'], dir)
  await git(['push', '--quiet'], dir)
  return { dir, repo, protected: await protectConfig(github, repo) }
}

/** What this computer remembers of environments: the last one opened, and the others. Never committed. */
export interface Remembered {
  current: string | null
  recent: string[]
}

export async function readRemembered(file: string): Promise<Remembered> {
  try {
    const raw = JSON.parse(await readFile(file, 'utf8'))
    const recent = (Array.isArray(raw?.recent) ? raw.recent : []).filter((repo: unknown) => typeof repo === 'string' && REPOSITORY.test(repo)).slice(0, 10)
    return { current: typeof raw?.current === 'string' && REPOSITORY.test(raw.current) ? raw.current : null, recent }
  } catch {
    return { current: null, recent: [] }
  }
}

export async function remember(file: string, current: string | null): Promise<Remembered> {
  const known = await readRemembered(file)
  const recent = current ? [current, ...known.recent.filter((repo) => repo.toLowerCase() !== current.toLowerCase())].slice(0, 10) : known.recent
  const next = { current, recent }
  await mkdir(join(file, '..'), { recursive: true })
  await writeFile(file, `${JSON.stringify(next, null, 2)}\n`)
  return next
}
