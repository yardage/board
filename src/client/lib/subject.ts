import { t } from '../../shared/i18n/i18n.ts'
/** What a thread was opened from: the thing the person was looking at when a question came. */

/** The environment's main repository on GitHub, set when the page starts: what links to items point at. */
export let REPOSITORY_URL = ''
export const setRepository = (url: string) => {
  REPOSITORY_URL = url
}

/** The number in an address of a ticket or a pull request of the main repository. A comment's address opens where it says. */
export function itemOfUrl(url: string): number | null {
  if (!REPOSITORY_URL || !url.startsWith(`${REPOSITORY_URL}/`)) return null
  const found = /^\/(?:pull|issues)\/(\d{1,7})\/?$/.exec(url.slice(REPOSITORY_URL.length))
  return found ? Number(found[1]) : null
}

export interface Subject {
  label: string
  title?: string
  /** What is being asked about it, such as the question an item waits on. */
  detail?: string
  /** In the copy agents read, so that the thread's agent can open it. */
  doc?: string
  url?: string
}

/** A pull request or a ticket: its address says which, and which file of the copy holds it. */
export function subjectOfItem(url: string, number: number, title?: string, detail?: string): Subject {
  const pull = url.includes('/pull/')
  return { label: `${pull ? 'PR' : t('Ticket')} #${number}`, title, detail, doc: `github/${pull ? 'pulls' : 'issues'}/${number}.md`, url: url.split('#')[0] }
}

/** A document. The copy of GitHub's files are items, which have an address too. */
export function subjectOfDoc(path: string, content = ''): Subject {
  const heading = /^#\s+(.+)$/m.exec(content)?.[1] ?? /<title>([^<]+)<\/title>/i.exec(content)?.[1]
  const github = /^github\/(pulls|issues)\/(\d+)\.md$/.exec(path)
  if (github) {
    const number = Number(github[2])
    const title = heading?.replace(/^#\d+\s*/, '')
    return { ...subjectOfItem(`${REPOSITORY_URL}/${github[1] === 'pulls' ? 'pull' : 'issues'}/${number}`, number, title), doc: path }
  }
  return { label: path.split('/').at(-1) ?? path, title: heading?.trim(), doc: path }
}

/** What the thread's first message starts with: only a link, so that nothing from elsewhere reads as the person's own words. */
export const subjectLink = (subject: Subject) => {
  const label = subject.label.replace(/[[\]]/g, '')
  // A space or a parenthesis ends a plain link. A name with an angle bracket can't be written either way.
  if (subject.doc && /[<>]/.test(subject.doc)) return label
  if (subject.doc) return /[\s()]/.test(subject.doc) ? `[${label}](<doc:${subject.doc}>)` : `[${label}](doc:${subject.doc})`
  return subject.url ? `[${label}](${subject.url})` : label
}
