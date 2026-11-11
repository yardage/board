/**
 * The ledger of the main repository, as the server keeps it and the overview and the reports read it: its issues and
 * pull requests, its CI runs, its open pull requests. Types only: the server writes it (`server/github/copy.ts`).
 */

/** What the overview draws from, kept from one refresh to the next, since GitHub only answers with what changed. */
export type RunState = 'success' | 'failure' | 'other' | 'running' | 'queued'
export interface HistoryItem {
  number: number
  kind: 'issue' | 'pull'
  author: string
  title: string
  created: string
  closed: string | null
  merged: string | null
  milestone: string | null
  labels: string[]
  /** Not in a ledger written by an older version. */
  assignees?: string[]
}
export interface HistoryRun {
  id: number
  branch: string
  pr: number | null
  event: string
  state: RunState
  start: string
  /** Null until it ends. */
  end: string | null
  /** A run started again keeps its id, so the latest word on a run is the one with the latest date. */
  updated: string
  /** Which try this is, its commit and its workflow. Runs read before these existed don't say. */
  attempt?: number
  sha?: string
  workflow?: string
}
export type ReviewState = 'none' | 'approved' | 'stale' | 'changes'
export interface OpenPull {
  number: number
  title: string
  author: string
  branch: string
  draft: boolean
  ci: string
  created: string
  labels: string[]
  review: ReviewState
}
export interface History {
  at: string
  /** The latest change read: the next reading starts from there. */
  since: string | null
  items: HistoryItem[]
  runs: HistoryRun[]
  pulls: OpenPull[]
  /** Lines changed by a merged pull request, which the lists don't say. Read once each: a merged one never changes. */
  lines: Record<string, { added: number; deleted: number }>
  /** An item's status on the project. Null when this login can't read the project. */
  project: { at: string; statuses: Record<string, string> } | null
  projectTriedAt: number
  /** When the last complete reading began. Runs and items are read one after the other, and what happened after this may be in neither. */
  itemsAt: string | null
  /** When the open pull requests were last read. A first reading that couldn't has no list, which isn't "none". */
  pullsAt: string | null
  /** When the whole list of items was last read. Deleted items and renamed labels change no date, so it is read again daily. */
  fullAt: number
  /** The runs are all there from this moment on. Null until a first reading has finished. */
  runsFrom: string | null
}
