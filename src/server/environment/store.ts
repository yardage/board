import { randomBytes } from 'node:crypto'
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { LOGIN } from './config.ts'
import { looksSecret, READ_AS_TEXT } from '../lib/secrets.ts'
import { parseSynthesis, type Synthesis } from '../ai/synthesis.ts'
import type { ToolAction } from '../ai/tools.ts'

/**
 * Threads are folders, messages are files, and nothing is ever edited: two people writing at the
 * same moment add two files, so Git never has a conflict to solve.
 *
 * There are only members, named by their GitHub login. A member's agent writes in their name, and
 * its messages say so (`agent: auto`, or `agent: draft` for one the member read and sent).
 */

export type Login = string
export type AgentMark = 'auto' | 'draft'

/** The repositories of the environment: a thread can only be about one of their items. Set from the configuration. */
let subjectRepos: string[] = []
export const setSubjectRepos = (repos: string[]) => {
  subjectRepos = repos.map((repo) => repo.toLowerCase())
}

/** Names from before environments, and who they were: set from the configuration. */
let aliases: Record<string, { login: string; agent: boolean }> = {}
export const setAliases = (found: Record<string, { login: string; agent: boolean }>) => {
  aliases = found
}

/** The login a name in a file stands for, and whether an agent wrote under it. Null for anything else. */
export function resolveAuthor(name: string): { login: string; agent: boolean } | null {
  const alias = aliases[name.toLowerCase()]
  if (alias) return alias
  return LOGIN.test(name) ? { login: name, agent: false } : null
}

export const sameLogin = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()

export interface Thread {
  id: string
  title: string
  kind: 'question' | 'topic'
  createdAt: string
  createdBy: Login
  /** What the thread was opened from. */
  subject?: Subject
}

/** What a thread is about: a pull request, a ticket, a document, a screen. */
export interface Subject {
  label: string
  title?: string
  detail?: string
  /** In the copy agents read. */
  doc?: string
  url?: string
}

/** A pull request or an issue on GitHub, and nothing that a browser would resolve elsewhere. */
const SUBJECT_URL = /^https:\/\/github\.com\/[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}\/(?:pull|issues)\/\d{1,9}$/
/** Control characters, and what can hide text from a person but not from a model. */
const HIDDEN = /[\u0000-\u001f\u007f-\u009f\u00ad\u034f\u061c\u180e\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff\ufff9-\ufffb\u{e0000}-\u{e007f}]/u
const HIDDEN_RUNS = new RegExp(`${HIDDEN.source}+`, 'gu')
export const oneLine = (value: unknown, max: number) => (typeof value === 'string' ? value.replace(HIDDEN_RUNS, ' ').trim().slice(0, max) : '')
/** Whether a text says anything once what doesn't show is gone. */
export const showsSomething = (text: string) => text.replace(HIDDEN_RUNS, '').replace(/[\s⠀ㅤ︀-️]/g, '') !== ''

/** From a file anyone could have pushed, and it ends up in a link and in an agent's prompt. What isn't plain is dropped. */
export function parseSubject(raw: any): Subject | null {
  if (typeof raw !== 'object' || raw === null) return null
  const label = oneLine(raw.label, 200)
  if (!label) return null
  const title = oneLine(raw.title, 200)
  const detail = oneLine(raw.detail, 600)
  // A file name, which an agent is told to read: it reaches the prompt as more than information.
  const doc = typeof raw.doc === 'string' && raw.doc.length <= 300 && /\.\w{1,5}$/.test(raw.doc) && !HIDDEN.test(raw.doc) && !/[\\:]|^\/|(^|\/)\.\.(\/|$)/.test(raw.doc) ? raw.doc : ''
  const repo = typeof raw.url === 'string' ? /^https:\/\/github\.com\/([^/]+\/[^/]+)\//.exec(raw.url)?.[1]?.toLowerCase() : undefined
  const url = typeof raw.url === 'string' && SUBJECT_URL.test(raw.url) && repo && subjectRepos.includes(repo) ? raw.url : ''
  return { label, ...(title ? { title } : {}), ...(detail ? { detail } : {}), ...(doc ? { doc } : {}), ...(url ? { url } : {}) }
}

