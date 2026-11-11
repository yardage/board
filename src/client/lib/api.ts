import { localize, localizeData } from '../../shared/i18n/i18n.ts'

/** What the server said, with its status, so that a screen can tell a missing thing from a blip. */
export class CallError extends Error {
  status: number
  constructor(message: string, status: number) {
    super(message)
    this.status = status
  }
}

/** The token of this process, which the page got with its HTML: every call carries it. In tests and a plain browser, the mark alone. */
const TOKEN = typeof document !== 'undefined' ? (document.querySelector('meta[name="board-token"]')?.getAttribute('content') ?? '1') : '1'

/** The last answer of each list the server tags, given back when the server says nothing moved. */
const kept = new Map<string, { etag: string; data: unknown }>()
/** One request at a time for a path: a second ask while one runs gets the same answer. */
const inFlight = new Map<string, Promise<unknown>>()

/** A request to this person's own board: a body makes it a POST. */
export function call<T>(path: string, body?: unknown): Promise<T> {
  if (body !== undefined) return request<T>(path, body)
  const running = inFlight.get(path)
  if (running) return running as Promise<T>
  const promise = request<T>(path).finally(() => inFlight.delete(path))
  inFlight.set(path, promise)
  return promise
}

async function request<T>(path: string, body?: unknown): Promise<T> {
  const known = body === undefined ? kept.get(path) : undefined
  const response = await fetch(`/api/${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'x-board': TOKEN, ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(known ? { 'if-none-match': known.etag } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  if (response.status === 304 && known) return known.data as T
  const data = await response.json()
  if (!response.ok) throw new CallError(localize(data.error ?? 'Une erreur est survenue.'), response.status)
  const result = localizeData(data)
  const etag = response.headers.get('etag')
  if (body === undefined && etag) kept.set(path, { etag, data: result })
  return result
}
