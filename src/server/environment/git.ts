import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rm, rmdir, stat, utimes, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

const LOCK_STALE_MS = 2 * 60 * 1000
const LOCK_REFRESH_MS = 30 * 1000
/** The reports the apps write by themselves, and no other file. Older ones are `.html`, written by hand. */
const REPORT_DAY = ':(glob)reports/[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]-'
const REPORT_FILES = [`${REPORT_DAY}[0-9][0-9][0-9][0-9].json`, `${REPORT_DAY}day.json`]
const REPORT_PATH = /^reports\/\d{4}-\d{2}-\d{2}-(\d{4}|day)\.json$/

/**
 * Plain git over the person's `gh` login, so a clone works wherever `gh` is signed in. `gh repo clone`
 * would spend GraphQL quota, which the same login needs for its real work.
 */
export const WITH_GH_LOGIN = ['-c', 'credential.helper=', '-c', 'credential.helper=!gh auth git-credential']

/**
 * Links someone pushed are checked out as plain files holding their target: a link in a thread or a followed repository
 * would otherwise lead an agent's reads, or a download, to any file on the computer.
 */
export const NO_LINKS = ['-c', 'core.symlinks=false']

/** Commands that go to GitHub, which a sleeping laptop or a proxy can leave hanging. */
const REMOTE = new Set(['push', 'pull', 'fetch', 'clone', 'ls-remote'])
const REMOTE_TIMEOUT_MS = 120_000
const LOCAL_TIMEOUT_MS = 30_000
/** Git gives up on a transfer slower than 1 KB/s for a minute, rather than waiting for ever. */
const SLOW_LINK = ['-c', 'http.lowSpeedLimit=1000', '-c', 'http.lowSpeedTime=60']

const run = (cwd: string, args: string[]) =>
  new Promise<string>((resolve, reject) => {
    const remote = REMOTE.has(args[0])
    execFile('git', [...WITH_GH_LOGIN, ...(remote ? SLOW_LINK : []), ...args], { cwd, encoding: 'utf8', maxBuffer: 1 << 26, windowsHide: true, timeout: remote ? REMOTE_TIMEOUT_MS : LOCAL_TIMEOUT_MS, killSignal: 'SIGKILL' }, (error, stdout, stderr) =>
      error ? reject(new Error((error as NodeJS.ErrnoException & { killed?: boolean }).killed ? `git ${args[0]} n'a pas répondu à temps` : stderr.trim() || error.message)) : resolve(stdout.trim()),
    )
  })

/** A push another push beat: a pull and another try settle it. Anything else is GitHub's word, and a retry changes nothing. */
const BEATEN = /non-fast-forward|fetch first|failed to push some refs|rejected.*(stale|behind)|cannot lock ref/i

/** Another git, such as an editor's, is working in this clone. */
const BUSY = /index\.lock|another git process|cannot lock ref/i
const pause = (ms: number) => new Promise((done) => setTimeout(done, ms))

async function exec(cwd: string, args: string[]): Promise<string> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await run(cwd, args)
    } catch (error) {
      if (attempt >= 20 || !BUSY.test((error as Error).message)) throw error
      await pause(150 + Math.random() * 350)
    }
  }
}

/** Git operations on the board's own clone, one at a time, so a pull never meets a commit. */
export class BoardGit {
  private readonly root: string
  private gitDir: string | null = null
  private queue: Promise<unknown> = Promise.resolve()
  lastError: string | null = null
  /** Whether files may be lying around uncommitted: at the start, and after a publish failed. */
  private needsSweep = true

  /** The remote branch's latest commit, asked in a way that costs nothing when it hasn't moved. Null when it can't tell. */
  private readonly remoteHead: (() => Promise<string | null>) | null

  constructor(root: string, options: { remoteHead?: () => Promise<string | null> } = {}) {
    this.root = root
    this.remoteHead = options.remoteHead ?? null
  }

  /** Whether a pull would bring nothing: the remote is where this clone last saw it, and nothing waits to go. Asks nothing of Git's network. */
  private async upToDate(): Promise<boolean> {
    if (!this.remoteHead) return false
    const remote = await this.remoteHead().catch(() => null)
    if (!remote) return false
    // Both where the remote is: a rebase that failed after a fetch leaves @{u} ahead of HEAD, and that still needs a pull.
    const [known, head] = await Promise.all([exec(this.root, ['rev-parse', '@{u}']).catch(() => ''), exec(this.root, ['rev-parse', 'HEAD']).catch(() => '')])
    return known === remote && head === remote
  }

