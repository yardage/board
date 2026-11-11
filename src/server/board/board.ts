import { randomBytes, timingSafeEqual } from 'node:crypto'
import { mkdir, readFile, stat } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join } from 'node:path'
import { type AgentActivity, AgentRunner, type ToolBridge } from '../ai/agent.ts'
import { currentProvider } from '../ai/harness.ts'
import { AiPrograms, updateSettings } from '../ai/programs.ts'
import { boardAgent, DISMISSED_MAX } from './board-agent.ts'
import type { AiView, BoardContext, BoardCore, BoardOptions, BoardState, RunningBoard } from './board-context.ts'
import { accessOf, CONFIG_FILE, configProtected, defaultConfig, formatConfig, mainRepository, type Member, parseConfig, readMembers, repositoryUrl, withNames } from '../environment/config.ts'
import { GithubError, askThrough } from '../github/client.ts'
import { GithubContext, type GhRequest } from '../github/copy.ts'
import { BoardGit } from '../environment/git.ts'
import { HttpError, MESSAGE_MAX, readJson, send } from '../lib/http.ts'
import { Infra } from '../infra/infra.ts'
import { itemFromGithub, itemView } from '../github/item.ts'
import { Knowledge, type TreeNode } from '../environment/knowledge.ts'
import { Live, ONLINE_MS, type ReplyMode } from '../environment/live.ts'
import { readPersonal, readReportFont, reportTheme } from './personal-settings.ts'
import { DEFAULT_POLICY, parsePolicy } from '../ai/policy.ts'
import { hostReadings } from '../infra/probes.ts'
import { REPORT_ID, ReportWriter, searchText, setReportZone, type ThreadActivity } from '../environment/reports.ts'
import { aboutRoutes } from './routes/about.ts'
import { settingsRoutes } from './routes/settings.ts'
import { threadsRoutes } from './routes/threads.ts'
import { voiceRoutes } from './routes/voice.ts'
import { waitingRoutes } from './routes/waiting.ts'
import { QUERY_MAX, Search } from '../environment/search.ts'
import { type PollState, pollOpen, sameLogin, setAliases, setSubjectRepos, Store } from '../environment/store.ts'
import { githubIssues, SynthesisFiles } from '../ai/synthesis.ts'
import { annotationsOf, runTool, type ToolAction, type ToolContext, toolsFor } from '../ai/tools.ts'
import { aiRun, detectLanguage, isLanguage, REPORT_PATH, Translator, writeWhole } from '../ai/translate.ts'
import { VoiceDrafts, type VoiceApi, VoiceEngine } from '../voice/engine.ts'
import { waitsFor } from '../github/waiting.ts'
import { type AiUse, choiceFor, EFFORTS, forProvider, type Provider, type ThreadChoices } from '../../shared/ai-uses.ts'
import { DEFAULT_TEXT_SIZE } from '../../shared/text-size.ts'
import { DEFAULT_NOTICES } from '../../shared/notices.ts'
import { setEpicLabel } from '../../shared/metrics.ts'

export type { BoardOptions, RunningBoard } from './board-context.ts'

const PULL_EVERY_MS = 10_000
const KNOWLEDGE_EVERY_MS = 5 * 60_000
/** A member's app says it is there this often: live.ts counts it gone after twice that. */
const ANNOUNCE_EVERY_MS = 5 * 60_000
/** Members' display names are asked again this often; in between, only a new member costs a request. */
const NAMES_FRESH_MS = 24 * 3_600_000
/** Pages of the repository's push activity read to find who pushed the configuration. */
const PUSH_PAGES_MAX = 10
/** Each thread can keep a choice on this computer: enough for years of threads, and the file stays small. */
const THREAD_MODELS_MAX = 500
/** Whether a configuration is protected by a ruleset: an admin's change, so asked again rarely. */
const PROTECTION_FRESH_MS = 60 * 60_000


