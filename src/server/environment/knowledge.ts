import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'
import type { EnvironmentConfig } from './config.ts'
import type { GhRequest } from '../github/client.ts'
import { NO_LINKS, WITH_GH_LOGIN } from './git.ts'

/**
 * What people and agents can read, on disk under `.cache/knowledge`, never committed:
 *   repos/<owner>/<name>/   each repository the configuration marks `code`, on its default branch, without history.
 *   documents/              the configured documents of a branch, such as a roadmap.
 *   github/                 the main repository on GitHub: issues, pull requests, CI, milestones, labels (github.ts).
 * The environment's own reports/ and threads/ are read from its clone.
 */

export interface TreeNode {
  name: string
  path: string
  children?: TreeNode[]
}

/** Text a person can open from a source. An image or an archive has no use in the viewer. */
const TEXT_FILE = /\.(md|html|tsx?|mts|cts|jsx?|mjs|cjs|json|ya?ml|toml|sql|py|sh|css|txt|diff|log|example)$|(^|\/)(Dockerfile|Caddyfile|\.[\w.-]+)$/
const TEXT_MAX = 1 << 21

/** A clone of a repository can be large; nothing here may hang the refresh for ever. */
const RUN_TIMEOUT_MS = 10 * 60_000

const run = (cmd: string, args: string[], cwd?: string) =>
  new Promise<string>((done, fail) => {
    execFile(cmd, args, { cwd, encoding: 'utf8', maxBuffer: 1 << 26, windowsHide: true, timeout: RUN_TIMEOUT_MS, killSignal: 'SIGKILL' }, (error, stdout, stderr) =>
      error ? fail(new Error(stderr.trim() || error.message)) : done(stdout),
    )
  })

export class Knowledge {
  readonly boardRoot: string
  readonly root: string
  private readonly ask: GhRequest
  private readonly config: () => EnvironmentConfig
  lastError: string | null = null

  constructor(boardRoot: string, options: { ask: GhRequest; config: () => EnvironmentConfig }) {
    this.boardRoot = boardRoot
    this.root = join(boardRoot, '.cache', 'knowledge')
    this.ask = options.ask
    this.config = options.config
  }

  /** The folders an agent may read, the first being its working directory. */
  get agentDirs(): string[] {
    return [this.root, join(this.boardRoot, 'reports'), join(this.boardRoot, 'threads')]
  }

  /** The same folders, as the board's file tools read them: reports/ and threads/ by their name. */
  get folders(): { work: string; named: Record<string, string> } {
    return { work: this.root, named: { reports: join(this.boardRoot, 'reports'), threads: join(this.boardRoot, 'threads') } }
  }

  /** Where a repository's code is, relative to the knowledge root. */
  static codePath = (repo: string) => `repos/${repo.toLowerCase()}`

  private async sync(folder: string, repo: string, branch: string | null, patterns: string[] | null): Promise<void> {
    const dir = join(this.root, folder)
    if (!existsSync(join(dir, '.git'))) {
      await mkdir(join(dir, '..'), { recursive: true })
      // In a side folder until it is complete: one stopped halfway would never get its documents.
      const partial = `${dir}.partial`
      await rm(partial, { recursive: true, force: true })
      await run('git', [
        ...WITH_GH_LOGIN, ...NO_LINKS, 'clone', `https://github.com/${repo}.git`, partial,
        '--quiet', '--depth=1', '--filter=blob:none', ...(patterns ? ['--sparse'] : []), '--single-branch', ...(branch ? [`--branch=${branch}`] : []),
      ])
      if (patterns) await run('git', [...WITH_GH_LOGIN, 'sparse-checkout', 'set', '--no-cone', ...patterns], partial)
      await rename(partial, dir)
      return
    }
    await run('git', [...WITH_GH_LOGIN, 'fetch', '--quiet', '--depth=1', 'origin', branch ?? 'HEAD'], dir)
    await run('git', [...WITH_GH_LOGIN, ...NO_LINKS, 'reset', '--quiet', '--hard', 'FETCH_HEAD'], dir)
  }

  /** Copies that the configuration no longer names: their code isn't for agents any more. */
  private async dropOthers(wanted: Set<string>): Promise<void> {
    const base = join(this.root, 'repos')
    for (const owner of await names(base)) {
      for (const name of await names(join(base, owner))) {
        if (!wanted.has(`${owner}/${name}`.toLowerCase()) && !name.endsWith('.partial')) await rm(join(base, owner, name), { recursive: true, force: true })
      }
    }
  }

