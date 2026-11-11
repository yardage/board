import { t } from '../../../shared/i18n/i18n.ts'
import type { EnvironmentSection } from './settings-sections.ts'

/**
 * The environment's configuration as the settings edit it: its shape, what the server would drop, and which part of
 * the settings each field is in. The server checks it all again: these checks only say it before the save, not after.
 */

export interface RepoAccess {
  name: string
  code: boolean
  issues: { create: boolean; comment: boolean; edit: boolean; close: boolean }
  pulls: { comment: boolean; edit: boolean; review: boolean }
}

export type HostRole = 'ci' | 'dev' | 'server' | 'other'

export interface EnvironmentConfig {
  name: string
  repos: RepoAccess[]
  projects: { owner: string; number: number; edit: boolean }[]
  waiting: { label: string; who: string; question: string }
  documents: { repo: string; branch: string; path: string } | null
  hosts: { name: string; role: HostRole }[]
  endpoints: { name: string; url: string }[]
  timezone: string
  aliases: Record<string, { login: string; agent: boolean }>
  conventions: { epicLabel: string; reviewComment: string; reportEveryHours: number; ciMemoryMib: number }
}

export interface EnvironmentView {
  repo: string
  admin: boolean
  protected: boolean
  warning: string | null
  config: EnvironmentConfig
}

export const CADENCES = [1, 2, 3, 4, 6, 8, 12, 24]
export const HOST_ROLES: HostRole[] = ['ci', 'dev', 'server', 'other']
/** As many as the server keeps. */
export const MAX = { repos: 20, projects: 10, hosts: 50, endpoints: 10, aliases: 50 }

const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/
const REPOSITORY = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}\/(?!\.+$)[A-Za-z0-9._-]{1,100}$/
const HOST_NAME = /^[a-z0-9][a-z0-9-]{0,40}$/
const ALIAS = /^[a-z0-9-]{1,40}$/i
const ADDRESS = /^https:\/\/[a-z0-9.-]+(:\d+)?(\/[\w./%-]*)?$/i
const PRIVATE_HOST = /^(localhost|127\.|10\.|192\.168\.|169\.254\.|0\.|\[|.*\.local$|.*\.internal$)/

export const blankRepo = (): RepoAccess => ({ name: '', code: true, issues: { create: true, comment: true, edit: false, close: false }, pulls: { comment: true, edit: false, review: true } })

export function validZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat('en', { timeZone: zone })
    return true
  } catch {
    return false
  }
}

const plain = (value: string, max: number) => value.length <= max && !/[\u0000-\u001f\u007f]/.test(value)

function addressProblem(url: string): string | null {
  if (!ADDRESS.test(url)) return t('Une adresse en https://, sans espace.')
  if (url.length > 300) return t('Une adresse de 300 caractères au plus.')
  const host = url.replace(/^https:\/\//i, '').split(/[/:]/)[0].toLowerCase()
  if (PRIVATE_HOST.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host) || !host.includes('.')) return t('Une adresse publique : chaque membre la demande depuis son ordinateur.')
  return null
}

/** Where a field is wrong, keyed by where it is drawn: `repos.0.name`, `hosts.2.name`, `waiting.label`… */
export type Problems = Record<string, string>

