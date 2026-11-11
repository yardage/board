import type { Github } from '../github/client.ts'

/**
 * An environment is a GitHub repository that holds one board's data and nothing else: its threads,
 * reports and polls, and its configuration. The app is the same for every environment.
 *
 *   board.json                The mark that makes a repository an environment.
 *   config/environment.json   What the environment works on, and what the board may do there. Admins only.
 *   threads/                  Conversations: one folder each, one file per message.
 *   reports/                  Progress reports, written by the apps themselves.
 *
 * What changes all the time, who is online and the hosts' figures, lives in the repository's
 * variables rather than in its history: see live.ts.
 */

export const MARK_FILE = 'board.json'
export const CONFIG_FILE = 'config/environment.json'
/** How an environment is found among the repositories a person can open. */
export const ENVIRONMENT_TOPIC = 'board-environment'
/** Paths only an admin may push, through a push ruleset where the plan has them. */
export const PROTECTED_PATHS = ['config/**', MARK_FILE]
export const RULESET_NAME = 'Board: configuration by admins only'

export const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/
export const REPOSITORY = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}\/(?!\.+$)[A-Za-z0-9._-]{1,100}$/
const HOST_NAME = /^[a-z0-9][a-z0-9-]{0,40}$/
export const HOST_ROLES = ['ci', 'dev', 'server', 'other'] as const
export type HostRole = (typeof HOST_ROLES)[number]

export interface RepoAccess {
  /** owner/name */
  name: string
  /** Its main branch is copied, code included, for agents to read. */
  code: boolean
  issues: { create: boolean; comment: boolean; edit: boolean; close: boolean }
  /** `review`: members approve, ask for changes or comment as a review, with their own login. Never an agent. */
  pulls: { comment: boolean; edit: boolean; review: boolean }
}

export interface ProjectAccess {
  owner: string
  number: number
  /** The board may add items and set fields. */
  edit: boolean
}

/** How a team works, which the board reads rather than assumes. */
export interface Conventions {
  /** Issues with this label are headings over work, left out of every count. Empty: none. */
  epicLabel: string
  /** A comment starting with these words, then APPROVE or CHANGES and the head's sha, counts as a review. Empty: only GitHub's reviews count. */
  reviewComment: string
  /** Hours between two progress reports. */
  reportEveryHours: number
  /** Free memory, in MiB, under which a CI host shows amber. */
  ciMemoryMib: number
}

export const REPORT_CADENCES = [1, 2, 3, 4, 6, 8, 12, 24] as const
export const DEFAULT_CONVENTIONS: Conventions = { epicLabel: 'epic', reviewComment: '', reportEveryHours: 3, ciMemoryMib: 1536 }

export interface EnvironmentConfig {
  name: string
  /** The first one is the environment's main repository: the overview and the reports follow it. */
  repos: RepoAccess[]
  /** The first one gives the overview its statuses. */
  projects: ProjectAccess[]
  /** What makes an item wait for a person's answer, on the main repository. */
  waiting: { label: string; who: string; question: string }
  /** Documents of a branch that agents read too, such as a roadmap. */
  documents: { repo: string; branch: string; path: string } | null
  hosts: { name: string; role: HostRole }[]
  endpoints: { name: string; url: string }[]
  /** Reports cut days and slots in this zone. */
  timezone: string
  /** Names used in messages before environments existed, and who they were. */
  aliases: Record<string, { login: string; agent: boolean }>
  conventions: Conventions
}

export interface Member {
  login: string
  name: string
  admin: boolean
}

const NO_ACCESS: RepoAccess = { name: '', code: false, issues: { create: false, comment: false, edit: false, close: false }, pulls: { comment: false, edit: false, review: false } }

export const defaultConfig = (name: string, timezone = 'UTC'): EnvironmentConfig => ({
  name,
  repos: [],
  projects: [],
  waiting: { label: 'needs-answer', who: '', question: '' },
  documents: null,
  hosts: [],
  endpoints: [],
  timezone,
  aliases: {},
  conventions: { ...DEFAULT_CONVENTIONS },
})

const text = (value: unknown, max: number, fallback = '') =>
  typeof value === 'string' && value.trim() && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value) ? value.trim() : fallback
const flag = (value: unknown) => value === true

export const validTimezone = (zone: string) => {
  try {
    new Intl.DateTimeFormat('en', { timeZone: zone })
    return true
  } catch {
    return false
  }
}