  private async writeMilestones(repo: string): Promise<void> {
    const milestones = JSON.parse(await this.ask(['api', '--paginate', `repos/${repo}/milestones?state=all&per_page=100`])) as {
      title: string
      state: string
      open_issues: number
      closed_issues: number
      due_on: string | null
    }[]
    const rows = milestones
      .sort((a, b) => a.title.localeCompare(b.title, 'en', { numeric: true }))
      .map((m) => {
        const total = m.open_issues + m.closed_issues
        const done = total ? Math.round((100 * m.closed_issues) / total) : 0
        return `| ${m.title.replace(/\|/g, '/')} | ${m.closed_issues} / ${total} | ${done} % | ${m.due_on?.slice(0, 10) ?? ''} | ${m.state} |`
      })
    await mkdir(join(this.root, 'github'), { recursive: true })
    await writeFile(
      join(this.root, 'github', 'milestones.md'),
      [`# Milestones of ${repo}`, '', `Generated from GitHub on ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC.`, '', '| Milestone | Closed | Done | Due | State |', '| --- | ---: | ---: | --- | --- |', ...rows, ''].join('\n'),
    )
    await writeFile(
      join(this.root, 'github', 'milestones.json'),
      JSON.stringify(milestones.filter((m) => m.state === 'open').map((m) => ({ title: m.title, closed: m.closed_issues, total: m.open_issues + m.closed_issues, due: m.due_on }))),
    )
  }

  private async writeLabels(repo: string): Promise<void> {
    const labels = JSON.parse(await this.ask(['api', '--paginate', `repos/${repo}/labels?per_page=100`])) as { name: string }[]
    await writeFile(join(this.root, 'github', 'labels.json'), JSON.stringify(labels.map((label) => label.name).filter((name) => typeof name === 'string')))
  }

  /** Refreshes everything. A failure keeps the last copy and shows in `lastError`. */
  async refresh(): Promise<void> {
    const config = this.config()
    const problems: string[] = []
    const step = async (name: string, work: () => Promise<void>) => {
      try {
        await work()
      } catch (error) {
        problems.push(`${name}: ${(error as Error).message}`)
      }
    }
    const code = config.repos.filter((repo) => repo.code)
    for (const repo of code) await step(repo.name, () => this.sync(Knowledge.codePath(repo.name), repo.name, null, null))
    await step('repositories', () => this.dropOthers(new Set(code.map((repo) => repo.name.toLowerCase()))))
    const { documents } = config
    if (documents) await step('documents', () => this.sync('documents', documents.repo, documents.branch, [`/${documents.path}/`]))
    else await rm(join(this.root, 'documents'), { recursive: true, force: true }).catch(() => undefined)
    const main = config.repos[0]?.name
    if (main) {
      await step('milestones', () => this.writeMilestones(main))
      await step('labels', () => this.writeLabels(main))
    }
    this.lastError = problems.length ? problems.join(' · ') : null
  }

  async tree(): Promise<TreeNode[]> {
    const sections: TreeNode[] = []
    const add = async (name: string, nodes: Promise<TreeNode[]>) => {
      const children = await nodes
      if (children.length) sections.push({ name, path: '', children })
    }
    await add('GitHub', this.listGithub())
    await add('Documents', walk(join(this.root, 'documents'), 'documents'))
    for (const repo of this.config().repos.filter((candidate) => candidate.code)) await add(repo.name, this.listRepository(repo.name))
    return sections
  }

  private async listGithub(): Promise<TreeNode[]> {
    const entries: [string, string][] = [
      ['En attente de réponse', 'github/waiting.md'],
      ['Pull requests ouvertes', 'github/pulls/open.md'],
      ['Merges récents', 'github/pulls/merged.md'],
      ['Issues ouvertes', 'github/issues/open.md'],
      ['Issues fermées récemment', 'github/issues/closed.md'],
      ['Jalons', 'github/milestones.md'],
      ['CI', 'github/ci/status.md'],
    ]
    return entries.filter(([, path]) => existsSync(join(this.root, path))).map(([name, path]) => ({ name, path }))
  }

