import type { IncomingMessage, ServerResponse } from 'node:http'
import type { AgentActivity, AgentResult, AgentRunner } from '../ai/agent.ts'
import type { AiPrograms, AiStub } from '../ai/programs.ts'
import type { EnvironmentConfig, Member } from '../environment/config.ts'
import type { Github } from '../github/client.ts'
import type { GithubContext, GhRequest } from '../github/copy.ts'
import type { BoardGit } from '../environment/git.ts'
import type { Knowledge } from '../environment/knowledge.ts'
import type { Live } from '../environment/live.ts'
import type { AgentPolicy } from '../ai/policy.ts'
import type { ReportWriter } from '../environment/reports.ts'
import type { Search } from '../environment/search.ts'
import type { Message, Store, Thread } from '../environment/store.ts'
import type { IssueApi, SynthesisFiles, SynthesisNames } from '../ai/synthesis.ts'
import type { ToolAction } from '../ai/tools.ts'
import type { Language, TranslateRun, Translator } from '../ai/translate.ts'
import type { VoiceApi, VoiceDrafts } from '../voice/engine.ts'
import type { WaitingApi } from '../github/waiting.ts'
import type { AiChoice, AiChoices, AiUse, Provider, ThreadChoices } from '../../shared/ai-uses.ts'
import type { NoticeSettings } from '../../shared/notices.ts'
import type { TextSize } from '../../shared/text-size.ts'
import type { Theme, ThemeColours } from '../../shared/themes.ts'

/**
 * What one open environment is made of, as `openBoard` builds it once and the route modules read it. The objects
 * never change; what a route can change is in `state`, so that every module sees the same value.
 */

export interface BoardOptions {
  /** The environment's clone. */
  root: string
  /** owner/name of the environment repository. */
  repo: string
  github: Github
  /** This member's own settings, kept for every environment on this computer. */
  settingsFile: string
  /** The built interface. */
  client: string
  version?: string
  /** Where this computer keeps the app's data: settings, environments, the command line. */
  home?: string
  /** Set in the installed app, which can replace itself. `error` is why the last check or download failed, until one works. */
  updates?: { available: () => string | null; check: () => Promise<void>; checkedAt: () => string | null; install: () => Promise<void>; progress?: () => number | null; error?: () => string | null }
  /** Set in the installed app: it quits as the tray's "Quitter" does, and starts again as it was opened. */
  restart?: () => void
  /** Set in the installed app: the data folder opens in the system's file manager. */
  openData?: () => Promise<void>
  /** How the agent reaches the board's tools. Without it, agents read files only. */
  tools?: { command: string[]; env: Record<string, string> } | null
  /** The address agents' tool calls come back to. */
  url: () => string
  /** Replaced in tests, by program: a real login would replace the person's. */
  claude?: AiStub
  codex?: AiStub
  /** The host's: which program and folders this computer uses. A board opened on its own (tests) reads its settings file. */
  programs?: AiPrograms
  /** Replaced in tests, for a board opened on its own: the person's home, where `~` and each program's usual folder are. */
  personHome?: string
  /** Replaced in tests: a real one downloads gigabytes and uses the graphics card. */
  voice?: VoiceApi
  onListening?: (listening: boolean) => void
  onBadge?: (counts: { unread: number; waiting: number }) => void
  /** Replaced in tests: a real translation spends the person's quota. */
  translate?: TranslateRun
  onLanguage?: (language: Language) => void
  onTheme?: (theme: Theme, colours: ThemeColours | null) => void
  /** The window scales the page. Without a window, the size isn't offered: a browser has its own zoom. */
  onTextSize?: (zoom: number) => void
  /** Replaced in tests: a real title spends the person's quota. */
  titler?: TranslateRun
  /** Replaced in tests: a real run spends the person's quota. */
  agent?: (input: { thread: Thread; messages: Message[]; task: string; asker: string; act: boolean; use: AiUse }) => Promise<AgentResult>
  /** Replaced in tests: a real issue stays on GitHub for good. */
  issues?: IssueApi
  /** Replaced in tests: a real answer is a comment on GitHub, under the person's name. */
  waiting?: WaitingApi
  /** Replaced in tests: real ones read the variables of the environment. */
  live?: Live
  /** Replaced in tests: real ones ask GitHub. */
  ask?: GhRequest
  /** Replaced in tests, which have no GitHub. */
  login?: string
  members?: Member[]
  /** Replaced in tests: never ask a real endpoint from a test. */
  probe?: (url: string) => Promise<{ ok: boolean; status: number | null; ms: number }>
  focus?: () => void
  /** Whether anyone can see the window. Left out, in a browser, the page's own timers decide. */
  onScreen?: () => boolean
  /** Off in tests: no pulling, no fetching. */
  loops?: boolean
}

export interface RunningBoard {
  repo: string
  login: string
  /** Answers a request under /api/. The host has checked where it comes from. */
  handle: (req: IncomingMessage, res: ServerResponse, url: URL) => Promise<void>
  theme: () => Theme
  themeColours: () => ThemeColours | null
  textSize: () => TextSize
  language: () => Language
  aiChoice: (use: AiUse, threadId?: string) => AiChoice
  /** The window is closing to the tray, where nothing would show that the microphone is open. */
  stopListening: () => void
  stop: () => Promise<void>
}