/** A file attached to a message, stored next to it in `attachments/`. */
export interface Attachment {
  name: string
  file: string
  size: number
  type: string
}

export interface Upload {
  name: string
  type: string
  data: Buffer
}

export const MAX_ATTACHMENTS = 10
/** Every member's clone keeps every file for good: the history only grows. */
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024

/** Programs, and the usual files of secrets: Git history is shared and permanent. */
const REFUSED_FILE =
  /(\.(exe|msi|bat|cmd|com|scr|ps1|vbs|dll|sh|pem|key|p12|pfx|kdbx|ppk|jks|keystore|tfstate)|^\.env(\..*)?|^id_(rsa|ed25519|ecdsa|dsa)|^\.npmrc|^\.netrc|^\.pgpass|^credentials(\.json)?|^secrets?\.(json|ya?ml))$/i

/** Why this upload can't go in the board, or null when it can. */
export function uploadProblem(uploads: Upload[]): string | null {
  if (uploads.length > MAX_ATTACHMENTS) return `Pas plus de ${MAX_ATTACHMENTS} fichiers par message.`
  const total = uploads.reduce((sum, upload) => sum + upload.data.length, 0)
  if (total > MAX_ATTACHMENT_BYTES) return 'Pas plus de 10 Mo de fichiers par message : ils restent pour toujours dans l’historique du fil.'
  const refused = uploads.find((upload) => REFUSED_FILE.test(upload.name))
  if (refused) return `« ${refused.name} » est refusé : ni programme ni fichier de secrets.`
  const secret = uploads.find((upload) => READ_AS_TEXT.test(upload.name) && looksSecret(upload.data.toString('utf8')))
  if (secret) return `« ${secret.name} » semble contenir un secret : il resterait à vie dans l'historique.`
  return uploads.find((upload) => !upload.data.length) ? 'Un des fichiers est vide.' : null
}

/** A name that is safe on every system, and can't leave the folder. */
export function safeFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? ''
  const clean = base
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/[^\w.-]+/g, '-')
    .replace(/^[.-]+|[.-]+$/g, '')
  return (clean.length > 80 ? `${clean.slice(0, 60)}${clean.slice(clean.lastIndexOf('.')).slice(0, 20)}` : clean) || 'fichier'
}

export const ATTACHMENT_FILE = /^\w[\w.-]*$/

/**
 * A question with choices. Votes are files, the latest of each member counts. A poll closes by itself at
 * `closesAt`, or when its author or an admin closes it (`polls/`), or with its thread.
 */
export interface Poll {
  question: string
  options: string[]
  multiple: boolean
  /** An ISO date, after which nobody votes. */
  closesAt?: string
}

export const POLL_OPTIONS_MAX = 12
const ISO_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/

export function parsePoll(raw: any): Poll | null {
  if (typeof raw !== 'object' || raw === null) return null
  const question = oneLine(raw.question, 300)
  const options = (Array.isArray(raw.options) ? raw.options : []).map((option: unknown) => oneLine(option, 120)).filter((option: string) => showsSomething(option))
  if (!showsSomething(question) || options.length < 2 || options.length > POLL_OPTIONS_MAX || new Set(options).size !== options.length) return null
  const closesAt = typeof raw.closesAt === 'string' && ISO_DATE.test(raw.closesAt) && !Number.isNaN(Date.parse(raw.closesAt)) ? new Date(raw.closesAt).toISOString() : undefined
  return { question, options, multiple: raw.multiple === true, ...(closesAt ? { closesAt } : {}) }
}

/** Whether a poll is closed by its author or an admin: the latest word wins. */
export interface PollState {
  poll: string
  closed: boolean
  at: number
  by: Login
}

/** What a poll looks like from outside its thread. */
export interface PollSummary {
  threadId: string
  threadTitle: string
  threadStatus: 'open' | 'closed'
  messageId: string
  author: Login
  createdAt: string
  poll: Poll
  votes: Vote[]
  /** Set when the author or an admin closed it. */
  closed: { at: string; by: Login } | null
}

