import { existsSync } from 'node:fs'
import { arch, homedir, platform, release } from 'node:os'
import { join, sep } from 'node:path'
import type { BoardContext, RouteHandler } from '../board-context.ts'
import { INSTALL_PAGE } from '../../ai/harness.ts'
import { canInstall, toolState } from '../../host/setup.ts'
import { HttpError, send } from '../../lib/http.ts'
import type { Provider } from '../../../shared/ai-uses.ts'

/**
 * What the "About" part shows: the app, its updates, the programs it works with, and its command line.
 * /api/about needs no program run; each program is asked on its own (/api/about/components/<id>), so that a
 * slow one holds up only its own row, and its answer is kept a minute. The updates' routes are here too.
 */

export const COMPONENTS = ['git', 'gh', 'claude', 'codex', 'voice'] as const
export type Component = (typeof COMPONENTS)[number]
const isComponent = (value: unknown): value is Component => (COMPONENTS as readonly unknown[]).includes(value)

/** A program's version, or where to get it: the setup installs Git and the GitHub CLI itself where Windows can. */
export interface ProgramView {
  id: Exclude<Component, 'voice'>
  installed: boolean
  version: string | null
  /** The setup's own install can put it here. */
  install: boolean
  /** Where to get it otherwise. */
  page: string
}

/** The dictation's two downloads, as chosen, or as the Dictation part would suggest them. */
export interface DictationView {
  id: 'voice'
  supported: boolean
  installing: boolean
  engine: { label: string | null; installed: boolean; size: number }
  model: { label: string | null; installed: boolean; size: number }
}

export interface AboutView {
  version: string | null
  platform: string
  /** Where the app keeps its data on this computer. */
  home: string | null
  canOpenData: boolean
  canRestart: boolean
  /** The command that starts the command line, here. */
  cli: string
  update: { can: boolean; available: string | null; checkedAt: string | null; progress: number | null; error: string | null }
}

/** Two commands run for a program: a minute is enough for every screen that asks. */
export const COMPONENT_MS = 60_000

const PAGES: Record<Exclude<Component, 'voice'>, string> = { git: 'https://git-scm.com/downloads', gh: 'https://cli.github.com', claude: INSTALL_PAGE.claude, codex: INSTALL_PAGE.codex }

const SYSTEMS: Record<string, string> = { win32: 'Windows', darwin: 'macOS', linux: 'Linux' }

/** "Windows 11 · x64": Windows 11 still calls itself 10, and only its build number tells them apart. */
export function platformName(system: string = platform(), version: string = release(), processor: string = arch()): string {
  const name = SYSTEMS[system] ?? system
  if (system !== 'win32') return `${name} · ${processor}`
  const build = Number(version.split('.')[2] ?? 0)
  return `${name} ${build >= 22_000 ? 11 : 10} · ${processor} · ${version}`
}

/** A path under the person's home, written from it, as the command line's own help writes it. */
const fromHome = (path: string) => {
  const home = homedir()
  return path.startsWith(home + sep) ? `~${path.slice(home.length).replaceAll(sep, '/')}` : path
}

/** The installed app puts the command line in the data folder; a clone runs it from its code. */
export function cliCommand(home: string | null): string {
  const script = home ? join(home, 'bin', 'board.mjs') : null
  return script && existsSync(script) ? `node ${fromHome(script)}` : 'npm run -s board --'
}

