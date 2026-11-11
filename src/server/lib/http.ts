import type { IncomingMessage, ServerResponse } from 'node:http'
import { looksSecret } from './secrets.ts'
import { MAX_ATTACHMENT_BYTES, parsePoll, type Poll, type Upload, uploadProblem } from '../environment/store.ts'

/** What comes in and goes out under /api/: how a request is read, and how an answer or a refusal is sent. */

export const MESSAGE_MAX = 100_000
/** A poll with a date ends within this. */
const POLL_LONGEST_MS = 366 * 24 * 3_600_000

export class HttpError extends Error {
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

/** A passage of speech, in memory, where it stays. */
export const readBytes = (req: IncomingMessage, max: number) =>
  new Promise<Buffer>((done, fail) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      // Read to its end and thrown away, so that the page gets the answer.
      if (size > max) {
        chunks.length = 0
        fail(new HttpError(413, 'Passage trop long.'))
      } else chunks.push(chunk)
    })
    req.on('end', () => done(Buffer.concat(chunks)))
    req.on('error', fail)
  })

export const readJson = (req: IncomingMessage, max: number) =>
  new Promise<any>((done, fail) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > max) {
        fail(new HttpError(413, 'Message ou fichiers trop lourds.'))
        req.destroy()
      } else chunks.push(chunk)
    })
    req.on('end', () => {
      try {
        const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
        // A list or a word where an object is read would break on its first field.
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object')
        done(parsed)
      } catch {
        fail(new HttpError(400, 'JSON invalide.'))
      }
    })
    req.on('error', fail)
  })

/** Base64 takes a third more room than the files it carries. */
export const WITH_FILES_MAX = Math.ceil((MAX_ATTACHMENT_BYTES * 4) / 3) + 2 * MESSAGE_MAX

export function send(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })
  res.end(JSON.stringify(data))
}

export const text = (value: unknown, name: string, max: number): string => {
  if (typeof value !== 'string' || !value.trim()) throw new HttpError(400, `${name} manquant.`)
  if (value.length > max) throw new HttpError(400, `${name} trop long.`)
  return value.trim()
}

export function readUploads(input: any): Upload[] {
  const list = Array.isArray(input.attachments) ? input.attachments : []
  const uploads: Upload[] = list.map((item: any) => ({
    name: text(item?.name, 'Nom de fichier', 300),
    type: typeof item?.type === 'string' ? item.type.slice(0, 100) : '',
    data: Buffer.from(typeof item?.data === 'string' ? item.data : '', 'base64'),
  }))
  const problem = uploadProblem(uploads)
  if (problem) throw new HttpError(400, problem)
  return uploads
}

/** A message needs words, files or a poll. What is written stays in the history for good, so it can't look like a secret. */
/** A poll as a member just wrote it: its date, if any, is ahead, and within a year. */
export function readPoll(input: any): Poll | null {
  if (input.poll === undefined) return null
  const poll = parsePoll(input.poll)
  if (!poll) throw new HttpError(400, 'Un sondage a une question et de 2 à 12 choix différents.')
  if (looksSecret(poll.question) || poll.options.some(looksSecret)) throw new HttpError(400, 'Ce sondage ressemble à un secret.')
  if (input.poll.closesAt !== undefined && !poll.closesAt) throw new HttpError(400, 'La date de fin du sondage est invalide.')
  if (poll.closesAt) {
    const closes = Date.parse(poll.closesAt)
    if (closes <= Date.now()) throw new HttpError(400, 'La date de fin du sondage est déjà passée.')
    if (closes > Date.now() + POLL_LONGEST_MS) throw new HttpError(400, 'Un sondage dure au plus un an.')
  }
  return poll
}

export function readBody(input: any, uploads: Upload[], poll: unknown): string {
  const body = (uploads.length || poll) && !String(input.body ?? '').trim() ? '' : text(input.body, 'Message', MESSAGE_MAX)
  if (looksSecret(body)) throw new HttpError(400, 'Ce message ressemble à un secret : il resterait à vie dans l’historique. Retirez-le, ou partagez-le autrement.')
  return body
}