/** Whether a vote can still be cast: the thread is open, nobody closed the poll, and its date hasn't passed. */
export const pollOpen = (summary: Pick<PollSummary, 'threadStatus' | 'poll' | 'closed'>, now = Date.now()) =>
  summary.threadStatus === 'open' && !summary.closed && !(summary.poll.closesAt && Date.parse(summary.poll.closesAt) <= now)

export interface Message {
  id: string
  threadId: string
  /** A GitHub login. */
  author: Login
  /** Written by the author's agent: by itself, or as a draft the author read and sent. */
  agent?: AgentMark
  createdAt: string
  /** Logins, lower case. */
  mentions: string[]
  /** What an agent read to write this message, as knowledge paths. */
  sources: string[]
  /** On an agent's reply: the last message it had read. A mention after that one is still owed an answer. */
  seen?: string
  /** Set on a message that opens or closes the thread. */
  status?: 'open' | 'closed'
  attachments: Attachment[]
  body: string
  /** Transcribed from its author's voice, and read by them before it was published. */
  voice?: boolean
  /** When that listening started: the marks in the text count from here. */
  spokenAt?: string
  /** The summary of what members published out loud. */
  voiceSummary?: boolean
  /** The spoken messages that summary read: one published while it ran is still to be read. */
  covers?: string[]
  /** Set on a message that is a synthesis of its thread. */
  synthesis?: Synthesis
  /** What the agent did on GitHub while writing this. */
  actions?: ToolAction[]
  poll?: Poll
}

export interface ThreadSummary extends Thread {
  status: 'open' | 'closed'
  messageCount: number
  lastAt: string
  lastAuthor: Login
  lastAgent: AgentMark | null
  /** Who the last message names, for a notification about a mention. */
  lastMentions: Login[]
  /** The last message carries a poll. */
  lastPoll: boolean
  /** Polls of this thread still taking votes, and who voted in each: the sidebar counts those without this member's. */
  openPolls: { id: string; voters: Login[] }[]
  preview: string
}

/** Mentions written in a body: `@login`. Names from before environments count as who they were. */
export function parseMentions(body: string): string[] {
  const found = new Set<string>()
  for (const match of body.matchAll(/(?<![\w@.-])@([A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38})(?![\w-])/g)) {
    const name = match[1].toLowerCase()
    if (name === 'agents') {
      for (const alias of Object.values(aliases)) if (alias.agent) found.add(alias.login.toLowerCase())
      continue
    }
    found.add((aliases[name]?.login ?? name).toLowerCase())
  }
  return [...found]
}

export function formatMessage(message: Omit<Message, 'id' | 'threadId'>): string {
  const head = [`author: ${message.author}`, `createdAt: ${message.createdAt}`]
  if (message.agent) head.push(`agent: ${message.agent}`)
  if (message.mentions.length) head.push(`mentions: ${message.mentions.join(',')}`)
  if (message.sources.length) head.push(`sources: ${JSON.stringify(message.sources)}`)
  if (message.seen) head.push(`seen: ${message.seen}`)
  if (message.status) head.push(`status: ${message.status}`)
  if (message.attachments.length) head.push(`attachments: ${JSON.stringify(message.attachments)}`)
  if (message.voice) head.push('voice: true')
  if (message.spokenAt) head.push(`spokenAt: ${message.spokenAt}`)
  if (message.voiceSummary) head.push('voiceSummary: true')
  if (message.covers?.length) head.push(`covers: ${JSON.stringify(message.covers)}`)
  if (message.synthesis) head.push(`synthesis: ${JSON.stringify(message.synthesis)}`)
  if (message.actions?.length) head.push(`actions: ${JSON.stringify(message.actions)}`)
  if (message.poll) head.push(`poll: ${JSON.stringify(message.poll)}`)
  return `---\n${head.join('\n')}\n---\n${message.body.trim()}\n`
}