  /** The last commit that changed this file here, or null. Read only: no lock. */
  async lastCommitOf(path: string): Promise<string | null> {
    return (await run(this.root, ['log', '-1', '--format=%H', '--', path]).catch(() => '')) || null
  }

  /** Puts a tracked file back as the last commit has it, when a change to it couldn't be committed. */
  restore(path: string): Promise<void> {
    return this.enqueue(async () => {
      if (await exec(this.root, ['diff', '--name-only', '--', path])) await exec(this.root, ['checkout', 'HEAD', '--', path])
    })
  }

  /** When a commit was made, by its own clock, or null when it isn't known here. */
  async commitTime(commit: string): Promise<number | null> {
    if (!/^[0-9a-f]{40}$/.test(commit)) return null
    const found = Date.parse(await run(this.root, ['log', '-1', '--format=%cI', commit]).catch(() => ''))
    return Number.isNaN(found) ? null : found
  }

  /** Whether `commit` is in the history of `of`. False when either isn't known here. */
  async isAncestor(commit: string, of: string): Promise<boolean> {
    if (!/^[0-9a-f]{40}$/.test(commit) || !/^[0-9a-f]{40}$/.test(of)) return false
    return run(this.root, ['merge-base', '--is-ancestor', commit, of]).then(() => true, () => false)
  }

