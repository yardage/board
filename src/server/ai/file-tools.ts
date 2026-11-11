import type { Dirent } from 'node:fs'
import { readdir, readFile, realpath, stat } from 'node:fs/promises'
import { extname, isAbsolute, relative, resolve, sep } from 'node:path'

/**
 * How a Codex agent reads its folders: through the board, never through a shell of its own.
 *
 * Codex has no file tool: it reads by running commands, and a command reads whatever its member's account can
 * read, sandbox or not. So the board turns Codex's shell off (harness.ts) and serves these three tools instead,
 * through the same bridge as the GitHub tools. Whatever path they are given, they stay inside the agent's
 * folders: the knowledge copy, the environment's reports and its threads. They follow no link out of them, and
 * never open a repository's `.git`. Claude Code doesn't need them: its own Read, Grep and Glob are kept to the
 * same folders.
 *
 * Every limit here keeps one run from holding up the app: the app is single-threaded, and a run is driven by a
 * model that reads what anyone wrote.
 */

export interface AgentFolders {
  /** The working directory: repos/, github/ and documents/ are read from it. */
  work: string
  /** Folders a path names first: reports/ and threads/. */
  named: Record<string, string>
}

export interface FileToolSpec {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

export interface FileResult {
  text: string
  isError?: boolean
  image?: { data: string; mimeType: string }
}

const pathField = {
  type: 'string',
  description: 'A path relative to your working directory (repos/..., github/..., documents/...), or one that starts with reports/ or threads/, or the full path of an attached file.',
}

export const FILE_TOOLS: FileToolSpec[] = [
  {
    name: 'read_file',
    description: 'Read a file of your folders: text with its line numbers, or an image. A long file is read in parts, with offset and limit.',
    inputSchema: {
      type: 'object',
      properties: {
        path: pathField,
        offset: { type: 'integer', description: 'First line to read, from 1' },
        limit: { type: 'integer', description: `How many lines, ${2000} at most` },
      },
      required: ['path'],
    },
  },
  {
    name: 'list_files',
    description: 'List a folder, or find files by name with a pattern: * and ? within a name, ** across folders, such as **/*.md or docs/**/README.md. Up to 500 files.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { ...pathField, description: 'The folder to list or search from. Your working directory when left out.' },
        pattern: { type: 'string', description: 'A pattern relative to that folder.' },
      },
    },
  },
  {
    name: 'search_files',
    description: 'Find the lines that contain a text, in the files of a folder or in one file. The text is found as it is written, not as a regular expression. Up to 200 lines.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'The words to find.' },
        path: { ...pathField, description: 'A folder or a file. Your working directory when left out.' },
        pattern: { type: 'string', description: 'Only the files matching it, such as **/*.ts' },
        case_sensitive: { type: 'boolean', description: 'Tell capitals apart. Off by default.' },
      },
      required: ['text'],
    },
  },
]

const LINES_MAX = 2000
const LINE_CHARS = 2000
const READ_CHARS = 200_000
/** A text file over this size is refused: no folder of the board holds one that an agent needs whole. */
const TEXT_BYTES = 10 << 20
const IMAGE_BYTES = 4 << 20
const IMAGES: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' }
const LIST_MAX = 500
const MATCHES_MAX = 200
const MATCH_CHARS = 300
/** How many entries a walk visits, and how much a search reads, before it stops and says so. */
const VISIT_MAX = 20_000
const SEARCH_BYTES = 100 << 20
const SEARCH_FILE_BYTES = 2 << 20
const SKIPPED = new Set(['.git', 'node_modules'])
/** Names Windows reads as a device, whatever folder they are in, and with any extension. */
const DEVICE = /^(con|prn|aux|nul|com\d|lpt\d|conin\$|conout\$)(\..*)?$/i

const windows = process.platform === 'win32'
const same = (a: string) => (windows ? a.toLowerCase() : a)
const inside = (file: string, root: string) => same(file) === same(root) || same(file).startsWith(same(root) + sep)
const rootsOf = (folders: AgentFolders) => [folders.work, ...Object.values(folders.named)]