export function aboutRoutes(ctx: BoardContext): RouteHandler {
  const { options, voice, ai } = ctx
  const known = new Map<'git' | 'gh', { at: number; value: Promise<ProgramView> }>()

  /** The programs keep their own answer a minute, on the folder the member chose: what is seen here is what the AI part sees. */
  const program = async (provider: Provider, fresh: boolean): Promise<ProgramView> => {
    const status = await ai.status(provider, fresh)
    return { id: provider, installed: status.installed, version: status.version, install: false, page: PAGES[provider] }
  }

  const tool = async (id: 'git' | 'gh'): Promise<ProgramView> => {
    const found = await toolState(id)
    return { id, ...found, install: !found.installed && (await canInstall()), page: PAGES[id] }
  }

  /** Read anew each time: these are the app's own files, which the Dictation part changes, and reading them runs nothing. */
  const dictation = async (): Promise<DictationView> => {
    const status = await voice.status()
    const engine = status.engines.find((candidate) => candidate.id === (status.chosen.engine ?? status.recommended.engine))
    const model = status.models.find((candidate) => candidate.id === (status.chosen.model ?? status.recommended.model))
    return {
      id: 'voice',
      supported: status.supported,
      installing: status.installing !== null,
      engine: { label: engine?.label ?? null, installed: Boolean(status.chosen.engine && engine?.installed), size: engine && !engine.installed ? engine.size : 0 },
      model: { label: model?.label ?? null, installed: Boolean(status.chosen.model && model?.installed), size: model && !model.installed && !model.inSpeak ? model.size : 0 },
    }
  }

  /** Asked again after a minute, or when the person asks: an install made elsewhere is seen then. */
  const component = (id: Component, fresh: boolean): Promise<ProgramView | DictationView> => {
    if (id === 'voice') return dictation()
    if (id === 'claude' || id === 'codex') return program(id, fresh)
    const kept = known.get(id)
    if (!fresh && kept && Date.now() - kept.at < COMPONENT_MS) return kept.value
    const value = tool(id).catch((error) => {
      known.delete(id)
      throw error
    })
    known.set(id, { at: Date.now(), value })
    return value
  }

  const about = (): AboutView => ({
    version: options.version ?? null,
    platform: platformName(),
    home: options.home ?? null,
    canOpenData: Boolean(options.openData && options.home),
    canRestart: Boolean(options.restart),
    cli: cliCommand(options.home ?? null),
    update: {
      can: Boolean(options.updates),
      available: options.updates?.available() ?? null,
      checkedAt: options.updates?.checkedAt() ?? null,
      progress: options.updates?.progress?.() ?? null,
      error: options.updates?.error?.() ?? null,
    },
  })

  return async (_req, res, url, parts, method) => {
    if (method === 'GET' && parts[0] === 'about' && !parts[1]) return send(res, 200, about())
    if (method === 'GET' && parts[0] === 'about' && parts[1] === 'components' && parts.length === 3) {
      if (!isComponent(parts[2])) throw new HttpError(404, 'Introuvable.')
      return send(res, 200, await component(parts[2], url.searchParams.has('fresh')))
    }
    if (method === 'POST' && parts[0] === 'app' && parts[1] === 'restart') {
      if (!options.restart) throw new HttpError(404, 'Seule l’app installée redémarre d’ici.')
      if (options.updates?.progress?.() != null) throw new HttpError(409, 'Une mise à jour se télécharge : l’app redémarre d’elle-même une fois installée.')
      options.restart()
      return send(res, 200, { restarting: true })
    }
    if (method === 'POST' && parts[0] === 'app' && parts[1] === 'open-data') {
      if (!options.openData || !options.home) throw new HttpError(404, 'Seule l’app installée ouvre ce dossier.')
      try {
        await options.openData()
      } catch (error) {
        throw new HttpError(502, `Le dossier ne s’est pas ouvert : ${(error as Error).message}`)
      }
      return send(res, 200, { opened: true })
    }
    if (method === 'POST' && parts[0] === 'update' && parts[1] === 'check') {
      if (!options.updates) throw new HttpError(404, 'Introuvable.')
      try {
        await options.updates.check()
      } catch (error) {
        throw new HttpError(502, `GitHub n'a pas répondu : ${(error as Error).message}`)
      }
      return send(res, 200, { update: options.updates.available(), checkedAt: options.updates.checkedAt() })
    }
    if (method === 'GET' && parts[0] === 'update' && parts[1] === 'progress') return send(res, 200, { ratio: options.updates?.progress?.() ?? null })
    if (method === 'POST' && parts[0] === 'update' && !parts[1]) {
      if (!options.updates) throw new HttpError(404, 'Introuvable.')
      await options.updates.install()
      return send(res, 200, { installing: true })
    }
    return false
  }
}