  /** Takes back the last commit when it is still unpushed and touches only this path, as if it had never been made. */
  undoUnpushed(path: string): Promise<void> {
    return this.enqueue(async () => {
      if ((await exec(this.root, ['rev-list', '--count', '@{u}..HEAD']).catch(() => '0')) === '0') return
      if ((await exec(this.root, ['show', '--name-only', '--format=', 'HEAD'])) !== path) return
      // Only that file goes back: anything else written meanwhile stays where it is.
      await exec(this.root, ['reset', '--quiet', '--mixed', 'HEAD~1'])
      await exec(this.root, ['checkout', 'HEAD', '--', path])
    })
  }

  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const locked = () => this.withLock(work)
    const next = this.queue.then(locked, locked)
    this.queue = next.catch(() => undefined)
    return next
  }

  /** The app and a session's CLI can share a clone, and a commit landing during another's rebase breaks it. */
  private async withLock<T>(work: () => Promise<T>): Promise<T> {
    this.gitDir ??= await exec(this.root, ['rev-parse', '--absolute-git-dir'])
    const lock = join(this.gitDir, 'board-lock')
    for (;;) {
      try {
        await mkdir(lock)
        break
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        const age = await stat(lock).then((found) => Date.now() - found.mtimeMs, () => 0)
        if (age > LOCK_STALE_MS) await rmdir(lock).catch(() => undefined)
        await pause(100 + Math.random() * 200)
      }
    }
    // A slow push must not look like a process that died.
    const alive = setInterval(() => {
      const now = new Date()
      void utimes(lock, now, now).catch(() => undefined)
    }, LOCK_REFRESH_MS)
    try {
      // We hold the lock, so a rebase still open was left by a process that died. Before anything else: a commit made now
      // would land on no branch, and the abort would then lose it. If it can't be aborted, nothing runs, and the failure shows.
      if (this.rebasing) {
        await exec(this.root, ['rebase', '--abort']).catch((error) => {
          this.lastError = (error as Error).message
          throw error
        })
      }
      return await work()
    } finally {
      clearInterval(alive)
      await rmdir(lock).catch(() => undefined)
    }
  }

  private async hasRemote(): Promise<boolean> {
    return (await exec(this.root, ['remote'])).length > 0
  }

  /**
   * A report left behind by a crash or a failed commit, which nobody will ever commit. The app writes these by itself and
   * `claim` writes them again, so dropping one loses nothing, and keeping one would stop every pull once the other
   * app had written the same file. Nothing here touches a file already committed.
   */
  private async dropStrayReports(): Promise<void> {
    const staged = await exec(this.root, ['diff', '--cached', '--name-only', '--diff-filter=A', '--', ...REPORT_FILES])
    if (staged) await exec(this.root, ['reset', '--quiet', '--', ...REPORT_FILES])
    await exec(this.root, ['clean', '--force', '--quiet', '--', ...REPORT_FILES])
  }

  private get rebasing() {
    return existsSync(join(this.gitDir ?? '', 'rebase-merge')) || existsSync(join(this.gitDir ?? '', 'rebase-apply'))
  }

  /** Whether the rebase stopped on a commit holding nothing but reports, in conflict with what the other app wrote. */
  private async stoppedOnReport(): Promise<boolean> {
    const lines = (text: string) => text.split('\n').filter(Boolean)
    const unmerged = lines(await run(this.root, ['diff', '--name-only', '--diff-filter=U']).catch(() => ''))
    const touched = lines(await run(this.root, ['show', '--name-only', '--format=', 'REBASE_HEAD']).catch(() => ''))
    return unmerged.length > 0 && touched.length > 0 && [...unmerged, ...touched].every((path) => REPORT_PATH.test(path))
  }

  /** Files are only added, so a conflict is rare; one must not leave the clone stuck mid-rebase. */
  private async rebase(): Promise<void> {
    await this.dropStrayReports()
    let step = () => exec(this.root, ['pull', '--rebase', '--autostash', '--quiet'])
    let skipped = ''
    for (;;) {
      try {
        await step()
        return
      } catch (error) {
        if (!this.rebasing) throw error
        // A report committed here and never pushed, which the other app has written since: theirs stands, as `claim` would
        // have had it. Only that commit gives way. For anything else, everything is put back and the failure says so.
        const stopped = await run(this.root, ['rev-parse', 'REBASE_HEAD']).catch(() => '')
        // The same commit again means skipping it didn't work: going on would never end, with the lock held.
        if (stopped === skipped || !(await this.stoppedOnReport())) {
          await exec(this.root, ['rebase', '--abort']).catch(() => undefined)
          throw error
        }
        skipped = stopped
        step = () => exec(this.root, ['rebase', '--skip'])
      }
    }
  }

  /**
   * Pushes, pulling again if someone pushed first. A failure stays in `lastError`, and a refusal that a retry
   * can't change (a rule, a protection, a secret GitHub saw) stops at once, so the app doesn't push every ten seconds.
   */
  private async push(): Promise<void> {
    for (let attempt = 0; ; attempt++) {
      try {
        await exec(this.root, ['push', '--quiet'])
        this.lastError = null
        return
      } catch (error) {
        if (attempt >= 8 || !BEATEN.test((error as Error).message)) {
          // The message is committed here, and the next pull sends it.
          this.lastError = (error as Error).message
          this.needsSweep = true
          return
        }
        // Many apps pushing at the same moment take turns: each waits a little longer, and not all the same.
        await pause(Math.min(4000, 150 * 2 ** attempt) + Math.random() * 400)
        await this.rebase().catch(() => undefined)
      }
    }
  }

  /**
   * Commits messages and files a failed publish left behind, or a crash between writing and
   * committing. Nothing written here stays on this machine alone.
   */
  private async sweep(): Promise<void> {
    if (!this.needsSweep || !existsSync(join(this.root, 'threads'))) return
    this.needsSweep = false
    await exec(this.root, ['add', '--all', '--force', '--', 'threads'])
    if (await exec(this.root, ['diff', '--cached', '--name-only', '--', 'threads'])) {
      await exec(this.root, ['commit', '--quiet', '-m', 'board: messages not sent earlier', '--', 'threads'])
    }
  }

  /** Waits for what is under way. */
  async drain(): Promise<void> {
    await this.queue
  }

  /** Brings in what the other person wrote, and sends what an earlier push couldn't. Returns whether anything came in. */
  pull(): Promise<boolean> {
    return this.enqueue(async () => {
      if (!(await this.hasRemote())) return false
      try {
        await this.sweep()
        // Every member's app looks every ten seconds: most of the time, nothing moved.
        if (await this.upToDate()) {
          this.lastError = null
          return false
        }
        const before = await exec(this.root, ['rev-parse', 'HEAD'])
        await this.rebase()
        this.lastError = null
        const after = await exec(this.root, ['rev-parse', 'HEAD'])
        if ((await exec(this.root, ['rev-list', '--count', '@{u}..HEAD'])) !== '0') await this.push()
        return after !== before
      } catch (error) {
        this.lastError = (error as Error).message
        return false
      }
    })
  }

  /**
   * Writes this file only if nobody has, and returns what the file says in the end: `text` if this computer
   * got there first. The remote decides, since it accepts only one of two pushes on the same commit, and
   * the loser takes its commit back rather than meet a conflict. It throws if it can't tell.
   */
  claim(path: string, text: string, subject = 'board: claim'): Promise<string> {
    return this.enqueue(async () => {
      const file = join(this.root, path)
      // A file deleted here is still written, and still can't be written again.
      const written = async () => {
        if (!existsSync(file) && (await run(this.root, ['cat-file', '-e', `HEAD:${path}`]).then(() => true, () => false))) await exec(this.root, ['checkout', 'HEAD', '--', path])
        return existsSync(file) ? readFile(file, 'utf8') : null
      }
      const write = async () => {
        await mkdir(dirname(file), { recursive: true })
        await writeFile(file, text)
        try {
          await exec(this.root, ['add', '--force', '--', path])
          await exec(this.root, ['commit', '--quiet', '-m', subject, '--', path])
        } catch (error) {
          // A file left on disk would read as written, by this computer alone.
          await run(this.root, ['reset', '--quiet', '--', path]).catch(() => undefined)
          await rm(file, { force: true })
          throw error
        }
      }
      if (!(await this.hasRemote())) {
        const found = await written()
        if (found !== null) return found
        await write()
        return text
      }
      await this.sweep()
      await this.rebase()
      if ((await exec(this.root, ['rev-list', '--count', '@{u}..HEAD'])) !== '0') {
        await this.push()
        if (this.lastError) throw new Error(this.lastError)
      }
      const found = await written()
      if (found !== null) return found
      await write()
      // Only this commit, still unpushed: a rebase may have dropped it already, and what is under it is someone else's.
      const takeBack = async () => {
        if ((await exec(this.root, ['rev-list', '--count', '@{u}..HEAD'])) === '0') return
        if ((await exec(this.root, ['show', '--name-only', '--format=', 'HEAD'])) !== path) return
        await exec(this.root, ['reset', '--quiet', '--mixed', 'HEAD~1'])
        await rm(file, { force: true })
      }
      for (let attempt = 0; ; attempt++) {
        try {
          // The other app wrote it during that rebase, so ours is gone: there is nothing to push, and the file is theirs.
          if ((await exec(this.root, ['rev-list', '--count', '@{u}..HEAD'])) === '0') {
            this.lastError = null
            return readFile(file, 'utf8')
          }
          await exec(this.root, ['push', '--quiet'])
          this.lastError = null
          return text
        } catch (error) {
          try {
            await exec(this.root, ['fetch', '--quiet'])
            if (await exec(this.root, ['ls-tree', '--name-only', '@{u}', '--', path])) {
              await takeBack()
              await this.rebase()
              return readFile(file, 'utf8')
            }
            if (attempt >= 8) throw error
            await pause(100 + Math.random() * 400)
            await this.rebase()
          } catch (failure) {
            await takeBack().catch(() => undefined)
            throw failure
          }
        }
      }
    })
  }

  /** Commits these paths and pushes them. */
  publish(paths: string[], subject: string): Promise<void> {
    return this.enqueue(async () => {
      try {
        await this.publishNow(paths, subject)
      } catch (error) {
        this.needsSweep = true
        throw error
      }
    })
  }

  private async publishNow(paths: string[], subject: string): Promise<void> {
    {
      // --force: an attached `debug.log` is a file like any other here, whatever .gitignore says.
      await exec(this.root, ['add', '--force', '--', ...paths])
      // A sweep may already have committed them.
      if (await exec(this.root, ['diff', '--cached', '--name-only', '--', ...paths])) {
        await exec(this.root, ['commit', '--quiet', '-m', subject, '--', ...paths])
      }
      if (await this.hasRemote()) await this.push()
    }
  }

  /**
   * Lets `change` rewrite a folder, then commits and pushes whatever differs, removals included.
   * It runs under the lock, so a pull can't stash the folder halfway through.
   */
  publishFolder(folder: string, subject: string, change: () => Promise<void>): Promise<void> {
    return this.enqueue(async () => {
      await change()
      await exec(this.root, ['add', '--all', '--', folder])
      if (!(await exec(this.root, ['diff', '--cached', '--name-only', '--', folder]))) return
      await exec(this.root, ['commit', '--quiet', '-m', subject, '--', folder])
      if (await this.hasRemote()) await this.push()
    })
  }
}