/** What the server would drop or refuse, said beside the field, so that nothing disappears in silence at the save. */
export function problemsOf(config: EnvironmentConfig): Problems {
  const found: Problems = {}
  const twice = <T>(list: T[], key: (item: T) => string, path: (at: number) => string, word: string) => {
    const seen = new Set<string>()
    list.forEach((item, at) => {
      const id = key(item)
      if (id && seen.has(id) && !found[path(at)]) found[path(at)] = word
      seen.add(id)
    })
  }
  config.repos.forEach((repo, at) => {
    if (!REPOSITORY.test(repo.name)) found[`repos.${at}.name`] = repo.name ? t('Un dépôt s’écrit propriétaire/nom.') : t('Le nom du dépôt manque.')
  })
  twice(config.repos, (repo) => repo.name.toLowerCase(), (at) => `repos.${at}.name`, t('Ce dépôt est déjà dans la liste.'))
  config.projects.forEach((project, at) => {
    if (!LOGIN.test(project.owner)) found[`projects.${at}.owner`] = project.owner ? t('Un nom de compte ou d’organisation GitHub.') : t('Le propriétaire manque.')
    if (!Number.isInteger(project.number) || project.number < 1 || project.number > 1e6) found[`projects.${at}.number`] = t('Le numéro du projet, de 1 à 1 000 000.')
  })
  twice(config.projects, (project) => `${project.owner}#${project.number}`, (at) => `projects.${at}.owner`, t('Ce projet est déjà dans la liste.'))
  if (!config.waiting.label.trim()) found['waiting.label'] = t('Une étiquette est nécessaire.')
  else if (!plain(config.waiting.label, 50)) found['waiting.label'] = t('{0} caractères au plus.', { 0: 50 })
  if (!plain(config.waiting.who, 60)) found['waiting.who'] = t('{0} caractères au plus.', { 0: 60 })
  if (!plain(config.waiting.question, 60)) found['waiting.question'] = t('{0} caractères au plus.', { 0: 60 })
  if (config.documents) {
    const { repo, branch, path } = config.documents
    if (!REPOSITORY.test(repo)) found['documents.repo'] = repo ? t('Un dépôt s’écrit propriétaire/nom.') : t('Le nom du dépôt manque.')
    if (!/^[\w./-]{1,100}$/.test(branch)) found['documents.branch'] = t('Le nom d’une branche, sans espace.')
    if (!/^[\w./-]{1,200}$/.test(path) || path.includes('..') || !path.replace(/^\/+|\/+$/g, '')) found['documents.path'] = t('Un dossier du dépôt, comme docs ou docs/roadmap.')
  }
  config.hosts.forEach((host, at) => {
    if (!HOST_NAME.test(host.name)) found[`hosts.${at}.name`] = host.name ? t('Des minuscules, des chiffres et des tirets.') : t('Le nom de la machine manque.')
  })
  twice(config.hosts, (host) => host.name, (at) => `hosts.${at}.name`, t('Cette machine est déjà dans la liste.'))
  config.endpoints.forEach((endpoint, at) => {
    if (!endpoint.name.trim()) found[`endpoints.${at}.name`] = t('Un nom, pour la vue d’ensemble.')
    else if (!plain(endpoint.name, 60)) found[`endpoints.${at}.name`] = t('{0} caractères au plus.', { 0: 60 })
    const problem = addressProblem(endpoint.url)
    if (problem) found[`endpoints.${at}.url`] = problem
  })
  if (!validZone(config.timezone)) found.timezone = t('Un fuseau comme Europe/Paris ou UTC.')
  if (!plain(config.conventions.epicLabel, 50)) found['conventions.epicLabel'] = t('{0} caractères au plus.', { 0: 50 })
  if (!plain(config.conventions.reviewComment, 60)) found['conventions.reviewComment'] = t('{0} caractères au plus.', { 0: 60 })
  if (!Number.isInteger(config.conventions.ciMemoryMib) || config.conventions.ciMemoryMib < 0 || config.conventions.ciMemoryMib > 2 ** 26) found['conventions.ciMemoryMib'] = t('Un nombre entier de Mio.')
  for (const [alias, target] of Object.entries(config.aliases)) {
    if (!ALIAS.test(alias)) found[`aliases.${alias}`] = t('Des lettres, des chiffres et des tirets.')
    else if (!LOGIN.test(target.login)) found[`aliases.${alias}`] = t('Le membre qu’il désigne manque.')
  }
  return found
}

/** The part of the settings each field of the configuration is drawn in. */
const PART_OF: Record<string, EnvironmentSection> = {
  aliases: 'environment',
  repos: 'repositories',
  projects: 'projects',
  waiting: 'projects',
  documents: 'documents',
  hosts: 'machines',
  endpoints: 'machines',
  'conventions.ciMemoryMib': 'machines',
  timezone: 'reports',
  'conventions.reportEveryHours': 'reports',
  'conventions.epicLabel': 'reports',
  'conventions.reviewComment': 'reports',
}
const partOf = (path: string): EnvironmentSection | undefined => PART_OF[path] ?? PART_OF[path.split('.')[0]]

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

/** The parts where the draft differs from what the environment has. */
export function changedParts(draft: EnvironmentConfig, saved: EnvironmentConfig): Set<EnvironmentSection> {
  const parts = new Set<EnvironmentSection>()
  for (const key of Object.keys(draft) as (keyof EnvironmentConfig)[]) {
    if (key === 'conventions') {
      for (const inner of Object.keys(draft.conventions) as (keyof EnvironmentConfig['conventions'])[]) {
        if (draft.conventions[inner] !== saved.conventions[inner]) {
          const part = partOf(`conventions.${inner}`)
          if (part) parts.add(part)
        }
      }
    } else if (!same(draft[key], saved[key])) {
      const part = partOf(key)
      if (part) parts.add(part)
    }
  }
  return parts
}

/** The parts that hold a problem. */
export const problemParts = (problems: Problems) => new Set(Object.keys(problems).map(partOf).filter((part): part is EnvironmentSection => part !== undefined))
