import { execFile, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'
import { type AiChoice, MODEL_ID, MODELS, type Provider, PROVIDER_NAMES } from '../../shared/ai-uses.ts'
import { TOOL_SERVER } from './tools.ts'

/**
 * The program that answers for a member: Claude Code or Codex, the member's own install with their own login,
 * which the board never sees. Everything that starts one goes through here: how to find it, which account folder
 * to give it, how to ask its state, how to start a text-only run or an agent's run, and how to read what it says.
 *
 * Both run from a folder of the board's with no settings of the person's own, no saved session, and the board's
 * instructions in place of theirs. Neither gets a shell. Claude Code's own file tools are kept to the board's folders
 * (`--restricted`). Codex has no file tool of its own, only its shell, which would read whatever the member's account
 * can: the board turns the shell off (`CODEX_LOCKED`) and Codex reads its folders through the board's file tools.
 */

/** The agent's run, in Claude Code's words: the file tools, and nothing else of its own. */
export const AGENT_TOOLS = 'Read,Grep,Glob'
/**
 * Reads are allowed inside the working directory and `--add-dir`, and everything else is refused.
 * Never add a file tool to `--allowedTools`: `Read` there opens every file on the person's disk.
 * Only the board's own MCP tools are listed there, by their full names.
 */
export const AGENT_PERMISSIONS = ['--tools', AGENT_TOOLS, '--permission-mode', 'dontAsk', '--restricted']
export const mcpName = (tool: string) => `mcp__${TOOL_SERVER}__${tool}`

export interface AiStatus {
  installed: boolean
  version: string | null
  /** Null when it couldn't be read, which isn't the same as logged out. */
  loggedIn: boolean | null
  /** How the person is signed in, in the program's words: "claude.ai", "ChatGPT", "API key". */
  method: string | null
  plan: string | null
}

export const NOT_INSTALLED: AiStatus = { installed: false, version: null, loggedIn: null, method: null, plan: null }

/** Where each program keeps its login, as it names the variable itself, and its usual folder. */
export const HOME_VAR: Record<Provider, string> = { claude: 'CLAUDE_CONFIG_DIR', codex: 'CODEX_HOME' }
export const DEFAULT_HOME: Record<Provider, string> = { claude: '.claude', codex: '.codex' }
/** The web page that says how to install each program. */
export const INSTALL_PAGE: Record<Provider, string> = { claude: 'https://docs.claude.com/en/docs/claude-code/setup', codex: 'https://developers.openai.com/codex' }

/**
 * What the member chose on this computer (`programs.ts`): the program, and for each one the account folder and
 * where the program is, null for its own.
 */
const chosen: { provider: Provider; homes: Record<Provider, string | null>; paths: Record<Provider, string | null> } = { provider: 'claude', homes: { claude: null, codex: null }, paths: { claude: null, codex: null } }

/** Every run started from now on uses this program: replies, syntheses, translations, titles, status and login. */
export function useProvider(provider: Provider): void {
  chosen.provider = provider
}
/**
 * Asked each time a run, or a screen, reads which program is chosen: another window of the app, its own process,
 * may have chosen since, and `programs.ts` takes it from the settings file then.
 */
let beforeRead: () => void = () => undefined
export function onRead(check: () => void): void {
  beforeRead = check
}
export const currentProvider = () => {
  beforeRead()
  return chosen.provider
}
/** Every run of this program uses this account folder from now on. */
export function useHome(provider: Provider, home: string | null): void {
  chosen.homes[provider] = home
}
export const homeOf = (provider: Provider = chosen.provider) => chosen.homes[provider]
/** Every run of this program starts this file from now on; null finds it in its usual places. */
export function usePath(provider: Provider, path: string | null): void {
  chosen.paths[provider] = path
}
export const pathOf = (provider: Provider = chosen.provider) => chosen.paths[provider]

/**
 * The environment a program starts in. Started from inside one of their sessions, both would otherwise refuse
 * to run. Nothing of the board's own GitHub login goes in it. An account other than the program's own is its
 * folder, under the variable the program names itself.
 */
export function aiEnv(provider: Provider = chosen.provider, base: NodeJS.ProcessEnv = process.env, home: string | null = chosen.homes[provider]): NodeJS.ProcessEnv {
  const env = { ...base }
  delete env.CLAUDECODE
  delete env.CLAUDE_CODE_ENTRYPOINT
  delete env.CODEX_SANDBOX
  delete env.CODEX_SANDBOX_NETWORK_DISABLED
  delete env.GH_TOKEN
  delete env.GITHUB_TOKEN
  if (home) env[HOME_VAR[provider]] = home
  return env
}

const STATUS_TIMEOUT_MS = 20_000

/**
 * How to start a program: where the member said it is, or else its usual places. On Windows a `.cmd` can't start
 * without a shell, which would have to quote every argument, so an install through npm runs its script with Node
 * instead. Tests name a stand-in that spends nothing.
 */
export function findProgram(provider: Provider = chosen.provider): string[] {
  const forced = provider === 'claude' ? process.env.BOARD_CLAUDE : process.env.BOARD_CODEX
  if (forced) return /\.[cm]?js$/.test(forced) ? [process.execPath, forced] : [forced]
  const given = chosen.paths[provider]
  if (given) return /\.[cm]?js$/i.test(given) ? ['node', given] : [given]
  const home = homedir()
  const name = provider
  if (process.platform !== 'win32') {
    const found = [join(home, '.local', 'bin', name), `/opt/homebrew/bin/${name}`, `/usr/local/bin/${name}`, join(home, '.npm-global', 'bin', name)].find((path) => existsSync(path))
    return [found ?? name]
  }
  const onPath = (process.env.PATH ?? '').split(delimiter).map((dir) => join(dir, `${name}.exe`))
  const local = process.env.LOCALAPPDATA ?? join(home, 'AppData', 'Local')
  const places = provider === 'claude' ? [join(home, '.local', 'bin', 'claude.exe'), join(local, 'Programs', 'claude', 'claude.exe')] : [join(local, 'Programs', 'OpenAI', 'Codex', 'bin', 'codex.exe'), join(home, '.local', 'bin', 'codex.exe')]
  const exe = [...places, ...onPath].find((path) => existsSync(path))
  if (exe) return [exe]
  const roaming = process.env.APPDATA ?? join(home, 'AppData', 'Roaming')
  const script = provider === 'claude' ? join(roaming, 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js') : join(roaming, 'npm', 'node_modules', '@openai', 'codex', 'bin', 'codex.js')
  return existsSync(script) ? ['node', script] : [name]
}

/** Reads its output even on failure: logged out, `claude auth status` still prints its answer, and exits 1. */
const ask = (provider: Provider, args: string[], home: string | null) =>
  new Promise<string>((done) => {
    const [command, ...before] = findProgram(provider)
    try {
      execFile(command, [...before, ...args], { encoding: 'utf8', timeout: STATUS_TIMEOUT_MS, windowsHide: true, env: aiEnv(provider, process.env, home) }, (_error, stdout, stderr) => done(`${stdout ?? ''}${provider === 'codex' ? `\n${stderr ?? ''}` : ''}`))
    } catch {
      done('')
    }
  })

/** What the settings show of Claude Code. The person's address and organisation stay out, so no screenshot carries them. */
export function readClaudeStatus(version: string, status: string): AiStatus {
  const number = version.trim().split(' ')[0]
  if (!number) return NOT_INSTALLED
  try {
    const found = JSON.parse(status)
    return {
      installed: true,
      version: number,
      loggedIn: typeof found.loggedIn === 'boolean' ? found.loggedIn : null,
      method: typeof found.authMethod === 'string' ? found.authMethod : null,
      plan: typeof found.subscriptionType === 'string' ? found.subscriptionType : null,
    }
  } catch {
    return { installed: true, version: number, loggedIn: null, method: null, plan: null }
  }
}

/** What the settings show of Codex: "codex-cli 0.166.0", then "Logged in using ChatGPT" or "Not logged in". */
export function readCodexStatus(version: string, status: string): AiStatus {
  const number = version.trim().split(/\s+/).find((word) => /^\d/.test(word)) ?? ''
  if (!number) return NOT_INSTALLED
  const line = status
    .split('\n')
    .map((one) => one.trim())
    .find((one) => /logged in/i.test(one))
  if (!line) return { installed: true, version: number, loggedIn: null, method: null, plan: null }
  const loggedIn = /^logged in/i.test(line)
  const method = line.match(/using (.+)$/i)?.[1]?.trim() ?? null
  return { installed: true, version: number, loggedIn, method: loggedIn ? method : null, plan: null }
}

/** Of the account chosen, or of the one in this folder. */
export async function aiStatus(provider: Provider = chosen.provider, home: string | null = chosen.homes[provider]): Promise<AiStatus> {
  if (provider === 'claude') {
    const [version, status] = await Promise.all([ask('claude', ['--version'], home), ask('claude', ['auth', 'status'], home)])
    return readClaudeStatus(version, status)
  }
  const [version, status] = await Promise.all([ask('codex', ['--version'], home), ask('codex', ['login', 'status'], home)])
  return readCodexStatus(version, status)
}

/** The logins open, by program and account folder. */
const loginOpen = new Set<string>()

/**
 * The program's own login, in its own window or browser: it may need the person to answer, and the board never
 * sees a credential. A second click while one is open on the same folder does nothing; on another folder, it
 * opens that folder's.
 */
export function startLogin(provider: Provider = chosen.provider, home: string | null = chosen.homes[provider]): Promise<void> {
  const key = `${provider}\n${home ?? ''}`
  if (loginOpen.has(key)) return Promise.resolve()
  return new Promise((done, fail) => {
    const [command, ...before] = findProgram(provider)
    const args = provider === 'claude' ? ['auth', 'login'] : ['login']
    const child = spawn(command, [...before, ...args], { detached: true, stdio: 'ignore', windowsHide: false, env: aiEnv(provider, process.env, home) })
    child.once('error', fail)
    child.once('spawn', () => {
      loginOpen.add(key)
      child.once('exit', () => loginOpen.delete(key))
      child.unref()
      done()
    })
  })
}

/**
 * The models Codex's own catalogue lists, from the file it keeps in its home. Only their ids are read, and only
 * ids shaped like one. Empty when there is no catalogue yet: the built-in list stands. `home` is the account
 * folder the member gave Codex, null for its own. That one is where Codex itself would look, under its variable
 * or in the person's home; a `personHome` given (tests) is the home, and the variable is not read.
 */
export async function codexCatalogue(home: string | null, personHome?: string): Promise<string[]> {
  const folder = home ?? (personHome === undefined ? (process.env.CODEX_HOME ?? join(homedir(), DEFAULT_HOME.codex)) : join(personHome, DEFAULT_HOME.codex))
  try {
    const cache = JSON.parse(await readFile(join(folder, 'models_cache.json'), 'utf8')) as { models?: { slug?: unknown; visibility?: unknown }[] }
    return (cache.models ?? []).filter((model) => typeof model.slug === 'string' && MODEL_ID.test(model.slug) && model.visibility === 'list').map((model) => model.slug as string).slice(0, 40)
  } catch {
    return []
  }
}

/** A TOML string for `codex -c key=value`: JSON's escapes are TOML's for a basic string. */
const toml = (value: string) => JSON.stringify(value)

/**
 * What Codex must never have: its shell, which reads any file the account can, and its image viewer, which opens
 * any image on the disk. `--disable` fails closed: a Codex too old to know one of them refuses to start, rather than
 * run with it. Then what it doesn't need, each off where this Codex knows it, ignored where it doesn't: the person's
 * connected apps and plugins, a browser, the computer, images made, hooks, memories, goals, and the web.
 */
export const CODEX_LOCKED = [
  '--disable', 'shell_tool',
  '--disable', 'unified_exec',
  '--disable', 'view_image',
  ...['apps', 'plugins', 'browser_use', 'computer_use', 'in_app_browser', 'image_generation', 'hooks', 'memories', 'goals'].flatMap((feature) => ['-c', `features.${feature}=false`]),
  '-c', 'web_search="disabled"',
]

/** Why a run failed, in the member's words when it is that their Codex is too old to be locked down. */
export const failureOf = (said: string) =>
  /unknown feature flag/i.test(said) ? 'Ce Codex est trop ancien pour le board : mettez-le à jour, puis demandez de nouveau.' : said

/** Which model and effort are the member's choice. They change what a run costs, and nothing of what it may do. */
export function textArgs(provider: Provider, choice: AiChoice, systemFile: string, outFile: string): string[] {
  if (provider === 'claude') {
    // No tool at all, from a folder of its own: a document that says otherwise can only change a translation.
    return [
      '-p',
      ...(choice.model ? ['--model', choice.model] : []),
      ...(choice.effort ? ['--effort', choice.effort] : []),
      '--system-prompt-file', systemFile,
      '--tools', '',
      '--setting-sources', '',
      '--strict-mcp-config',
      '--disable-slash-commands',
      '--no-session-persistence',
      '--output-format', 'text',
    ]
  }
  // The board's instructions in place of Codex's, none of the person's settings, no project file, no saved session.
  return [
    'exec',
    ...(choice.model ? ['-m', choice.model] : []),
    ...(choice.effort ? ['-c', `model_reasoning_effort=${toml(choice.effort)}`] : []),
    '-c', `model_instructions_file=${toml(systemFile.replace(/\\/g, '/'))}`,
    '-c', 'project_doc_max_bytes=0',
    ...CODEX_LOCKED,
    '--ignore-user-config',
    '--ignore-rules',
    '--sandbox', 'read-only',
    '--ephemeral',
    '--skip-git-repo-check',
    '--color', 'never',
    '-o', outFile,
    '-',
  ]
}

export interface McpSetup {
  /** Claude Code reads a JSON file; Codex takes the same server on its command line. */
  file: string
  command: string[]
  env: Record<string, string>
  tools: string[]
}

/** An agent's run: the board's instructions, its folders, its tools, and the member's model and effort. */
export function agentArgs(provider: Provider, promptFile: string, others: string[], choice: AiChoice, mcp: McpSetup | null = null): string[] {
  const model = process.env.BOARD_AGENT_MODEL || choice.model
  if (provider === 'claude') {
    return [
      '-p',
      ...AGENT_PERMISSIONS,
      '--setting-sources', '',
      ...(mcp ? ['--mcp-config', mcp.file] : []),
      '--strict-mcp-config',
      ...(mcp && mcp.tools.length ? ['--allowedTools', mcp.tools.map(mcpName).join(',')] : []),
      '--disable-slash-commands',
      '--no-session-persistence',
      '--append-system-prompt-file', promptFile,
      '--add-dir', ...others,
      '--output-format', 'stream-json',
      '--verbose',
      '--include-partial-messages',
      ...(model ? ['--model', model] : []),
      ...(choice.effort ? ['--effort', choice.effort] : []),
    ]
  }
  const [command, ...args] = mcp?.command ?? []
  const env = Object.entries(mcp?.env ?? {})
    .map(([key, value]) => `${key} = ${toml(value)}`)
    .join(', ')
  return [
    'exec',
    ...(model ? ['-m', model] : []),
    ...(choice.effort ? ['-c', `model_reasoning_effort=${toml(choice.effort)}`] : []),
    '-c', `model_instructions_file=${toml(promptFile.replace(/\\/g, '/'))}`,
    '-c', 'project_doc_max_bytes=0',
    ...CODEX_LOCKED,
    // The board's tools are how it reads at all: the run stops if they don't start. The app checks every call, so
    // Codex asks no one before one.
    ...(mcp
      ? [
          '-c', `mcp_servers.${TOOL_SERVER}.command=${toml(command)}`,
          '-c', `mcp_servers.${TOOL_SERVER}.args=[${args.map(toml).join(', ')}]`,
          '-c', `mcp_servers.${TOOL_SERVER}.env={ ${env} }`,
          '-c', `mcp_servers.${TOOL_SERVER}.required=true`,
          '-c', `mcp_servers.${TOOL_SERVER}.default_tools_approval_mode="approve"`,
          '-c', `mcp_servers.${TOOL_SERVER}.startup_timeout_sec=30`,
          '-c', `mcp_servers.${TOOL_SERVER}.tool_timeout_sec=120`,
        ]
      : []),
    ...(process.platform === 'win32' ? ['-c', 'windows.sandbox="unelevated"'] : []),
    '--ignore-user-config',
    '--ignore-rules',
    '--sandbox', 'read-only',
    '--ephemeral',
    '--skip-git-repo-check',
    '--color', 'never',
    '--json',
    '-',
  ]
}

export interface RunEvent {
  doing?: string
  delta?: string
  source?: string
  result?: string
  error?: string
  toolsDown?: boolean
}

/** Pulls what the board shows out of Codex's JSONL events. Exported for its tests. */
export function readCodexEvent(line: string, toKnowledgePath: (path: string) => string | null): RunEvent {
  let event: any
  try {
    event = JSON.parse(line)
  } catch {
    return {}
  }
  const item = event?.item
  if (event.type === 'item.completed' && item?.type === 'agent_message' && typeof item.text === 'string') return { result: item.text }
  // Codex's own tools, such as list_mcp_resources, come as calls too: only the board's say what the agent does.
  if (event.type === 'item.started' && item?.type === 'mcp_tool_call' && item.server === TOOL_SERVER) {
    const tool = String(item.tool ?? '')
    const args = item.arguments && typeof item.arguments === 'object' ? item.arguments : {}
    if (tool === 'read_file' || tool === 'list_files' || tool === 'search_files') {
      const path = typeof args.path === 'string' ? args.path : ''
      const shown = (path && toKnowledgePath(path)) || path
      if (tool === 'read_file') return { doing: `Lit le fichier ${shown}`.trim(), source: (path && toKnowledgePath(path)) || undefined }
      const what = tool === 'search_files' ? String(args.text ?? '') : String(args.pattern ?? '') || shown
      return { doing: `Cherche dans les fichiers : ${what.slice(0, 80)}`.trim() }
    }
    const target = args.repo ? ` ${args.repo}${args.number ? `#${args.number}` : ''}` : ''
    return { doing: `${tool.startsWith('github_') ? 'Lit GitHub' : 'Agit sur GitHub'} : ${tool}${target}` }
  }
  if (event.type === 'turn.failed' || event.type === 'error') return { error: String(event.error?.message ?? event.message ?? 'erreur inconnue') }
  return {}
}

/** The program's name, for a sentence about it. */
export const providerName = (provider: Provider = chosen.provider) => PROVIDER_NAMES[provider]
