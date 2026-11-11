import type { Github } from '../github/client.ts'
import { LOGIN } from './config.ts'

/**
 * What changes all the time, kept out of the history: the environment repository's variables.
 * Any member can write them, they keep no versions, and one request lists them all.
 *
 *   BOARD_MEMBER_<LOGIN>   {"v":1,"at":"…","reply":"auto"}   written by that member's app.
 *   BOARD_HOST_<NAME>      what that host's probe reads, written by the host itself.
 *
 * A variable is anyone's text: each is read with the same care as a pushed file.
 */

export const MEMBER_PREFIX = 'BOARD_MEMBER_'
export const HOST_PREFIX = 'BOARD_HOST_'
/** A member's app says it is there this often, and counts as gone after twice that and a margin. */
export const HEARTBEAT_MS = 5 * 60_000
export const ONLINE_MS = 12 * 60_000
export const REPLY_MODES = ['off', 'auto', 'draft'] as const
export type ReplyMode = (typeof REPLY_MODES)[number]

export interface MemberLive {
  login: string
  at: string
  online: boolean
  reply: ReplyMode
}

/** A host's variable as GitHub gives it: probes.ts reads it. */
export interface HostLive {
  name: string
  value: string
  updatedAt: string
}

/** A variable's name: letters, digits and underscores, upper case. A login has no underscore, so no two logins share one. */
export const variableOf = (prefix: string, name: string) => `${prefix}${name.toUpperCase().replace(/-/g, '_')}`

export const memberValue = (reply: ReplyMode, at = new Date()) => JSON.stringify({ v: 1, at: at.toISOString(), reply })

export function parseMember(name: string, value: string, logins: string[], now = Date.now()): MemberLive | null {
  const login = logins.find((candidate) => variableOf(MEMBER_PREFIX, candidate) === name)
  if (!login || !LOGIN.test(login)) return null
  try {
    const raw = JSON.parse(value)
    const at = typeof raw?.at === 'string' ? Date.parse(raw.at) : Number.NaN
    // A date from the future would keep someone online for good.
    if (raw?.v !== 1 || Number.isNaN(at) || at > now + 5 * 60_000) return null
    return { login, at: new Date(at).toISOString(), online: now - at < ONLINE_MS, reply: (REPLY_MODES as readonly string[]).includes(raw.reply) ? raw.reply : 'off' }
  } catch {
    return null
  }
}

export function parseHost(name: string, value: string, updatedAt: string): HostLive | null {
  const host = name.slice(HOST_PREFIX.length).toLowerCase().replace(/_/g, '-')
  if (!/^[a-z0-9][a-z0-9-]{0,40}$/.test(host) || typeof value !== 'string' || value.length > 64 * 1024) return null
  return { name: host, value, updatedAt }
}

export interface LiveState {
  members: MemberLive[]
  hosts: HostLive[]
  at: number
  error: string | null
}

/** Reads and writes the variables of one environment. */
export class Live {
  private readonly github: Github
  private readonly repo: string
  private state: LiveState = { members: [], hosts: [], at: 0, error: null }
  private reading: Promise<LiveState> | null = null
  /** Whether this member's variable exists yet: creating and updating are two requests. */
  private exists: boolean | null = null
  /** Every variable name the last reading saw, members or not. */
  private allNames: string[] = []

  constructor(github: Github, repo: string) {
    this.github = github
    this.repo = repo
  }

  get last(): LiveState {
    return this.state
  }

  /** At most once in `freshMs`: every screen that shows someone asks. */
  read(logins: string[], freshMs = 60_000): Promise<LiveState> {
    if (Date.now() - this.state.at < freshMs) return Promise.resolve(this.state)
    this.reading ??= (async () => {
      try {
        const variables: { name: string; value: string; updated_at: string }[] = []
        // GitHub keeps at most 500 variables in a repository: five pages of a hundred see them all.
        for (let page = 1; page <= 5; page++) {
          const found = await this.github.get<any>(`repos/${this.repo}/actions/variables?per_page=100&page=${page}`)
          variables.push(...(found?.variables ?? []))
          if ((found?.variables ?? []).length < 100) break
        }
        const now = Date.now()
        this.allNames = variables.map((v) => v.name)
        this.state = {
          members: variables.filter((v) => v.name.startsWith(MEMBER_PREFIX)).map((v) => parseMember(v.name, v.value, logins, now)).filter((m): m is MemberLive => m !== null),
          hosts: variables.filter((v) => v.name.startsWith(HOST_PREFIX)).map((v) => parseHost(v.name, v.value, v.updated_at)).filter((h): h is HostLive => h !== null),
          at: now,
          error: null,
        }
      } catch (error) {
        this.state = { ...this.state, at: Date.now(), error: (error as Error).message }
      } finally {
        this.reading = null
      }
      return this.state
    })()
    return this.reading
  }

  /**
   * Drops the variable of anyone who is no longer a member, so that the repository's 500 never fill up with people
   * who left. Only an admin's app does this, with the members GitHub lists now. Returns the names dropped.
   */
  async prune(logins: string[]): Promise<string[]> {
    const state = await this.read(logins, 0)
    const kept = new Set(logins.map((login) => variableOf(MEMBER_PREFIX, login)))
    const dropped: string[] = []
    for (const name of this.allNames.filter((candidate) => candidate.startsWith(MEMBER_PREFIX) && !kept.has(candidate))) {
      await this.github.send('DELETE', `repos/${this.repo}/actions/variables/${name}`)
      dropped.push(name)
    }
    if (dropped.length) this.state = { ...state, at: 0 }
    return dropped
  }

  /** Says this member is here, and how their agent answers others. */
  async announce(login: string, reply: ReplyMode): Promise<void> {
    const name = variableOf(MEMBER_PREFIX, login)
    const value = memberValue(reply)
    if (this.exists !== false) {
      try {
        await this.github.send('PATCH', `repos/${this.repo}/actions/variables/${name}`, { name, value })
        this.exists = true
        this.state = { ...this.state, at: 0 }
        return
      } catch (error) {
        if ((error as { status?: number }).status !== 404) throw error
      }
    }
    await this.github.send('POST', `repos/${this.repo}/actions/variables`, { name, value })
    this.exists = true
    this.state = { ...this.state, at: 0 }
  }
}
