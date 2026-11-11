import { join } from 'node:path'
import { currentProvider } from '../../ai/harness.ts'
import type { BoardContext, RouteHandler } from '../board-context.ts'
import { CONFIG_FILE, formatConfig, parseConfig, protectConfig } from '../../environment/config.ts'
import { HttpError, MESSAGE_MAX, readJson, send } from '../../lib/http.ts'
import { parsePolicy } from '../../ai/policy.ts'
import { isLanguage, writeWhole } from '../../ai/translate.ts'
import { canBeLeftToProgram, isAiUse, parseChoice } from '../../../shared/ai-uses.ts'
import { parseNotices } from '../../../shared/notices.ts'
import { isTextSize, TEXT_ZOOM } from '../../../shared/text-size.ts'
import { isTheme, parseColours, themeProblem } from '../../../shared/themes.ts'

/**
 * What a member sets for themselves and what an admin sets for the environment: /api/settings, /api/environment,
 * the program's login, the badge and the window's focus. Updates are the About part's: routes/about.ts.
 */
export function settingsRoutes(ctx: BoardContext): RouteHandler {
  const { options, api, root, acceptedFile, git, knowledge, me, ai, aiView, knownModels, saveSettings, saveAgent, showBadge, isProtected, loadConfig, announce, broadcast, wakeAgent, login, state } = ctx
  return async (req, res, _url, parts, method) => {
    if (method === 'GET' && parts[0] === 'settings' && parts[1] === 'models') return send(res, 200, { ai: await aiView() })
    // The program's page: what is set, offered and chosen, at once; each program's state comes from its own request.
    if (method === 'GET' && parts[0] === 'ai' && !parts[1]) {
      send(res, 200, { ...(await ai.view()), choices: state.models })
      return true
    }
    if (parts[0] === 'ai') {
      await ai.route(req, res, parts, method)
      return true
    }
    if (method === 'GET' && parts[0] === 'settings') {
      return send(res, 200, {
        version: options.version ?? null,
        canUpdate: Boolean(options.updates),
        update: options.updates?.available() ?? null,
        checkedAt: options.updates?.checkedAt() ?? null,
        language: state.language,
        theme: state.theme,
        themeColours: state.customColours,
        // Never waits for the program: its state when already known, and a look started otherwise.
        ai: { provider: ai.provider, status: ai.lastStatus() },
        policy: state.policy,
        notices: state.notices,
        environment: { repo: options.repo, admin: me().admin, protected: await isProtected().catch(() => false), warning: state.configWarning, config: state.config },
      })
    }
    if (method === 'POST' && parts[0] === 'settings' && parts[1] === 'models') {
      const input = await readJson(req, MESSAGE_MAX)
      const provider = currentProvider()
      const choice = parseChoice(input, provider, knownModels(provider))
      if (!isAiUse(input.use) || !choice || (!choice.model && !canBeLeftToProgram(input.use))) throw new HttpError(400, 'Modèle ou effort inconnu.')
      state.models = { ...state.models, [provider]: { ...state.models[provider], [input.use]: choice } }
      await saveSettings()
      return send(res, 200, { ai: await aiView() })
    }
    if (method === 'POST' && parts[0] === 'settings' && parts[1] === 'theme') {
      const input = await readJson(req, MESSAGE_MAX)
      const chosen = input.theme
      if (!isTheme(chosen)) throw new HttpError(400, 'Thème inconnu.')
      let colours = state.customColours
      if (input.colours !== undefined) {
        const problem = themeProblem(input.colours)
        if (problem) throw new HttpError(400, problem)
        colours = parseColours(input.colours)
      }
      if (chosen === 'custom' && !colours) throw new HttpError(400, 'Aucune couleur choisie.')
      state.theme = chosen
      state.customColours = colours
      await saveSettings()
      options.onTheme?.(state.theme, state.customColours)
      return send(res, 200, { theme: state.theme, themeColours: state.customColours })
    }
    if (method === 'POST' && parts[0] === 'settings' && parts[1] === 'notifications') {
      const input = await readJson(req, MESSAGE_MAX)
      const kinds = input.kinds && typeof input.kinds === 'object' ? input.kinds : {}
      state.notices = parseNotices({ ...state.notices, ...input, kinds: { ...state.notices.kinds, ...kinds } })
      await saveSettings()
      showBadge()
      return send(res, 200, { notices: state.notices })
    }
    if (method === 'POST' && parts[0] === 'settings' && parts[1] === 'text-size') {
      const chosen = (await readJson(req, MESSAGE_MAX)).size
      if (!isTextSize(chosen)) throw new HttpError(400, 'Taille inconnue.')
      state.textSize = chosen
      await saveSettings()
      options.onTextSize?.(TEXT_ZOOM[state.textSize])
      return send(res, 200, { textSize: state.textSize })
    }
    if (method === 'POST' && parts[0] === 'settings' && parts[1] === 'language') {
      const chosen = (await readJson(req, MESSAGE_MAX)).language
      if (!isLanguage(chosen)) throw new HttpError(400, 'Langue inconnue.')
      state.language = chosen
      await saveSettings()
      options.onLanguage?.(state.language)
      return send(res, 200, { language: state.language })
    }
    if (method === 'POST' && parts[0] === 'settings' && parts[1] === 'policy') {
      state.policy = parsePolicy({ ...state.policy, ...(await readJson(req, MESSAGE_MAX)) })
      await saveAgent()
      void announce()
      broadcast('changed', {})
      void wakeAgent()
      return send(res, 200, { policy: state.policy })
    }
    if (method === 'POST' && parts[0] === 'environment' && parts[1] === 'config') {
      if (!me().admin) throw new HttpError(403, 'Seul un administrateur de l’environnement change sa configuration.')
      const input = await readJson(req, MESSAGE_MAX)
      // Saved from a configuration that is no longer the environment's: someone else's save would be undone without a word.
      if (input.base !== undefined && JSON.stringify(parseConfig(input.base, state.config.name)) !== JSON.stringify(state.config)) {
        throw new HttpError(409, 'La configuration a changé entre-temps : relisez-la, puis enregistrez de nouveau.')
      }
      const next = parseConfig(input.config, state.config.name)
      await writeWhole(join(root, CONFIG_FILE), formatConfig(next))
      // A commit GitHub refuses, by its ruleset say, would stop every push after it: it is taken back.
      const refused = async (why: string) => {
        await git.undoUnpushed(CONFIG_FILE).catch(() => undefined)
        // Nothing committed: the file written above goes back to what the repository has.
        await git.restore(CONFIG_FILE).catch(() => undefined)
        await loadConfig()
        return new HttpError(502, why)
      }
      try {
        await git.publish([CONFIG_FILE], `board: ${login} configured the environment`)
      } catch (error) {
        throw await refused(`La configuration n’a pas pu être envoyée : ${(error as Error).message}`)
      }
      if (git.lastError) throw await refused(`GitHub a refusé la configuration : ${git.lastError}`)
      const commit = await git.lastCommitOf(CONFIG_FILE)
      if (commit) await writeWhole(`${acceptedFile}.sha`, commit)
      await loadConfig()
      broadcast('changed', {})
      broadcast('knowledge', {})
      void knowledge.refresh().then(() => broadcast('knowledge', {}))
      return send(res, 200, { config: state.config })
    }
    if (method === 'POST' && parts[0] === 'environment' && parts[1] === 'protect') {
      if (!me().admin) throw new HttpError(403, 'Seul un administrateur protège la configuration.')
      state.protection = { at: Date.now(), protected: await protectConfig(api, options.repo) }
      return send(res, 200, { protected: state.protection.protected })
    }
    if (method === 'POST' && parts[0] === 'focus') {
      options.focus?.()
      return send(res, 200, {})
    }
    if (method === 'POST' && parts[0] === 'badge') {
      const input = await readJson(req, 1000)
      const counted = (value: unknown) => (Number.isInteger(value) && (value as number) >= 0 ? Math.min(value as number, 9999) : 0)
      state.counts = { unread: counted(input.unread), waiting: counted(input.waiting) }
      showBadge()
      return send(res, 200, {})
    }
    return false
  }
}
