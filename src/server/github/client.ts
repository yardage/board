import { execFile } from 'node:child_process'

/**
 * GitHub's REST and GraphQL, from this process, with the person's own `gh` login.
 *
 * Every member's app reads the same things, so each read is conditional: GitHub answers 304 when
 * nothing changed, and a 304 doesn't count against the person's quota. The token is asked from
 * `gh auth token` when needed, kept in memory only, and never logged, written or given to a child.
 */

const API = 'https://api.github.com'
const TIMEOUT_MS = 90_000
/** Enough for every list the board reads, a few times over. The oldest answers go first. */
const CACHE_MAX = 4000
/** Beyond this, an answer isn't kept. */
const CACHE_BODY_MAX = 256 * 1024
const PAGES_MAX = 50

/** What a status means to a member: the code and GitHub's words stay as a detail after it. */
export function humanReason(status: number, message: string): string {
  const detail = message.replace(/\s+/g, ' ').trim().slice(0, 140)
  if (status === 401 || status === 403) return `ce compte n'y a pas accès (${status}${detail ? `, ${detail}` : ''})`
  if (status === 404) return `introuvable sur GitHub (404${detail ? `, ${detail}` : ''})`
  if (status === 422) return `GitHub a refusé la demande (${detail || '422'})`
  if (status >= 500) return `GitHub est indisponible (${status})`
  return `GitHub ${status}${detail ? `: ${detail}` : ''}`
}

export class GithubError extends Error {
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

interface Cached {
  etag: string
  body: string
  next: string | null
}

const runGh = (args: string[]) =>
  new Promise<string>((done, fail) => {
    execFile('gh', args, { encoding: 'utf8', windowsHide: true, timeout: 20_000 }, (error, stdout, stderr) =>
      error ? fail(new Error(stderr.trim() || error.message)) : done(stdout.trim()),
    )
  })

export interface GithubOptions {
  /** Replaced in tests. */
  token?: () => Promise<string>
  fetch?: typeof fetch
}

export class Github {
  private token: string | null = null
  private readonly cache = new Map<string, Cached>()
  private readonly readToken: () => Promise<string>
  private readonly doFetch: typeof fetch
  /** What GitHub said is left of the hour's quota, and when it comes back. */
  remaining: number | null = null
  resetAt: number | null = null

  constructor(options: GithubOptions = {}) {
    this.readToken = options.token ?? (() => runGh(['auth', 'token']))
    this.doFetch = options.fetch ?? fetch
  }

  /** Forgets the token, after `gh auth login` or logout. */
  forget(): void {
    this.token = null
  }

  private reading: Promise<string> | null = null
  private async auth(): Promise<string> {
    if (!this.token) {
      // Many calls at once read the token once.
      this.reading ??= this.readToken().finally(() => {
        this.reading = null
      })
      this.token = await this.reading
    }
    if (!this.token) throw new GithubError(401, 'Pas de connexion GitHub : connectez-vous depuis le board.')
    return this.token
  }

  private remember(url: string, value: Cached): void {
    // A diff or a log can weigh megabytes: those are read again rather than kept.
    if (value.body.length > CACHE_BODY_MAX || /\/logs(\?|$)/.test(url)) return
    this.cache.delete(url)
    this.cache.set(url, value)
    if (this.cache.size > CACHE_MAX) this.cache.delete(this.cache.keys().next().value as string)
  }

  /** One request. A GET reuses what GitHub already gave, for free, when it hasn't changed. */
  async request(method: string, path: string, options: { body?: unknown; accept?: string; retried?: boolean; timeout?: number } = {}): Promise<{ status: number; body: string; next: string | null; headers: Headers }> {
    const url = path.startsWith('https://') ? path : `${API}/${path.replace(/^\//, '')}`
    if (!url.startsWith(`${API}/`)) throw new GithubError(400, 'Adresse GitHub refusée.')
    // The quota is spent until GitHub says: asking again only costs time.
    if (this.remaining === 0 && this.resetAt && Date.now() < this.resetAt) throw new GithubError(429, `GitHub rate limit: le quota revient à ${new Date(this.resetAt).toLocaleTimeString()}`)
    const accept = options.accept ?? 'application/vnd.github+json'
    const key = `${accept} ${url}`
    const cached = method === 'GET' ? this.cache.get(key) : undefined
    const headers: Record<string, string> = {
      accept,
      authorization: `Bearer ${await this.auth()}`,
      'x-github-api-version': '2022-11-28',
      'user-agent': 'board',
    }
    if (cached) headers['if-none-match'] = cached.etag
    if (options.body !== undefined) headers['content-type'] = 'application/json'
    const answer = await this.doFetch(url, {
      method,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: AbortSignal.timeout(options.timeout ?? TIMEOUT_MS),
    })
    const remaining = Number(answer.headers.get('x-ratelimit-remaining'))
    if (answer.headers.has('x-ratelimit-remaining') && Number.isFinite(remaining)) {
      this.remaining = remaining
      this.resetAt = Number(answer.headers.get('x-ratelimit-reset')) * 1000 || null
    }
    if (answer.status === 304 && cached) {
      await answer.arrayBuffer().catch(() => undefined)
      this.remember(key, cached)
      return { status: 200, body: cached.body, next: cached.next, headers: answer.headers }
    }
    const body = await answer.text()
    if (answer.status === 401 && !options.retried) {
      // The person logged in again: the next token is another one.
      this.token = null
      return this.request(method, path, { ...options, retried: true })
    }
    if (answer.status >= 400) {
      let message = body
      try {
        message = JSON.parse(body).message ?? body
      } catch {
        // Not JSON: the text says it.
      }
      const limited = answer.status === 429 || (answer.status === 403 && (remaining === 0 || /rate limit/i.test(message)))
      throw new GithubError(answer.status, limited ? `GitHub rate limit: ${message}` : humanReason(answer.status, String(message)))
    }
    const next = /<([^>]+)>;\s*rel="next"/.exec(answer.headers.get('link') ?? '')?.[1] ?? null
    const etag = answer.headers.get('etag')
    if (method === 'GET' && etag) this.remember(key, { etag, body, next })
    return { status: answer.status, body, next, headers: answer.headers }
  }