export async function openBoard(options: BoardOptions): Promise<RunningBoard> {
  const { root, client, github: api } = options
  const ask: GhRequest = options.ask ?? askThrough(api)
  const knowledgeLoops = options.loops !== false

  // Who this is: the login `gh` uses, which must be able to write to the environment.
  const login = options.login ?? String((await api.get<any>('user'))?.login ?? '')
  if (!login) throw new Error('Connectez-vous à GitHub depuis le board, puis rouvrez l’environnement.')
  if (!options.login) {
    const permission = await api.get<any>(`repos/${options.repo}/collaborators/${login}/permission`).catch((error: unknown) => {
      if ((error as GithubError).status === 404) return { permission: 'none' }
      throw error
    })
    if (!['admin', 'maintain', 'write'].includes(String(permission?.permission))) throw new Error(`Le compte GitHub « ${login} » ne peut pas écrire dans ${options.repo} : demandez à un administrateur de l’y inviter.`)
  }

  const cacheDir = join(root, '.cache')
  await mkdir(cacheDir, { recursive: true })
  const membersFile = join(cacheDir, 'members.json')
  const acceptedFile = join(cacheDir, 'config-accepted.json')
  const agentFile = join(cacheDir, 'agent.json')

  // The host's, which every environment of this computer shares. A board opened on its own (tests) reads its
  // settings file, and refuses an account folder in its clone, which is pushed.
  const ai = options.programs ?? new AiPrograms({ boardHome: root, settingsFile: options.settingsFile, ai: { claude: options.claude, codex: options.codex }, home: options.personHome })
  if (!options.programs) await ai.load()
  const personal = await readPersonal(options.settingsFile, () => ai.catalogue())
  // What the routes may change, in one place every module reads: see BoardState.
  const state: BoardState = {
    members: options.members ?? (await readFile(membersFile, 'utf8').then((found) => JSON.parse(found) as Member[], () => [])),
    language: personal.language,
    theme: personal.theme,
    textSize: personal.textSize,
    customColours: personal.themeColours,
    models: personal.models,
    notices: personal.notices,
    // How this member's agent answers for them: their choice, on this computer, read below.
    policy: { ...DEFAULT_POLICY },
    counts: { unread: 0, waiting: 0 },
    // The configuration: anyone can push a file, so an unprotected one counts only when an admin pushed it.
    config: defaultConfig(options.repo.split('/')[1]),
    configWarning: null,
    configProblem: null,
    protection: { at: 0, protected: false },
    dismissed: [],
    knowledgeReady: !knowledgeLoops,
    stopped: false,
  }
  /** When display names were last asked for everyone: once a day, otherwise only for new members. */
  let namesAskedAt = 0
  const refreshMembers = async () => {
    if (options.members) return
    const listed = await readMembers(api, options.repo)
    if (!listed.length) return
    const known = Date.now() - namesAskedAt > NAMES_FRESH_MS ? new Map<string, string>() : new Map(state.members.filter((member) => member.name !== member.login).map((member) => [member.login.toLowerCase(), member.name]))
    if (!known.size) namesAskedAt = Date.now()
    state.members = await withNames(api, listed, known)
    await writeWhole(membersFile, JSON.stringify(state.members))
  }
  if (!options.members) await refreshMembers().catch(() => undefined)
  if (!state.members.some((member) => sameLogin(member.login, login))) state.members = [...state.members, { login, name: login, admin: false }]
  const me = () => state.members.find((member) => sameLogin(member.login, login)) ?? { login, name: login, admin: false }
  const memberOf = (who: string) => state.members.find((member) => sameLogin(member.login, who)) ?? { login: who, name: who, admin: false }
  const names = () => Object.fromEntries(state.members.map((member) => [member.login.toLowerCase(), member.name]))

  const git = new BoardGit(root, knowledgeLoops ? { remoteHead: async () => {
    const branch = (await readFile(join(root, '.git', 'HEAD'), 'utf8').catch(() => '')).trim().replace(/^ref: refs\/heads\//, '') || 'main'
    // Asked every 10 seconds: a slow answer is skipped rather than waited for.
    return (await api.text(`repos/${options.repo}/commits/${encodeURIComponent(branch)}`, 'application/vnd.github.sha', 5000)).trim() || null
  } } : {})
  const isProtected = async () => {
    if (Date.now() - state.protection.at > PROTECTION_FRESH_MS) state.protection = { at: Date.now(), protected: knowledgeLoops ? await configProtected(api, options.repo) : false }
    return state.protection.protected
  }
  /**
   * Who pushed a commit, from the repository's activity: GitHub records the account that pushed, which no commit can
   * forge. The activity comes newest first, so the search stops once it has gone past the commit's own time.
   */
  const pusherOf = async (commit: string): Promise<string | null> => {
    const madeAt = await git.commitTime(commit)
    let next: string | null = `repos/${options.repo}/activity?activity_type=push&per_page=100`
    for (let page = 0; next && page < PUSH_PAGES_MAX; page++) {
      const answer: { body: string; next: string | null } = await api.request('GET', next)
      for (const push of JSON.parse(answer.body || '[]') as any[]) {
        const after = String(push?.after ?? '')
        const before = String(push?.before ?? '')
        if (after === commit || ((await git.isAncestor(commit, after)) && !(await git.isAncestor(commit, before)))) return typeof push?.actor?.login === 'string' ? push.actor.login : null
        // A push made before the commit existed can't have carried it, nor can any older one.
        const pushedAt = Date.parse(String(push?.timestamp ?? ''))
        if (madeAt !== null && !Number.isNaN(pushedAt) && pushedAt < madeAt - 60_000) return null
      }
      next = answer.next
    }
    return null
  }
  const loadConfig = async () => {
    const raw = await readFile(join(root, CONFIG_FILE), 'utf8').catch(() => null)
    const parsed = parseConfig(raw === null ? null : (() => { try { return JSON.parse(raw) } catch { return null } })(), options.repo.split('/')[1])
    const accepted = await readFile(acceptedFile, 'utf8').then((found) => parseConfig(JSON.parse(found)), () => null)
    let trusted = true
    if (raw !== null && knowledgeLoops && !(await isProtected().catch(() => false))) {
      // The commit that wrote the file read here, not the remote's latest. Its author is whatever its maker typed, so what
      // counts is who pushed it, which only GitHub says.
      const commit = await git.lastCommitOf(CONFIG_FILE)
      const known = await readFile(`${acceptedFile}.sha`, 'utf8').catch(() => '')
      state.configProblem = null
      if (!commit || known !== commit) {
        const pusher = commit ? await pusherOf(commit).catch(() => null) : null
        trusted = Boolean(pusher) && state.members.some((member) => member.admin && sameLogin(member.login, pusher!))
      if (!pusher) state.configProblem = 'Le board n’a pas pu vérifier qui a envoyé la configuration : il garde la précédente. Un administrateur peut la protéger avec une règle GitHub, sous Réglages · Environnement.'
        if (trusted && commit) await writeWhole(`${acceptedFile}.sha`, commit)
      }
    }
    if (trusted) {
      state.config = parsed
      state.configWarning = null
      await writeWhole(acceptedFile, formatConfig(parsed))
    } else {
      state.config = accepted ?? defaultConfig(options.repo.split('/')[1])
      state.configWarning = state.configProblem ?? 'La configuration a été changée par quelqu’un qui n’est pas administrateur : le board garde la précédente.'
    }
    setAliases(state.config.aliases)
    setSubjectRepos(state.config.repos.map((repo) => repo.name))
    setReportZone(state.config.timezone, state.members.map(({ login: who, name }) => ({ login: who, name })), state.config.conventions.reportEveryHours)
    setEpicLabel(state.config.conventions.epicLabel)
  }
  await loadConfig()

  const threadModels = personal.threadModels
  const showBadge = () => options.onBadge?.(state.notices.badge ? state.counts : { unread: 0, waiting: 0 })
  // Read again, and only these keys written: another window may have written since, and the programs' own keys
  // (`aiProvider`, `aiPrograms`) are `ai`'s.
  const saveSettings = () =>
    updateSettings(options.settingsFile, (found) => ({ ...found, language: state.language, theme: state.theme, themeColours: state.customColours ?? undefined, textSize: state.textSize === DEFAULT_TEXT_SIZE ? undefined : state.textSize, models: state.models, threadModels: Object.fromEntries(threadModels), notifications: JSON.stringify(state.notices) === JSON.stringify(DEFAULT_NOTICES) ? undefined : state.notices }))
  /** The models Codex's own catalogue names on this computer, read when the settings are. */
  const knownModels = (provider: Provider) => ai.knownModels(provider)
  const pick = (use: AiUse, threadId?: string) => {
    const provider = currentProvider()
    return choiceFor(state.models[provider], threadId ? forProvider(threadModels.get(threadId), provider, knownModels(provider)) : undefined, use)
  }
  /** Oldest first: a Map keeps the order things were added in. */
  const setThreadModels = (threadId: string, choices: ThreadChoices) => {
    threadModels.delete(threadId)
    if (Object.keys(choices).length) threadModels.set(threadId, choices)
    while (threadModels.size > THREAD_MODELS_MAX) threadModels.delete(threadModels.keys().next().value as string)
  }

  try {
    const saved = JSON.parse(await readFile(agentFile, 'utf8'))
    state.policy = parsePolicy(saved?.policy)
    state.dismissed = (Array.isArray(saved?.dismissed) ? saved.dismissed : []).filter((id: unknown) => typeof id === 'string').slice(-DISMISSED_MAX)
  } catch {
    // The defaults: drafts for everyone, acting on GitHub only when asked by the member.
  }
  const saveAgent = () => writeWhole(agentFile, JSON.stringify({ policy: state.policy, dismissed: state.dismissed }))

  const store = new Store(root)
  const synthesisFiles = new SynthesisFiles(store.root)
  const issueApi = options.issues ?? githubIssues(api)
  const knowledge = new Knowledge(root, { ask, config: () => state.config })
  const live = options.live ?? new Live(api, options.repo)

  // The copy of the main repository on GitHub, made again when the configuration names another.
  let githubKey = ''
  let githubCopy: GithubContext | null = null
  const copy = () => {
    const main = mainRepository(state.config)
    const project = state.config.projects[0] ?? null
    const key = JSON.stringify([main, project?.owner, project?.number, state.config.waiting, state.config.conventions.reviewComment])
    if (key !== githubKey) {
      githubKey = key
      githubCopy = main ? new GithubContext(knowledge.root, ask, { repo: main, project: project ? { owner: project.owner, number: project.number } : null, waiting: state.config.waiting, reviewComment: state.config.conventions.reviewComment }) : null
    }
    return githubCopy
  }
  copy()

  /** The program chosen and the member's choices for it, what a thread's panel shows: nothing waits for the program. */
  const aiView = async (): Promise<AiView> => {
    const provider = currentProvider()
    return { provider, choices: state.models[provider], models: await ai.models(provider), efforts: EFFORTS[provider] }
  }
  const translator = new Translator(join(cacheDir, 'translations'), options.translate ?? aiRun(() => pick('translation')), login)
  const voiceDir = join(cacheDir, 'voice')
  const voice: VoiceApi = options.voice ?? new VoiceEngine({ dir: voiceDir })
  const drafts = new VoiceDrafts(voiceDir)
  // Nothing keeps listening across a start: the person reads what was cut short.
  await drafts.closeInterrupted().catch(() => undefined)
  void voice.clearLeftover().catch(() => undefined)
  const reportFont = await readReportFont(client)
  const reportPath = (path: string) => {
    if (!REPORT_PATH.test(path)) throw new HttpError(400, 'Seuls les rapports se traduisent.')
    return path
  }
  const clients = new Set<ServerResponse>()
  const activities = new Map<string, AgentActivity>()
  const agentErrors = new Map<string, string>()
  /** Threads whose last synthesis failed: trying again there means that, not an answer. */
  const failedSyntheses = new Set<string>()
  const failedSummaries = new Set<string>()
  /** A draft the member asked for themselves, that failed: "Réessayer" asks for it again. */
  const failedDrafts = new Set<string>()
  const creatingIssues = new Set<string>()
  /** Threads with a run on the way, from before its program has even started. */
  const answering = new Set<string>()
  /** Stopped while it was still waiting for GitHub, before its program started. */
  const cancelled = new Set<string>()
  const timers = new Set<NodeJS.Timeout>()

  function broadcast(event: string, data: unknown): void {
    for (const listener of clients) listener.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
  }

  // The tools an agent's run may call, through `board.mjs mcp`, with a token good for that run only.
  const toolRuns = new Map<string, { token: string; files: boolean; context: Omit<ToolContext, 'github' | 'config' | 'members' | 'files'>; actions: ToolAction[] }>()
  const bridge: ToolBridge | null = options.tools
    ? {
        command: options.tools.command,
        env: options.tools.env,
        get url() {
          return options.url()
        },
        open: ({ threadId, asker, act, files }) => {
          const id = randomBytes(12).toString('hex')
          const token = randomBytes(24).toString('hex')
          const entry = { token, files, context: { owner: login, asker, act, thread: { id: threadId, title: '' } }, actions: [] as ToolAction[] }
          toolRuns.set(id, entry)
          return { id, token, actions: () => [...entry.actions] }
        },
        close: (id) => {
          toolRuns.delete(id)
        },
      }
    : null

  const runner = new AgentRunner({
    knowledge,
    onActivity: (activity) => {
      activities.set(activity.threadId, activity)
      broadcast('activity', activity)
    },
    setup: () => ({ owner: me(), members: state.members, config: state.config, language: state.language }),
    choice: pick,
    bridge,
  })

  const search = new Search({
    repository: () => repositoryUrl(mainRepository(state.config)),
    threads: async () =>
      (await store.listThreads()).map((thread) => ({
        id: thread.id,
        title: thread.title,
        status: thread.status,
        lastAt: thread.lastAt,
        messageCount: thread.messageCount,
        messages: async () =>
          ((await store.readThread(thread.id))?.messages ?? []).map((message) => ({ id: message.id, who: `${memberOf(message.author).name}${message.agent === 'auto' ? ' (agent)' : ''}`, body: message.body })),
      })),
    items: async () => (await copy()?.overview().catch(() => null))?.history?.items ?? [],
    docs: async () => {
      const found: { name: string; path: string }[] = []
      const walk = (nodes: TreeNode[]) => {
        for (const node of nodes) {
          if (node.children) walk(node.children)
          else if (node.path) found.push({ name: node.name, path: node.path })
        }
      }
      walk(await knowledge.tree())
      return found.map((doc) => ({
        ...doc,
        stamp: async () => {
          const file = knowledge.resolve(doc.path)
          return file ? stat(file).then((info) => info.mtimeMs, () => null) : null
        },
        text: () => knowledge.read(doc.path),
      }))
    },
    reports: async () =>
      (await reports.list()).map((report) => ({
        id: report.id,
        title: report.kind === 'day' ? `Rapport du ${report.day}` : `Point de ${String(report.slot).padStart(2, '0')}:00, ${report.day}`,
        text: async () => {
          const found = await reports.read(report.id)
          return found ? searchText(found) : ''
        },
      })),
  })

  /** The board's threads as a report counts them: who wrote when, and each poll with its votes. */
  const threadActivity = async (): Promise<ThreadActivity[]> => {
    const found: ThreadActivity[] = []
    for (const summary of await store.listThreads()) {
      const read = await store.readThread(summary.id)
      if (!read) continue
      const withPolls = read.messages.filter((message) => message.poll)
      const [votes, states] = withPolls.length ? await Promise.all([store.votes(summary.id), store.pollStates(summary.id)]) : [[], new Map<string, PollState>()]
      found.push({
        id: summary.id,
        title: read.thread.title,
        createdAt: read.thread.createdAt,
        createdBy: read.thread.createdBy,
        status: summary.status,
        messages: read.messages.map((message) => ({ author: message.author, createdAt: message.createdAt, agent: message.agent, status: message.status, synthesis: Boolean(message.synthesis) })),
        polls: withPolls.map((message) => {
          const poll = message.poll!
          const cast = votes.filter((vote) => vote.poll === message.id && vote.choices.length)
          const tally = poll.options.map((_, index) => cast.filter((vote) => vote.choices.includes(index)).length)
          const top = Math.max(0, ...tally)
          const leaders = poll.options.filter((_, index) => top > 0 && tally[index] === top)
          const state = states.get(message.id)
          return { messageId: message.id, question: poll.question, createdAt: message.createdAt, closedAt: state?.closed ? new Date(state.at).toISOString() : null, closesAt: poll.closesAt ?? null, voters: cast.length, leading: leaders.length === 1 ? leaders[0] : null }
        }),
      })
    }
    return found
  }

  const reports = new ReportWriter({
    root,
    knowledgeRoot: knowledge.root,
    person: login,
    threads: threadActivity,
    repository: () => mainRepository(state.config),
    history: async () => (await copy()?.overview().catch(() => null))?.history ?? null,
    claim: (path, content, subject) => git.claim(path, content, subject),
    serverTime: () => api.serverTime(),
  })

  let infraKey = ''
  let infraReader: Infra | null = null
  const infra = () => {
    const main = mainRepository(state.config)
    if (!main) return null
    if (main !== infraKey) {
      infraKey = main
      infraReader = new Infra({
        knowledgeRoot: knowledge.root,
        repo: main,
        ask,
        endpoints: () => state.config.endpoints,
        probe: options.probe,
        hosts: async () => {
          const presence = await live.read(state.members.map((member) => member.login), 30_000)
          return hostReadings(state.config.hosts, presence.hosts, Date.now(), state.config.conventions.ciMemoryMib)
        },
        onRuns: (runs) => copy()?.noteRuns(runs),
      })
    }
    return infraReader
  }

  /** Says this member is here and how their agent answers, for everyone's screens. */
  const announce = () => (knowledgeLoops ? live.announce(login, state.policy.reply as ReplyMode).catch(() => undefined) : Promise.resolve())

  async function now(): Promise<unknown> {
    const presence = await live.read(state.members.map((member) => member.login))
    const history = (await copy()?.overview().catch(() => null))?.history ?? null
    const people = state.members.map((member) => {
      const found = presence.members.find((entry) => sameLogin(entry.login, member.login))
      const mine = sameLogin(member.login, login)
      return {
        ...member,
        online: mine ? true : Boolean(found?.online),
        reply: mine ? state.policy.reply : (found?.reply ?? null),
        seenAt: found?.at ?? null,
        assigned: (history?.items ?? []).filter((item) => !item.closed && (item.assignees ?? []).some((who) => sameLogin(who, member.login))).map((item) => ({ number: item.number, title: item.title, kind: item.kind })),
        pulls: (history?.pulls ?? []).filter((pull) => sameLogin(pull.author, member.login)).map((pull) => ({ number: pull.number, title: pull.title, draft: pull.draft, review: pull.review, ci: pull.ci })),
      }
    })
    return {
      me: login,
      members: people,
      activities: [...activities.values()].map(({ threadId, agent, doing }) => ({ threadId, agent, doing })),
      onlineMs: ONLINE_MS,
      liveError: presence.error,
    }
  }

  // Everything above, handed to the agent's runs and then, with them, to the route modules: they read the same
  // objects and change the same state.
  const core: BoardCore = {
    options,
    login,
    root,
    cacheDir,
    acceptedFile,
    knowledgeLoops,
    api,
    ask,
    store,
    git,
    knowledge,
    live,
    runner,
    translator,
    voice,
    drafts,
    reports,
    search,
    synthesisFiles,
    issueApi,
    threadModels,
    state,
    activities,
    agentErrors,
    failedSyntheses,
    failedSummaries,
    failedDrafts,
    creatingIssues,
    answering,
    cancelled,
    me,
    memberOf,
    names,
    broadcast,
    pick,
    knownModels,
    aiView,
    ai,
    setThreadModels,
    saveSettings,
    saveAgent,
    showBadge,
    isProtected,
    loadConfig,
    copy,
    announce,
  }
  const agent = boardAgent(core)
  const { ownsAgent, wakeAgent } = agent
  const ctx: BoardContext = { ...core, ...agent }
  const voiceRoute = voiceRoutes(ctx)
  const settingsRoute = settingsRoutes(ctx)
  const aboutRoute = aboutRoutes(ctx)
  const waitingRoute = waitingRoutes(ctx)
  const threadsRoute = threadsRoutes(ctx)

  /** The agent's tool calls, from `board.mjs mcp`: only with the token of a run that is under way. */
  async function toolsRoute(req: IncomingMessage, res: ServerResponse, parts: string[], method: string): Promise<void> {
    const entry = toolRuns.get(parts[1] ?? '')
    const given = Buffer.from(String(req.headers.authorization ?? '').replace(/^Bearer /, ''))
    const wanted = Buffer.from(entry?.token ?? '')
    if (!entry || given.length !== wanted.length || !timingSafeEqual(given, wanted)) throw new HttpError(403, 'Refusé.')
    const thread = await store.readThread(entry.context.thread.id).catch(() => null)
    const context: ToolContext = {
      ...entry.context,
      thread: { id: entry.context.thread.id, title: thread?.thread.title ?? '' },
      github: api,
      config: state.config,
      members: state.members.map((member) => member.login.toLowerCase()),
      files: entry.files ? knowledge.folders : null,
    }
    if (method === 'GET' && !parts[2]) {
      return send(res, 200, { tools: toolsFor(context).map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema, annotations: annotationsOf(tool) })) })
    }
    if (method === 'POST' && parts[2] === 'call') {
      const input = await readJson(req, 200_000)
      const name = String(input.name ?? '')
      if (!toolsFor(context).some((tool) => tool.name === name)) return send(res, 200, { text: `The tool ${name} isn't available in this run.`, isError: true })
      const result = await runTool(name, input.arguments ?? {}, context)
      if (result.action) entry.actions.push(result.action)
      return send(res, 200, { text: result.text, isError: result.isError === true, ...(result.image ? { image: result.image } : {}) })
    }
    throw new HttpError(404, 'Introuvable.')
  }

  async function handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const parts = url.pathname.split('/').filter(Boolean).slice(1).map(decodeURIComponent)
    const method = req.method ?? 'GET'

    if (parts[0] === 'tools') return toolsRoute(req, res, parts, method)
    if (method === 'GET' && parts[0] === 'me')
      return send(res, 200, {
        login,
        name: me().name,
        admin: me().admin,
        environment: options.repo,
        repository: repositoryUrl(mainRepository(state.config)),
        members: state.members,
        syncError: git.lastError,
        knowledgeError: knowledge.lastError ?? copy()?.lastError ?? null,
        configWarning: state.configWarning,
        version: options.version ?? null,
        update: options.updates?.available() ?? null,
        language: state.language,
        theme: state.theme,
        themeColours: state.customColours,
        textSize: options.onTextSize ? state.textSize : null,
        reply: state.policy.reply,
        notices: state.notices,
        conventions: state.config.conventions,
        timezone: state.config.timezone,
      })
    if (method === 'GET' && parts[0] === 'agent-ready') {
      const status = await ai.status()
      return send(res, 200, { ready: status.installed && status.loggedIn !== false })
    }
    if (parts[0] === 'voice') {
      await voiceRoute.handle(req, res, url, parts, method)
      return
    }
    if (await settingsRoute(req, res, url, parts, method)) return
    if ((await aboutRoute(req, res, url, parts, method)) !== false) return
    if (method === 'GET' && parts[0] === 'now') return send(res, 200, await now())
    if (parts[0] === 'waiting') {
      await waitingRoute.handle(req, res, url, parts, method)
      return
    }
    if (method === 'GET' && parts[0] === 'infra') {
      const reader = infra()
      if (!reader) return send(res, 200, { unconfigured: true })
      try {
        return send(res, 200, options.onScreen?.() === false ? reader.last() : await reader.snapshot())
      } catch (error) {
        throw new HttpError(502, `GitHub ne répond pas : ${(error as Error).message}`)
      }
    }
    if (method === 'GET' && parts[0] === 'item') {
      const number = Number(parts[1])
      if (!Number.isInteger(number) || number <= 0 || number > 9_999_999) throw new HttpError(404, 'Introuvable.')
      const context = copy()
      if (!context) throw new HttpError(404, 'Aucun dépôt n’est configuré.')
      const { history } = await context.overview().catch(() => ({ history: null }))
      let unread: string | null = null
      const found = await context.item(number).then(
        (raw) => itemFromGithub(number, raw),
        (error) => {
          unread = (error as Error).message.slice(0, 200)
          return null
        },
      )
      const view = itemView(number, found, history, repositoryUrl(context.repo), unread)
      if (!view) throw new HttpError(404, unread ? `GitHub n'a pas répondu : ${unread}` : 'Introuvable.')
      const waitingItem = (await waitingRoute.readWaitingState())?.waiting?.find((candidate) => candidate.number === number) ?? null
      const access = accessOf(state.config, context.repo)
      return send(res, 200, {
        ...view,
        waiting: waitingItem ? { who: waitingItem.who, question: waitingItem.question, mine: waitsFor(waitingItem, me()), label: state.config.waiting.label } : null,
        may: { comment: view.kind === 'pull' ? access.pulls.comment : access.issues.comment, review: view.kind === 'pull' && access.pulls.review },
      })
    }
    if (method === 'GET' && parts[0] === 'search') {
      const query = url.searchParams.get('q') ?? ''
      if (query.length > QUERY_MAX) throw new HttpError(400, 'Cette recherche est trop longue.')
      return send(res, 200, { hits: await search.find(query) })
    }
    if (method === 'GET' && parts[0] === 'reports') {
      if (!parts[1]) return send(res, 200, { reports: await reports.list(), error: reports.lastError })
      const report = REPORT_ID.test(parts[1]) ? await reports.read(parts[1]) : null
      if (!report) throw new HttpError(404, 'Ce rapport est introuvable, ou vient d’une version plus récente de l’app.')
      return send(res, 200, report)
    }
    if (method === 'GET' && parts[0] === 'overview') {
      const context = copy()
      if (!context) return send(res, 200, { history: null, members: state.members, unconfigured: true })
      // Only an open screen asks. It doesn't wait: the first reading of the whole history takes a minute.
      if (knowledgeLoops && options.onScreen?.() !== false) void context.live()
      return send(res, 200, { ...(await context.overview()), members: state.members, repository: repositoryUrl(context.repo) })
    }
    if (method === 'GET' && parts[0] === 'events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' })
      res.write(': connected\n\n')
      for (const activity of activities.values()) res.write(`event: activity\ndata: ${JSON.stringify(activity)}\n\n`)
      clients.add(res)
      req.on('close', () => clients.delete(res))
      // A broadcast can land between a client's end and its close: it mustn't throw where nothing listens.
      res.on('error', () => clients.delete(res))
      return
    }
    if (parts[0] === 'translate' && parts[1] === 'doc') {
      if (method === 'GET') {
        const to = url.searchParams.get('to')
        if (!isLanguage(to)) throw new HttpError(400, 'Langue inconnue.')
        return send(res, 200, translator.state(reportPath(url.searchParams.get('path') ?? ''), to))
      }
      if (method === 'POST') {
        const input = await readJson(req, MESSAGE_MAX)
        if (!isLanguage(input.to)) throw new HttpError(400, 'Langue inconnue.')
        const path = reportPath(String(input.path ?? ''))
        if (input.cancel === true) {
          translator.cancel(path, input.to)
          return send(res, 200, translator.state(path, input.to))
        }
        const content = await knowledge.read(path)
        if (content === null) throw new HttpError(404, 'Document introuvable.')
        return send(res, 200, await translator.start(path, content, input.to, input.again === true))
      }
    }
    if (method === 'GET' && parts[0] === 'tree') return send(res, 200, await knowledge.tree())
    if (method === 'GET' && parts[0] === 'polls') {
      const polls = await store.listPolls()
      return send(res, 200, { polls: polls.map((poll) => ({ ...poll, open: pollOpen(poll) })) })
    }
    if (method === 'GET' && parts[0] === 'doc') {
      const path = url.searchParams.get('path') ?? ''
      const content = await knowledge.read(path)
      if (content === null) throw new HttpError(404, 'Document introuvable.')
      const report = REPORT_PATH.test(path)
      const wanted = url.searchParams.get('lang')
      const shown = report && isLanguage(wanted) ? await translator.assemble(path, content, wanted) : content
      if (parts[1] === 'page') {
        if (!path.endsWith('.html')) throw new HttpError(404, 'Document introuvable.')
        // A report page runs its own charts: alone, in a sandbox, with no access to this app.
        res.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'content-security-policy': "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; frame-ancestors 'self'",
        })
        res.end(`<style>${reportFont}${reportTheme(state.theme, state.customColours)}</style>${shown}`)
        return
      }
      return send(res, 200, { path, content: shown, kind: path.endsWith('.html') ? 'html' : path.endsWith('.md') ? 'markdown' : 'text', language: report ? detectLanguage(content) : null })
    }
    if (parts[0] === 'threads') {
      await threadsRoute(req, res, url, parts, method)
      return
    }
    throw new HttpError(404, 'Introuvable.')
  }

  const every = (ms: number, work: () => Promise<unknown>) => {
    let handle: ReturnType<typeof setTimeout> | undefined
    const loop = async () => {
      if (handle) timers.delete(handle)
      await work().catch(() => undefined)
      if (!state.stopped) {
        handle = setTimeout(loop, ms)
        timers.add(handle)
      }
    }
    void loop()
  }

  if (knowledgeLoops) {
    every(PULL_EVERY_MS, async () => {
      // Only what came in can owe an answer: a quiet pull wakes nobody.
      if (await git.pull()) {
        store.changed()
        await loadConfig()
        broadcast('changed', {})
        await wakeAgent()
      }
    })
    every(ANNOUNCE_EVERY_MS, announce)
    every(KNOWLEDGE_EVERY_MS, async () => {
      await refreshMembers().catch(() => undefined)
      // An admin's app drops the variables of people who left, so that the repository's never fill up.
      if (me().admin) await live.prune(state.members.map((member) => member.login)).catch(() => undefined)
      await loadConfig().catch(() => undefined)
      // Another window of this app on the same environment refreshes the copies: this one reads what it wrote.
      if (await ownsAgent()) await knowledge.refresh()
      state.knowledgeReady = true
      broadcast('knowledge', {})
      broadcast('changed', {})
      await wakeAgent()
      // Its first run takes a minute or more, and an agent wakes without waiting for the loop.
      await copy()?.refresh()
      broadcast('knowledge', {})
      // Nobody asks for these: whichever app gets here first writes what is due.
      if (!state.stopped && (await reports.pass()).length) broadcast('changed', {})
    })
  }

  return {
    repo: options.repo,
    login,
    handle: async (req, res, url) => {
      try {
        await handle(req, res, url)
      } catch (error) {
        if (res.headersSent) {
          res.end()
          return
        }
        const status = error instanceof HttpError ? error.status : error instanceof GithubError && error.status < 500 ? 502 : 500
        send(res, status, { error: (error as Error).message })
      }
    },
    theme: () => state.theme,
    themeColours: () => state.customColours,
    textSize: () => state.textSize,
    language: () => state.language,
    aiChoice: pick,
    stopListening: voiceRoute.stopListening,
    stop: async () => {
      state.stopped = true
      broadcast('voice-stop', {})
      // Words already on their way would otherwise start the engine again as the app leaves.
      const closing = voice.close().catch(() => undefined)
      for (const timer of timers) clearTimeout(timer)
      runner.stopAll()
      translator.stop()
      for (const listener of clients) listener.end()
      // Leaves no lock or half-done rebase behind for the next start.
      await git.drain()
      await closing
    },
  }
}