/**
 * The file an agent's path names, or null when it would leave its folders. Only the path is read here: what is
 * really on disk is checked by `realInside`. Anything Windows reads otherwise than it looks is refused: a device
 * name, a stream after a colon, a name ending with a dot or a space (`.git.` is `.git`), a path that starts
 * with two slashes.
 */
export function agentFile(path: unknown, folders: AgentFolders): string | null {
  if (typeof path !== 'string') return null
  const given = path.trim() || '.'
  if (given.length > 1000 || /[\0*?"<>|]/.test(given) || /^[\\/]{2}/.test(given)) return null
  const colon = given.indexOf(':')
  if (colon !== -1 && !(colon === 1 && /^[A-Za-z]:[\\/]/.test(given) && !given.includes(':', 2))) return null
  const segments = given.replace(/\\/g, '/').split('/').filter((segment) => segment && segment !== '.')
  if (segments.some((segment) => segment === '..' || segment.toLowerCase() === '.git' || /[. ]$/.test(segment) || DEVICE.test(segment))) return null
  let file: string
  if (isAbsolute(given)) file = resolve(given)
  else {
    const base = segments.length ? folders.named[segments[0].toLowerCase()] : undefined
    file = base ? resolve(base, ...segments.slice(1)) : resolve(folders.work, ...segments)
  }
  return rootsOf(folders).some((root) => inside(file, root)) ? file : null
}

/** Where a file really is, if that is still inside the folders: a link, a junction or a short name can lead out. */
async function realInside(file: string, folders: AgentFolders): Promise<string | null> {
  try {
    const real = await realpath(file)
    for (const root of rootsOf(folders)) {
      const realRoot = await realpath(root).catch(() => null)
      if (!realRoot || !inside(real, realRoot)) continue
      if (relative(realRoot, real).split(sep).some((segment) => segment.toLowerCase() === '.git')) return null
      return real
    }
    return null
  } catch {
    return null
  }
}

/** A path as the agent would give it back: relative to its working directory, or under reports/ or threads/. */
export function agentPath(file: string, folders: AgentFolders): string {
  for (const [name, dir] of Object.entries(folders.named)) {
    if (inside(file, dir)) return [name, ...relative(dir, file).split(sep)].filter(Boolean).join('/')
  }
  return relative(folders.work, file).split(sep).join('/') || '.'
}

/**
 * A matcher for a pattern of names: `*` and `?` within a name, `**` across folders, and `**` before a slash for any
 * folders or none. It runs as a small machine over the path, never as a regular expression, and takes a few wildcards at most, so no
 * pattern can take long.
 */
export function globMatcher(pattern: string): ((path: string) => boolean) | null {
  const given = pattern.trim().replace(/\\/g, '/').replace(/^(\.\/|\/)+/, '').toLowerCase()
  if (!given || given.length > 200 || (given.match(/[*?]/g) ?? []).length > 20) return null
  const tokens: string[] = []
  for (let at = 0; at < given.length; ) {
    const token = given.startsWith('**/', at) ? '**/' : given.startsWith('**', at) ? '**' : given[at]
    tokens.push(token)
    at += token.length
  }
  // A state is how many tokens are matched; within a `**/`, it is that token's place plus INSIDE.
  const INSIDE = 1000
  const close = (states: Set<number>) => {
    for (const state of states) if (state < INSIDE && ['*', '**', '**/'].includes(tokens[state])) states.add(state + 1)
    return states
  }
  return (path) => {
    let states = close(new Set([0]))
    for (const char of path.toLowerCase()) {
      const next = new Set<number>()
      for (const state of states) {
        if (state >= INSIDE) {
          next.add(state)
          if (char === '/') next.add(state - INSIDE + 1)
          continue
        }
        const token = tokens[state]
        if (token === '**/') {
          next.add(state + INSIDE)
          if (char === '/') next.add(state + 1)
        } else if (token === '**' || (token === '*' && char !== '/')) next.add(state)
        else if ((token === '?' && char !== '/') || token === char) next.add(state + 1)
      }
      if (!next.size) return false
      states = close(next)
    }
    return states.has(tokens.length)
  }
}

/** The files and folders under a folder, without following a link, up to a number of entries. */
async function walk(dir: string, visit: (file: string, entry: Dirent) => Promise<boolean>): Promise<boolean> {
  let visited = 0
  const go = async (folder: string): Promise<boolean> => {
    const entries = await readdir(folder, { withFileTypes: true }).catch(() => [] as Dirent[])
    entries.sort((a, b) => a.name.localeCompare(b.name))
    for (const entry of entries) {
      if (++visited > VISIT_MAX) return false
      if (entry.isSymbolicLink() || SKIPPED.has(entry.name.toLowerCase())) continue
      const file = resolve(folder, entry.name)
      if (!(await visit(file, entry))) return false
      if (entry.isDirectory() && !(await go(file))) return false
    }
    return true
  }
  return go(dir)
}

const refused = (text: string): FileResult => ({ text, isError: true })
const OUTSIDE = 'This path is outside your folders, or isn\'t there. Paths are relative to your working directory, or start with reports/ or threads/.'

async function readText(file: string): Promise<string | null> {
  const bytes = await readFile(file)
  // A file with a zero byte isn't text, whatever its name says.
  return bytes.subarray(0, 8192).includes(0) ? null : bytes.toString('utf8')
}

async function readFileTool(input: any, folders: AgentFolders): Promise<FileResult> {
  const file = agentFile(input?.path, folders)
  const real = file && (await realInside(file, folders))
  if (!real) return refused(OUTSIDE)
  const found = await stat(real)
  const shown = agentPath(file, folders)
  if (found.isDirectory()) return refused(`${shown} is a folder: list it with list_files.`)
  if (!found.isFile()) return refused(`${shown} isn't a file.`)
  const type = IMAGES[extname(real).toLowerCase()]
  if (type) {
    if (found.size > IMAGE_BYTES) return refused(`${shown} is an image over ${IMAGE_BYTES >> 20} MB.`)
    return { text: `${shown}, an image:`, image: { data: (await readFile(real)).toString('base64'), mimeType: type } }
  }
  if (found.size > TEXT_BYTES) return refused(`${shown} is over ${TEXT_BYTES >> 20} MB: search it with search_files instead.`)
  const text = await readText(real)
  if (text === null) return refused(`${shown} isn't text, and this format can't be read here.`)
  if (!text) return { text: `${shown} is empty.` }
  const lines = text.split(/\r?\n/)
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop()
  const offset = Number.isInteger(input?.offset) && input.offset > 0 ? input.offset : 1
  const limit = Number.isInteger(input?.limit) && input.limit > 0 ? Math.min(input.limit, LINES_MAX) : LINES_MAX
  if (offset > lines.length) return refused(`${shown} has ${lines.length} lines.`)
  const out: string[] = []
  let chars = 0
  let last = offset - 1
  for (let at = offset - 1; at < Math.min(lines.length, offset - 1 + limit); at++) {
    const line = lines[at].length > LINE_CHARS ? `${lines[at].slice(0, LINE_CHARS)}…` : lines[at]
    chars += line.length + 8
    if (chars > READ_CHARS && out.length) break
    out.push(`${at + 1}\t${line}`)
    last = at + 1
  }
  const more = last < lines.length ? `\n(Lines ${offset} to ${last} of ${lines.length}: read on with offset ${last + 1}.)` : ''
  return { text: `${shown}:\n${out.join('\n')}${more}` }
}

async function listFilesTool(input: any, folders: AgentFolders): Promise<FileResult> {
  const file = agentFile(input?.path ?? '.', folders)
  const real = file && (await realInside(file, folders))
  if (!real) return refused(OUTSIDE)
  if (!(await stat(real)).isDirectory()) return refused(`${agentPath(file, folders)} isn't a folder.`)
  const atWork = same(file) === same(folders.work)
  if (input?.pattern === undefined || input.pattern === '') {
    const entries = (await readdir(file, { withFileTypes: true })).filter((entry) => !entry.isSymbolicLink() && !SKIPPED.has(entry.name.toLowerCase()))
    entries.sort((a, b) => a.name.localeCompare(b.name))
    const names = entries.map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name))
    // The working directory's neighbours are read from it by name.
    if (atWork) names.push(...Object.keys(folders.named).map((name) => `${name}/`))
    if (!names.length) return { text: `${agentPath(file, folders)} is empty.` }
    const shown = names.slice(0, LIST_MAX)
    return { text: `${agentPath(file, folders)}:\n${shown.join('\n')}${names.length > shown.length ? `\n(${names.length - shown.length} more.)` : ''}` }
  }
  const matches = typeof input.pattern === 'string' ? globMatcher(input.pattern) : null
  if (!matches) return refused('pattern must be a pattern of names, of 200 characters at most, such as **/*.md.')
  const found: string[] = []
  const whole = await walk(file, async (path, entry) => {
    if (entry.isFile() && matches(relative(file, path).split(sep).join('/'))) found.push(agentPath(path, folders))
    return found.length < LIST_MAX
  })
  if (!found.length) return { text: whole ? 'Nothing matches.' : 'Nothing matches in the part that was looked at: give a narrower folder.' }
  return { text: `${found.join('\n')}${!whole ? `\n(Stopped at ${found.length === LIST_MAX ? `${LIST_MAX} paths` : 'the part that was looked at'}: give a narrower folder or pattern.)` : ''}` }
}