/**
 * The configuration, from a file someone pushed. What isn't plain is dropped, and a repository or
 * a project appears once. Only an admin can push it where the plan allows a ruleset; it is still
 * read as anyone's text.
 */
export function parseConfig(raw: any, fallbackName = 'board'): EnvironmentConfig {
  const config = defaultConfig(text(raw?.name, 80, fallbackName))
  if (typeof raw !== 'object' || raw === null) return config
  const seen = new Set<string>()
  for (const repo of Array.isArray(raw.repos) ? raw.repos.slice(0, 20) : []) {
    const name = text(repo?.name, 140)
    if (!REPOSITORY.test(name) || seen.has(name.toLowerCase())) continue
    seen.add(name.toLowerCase())
    config.repos.push({
      name,
      code: flag(repo.code),
      issues: { create: flag(repo.issues?.create), comment: flag(repo.issues?.comment), edit: flag(repo.issues?.edit), close: flag(repo.issues?.close) },
      pulls: { comment: flag(repo.pulls?.comment), edit: flag(repo.pulls?.edit), review: flag(repo.pulls?.review) },
    })
  }
  for (const project of Array.isArray(raw.projects) ? raw.projects.slice(0, 10) : []) {
    const owner = text(project?.owner, 39)
    const number = Number(project?.number)
    if (!LOGIN.test(owner) || !Number.isInteger(number) || number < 1 || number > 1e6) continue
    if (config.projects.some((p) => p.owner === owner && p.number === number)) continue
    config.projects.push({ owner, number, edit: flag(project.edit) })
  }
  config.waiting = {
    label: text(raw.waiting?.label, 50, 'needs-answer'),
    who: text(raw.waiting?.who, 60),
    question: text(raw.waiting?.question, 60),
  }
  const documents = raw.documents
  // A folder that is only slashes is the repository's root, which isn't a folder of documents: it is refused, not stored empty.
  if (documents && REPOSITORY.test(text(documents.repo, 140)) && /^[\w./-]{1,100}$/.test(text(documents.branch, 100)) && /^[\w./-]{1,200}$/.test(text(documents.path, 200)) && !String(documents.path).includes('..') && text(documents.path, 200).replace(/^\/+|\/+$/g, '')) {
    config.documents = { repo: text(documents.repo, 140), branch: text(documents.branch, 100), path: text(documents.path, 200).replace(/^\/+|\/+$/g, '') }
  }
  for (const host of Array.isArray(raw.hosts) ? raw.hosts.slice(0, 50) : []) {
    const name = text(host?.name, 41).toLowerCase()
    if (!HOST_NAME.test(name) || config.hosts.some((h) => h.name === name)) continue
    config.hosts.push({ name, role: (HOST_ROLES as readonly string[]).includes(host.role) ? host.role : 'other' })
  }
  for (const endpoint of Array.isArray(raw.endpoints) ? raw.endpoints.slice(0, 10) : []) {
    const name = text(endpoint?.name, 60)
    const url = text(endpoint?.url, 300)
    if (!name || !/^https:\/\/[a-z0-9.-]+(:\d+)?(\/[\w./%-]*)?$/i.test(url)) continue
    // Every member's app would ask this address: a private one would make them probe their own network.
    const hostname = url.replace(/^https:\/\//i, '').split(/[/:]/)[0].toLowerCase()
    if (/^(localhost|127\.|10\.|192\.168\.|169\.254\.|0\.|\[|.*\.local$|.*\.internal$)/.test(hostname) || /^172\.(1[6-9]|2\d|3[01])\./.test(hostname) || !hostname.includes('.')) continue
    config.endpoints.push({ name, url })
  }
  const zone = text(raw.timezone, 60, 'UTC')
  config.timezone = validTimezone(zone) ? zone : 'UTC'
  for (const [alias, target] of Object.entries(typeof raw.aliases === 'object' && raw.aliases ? raw.aliases : {}).slice(0, 50)) {
    const login = text((target as any)?.login, 39)
    if (/^[a-z0-9-]{1,40}$/i.test(alias) && LOGIN.test(login)) config.aliases[alias.toLowerCase()] = { login, agent: flag((target as any)?.agent) }
  }
  const conventions = typeof raw.conventions === 'object' && raw.conventions ? raw.conventions : {}
  // An empty string is a choice: no such label, no such comment.
  const word = (value: unknown, max: number, fallback: string) => (value === '' ? '' : text(value, max, fallback))
  const every = Number(conventions.reportEveryHours)
  const mib = Number(conventions.ciMemoryMib)
  config.conventions = {
    epicLabel: word(conventions.epicLabel, 50, DEFAULT_CONVENTIONS.epicLabel),
    reviewComment: word(conventions.reviewComment, 60, DEFAULT_CONVENTIONS.reviewComment),
    reportEveryHours: (REPORT_CADENCES as readonly number[]).includes(every) ? every : DEFAULT_CONVENTIONS.reportEveryHours,
    ciMemoryMib: Number.isInteger(mib) && mib >= 0 && mib <= 2 ** 26 ? mib : DEFAULT_CONVENTIONS.ciMemoryMib,
  }
  return config
}

export const formatConfig = (config: EnvironmentConfig) => `${JSON.stringify(config, null, 2)}\n`

/** What the board may do on a repository. One not listed allows nothing. */
export const accessOf = (config: EnvironmentConfig, repo: string): RepoAccess =>
  config.repos.find((candidate) => candidate.name.toLowerCase() === repo.toLowerCase()) ?? { ...NO_ACCESS, name: repo }

export const mainRepository = (config: EnvironmentConfig): string | null => config.repos[0]?.name ?? null

export const repositoryUrl = (repo: string | null) => (repo ? `https://github.com/${repo}` : '')

/** The repository's collaborators, who are its members. Listing them needs write access, which members have. */
export async function readMembers(github: Github, repo: string): Promise<Member[]> {
  const found = await github.all<any>(`repos/${repo}/collaborators?affiliation=all&per_page=100`)
  return found
    .filter((user) => typeof user?.login === 'string' && LOGIN.test(user.login) && user.type !== 'Bot' && (user.permissions?.push || user.permissions?.admin))
    .map((user) => ({ login: user.login, name: user.login, admin: Boolean(user.permissions?.admin) }))
    .sort((a, b) => a.login.localeCompare(b.login))
}

/** How many profiles are asked for at once: GitHub turns away a burst of a hundred. */
const NAMES_AT_ONCE = 6

/**
 * Members' display names, from their public profiles. Names already known are kept, so a refresh costs a request
 * only for a new member; `known` is empty once a day, so a changed name is seen.
 */
export async function withNames(github: Github, members: Member[], known: Map<string, string> = new Map()): Promise<Member[]> {
  const named: Member[] = members.map((member) => ({ ...member, name: known.get(member.login.toLowerCase()) || member.login }))
  const missing = named.filter((member) => !known.has(member.login.toLowerCase()))
  for (let at = 0; at < missing.length; at += NAMES_AT_ONCE) {
    await Promise.all(
      missing.slice(at, at + NAMES_AT_ONCE).map(async (member) => {
        const user = await github.get<any>(`users/${member.login}`).catch(() => null)
        member.name = text(user?.name, 80) || member.login
      }),
    )
  }
  return named
}

/** The ruleset that keeps the configuration to admins: repository admins and organisation owners bypass it. */
export const configRuleset = () => ({
  name: RULESET_NAME,
  target: 'push',
  enforcement: 'active',
  bypass_actors: [
    { actor_id: 5, actor_type: 'RepositoryRole', bypass_mode: 'always' },
    { actor_id: 1, actor_type: 'OrganizationAdmin', bypass_mode: 'always' },
  ],
  rules: [{ type: 'file_path_restriction', parameters: { restricted_file_paths: PROTECTED_PATHS } }],
})

/** Whether the configuration is protected by GitHub itself, rather than by each app's good behaviour. */
export async function configProtected(github: Github, repo: string): Promise<boolean> {
  const rulesets = await github.get<any[]>(`repos/${repo}/rulesets`).catch(() => [])
  return Array.isArray(rulesets) && rulesets.some((ruleset) => ruleset?.name === RULESET_NAME && ruleset?.enforcement === 'active')
}

export async function protectConfig(github: Github, repo: string): Promise<boolean> {
  if (await configProtected(github, repo)) return true
  try {
    await github.send('POST', `repos/${repo}/rulesets`, configRuleset())
    return true
  } catch {
    // A plan without push rulesets: each app still refuses a change from someone who isn't an admin.
    return false
  }
}