  async get<T = any>(path: string): Promise<T> {
    const { body } = await this.request('GET', path)
    return (body ? JSON.parse(body) : null) as T
  }

  async text(path: string, accept: string, timeout?: number): Promise<string> {
    return (await this.request('GET', path, { accept, timeout })).body
  }

  /** Every page of a list, each one conditional. */
  async all<T = any>(path: string): Promise<T[]> {
    const items: T[] = []
    let next: string | null = path
    for (let page = 0; next && page < PAGES_MAX; page++) {
      const answer = await this.request('GET', next)
      const found = answer.body ? JSON.parse(answer.body) : []
      if (!Array.isArray(found)) return [found]
      items.push(...found)
      next = answer.next
    }
    return items
  }

  async send<T = any>(method: 'POST' | 'PATCH' | 'PUT' | 'DELETE', path: string, body?: unknown): Promise<T> {
    const answer = await this.request(method, path, { body })
    return (answer.body ? JSON.parse(answer.body) : null) as T
  }

  async graphql<T = any>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    const answer = await this.send<any>('POST', 'graphql', { query, variables })
    if (answer?.errors?.length) throw new GithubError(400, `GitHub GraphQL: ${answer.errors.map((e: any) => e.message).join('; ').slice(0, 300)}`)
    return answer
  }

  /** GitHub's own clock, from a request that counts against no quota. */
  async serverTime(): Promise<number | null> {
    const { headers } = await this.request('GET', 'rate_limit')
    const time = Date.parse(headers.get('date') ?? '')
    return Number.isNaN(time) ? null : time
  }
}

/** A request the board's modules make, in the form of `gh api` arguments, so a test can answer it. */
export type GhRequest = (args: string[]) => Promise<string>

/**
 * Reads `gh api` arguments the board's modules use, and answers them through the client: the same
 * calls, conditional, without starting a program for each.
 */
export function askThrough(github: Github): GhRequest {
  return async (args) => {
    if (args[0] !== 'api') throw new Error('Only gh api is supported.')
    let paginate = false
    let headersOnly = false
    let accept: string | undefined
    let method = 'GET'
    const fields: Record<string, unknown> = {}
    let path = ''
    for (let i = 1; i < args.length; i++) {
      const arg = args[i]
      if (arg === '--paginate') paginate = true
      else if (arg === '-i') headersOnly = true
      else if (arg === '-H') {
        const header = args[++i]
        const found = /^accept:\s*(.+)$/i.exec(header)
        if (found) accept = found[1]
      } else if (arg === '-X') method = args[++i]
      else if (arg === '-f' || arg === '-F') {
        const [name, ...rest] = args[++i].split('=')
        const value = rest.join('=')
        fields[name] = arg === '-F' && /^-?\d+$/.test(value) ? Number(value) : value
      } else path = arg
    }
    if (path === 'graphql') {
      const { query, ...variables } = fields
      return JSON.stringify(await github.graphql(String(query), variables))
    }
    if (headersOnly) {
      const { headers } = await github.request('GET', path)
      return [...headers.entries()].map(([name, value]) => `${name}: ${value}`).join('\n')
    }
    if (method === 'GET' && Object.keys(fields).length) path = `${path}${path.includes('?') ? '&' : '?'}${new URLSearchParams(Object.entries(fields).map(([k, v]) => [k, String(v)]))}`
    if (accept && !accept.includes('json')) return github.text(path, accept)
    if (paginate) return JSON.stringify(await github.all(path))
    // As `gh api` gives it: a job's log is text, not JSON.
    if (method === 'GET') return (await github.request('GET', path)).body
    return JSON.stringify(await github.send(method as 'POST', path))
  }
}
