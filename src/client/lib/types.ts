import type { Language } from '../../shared/i18n/i18n.ts'
import type { NoticeSettings } from '../../shared/notices.ts'
import type { Person, ReplyMode } from './people.tsx'
import type { Subject } from './subject.ts'
import type { Synthesis, SynthesisView } from '../features/threads/synthesis.tsx'
import type { TextSize } from '../../shared/text-size.ts'
import type { Theme, ThemeColours } from '../../shared/themes.ts'
import type { Draft, Poll, PollClosed, ToolAction, Vote, WaitingOn } from '../features/threads/thread-parts.tsx'
import type { VoiceState } from '../features/voice/voice.tsx'

/** What the server says about this member and the environment they have open. */
export interface Me {
  login: string
  name: string
  admin: boolean
  /** owner/name of the environment repository. */
  environment: string
  /** The main repository's address on GitHub, or empty before one is configured. */
  repository: string
  members: Person[]
  reply: ReplyMode
  configWarning: string | null
  syncError: string | null
  theme: Theme
  themeColours: ThemeColours | null
  /** Null in a browser, which has its own zoom. */
  textSize: TextSize | null
  knowledgeError: string | null
  version: string | null
  update: string | null
  language: Language
  notices: NoticeSettings
  conventions?: { epicLabel: string }
  timezone?: string
}
export interface Thread {
  id: string
  title: string
  kind: 'question' | 'topic'
  createdAt: string
  createdBy: string
  subject?: Subject
}
export interface Summary extends Thread {
  status: 'open' | 'closed'
  messageCount: number
  lastAt: string
  lastAuthor: string
  lastAgent: 'auto' | 'draft' | null
  lastMentions?: string[]
  lastPoll?: boolean
  openPolls?: { id: string; voters: string[] }[]
  preview: string
}
export interface Message {
  id: string
  author: string
  agent?: 'auto' | 'draft'
  createdAt: string
  mentions: string[]
  sources: string[]
  status?: 'open' | 'closed'
  attachments: Attachment[]
  body: string
  language: Language | null
  voice?: boolean
  voiceSummary?: boolean
  synthesis?: Synthesis
  actions?: ToolAction[]
  poll?: Poll
}
export interface Attachment {
  name: string
  file: string
  size: number
  type: string
}
export interface Upload {
  name: string
  type: string
  data: string
}
export interface Activity {
  threadId: string
  /** Whose agent: always this member's own, since each app runs only its member's agent. */
  agent: string
  doing: string
  partial: string
  done?: boolean
}
export interface ThreadView {
  thread: Thread
  messages: Message[]
  activity: Activity | null
  agentError: string | null
  waitingOn: WaitingOn[]
  votes: Vote[]
  pollStates?: Record<string, PollClosed>
  draft: Draft | null
  muted: boolean
  translations: Record<string, string>
  synthesis: SynthesisView | null
  voice?: VoiceState
}
export interface TreeNode {
  name: string
  path: string
  children?: TreeNode[]
}
