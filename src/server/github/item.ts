import type { History, HistoryRun } from './copy.ts'

/**
 * What the side panel shows about a ticket or a pull request: GitHub's word on it, and what the ledger already knows.
 * It only reads. Its text was written by anyone: it reaches the screen through the same Markdown as a thread's.
 */

export type ItemState = 'open' | 'draft' | 'closed' | 'merged'

export interface ItemView {
  number: number
  kind: 'issue' | 'pull'
  title: string
  state: ItemState
  author: string
  labels: string[]
  milestone: string | null
  body: string
  url: string
  created: string
  closed: string | null
  merged: string | null
  /** The commit's CI and the review, on an open pull request the ledger has read. */
  ci: string | null
  review: string | null
  /** The latest runs on this pull request. */
  runs: Pick<HistoryRun, 'id' | 'state' | 'start' | 'end' | 'branch'>[]
  /** GitHub couldn't be asked: what shows is the ledger's, with no text. */
  unread: string | null
  /** A pull request's head commit, which a review is made at, and whose review GitHub asks. */
  head: string | null
  reviewers: string[]
}

const BODY_MAX = 40_000
const RUNS_SHOWN = 5

const text = (value: unknown) => (typeof value === 'string' ? value : '')

export interface GithubItem {
  issue: any
  /** Only for a pull request. */
  pull: any | null
}

export function itemFromGithub(number: number, { issue, pull }: GithubItem): Omit<ItemView, 'ci' | 'review' | 'runs' | 'unread'> {
  const merged = pull?.merged_at ?? null
  const closed = issue.closed_at ?? null
  return {
    head: typeof pull?.head?.sha === 'string' ? pull.head.sha : null,
    reviewers: Array.isArray(pull?.requested_reviewers) ? pull.requested_reviewers.map((user: any) => text(user?.login)).filter(Boolean) : [],
    number,
    kind: pull ? 'pull' : 'issue',
    title: text(issue.title),
    state: merged ? 'merged' : closed ? 'closed' : pull?.draft ? 'draft' : 'open',
    author: text(issue.user?.login),
    labels: Array.isArray(issue.labels) ? issue.labels.map((label: any) => text(label?.name)).filter(Boolean) : [],
    milestone: text(issue.milestone?.title) || null,
    body: text(issue.body).slice(0, BODY_MAX),
    url: text(issue.html_url),
    created: text(issue.created_at),
    closed,
    merged,
  }
}

/** What the ledger adds. Alone, when GitHub couldn't be asked, it's enough to say what the item is. */
export function itemView(number: number, found: ReturnType<typeof itemFromGithub> | null, history: History | null, repository: string, unread: string | null): ItemView | null {
  const known = history?.items.find((item) => item.number === number)
  if (!found && !known) return null
  const open = history?.pulls.find((pull) => pull.number === number)
  const kind = found?.kind ?? known?.kind ?? 'issue'
  const runs = (history?.runs ?? [])
    .filter((run) => run.pr === number)
    .sort((a, b) => b.start.localeCompare(a.start))
    .slice(0, RUNS_SHOWN)
    .map(({ id, state, start, end, branch }) => ({ id, state, start, end, branch }))
  return {
    number,
    kind,
    title: found?.title ?? known?.title ?? '',
    state: found?.state ?? (known?.merged ? 'merged' : known?.closed ? 'closed' : open?.draft ? 'draft' : 'open'),
    author: found?.author ?? known?.author ?? '',
    labels: found?.labels ?? known?.labels ?? [],
    milestone: found?.milestone ?? known?.milestone ?? null,
    body: found?.body ?? '',
    url: found?.url || `${repository}/${kind === 'pull' ? 'pull' : 'issues'}/${number}`,
    created: found?.created ?? known?.created ?? '',
    closed: found?.closed ?? known?.closed ?? null,
    merged: found?.merged ?? known?.merged ?? null,
    ci: open?.ci ?? null,
    review: open?.review ?? null,
    runs,
    unread,
    head: found?.head ?? null,
    reviewers: found?.reviewers ?? [],
  }
}