  /** A repository's own documents: what is at its root, its docs/, and each folder's README and AGENTS, two levels down. */
  private async listRepository(repo: string): Promise<TreeNode[]> {
    const path = Knowledge.codePath(repo)
    const base = join(this.root, ...path.split('/'))
    const rootFiles = (await names(base))
      .filter((name) => name.endsWith('.md') && name !== 'CLAUDE.md')
      .map((name) => ({ name: name === 'README.md' ? 'Présentation du dépôt' : name === 'AGENTS.md' ? 'Règles du dépôt' : name, path: `${path}/${name}` }))
    const docs = await walk(join(base, 'docs'), `${path}/docs`)
    const parts: TreeNode[] = []
    for (const top of (await readdir(base, { withFileTypes: true }).catch(() => [])).filter((entry) => entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'docs' && entry.name !== 'node_modules')) {
      const children: TreeNode[] = []
      const own = (await names(join(base, top.name))).filter((name) => name === 'README.md' || name === 'AGENTS.md')
      children.push(...own.map((name) => ({ name, path: `${path}/${top.name}/${name}` })))
      for (const sub of (await readdir(join(base, top.name), { withFileTypes: true }).catch(() => [])).filter((entry) => entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules')) {
        const found = (await names(join(base, top.name, sub.name))).filter((name) => name === 'README.md' || name === 'AGENTS.md')
        if (found.length) children.push({ name: sub.name, path: '', children: found.map((name) => ({ name, path: `${path}/${top.name}/${sub.name}/${name}` })) })
      }
      if (children.length) parts.push({ name: top.name, path: '', children })
    }
    return [...rootFiles, ...(docs.length ? [{ name: 'docs', path: '', children: docs }] : []), ...parts]
  }

  /** The file at a knowledge path, or null if the path leaves the readable folders. */
  resolve(path: string): string | null {
    // Lowercase: on Windows, .GIT is .git.
    const segments = path.toLowerCase().split('/')
    if (!/^[\w./ \-[\]()@+]+$/.test(path) || segments.includes('..') || segments.includes('.git')) return null
    const base = path.startsWith('reports/') || path.startsWith('threads/') ? this.boardRoot : this.root
    const file = resolve(base, path)
    const allowed = base === this.boardRoot ? this.agentDirs.slice(1) : [this.root]
    return allowed.some((dir) => file.startsWith(dir + sep)) ? file : null
  }

  async read(path: string): Promise<string | null> {
    const file = this.resolve(path)
    // Attached files only download: an attached page is never shown as one of ours.
    if (!file || !TEXT_FILE.test(path) || path.toLowerCase().includes('/attachments/')) return null
    // Only the repositories and the copy of GitHub hold anything but documents and reports.
    if (!/\.(md|html)$/.test(path) && !path.startsWith('repos/') && !path.startsWith('github/')) return null
    try {
      // A link can point anywhere, and the check on the path above doesn't see that.
      const real = await realpath(file)
      const roots = await Promise.all([this.root, ...this.agentDirs.slice(1)].map((dir) => realpath(dir).catch(() => dir)))
      if (!roots.some((dir) => real.startsWith(dir + sep))) return null
      const found = await stat(real)
      if (!found.isFile() || found.size > TEXT_MAX) return null
      return await readFile(file, 'utf8')
    } catch {
      return null
    }
  }

  /** A file an agent read, as a knowledge path, or null when it isn't one. */
  toKnowledgePath(file: string): string | null {
    const full = resolve(this.root, file)
    for (const [dir, prefix] of [
      [this.root, ''],
      [join(this.boardRoot, 'reports'), 'reports/'],
      [join(this.boardRoot, 'threads'), 'threads/'],
    ] as const) {
      if (full.startsWith(dir + sep)) return prefix + relative(dir, full).split(sep).join('/')
    }
    return null
  }
}

const names = async (dir: string): Promise<string[]> => {
  try {
    return await readdir(dir)
  } catch {
    return []
  }
}

async function walk(dir: string, path: string, keep: (name: string) => boolean = () => true): Promise<TreeNode[]> {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const folders: TreeNode[] = []
  const files: TreeNode[] = []
  for (const entry of entries) {
    if (entry.name === '.git') continue
    if (entry.isDirectory()) {
      const children = await walk(join(dir, entry.name), `${path}/${entry.name}`, keep)
      if (children.length) folders.push({ name: entry.name, path: '', children })
    } else if (entry.name.endsWith('.md') && keep(entry.name)) {
      files.push({ name: entry.name, path: `${path}/${entry.name}` })
    }
  }
  const byName = (a: TreeNode, b: TreeNode) => a.name.localeCompare(b.name, 'en', { numeric: true })
  return [...folders.sort(byName), ...files.sort(byName)]
}