const jsonList = (text: string | undefined): unknown[] => {
  try {
    const parsed = JSON.parse(text ?? '[]')
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

/** Only links to GitHub, and only what the screen shows. */
function parseActions(text: string | undefined): ToolAction[] {
  return jsonList(text)
    .filter((a: any) => typeof a?.repo === 'string' && Number.isInteger(a?.number) && typeof a?.url === 'string' && /^https:\/\/github\.com\//.test(a.url))
    .slice(0, 20)
    .map((a: any) => ({ tool: oneLine(a.tool, 40), repo: oneLine(a.repo, 140), number: a.number, url: a.url.slice(0, 300), what: oneLine(a.what, 80) }))
}

/** Reads a message file. Returns null for a file that isn't one, so a stray file can't break a thread. */
export function parseMessage(threadId: string, id: string, text: string): Message | null {
  const match = text.replace(/\r\n/g, '\n').match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/)
  if (!match) return null
  const fields = new Map<string, string>()
  for (const line of match[1].split('\n')) {
    const at = line.indexOf(': ')
    if (at > 0) fields.set(line.slice(0, at), line.slice(at + 2))
  }
  const author = resolveAuthor(fields.get('author') ?? '')
  const createdAt = fields.get('createdAt') ?? ''
  if (!author || !createdAt) return null
  const sources = jsonList(fields.get('sources')).filter((s): s is string => typeof s === 'string')
  const attachments = jsonList(fields.get('attachments'))
    .filter((a: any) => typeof a?.name === 'string' && typeof a?.file === 'string' && ATTACHMENT_FILE.test(a.file))
    .map((a: any) => ({ name: a.name, file: a.file, size: Number(a.size) || 0, type: String(a.type ?? '') }))
  let synthesis: Synthesis | undefined
  try {
    if (fields.has('synthesis')) synthesis = parseSynthesis(JSON.parse(fields.get('synthesis') ?? ''))
  } catch {
    // A bad synthesis stays a message that reads as text.
  }
  let poll: Poll | null = null
  try {
    if (fields.has('poll')) poll = parsePoll(JSON.parse(fields.get('poll') ?? ''))
  } catch {
    // A bad poll stays a message that reads as text.
  }
  const status = fields.get('status')
  const marked = fields.get('agent')
  const agent: AgentMark | undefined = marked === 'auto' || marked === 'draft' ? marked : author.agent ? 'auto' : undefined
  // From a file anyone could have pushed, and it reaches a line of an agent's prompt that only the app writes.
  const spokenAt = fields.get('spokenAt')
  const spokenAtIsDate = spokenAt !== undefined && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/.test(spokenAt) && !Number.isNaN(Date.parse(spokenAt))
  // Only an agent writes a summary: on a person's message, the mark would hide its mentions.
  const voiceSummary = fields.get('voiceSummary') === 'true' && agent !== undefined
  const covers = voiceSummary ? jsonList(fields.get('covers')).filter((c): c is string => typeof c === 'string') : []
  const actions = agent ? parseActions(fields.get('actions')) : []
  return {
    id,
    threadId,
    author: author.login,
    ...(agent ? { agent } : {}),
    createdAt,
    mentions: (fields.get('mentions') ?? '')
      .split(',')
      .map((name) => resolveAuthor(name.trim())?.login.toLowerCase() ?? '')
      .filter(Boolean),
    sources,
    seen: fields.get('seen') || undefined,
    status: status === 'open' || status === 'closed' ? status : undefined,
    attachments,
    body: match[2].trim(),
    ...(fields.get('voice') === 'true' ? { voice: true } : {}),
    ...(spokenAtIsDate ? { spokenAt } : {}),
    ...(voiceSummary ? { voiceSummary: true } : {}),
    ...(covers.length ? { covers } : {}),
    ...(synthesis ? { synthesis } : {}),
    ...(actions.length ? { actions } : {}),
    ...(poll ? { poll } : {}),
  }
}

/**
 * The question a member owes an answer to: the last message from another member, written by that
 * member themselves, that mentions them after their last word in the thread. An agent's message
 * never asks anything of anyone: agents don't wake each other, so no two of them can talk in a loop,
 * and nobody can drive someone else's agent through their own.
 */
export function owedMention(messages: Message[], me: Login): Message | null {
  if (statusOf(messages) === 'closed') return null
  let answered = -1
  let mention: Message | null = null
  let mentionAt = -1
  for (const [index, message] of messages.entries()) {
    if (sameLogin(message.author, me)) {
      // What it had read, not where its reply landed: a reply takes minutes to write.
      const seen = message.agent && message.seen ? messages.findIndex((candidate) => candidate.id === message.seen) : -1
      answered = Math.max(answered, seen >= 0 ? seen : index)
    } else if (!message.agent && message.mentions.includes(me.toLowerCase())) {
      mention = message
      mentionAt = index
    }
  }
  return mentionAt > answered ? mention : null
}

export const statusOf = (messages: Message[]): 'open' | 'closed' => messages.findLast((message) => message.status)?.status ?? 'open'

const slug = (title: string) =>
  title
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 48)

/** A file a member added under a thread: `<time>-<login>-<hex>.json`. */
const ADDED_FILE = /^(\d{1,15})-([A-Za-z0-9-]{1,40})-([0-9a-f]{4})\.json$/

export interface Vote {
  poll: string
  author: Login
  choices: number[]
  at: number
}

export class Store {
  readonly root: string
  /** What each thread's files said, keyed by the names of its message files: a message never changes, so a new name is the only news. */
  private readonly parsed = new Map<string, { key: string; thread: Thread; messages: Message[] }>()
  /** The list of every thread, kept until something is written or pulled: the screens ask for it at every refresh. */
  private summaries: { at: number; list: ThreadSummary[] } | null = null
  private polls: { at: number; list: PollSummary[] } | null = null
  /** Counts up at every change, so that a screen can be told nothing moved. */
  version = 1

  /** Something changed on disk, by a write here or a pull: the lists are read again next time. */
  changed(): void {
    this.summaries = null
    this.polls = null
    this.version += 1
  }

  constructor(boardRoot: string) {
    this.root = join(boardRoot, 'threads')
  }

  /** Forgets what was read: after a pull that rewrote files by hand, or in a test. */
  forget(threadId?: string): void {
    if (threadId) this.parsed.delete(threadId)
    else this.parsed.clear()
    this.changed()
  }

  async createThread(input: { title: string; kind: Thread['kind']; author: Login; subject?: Subject }): Promise<Thread> {
    const now = new Date()
    const id = `${now.toISOString().slice(0, 10)}-${slug(input.title) || 'fil'}-${randomBytes(2).toString('hex')}`
    const thread: Thread = {
      id,
      title: input.title.trim(),
      kind: input.kind,
      createdAt: now.toISOString(),
      createdBy: input.author,
      ...(input.subject ? { subject: input.subject } : {}),
    }
    await mkdir(join(this.root, id), { recursive: true })
    await writeFile(join(this.root, id, 'thread.json'), `${JSON.stringify(thread, null, 2)}\n`)
    this.changed()
    return thread
  }

  /** Writes a message and returns its path relative to the board's root. */
  async addMessage(
    threadId: string,
    input: {
      author: Login
      agent?: AgentMark
      body: string
      sources?: string[]
      seen?: string
      status?: Message['status']
      uploads?: Upload[]
      synthesis?: Synthesis
      voice?: boolean
      spokenAt?: string
      voiceSummary?: boolean
      covers?: string[]
      actions?: ToolAction[]
      poll?: Poll
    },
  ): Promise<{ message: Message; path: string; paths: string[] }> {
    assertThreadId(threadId)
    if (!LOGIN.test(input.author)) throw new Error('invalid author')
    const now = new Date()
    const id = `${String(now.getTime())}-${input.author}-${randomBytes(2).toString('hex')}`
    const uploads = input.uploads ?? []
    const paths: string[] = []
    const attachments: Attachment[] = []
    if (uploads.length) await mkdir(join(this.root, threadId, 'attachments'), { recursive: true })
    for (const [index, upload] of uploads.entries()) {
      const file = `${id}-${index}-${safeFileName(upload.name)}`
      await writeFile(join(this.root, threadId, 'attachments', file), upload.data)
      attachments.push({ name: upload.name, file, size: upload.data.length, type: upload.type })
      paths.push(`threads/${threadId}/attachments/${file}`)
    }
    const message: Message = {
      id,
      threadId,
      author: input.author,
      ...(input.agent ? { agent: input.agent } : {}),
      createdAt: now.toISOString(),
      mentions: parseMentions(input.body).filter((login) => !sameLogin(login, input.author)),
      sources: input.sources ?? [],
      seen: input.seen,
      status: input.status,
      attachments,
      body: input.body,
      ...(input.voice ? { voice: true } : {}),
      ...(input.spokenAt ? { spokenAt: input.spokenAt } : {}),
      ...(input.voiceSummary ? { voiceSummary: true } : {}),
      ...(input.covers?.length ? { covers: input.covers } : {}),
      ...(input.synthesis ? { synthesis: input.synthesis } : {}),
      ...(input.actions?.length ? { actions: input.actions } : {}),
      ...(input.poll ? { poll: input.poll } : {}),
    }
    await writeFile(join(this.root, threadId, `${id}.md`), formatMessage(message))
    this.changed()
    const path = `threads/${threadId}/${id}.md`
    return { message, path, paths: [path, ...paths] }
  }

  private async addFile(threadId: string, folder: string, author: Login, content: unknown, at = Date.now()): Promise<string> {
    assertThreadId(threadId)
    if (!LOGIN.test(author)) throw new Error('invalid author')
    await mkdir(join(this.root, threadId, folder), { recursive: true })
    const name = `${at}-${author}-${randomBytes(2).toString('hex')}.json`
    await writeFile(join(this.root, threadId, folder, name), `${JSON.stringify(content, null, 2)}\n`)
    this.changed()
    return `threads/${threadId}/${folder}/${name}`
  }

  /** The files of a folder under a thread, oldest first, each with who added it and when. Names from the future are left out. */
  private async readAdded(threadId: string, folder: string): Promise<{ at: number; author: Login; raw: any }[]> {
    assertThreadId(threadId)
    const dir = join(this.root, threadId, folder)
    const latest = Date.now() + CLOCK_MARGIN_MS
    const found: { at: number; author: Login; raw: any }[] = []
    for (const name of (await readdir(dir).catch(() => [] as string[])).sort(byTime)) {
      const match = ADDED_FILE.exec(name)
      const at = Number(match?.[1])
      const author = match ? resolveAuthor(match[2]) : null
      if (!match || !author || author.agent || at > latest) continue
      try {
        const raw = JSON.parse(await readFile(join(dir, name), 'utf8'))
        // The file's name says who, and what it says must agree.
        if (typeof raw?.author === 'string' && resolveAuthor(raw.author)?.login === author.login) found.push({ at, author: author.login, raw })
      } catch {
        // A broken file counts for nothing.
      }
    }
    return found
  }

  /** A new title is an added file. The thread's messages don't change. `at` is when this title was decided. */
  addTitle(threadId: string, title: string, author: Login, at = Date.now()): Promise<string> {
    return this.addFile(threadId, TITLES, author, { title, author, createdAt: new Date(at).toISOString() }, at)
  }

  /** The last title someone gave a thread, or null. */
  async latestTitle(threadId: string): Promise<string | null> {
    const titles = await this.readAdded(threadId, TITLES)
    for (const entry of titles.reverse()) {
      const title = oneLine(entry.raw.title, 200)
      if (showsSomething(title)) return title
    }
    return null
  }

  /** A member's vote. Only a member votes, never an agent: the route that calls this is a click. */
  addVote(threadId: string, poll: string, choices: number[], author: Login): Promise<string> {
    return this.addFile(threadId, VOTES, author, { poll, choices, author, createdAt: new Date().toISOString() })
  }

  /** The latest vote of each member on each poll of a thread. */
  async votes(threadId: string): Promise<Vote[]> {
    const latest = new Map<string, Vote>()
    for (const entry of await this.readAdded(threadId, VOTES)) {
      const poll = typeof entry.raw.poll === 'string' ? entry.raw.poll : ''
      const choices = Array.isArray(entry.raw.choices) ? [...new Set(entry.raw.choices.filter((c: unknown) => Number.isInteger(c) && (c as number) >= 0 && (c as number) < POLL_OPTIONS_MAX))] as number[] : []
      if (!poll) continue
      latest.set(`${poll} ${entry.author.toLowerCase()}`, { poll, author: entry.author, choices, at: entry.at })
    }
    return [...latest.values()]
  }

  /** Closes or reopens a poll. The route that calls this checks that the author or an admin clicked. */
  setPollClosed(threadId: string, poll: string, closed: boolean, author: Login): Promise<string> {
    return this.addFile(threadId, POLLS, author, { poll, closed, author, createdAt: new Date().toISOString() })
  }

  /** The latest word on each poll of a thread: closed or open again. */
  async pollStates(threadId: string): Promise<Map<string, PollState>> {
    const latest = new Map<string, PollState>()
    for (const entry of await this.readAdded(threadId, POLLS)) {
      const poll = typeof entry.raw.poll === 'string' ? entry.raw.poll : ''
      if (!poll || typeof entry.raw.closed !== 'boolean') continue
      latest.set(poll, { poll, closed: entry.raw.closed, at: entry.at, by: entry.author })
    }
    return latest
  }

  /** Every poll of the board, latest first, with its votes and whether it is closed. Kept until something changes. */
  async listPolls(): Promise<PollSummary[]> {
    if (this.polls && Date.now() - this.polls.at < LIST_KEPT_MS) return this.polls.list
    const list = await this.readPolls()
    this.polls = { at: Date.now(), list }
    return list
  }

  private async readPolls(): Promise<PollSummary[]> {
    const found: PollSummary[] = []
    for (const id of await this.threadIds()) {
      const thread = await this.readThread(id)
      if (!thread) continue
      const withPolls = thread.messages.filter((message) => message.poll)
      if (!withPolls.length) continue
      const [votes, states] = await Promise.all([this.votes(id), this.pollStates(id)])
      const threadStatus = statusOf(thread.messages)
      for (const message of withPolls) {
        const state = states.get(message.id)
        found.push({
          threadId: id,
          threadTitle: thread.thread.title,
          threadStatus,
          messageId: message.id,
          author: message.author,
          createdAt: message.createdAt,
          poll: message.poll!,
          votes: votes.filter((vote) => vote.poll === message.id),
          closed: state?.closed ? { at: new Date(state.at).toISOString(), by: state.by } : null,
        })
      }
    }
    return found.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  }

  private async threadIds(): Promise<string[]> {
    try {
      return (await readdir(this.root, { withFileTypes: true })).filter((d) => d.isDirectory() && THREAD_ID.test(d.name)).map((d) => d.name)
    } catch {
      return []
    }
  }

  async readThread(threadId: string): Promise<{ thread: Thread; messages: Message[] } | null> {
    assertThreadId(threadId)
    const dir = join(this.root, threadId)
    let listed: string[]
    try {
      listed = await readdir(dir)
    } catch {
      return null
    }
    if (!listed.includes('thread.json')) return null
    // A message named in the future would stay last whatever is written after it.
    const latest = Date.now() + CLOCK_MARGIN_MS
    const names = listed.filter((name) => name.endsWith('.md') && !(Number.parseInt(name, 10) > latest)).sort(byTime)
    // The thread's own file is written once, but a hand could rewrite it: its size and time are part of the key.
    const meta = await stat(join(dir, 'thread.json')).catch(() => null)
    const key = `${meta?.mtimeMs ?? 0}:${meta?.size ?? 0}|${names.join('\n')}`
    let known = this.parsed.get(threadId)
    if (!known || known.key !== key) {
      let thread: Thread | null
      try {
        thread = parseThread(threadId, await readFile(join(dir, 'thread.json'), 'utf8'))
      } catch {
        return null
      }
      if (!thread) return null
      const messages: Message[] = []
      let complete = true
      for (const name of names) {
        // What was already parsed stays: only a new file is read.
        const seen = known?.messages.find((message) => message.id === name.slice(0, -3))
        if (seen) {
          messages.push(seen)
          continue
        }
        const text = await readFile(join(dir, name), 'utf8').catch(() => null)
        const message = text === null ? null : parseMessage(threadId, name.slice(0, -3), text)
        if (message) messages.push(message)
        // A file half written by a pull under way, or unreadable for a moment: read again next time rather than dropped.
        else if (text === null || !text.trim()) complete = false
      }
      known = { key, thread, messages }
      if (complete) this.parsed.set(threadId, known)
      else this.parsed.delete(threadId)
    }
    const thread = { ...known.thread }
    thread.title = (await this.latestTitle(threadId)) ?? thread.title
    return { thread, messages: [...known.messages] }
  }

  async listThreads(): Promise<ThreadSummary[]> {
    if (this.summaries && Date.now() - this.summaries.at < LIST_KEPT_MS) return this.summaries.list
    const list = await this.readSummaries()
    this.summaries = { at: Date.now(), list }
    return list
  }

  private async readSummaries(): Promise<ThreadSummary[]> {
    const summaries: ThreadSummary[] = []
    for (const id of await this.threadIds()) {
      const found = await this.readThread(id)
      if (!found) continue
      const last = found.messages.at(-1)
      const status = statusOf(found.messages)
      const withPolls = found.messages.filter((message) => message.poll)
      let openPolls: { id: string; voters: Login[] }[] = []
      if (withPolls.length && status === 'open') {
        const [votes, states] = await Promise.all([this.votes(id), this.pollStates(id)])
        openPolls = withPolls
          .filter((message) => pollOpen({ threadStatus: status, poll: message.poll!, closed: states.get(message.id)?.closed ? { at: '', by: '' } : null }))
          .map((message) => ({ id: message.id, voters: votes.filter((vote) => vote.poll === message.id && vote.choices.length).map((vote) => vote.author) }))
      }
      summaries.push({
        ...found.thread,
        status,
        messageCount: found.messages.length,
        openPolls,
        lastAt: last?.createdAt ?? found.thread.createdAt,
        lastAuthor: last?.author ?? found.thread.createdBy,
        lastAgent: last?.agent ?? null,
        lastMentions: last?.mentions ?? [],
        lastPoll: Boolean(last?.poll),
        // A link reads as its words, as it does in the thread.
        preview: (last?.poll?.question || last?.body || last?.attachments.map((a) => a.name).join(', ') || '').replace(/\[([^\]]*)\]\(<?(?:doc:|https?:)[^)]*\)/g, '$1').replace(/\s+/g, ' ').slice(0, 120),
      })
    }
    return summaries.sort((a, b) => b.lastAt.localeCompare(a.lastAt))
  }
}

