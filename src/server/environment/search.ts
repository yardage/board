/**
 * What "Ctrl+K" searches: threads and their messages, tickets and pull requests, the knowledge documents and the
 * reports. All of it is already on this computer, so a search spends nothing and reaches nothing. It only reads.
 */

export type SearchKind = 'thread' | 'message' | 'item' | 'doc' | 'report'

export interface SearchHit {
  kind: SearchKind
  title: string
  detail: string
  /** A hash in the board, or an address outside it. */
  href: string
}

export interface SearchThread {
  id: string
  title: string
  status: string
  lastAt: string
  messageCount: number
  /** Read only when the thread has changed. */
  messages: () => Promise<{ id: string; who: string; body: string }[]>
}

export interface SearchItem {
  number: number
  kind: 'issue' | 'pull'
  title: string
  closed: string | null
}

export interface SearchReport {
  id: string
  title: string
  text: () => Promise<string>
}

export interface SearchDoc {
  path: string
  name: string
  /** When it last changed, or null when it can't be read. */
  stamp: () => Promise<number | null>
  text: () => Promise<string | null>
}

export interface SearchSources {
  threads: () => Promise<SearchThread[]>
  items: () => Promise<SearchItem[]>
  docs: () => Promise<SearchDoc[]>
  reports: () => Promise<SearchReport[]>
  /** The repository's address, for a ticket's link. */
  repository: () => string
}

export const QUERY_MAX = 200
const WORDS_MAX = 8
const HITS_MAX = 40
/** One word in every path shouldn't push tickets and messages out. */
const NAMED_DOCS_MAX = 15
/** A burst of keystrokes shares one reading of the lists. What is new shows a moment later. */
const SOURCES_FRESH_MS = 4000
const DOCS_MAX = 3000
const DOC_MAX = 512 * 1024
const SNIPPET = 140

/** Case and accents don't count. Each character stays one character, so a place found here is the same in `composed`. */
const composed = (text: string) => text.normalize('NFC')
const fold = (text: string) =>
  [...composed(text)]
    .map((char) => [...char.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()][0] ?? char)
    .join('')

export const wordsOf = (query: string) => fold(query.slice(0, QUERY_MAX)).split(/\s+/).filter(Boolean).slice(0, WORDS_MAX)

const hasAll = (folded: string, words: string[]) => words.every((word) => folded.includes(word))

/** The line around the first word found: long lines would otherwise show nothing of what was looked for. */
export function snippetOf(text: string, folded: string, words: string[]): string {
  const where = Math.min(...words.map((word) => folded.indexOf(word)).filter((at) => at >= 0))
  const chars = [...composed(text)]
  const start = Math.max(0, where - 40)
  const piece = chars.slice(start, start + SNIPPET).join('').replace(/\s+/g, ' ').trim()
  return `${start > 0 ? '…' : ''}${piece}${chars.length > start + SNIPPET ? '…' : ''}`
}

const toThread = (id: string) => `#t/${encodeURIComponent(id)}`
const toDoc = (path: string) => `#d/${encodeURI(path)}`
const number = (text: string) => /^#?(\d{1,7})$/.exec(text.trim())?.[1]

/** The same answer for a while, and one question at a time. A failure isn't kept. */
function fresh<T>(read: () => Promise<T>): () => Promise<T> {
  let kept: { at: number; value: Promise<T> } | null = null
  return () => {
    if (kept && Date.now() - kept.at < SOURCES_FRESH_MS) return kept.value
    const value = read()
    kept = { at: Date.now(), value }
    value.catch(() => {
      kept = null
    })
    return value
  }
}

interface Cached {
  stamp: string
  rows: { hit: SearchHit; text: string; folded: string }[]
}

export class Search {
  private readonly sources: SearchSources
  /** Each is read again only when it changes: a report never does. */
  private readonly threads = new Map<string, Cached>()
  private readonly docs = new Map<string, { stamp: number; text: string; folded: string }>()
  private readonly reports = new Map<string, { text: string; folded: string }>()

  constructor(sources: SearchSources) {
    this.sources = { ...sources, threads: fresh(sources.threads), items: fresh(sources.items), docs: fresh(sources.docs), reports: fresh(sources.reports) }
  }