async function searchFilesTool(input: any, folders: AgentFolders): Promise<FileResult> {
  const text = input?.text
  if (typeof text !== 'string' || !text.trim() || text.length > 200) return refused('text must be a few words, of 200 characters at most.')
  const file = agentFile(input?.path ?? '.', folders)
  const real = file && (await realInside(file, folders))
  if (!real) return refused(OUTSIDE)
  const matches = input?.pattern === undefined || input.pattern === '' ? () => true : typeof input.pattern === 'string' ? globMatcher(input.pattern) : null
  if (!matches) return refused('pattern must be a pattern of names, of 200 characters at most, such as **/*.ts.')
  const sensitive = input?.case_sensitive === true
  const wanted = sensitive ? text : text.toLowerCase()
  const found: string[] = []
  let read = 0
  let skipped = 0
  const look = async (path: string, size: number) => {
    if (size > SEARCH_FILE_BYTES || read + size > SEARCH_BYTES) {
      skipped++
      return
    }
    read += size
    const content = await readText(path).catch(() => null)
    if (content === null) return
    const shown = agentPath(path, folders)
    const lines = content.split(/\r?\n/)
    for (let at = 0; at < lines.length && found.length < MATCHES_MAX; at++) {
      if (!(sensitive ? lines[at] : lines[at].toLowerCase()).includes(wanted)) continue
      const line = lines[at].trim()
      found.push(`${shown}:${at + 1}: ${line.length > MATCH_CHARS ? `${line.slice(0, MATCH_CHARS)}…` : line}`)
    }
  }
  const info = await stat(real)
  let whole = true
  if (info.isFile()) await look(file, info.size)
  else
    whole = await walk(file, async (path, entry) => {
      if (entry.isFile() && matches(relative(file, path).split(sep).join('/'))) {
        const size = (await stat(path).catch(() => null))?.size ?? 0
        await look(path, size)
      }
      return found.length < MATCHES_MAX
    })
  const notes = [
    found.length >= MATCHES_MAX ? `Stopped at ${MATCHES_MAX} lines: give a narrower folder or pattern.` : '',
    !whole && found.length < MATCHES_MAX ? 'Only part of the folder was looked at: give a narrower folder.' : '',
    skipped ? `${skipped} files over ${SEARCH_FILE_BYTES >> 20} MB, or past what one search reads, were left out.` : '',
  ].filter(Boolean)
  return { text: `${found.length ? found.join('\n') : 'Nothing found.'}${notes.length ? `\n(${notes.join(' ')})` : ''}` }
}

/** Runs one call. Never throws: a refusal is an answer the agent reads. */
export async function runFileTool(name: string, input: any, folders: AgentFolders): Promise<FileResult> {
  try {
    if (name === 'read_file') return await readFileTool(input, folders)
    if (name === 'list_files') return await listFilesTool(input, folders)
    if (name === 'search_files') return await searchFilesTool(input, folders)
    return refused(`Unknown tool ${name}.`)
  } catch {
    return refused('This file or folder can\'t be read.')
  }
}