/** Oldest first, by the time at the start of the name, compared as a number. */
function byTime(a: string, b: string): number {
  return Number.parseInt(a, 10) - Number.parseInt(b, 10) || a.localeCompare(b)
}

const THREAD_ID = /^[a-z0-9][a-z0-9-]*$/

export function assertThreadId(id: string): void {
  if (!THREAD_ID.test(id)) throw new Error('invalid thread id')
}

const TITLES = 'titles'
const VOTES = 'votes'
const POLLS = 'polls'
/** A list is read again at least this often, in case a file was written by a hand the store didn't see. */
const LIST_KEPT_MS = 60_000
/** A name from the future, pushed by a broken clock or on purpose, would stay the latest whatever is added after it. */
const CLOCK_MARGIN_MS = 24 * 60 * 60 * 1000

export function parseThread(id: string, text: string): Thread | null {
  let raw: any
  try {
    raw = JSON.parse(text)
  } catch {
    return null
  }
  const createdBy = resolveAuthor(String(raw?.createdBy ?? ''))
  if (typeof raw?.title !== 'string' || typeof raw?.createdAt !== 'string' || !createdBy) return null
  const subject = parseSubject(raw.subject)
  return { id, title: raw.title, kind: raw.kind === 'question' ? 'question' : 'topic', createdAt: raw.createdAt, createdBy: createdBy.login, ...(subject ? { subject } : {}) }
}
