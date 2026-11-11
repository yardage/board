import { createHash } from 'node:crypto'
import type { Member } from '../environment/config.ts'
import { askThrough, type Github } from './client.ts'
import { waitingFields, type WaitingSetup } from './copy.ts'
import { safeForGithub } from '../ai/tools.ts'

/**
 * What waits for a member on GitHub: an item with the configured label whose project field names
 * them, and a pull request whose review GitHub asks of them. GitHub is the record: an answer is a
 * comment made with the member's own login, by a click, and settling it takes the label off; a
 * review is a review on GitHub, made the same way, at the commit the member read. The board keeps
 * nothing of it.
 */

export const REASON_MAX = 4000

export interface WaitingItem {
  number: number
  title: string
  who: string
  question: string
  author?: string
  url?: string
  draft?: boolean
  /** Logins GitHub asks a review of. */
  reviewers?: string[]
}

/** What an answer says beyond its words: a yes, a no, or only words. */
export const VERDICTS = ['answer', 'approve', 'refuse'] as const
export type Verdict = (typeof VERDICTS)[number]
export const isVerdict = (value: unknown): value is Verdict => (VERDICTS as readonly unknown[]).includes(value)

/** What a review says, as GitHub names it. */
export const REVIEW_EVENTS = { approve: 'APPROVE', changes: 'REQUEST_CHANGES', comment: 'COMMENT' } as const
export type ReviewEvent = keyof typeof REVIEW_EVENTS
export const isReviewEvent = (value: unknown): value is ReviewEvent => typeof value === 'string' && value in REVIEW_EVENTS

/** Whether a field names this member: their login, their name, or their first name, as a project's options often do. */
export const names = (who: string, member: Pick<Member, 'login' | 'name'>) => {
  const wanted = who.trim().toLowerCase()
  return Boolean(wanted) && [member.login, member.name, member.name.split(' ')[0]].some((word) => word.toLowerCase() === wanted)
}

export const waitsFor = (item: WaitingItem, member: Pick<Member, 'login' | 'name'>) =>
  names(item.who, member) || (item.reviewers ?? []).some((login) => login.toLowerCase() === member.login.toLowerCase())

const digest = (parts: unknown[]) => createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 16)

/**
 * Finds a comment again when GitHub's answer was lost, so a second try doesn't post twice. The attempt tells a
 * second try from a second answer: the same words can be meant again once the item waits again.
 */
export const answerMark = (login: string, number: number, question: string, text: string, settle: boolean, attempt = '', verdict: Verdict = 'answer') =>
  `board-answer-${digest([login.toLowerCase(), number, question, text, settle, attempt, ...(verdict === 'answer' ? [] : [verdict])])}`

/** The same for a review: at this head, this word, these words. */
export const reviewMark = (login: string, number: number, head: string, event: ReviewEvent, text: string, attempt = '') => `board-review-${digest([login.toLowerCase(), number, head, event, text, attempt])}`

const HEADINGS: Record<Verdict, (name: string) => string> = {
  answer: (name) => `**${name} answered, from the board.**`,
  approve: (name) => `**✓ Approved by ${name}, from the board.**`,
  refuse: (name) => `**✕ Refused by ${name}, from the board.**`,
}

/** The member read this exact text before confirming it. It says what it answers, since the question can change. */
export function commentBody(name: string, text: string, question: string, mark: string, verdict: Verdict = 'answer'): string {
  const asked = question.trim() ? [`> ${safeForGithub(question).replace(/\s+/g, ' ')}`, ''] : []
  return [HEADINGS[verdict](safeForGithub(name)), '', ...asked, ...(text.trim() ? [safeForGithub(text), ''] : []), `Reference: \`${mark}\``].join('\n')
}

/** A review's words, which can be none for an approval. */
export function reviewBody(name: string, text: string, mark: string): string {
  return [`**${safeForGithub(name)}, from the board.**`, '', ...(text.trim() ? [safeForGithub(text), ''] : []), `Reference: \`${mark}\``].join('\n')
}

export interface PullNow {
  open: boolean
  draft: boolean
  /** The commit a review is made at. */
  head: string
  author: string
  reviewers: string[]
}

export interface WaitingApi {
  /** The login the GitHub client uses now: someone can log in again while the board runs. */
  login: () => Promise<string>
  /** What GitHub says at this moment, since the copy can be minutes old. */
  current: (number: number) => Promise<{ labels: string[]; who: string; question: string }>
  labels: (number: number) => Promise<string[]>
  find: (number: number, mark: string) => Promise<string | null>
  comment: (number: number, body: string) => Promise<string>
  setLabels: (number: number, labels: string[]) => Promise<void>
  /** The pull request as it is now. */
  pull: (number: number) => Promise<PullNow>
  findReview: (number: number, mark: string) => Promise<string | null>
  review: (number: number, event: ReviewEvent, body: string, head: string) => Promise<string>
}

export const githubWaiting = (github: Github, repo: string, setup: WaitingSetup): WaitingApi => {
  const labels = async (number: number): Promise<string[]> => ((await github.get<any>(`repos/${repo}/issues/${number}`))?.labels ?? []).map((label: { name: string }) => label.name)
  return {
    login: async () => String((await github.get<any>('user'))?.login ?? ''),
    current: async (number) => {
      const [found, fields] = await Promise.all([labels(number), waitingFields(askThrough(github), repo, setup, number)])
      return { labels: found, ...fields }
    },
    labels,
    find: async (number, mark) => {
      const comments = await github.all<any>(`repos/${repo}/issues/${number}/comments?per_page=100`)
      return comments.find((comment) => String(comment?.body ?? '').includes(mark))?.html_url ?? null
    },
    comment: async (number, body) => {
      const created = await github.send<any>('POST', `repos/${repo}/issues/${number}/comments`, { body })
      if (typeof created?.html_url !== 'string') throw new Error("GitHub n'a pas donné l'adresse du commentaire.")
      return created.html_url
    },
    setLabels: async (number, next) => {
      await github.send('PUT', `repos/${repo}/issues/${number}/labels`, { labels: next })
    },
    pull: async (number) => {
      const pull = await github.get<any>(`repos/${repo}/pulls/${number}`)
      if (typeof pull?.head?.sha !== 'string') throw new Error("GitHub n'a pas donné le commit de la pull request.")
      return {
        open: pull.state === 'open',
        draft: Boolean(pull.draft),
        head: pull.head.sha,
        author: String(pull.user?.login ?? ''),
        reviewers: (pull.requested_reviewers ?? []).map((user: any) => String(user?.login ?? '')).filter(Boolean),
      }
    },
    findReview: async (number, mark) => {
      const reviews = await github.all<any>(`repos/${repo}/pulls/${number}/reviews?per_page=100`)
      return reviews.find((review) => String(review?.body ?? '').includes(mark))?.html_url ?? null
    },
    review: async (number, event, body, head) => {
      const created = await github.send<any>('POST', `repos/${repo}/pulls/${number}/reviews`, { event: REVIEW_EVENTS[event], body, commit_id: head })
      if (typeof created?.html_url !== 'string') throw new Error("GitHub n'a pas donné l'adresse de la revue.")
      return created.html_url
    },
  }
}