  private async messagesOf(thread: SearchThread): Promise<Cached['rows']> {
    const stamp = `${thread.lastAt}:${thread.messageCount}`
    const found = this.threads.get(thread.id)
    if (found?.stamp === stamp) return found.rows
    const rows = (await thread.messages()).map((message) => ({
      hit: { kind: 'message' as const, title: thread.title, detail: message.who, href: toThread(thread.id) },
      text: message.body,
      folded: fold(message.body),
    }))
    this.threads.set(thread.id, { stamp, rows })
    return rows
  }

  private async docOf(doc: SearchDoc) {
    const stamp = await doc.stamp()
    if (stamp === null) return null
    const found = this.docs.get(doc.path)
    if (found?.stamp === stamp) return found
    const text = (await doc.text()) ?? ''
    // A page of charts is code, and something enormous isn't a document anyone reads here.
    const usable = !doc.path.endsWith('.html') && text.length <= DOC_MAX ? text : ''
    const entry = { stamp, text: usable, folded: fold(usable) }
    this.docs.set(doc.path, entry)
    return entry
  }

  /** Best first: what is named so, then what mentions it. Threads before documents, since that's the shared work. */
  async find(query: string): Promise<SearchHit[]> {
    const words = wordsOf(query)
    if (!words.length) return []
    const named: SearchHit[] = []
    const items: SearchHit[] = []
    const messages: SearchHit[] = []
    const docs: SearchHit[] = []
    const reports: SearchHit[] = []
    const asked = number(query)

    for (const thread of await this.sources.threads()) {
      if (hasAll(fold(thread.title), words)) named.push({ kind: 'thread', title: thread.title, detail: thread.status === 'closed' ? 'fil clos' : 'fil', href: toThread(thread.id) })
      for (const row of await this.messagesOf(thread)) {
        if (hasAll(row.folded, words)) messages.push({ ...row.hit, detail: `${row.hit.detail} : ${snippetOf(row.text, row.folded, words)}` })
      }
    }

    const toItem = (item: SearchItem): SearchHit => ({
      kind: 'item',
      title: `#${item.number} ${item.title}`,
      detail: `${item.kind === 'pull' ? 'PR' : 'ticket'}${item.closed ? ', fermé' : ''}`,
      href: `${this.sources.repository()}/${item.kind === 'pull' ? 'pull' : 'issues'}/${item.number}`,
    })
    for (const item of await this.sources.items()) {
      if (asked && String(item.number) === asked) named.unshift(toItem(item))
      else if (hasAll(fold(item.title), words)) items.push(toItem(item))
    }

    let namedDocs = 0
    for (const doc of (await this.sources.docs()).slice(0, DOCS_MAX)) {
      // Not its top folder, which every document of a section shares.
      if (hasAll(fold(`${doc.name} ${doc.path.split('/').slice(1).join('/')}`), words)) {
        const hit: SearchHit = { kind: 'doc', title: doc.name, detail: doc.path, href: toDoc(doc.path) }
        if (namedDocs < NAMED_DOCS_MAX) named.push(hit)
        else docs.push(hit)
        namedDocs += 1
        continue
      }
      const read = await this.docOf(doc)
      if (read && hasAll(read.folded, words)) docs.push({ kind: 'doc', title: doc.name, detail: snippetOf(read.text, read.folded, words), href: toDoc(doc.path) })
    }

    for (const report of await this.sources.reports()) {
      const hit = (detail: string): SearchHit => ({ kind: 'report', title: report.title, detail, href: `#rapports/${report.id}` })
      if (hasAll(fold(report.title), words)) {
        named.push(hit('rapport'))
        continue
      }
      let read = this.reports.get(report.id)
      if (!read) {
        const text = await report.text()
        read = { text, folded: fold(text) }
        this.reports.set(report.id, read)
      }
      if (hasAll(read.folded, words)) reports.push(hit(snippetOf(read.text, read.folded, words)))
    }

    return [...named, ...items, ...messages, ...docs, ...reports].slice(0, HITS_MAX)
  }
}