export interface Draft {
  threadId: string
  body: string
  sources: string[]
  actions: ToolAction[]
  /** The message it answers, or empty for a draft its owner asked for. */
  forMessage: string
  asker: string
  at: string
}

/** What changes while the environment is open: a member's choices, the configuration as last read, and where the app is in its life. */
export interface BoardState {
  /** The repository's collaborators, read again every few minutes. */
  members: Member[]
  language: Language
  theme: Theme
  textSize: TextSize
  customColours: ThemeColours | null
  models: Record<Provider, AiChoices>
  notices: NoticeSettings
  /** How this member's agent answers for them: their choice, on this computer. */
  policy: AgentPolicy
  /** What the page last counted, shown again when the badge is turned back on. */
  counts: { unread: number; waiting: number }
  config: EnvironmentConfig
  configWarning: string | null
  /** Why the configuration couldn't be checked, as opposed to who changed it. */
  configProblem: string | null
  /** Whether a ruleset protects the configuration, and when that was last asked. */
  protection: { at: number; protected: boolean }
  /** Questions whose draft was thrown away, so it isn't prepared again. */
  dismissed: string[]
  /** An agent woken before its documents arrive would say it can't read them. */
  knowledgeReady: boolean
  stopped: boolean
}

/** The program chosen and the member's choices for it, what a thread's panel shows: nothing in it runs the program. */
export interface AiView {
  provider: Provider
  choices: AiChoices
  models: string[]
  efforts: readonly string[]
}

/** What the agent's runs need, built first; the routes get this and the runs together. */
export interface BoardCore {
  options: BoardOptions
  /** The login `gh` uses, which can write to the environment. */
  login: string
  /** The environment's clone. */
  root: string
  cacheDir: string
  /** The last configuration an admin pushed, kept here when an unprotected one can't be trusted. */
  acceptedFile: string
  /** Off in tests: no pulling, no fetching, and GitHub is never asked. */
  knowledgeLoops: boolean
  api: Github
  ask: GhRequest
  store: Store
  git: BoardGit
  knowledge: Knowledge
  live: Live
  runner: AgentRunner
  translator: Translator
  voice: VoiceApi
  drafts: VoiceDrafts
  reports: ReportWriter
  search: Search
  synthesisFiles: SynthesisFiles
  issueApi: IssueApi
  /** Each thread's own choice of model, on this computer. */
  threadModels: Map<string, ThreadChoices>
  state: BoardState

  /** What each agent's run is doing right now, by thread. */
  activities: Map<string, AgentActivity>
  /** The last failure of an agent on a thread, said under the text box until someone asks again. */
  agentErrors: Map<string, string>
  /** Threads whose last synthesis failed: trying again there means that, not an answer. */
  failedSyntheses: Set<string>
  failedSummaries: Set<string>
  /** A draft the member asked for themselves, that failed: "Réessayer" asks for it again. */
  failedDrafts: Set<string>
  creatingIssues: Set<string>
  /** Threads with a run on the way, from before its program has even started. */
  answering: Set<string>
  /** Stopped while it was still waiting for GitHub, before its program started. */
  cancelled: Set<string>

  me: () => Member
  memberOf: (who: string) => Member
  names: () => Record<string, string>
  broadcast: (event: string, data: unknown) => void
  /** The model and effort for one use, in a thread or in general. */
  pick: (use: AiUse, threadId?: string) => AiChoice
  /** The models a program's own catalogue names on this computer, if it has one. */
  knownModels: (provider: Provider) => string[]
  aiView: () => Promise<AiView>
  /** The program, its folders and its state, for every environment of this computer. */
  ai: AiPrograms
  setThreadModels: (threadId: string, choices: ThreadChoices) => void
  saveSettings: () => Promise<void>
  saveAgent: () => Promise<void>
  showBadge: () => void
  isProtected: () => Promise<boolean>
  loadConfig: () => Promise<void>
  /** The copy of the main repository on GitHub, or null when none is configured. */
  copy: () => GithubContext | null
  /** Says this member is here and how their agent answers, for everyone's screens. */
  announce: () => Promise<void>
}

/** This member's agent at work, as `boardAgent` builds it. */
export interface BoardAgent {
  /** Whether this window of the app is the one that runs the member's agent, when two are open on the environment. */
  ownsAgent: () => Promise<boolean>
  /** Starts the agent wherever someone else's question is owed an answer, as the member's policy says. */
  wakeAgent: () => Promise<void>
  runAgent: (threadId: string, mention: Message | null, draft: boolean) => Promise<void>
  runSynthesis: (threadId: string) => Promise<void>
  runVoiceSummary: (threadId: string) => Promise<void>
  synthesisNames: () => Promise<SynthesisNames>
  nameThread: (threadId: string, body: string) => Promise<void>
  draftFile: (threadId: string) => string
  readDraft: (threadId: string) => Promise<Draft | null>
  /** A question whose draft was thrown away isn't prepared again. */
  dismiss: (id: string) => Promise<void>
}

export type BoardContext = BoardCore & BoardAgent

/** A group of routes under /api/: it answers, or returns false when the path is none of its own. */
export type RouteHandler = (req: IncomingMessage, res: ServerResponse, url: URL, parts: string[], method: string) => Promise<boolean | void>
