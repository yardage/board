import { LOGIN } from '../environment/config.ts'
import { REPLY_MODES, type ReplyMode } from '../environment/live.ts'

/**
 * How a member's agent answers for them. It is the member's own choice, on their computer: their
 * agent runs on their Claude Code and their quota, so only their app ever applies it. The mode is
 * published (live.ts) so that others know what to expect, and nothing else of it is.
 *
 * When someone else asks:
 *   off     nothing happens until the member answers.
 *   auto    the agent answers in the member's name, marked as the agent's.
 *   draft   the agent prepares an answer the member reads, changes and sends, or throws away.
 *
 * Whatever the mode, an agent only reads files and, if `act` allows the person who asked, acts on
 * GitHub within what the environment allows. It never runs a command or writes a file anywhere.
 */

export const PEOPLE_MODES = ['everyone', 'only', 'except'] as const
export const ACT_MODES = ['nobody', 'me', 'everyone', 'only'] as const

export interface AgentPolicy {
  reply: ReplyMode
  /** Whose questions it answers. */
  people: (typeof PEOPLE_MODES)[number]
  logins: string[]
  /** Threads where it never answers by itself. */
  mutedThreads: string[]
  /** Whose questions may make it act on GitHub: create an issue, comment, set a field. */
  act: (typeof ACT_MODES)[number]
  actLogins: string[]
}

export const DEFAULT_POLICY: AgentPolicy = { reply: 'draft', people: 'everyone', logins: [], mutedThreads: [], act: 'me', actLogins: [] }

const logins = (value: unknown) => [...new Set((Array.isArray(value) ? value : []).filter((login) => typeof login === 'string' && LOGIN.test(login)).map((login) => login.toLowerCase()))].slice(0, 2000)

export function parsePolicy(raw: any): AgentPolicy {
  if (typeof raw !== 'object' || raw === null) return { ...DEFAULT_POLICY }
  return {
    reply: (REPLY_MODES as readonly string[]).includes(raw.reply) ? raw.reply : DEFAULT_POLICY.reply,
    people: (PEOPLE_MODES as readonly string[]).includes(raw.people) ? raw.people : 'everyone',
    logins: logins(raw.logins),
    mutedThreads: (Array.isArray(raw.mutedThreads) ? raw.mutedThreads : []).filter((id: unknown) => typeof id === 'string' && /^[a-z0-9][a-z0-9-]{0,100}$/.test(id)).slice(-5000),
    act: (ACT_MODES as readonly string[]).includes(raw.act) ? raw.act : DEFAULT_POLICY.act,
    actLogins: logins(raw.actLogins),
  }
}

const listed = (list: string[], login: string) => list.includes(login.toLowerCase())

/** What the agent does for this question: the member's mode, or off. */
export function replyFor(policy: AgentPolicy, asker: string, threadId: string): ReplyMode {
  if (policy.reply === 'off' || policy.mutedThreads.includes(threadId)) return 'off'
  if (policy.people === 'only' && !listed(policy.logins, asker)) return 'off'
  if (policy.people === 'except' && listed(policy.logins, asker)) return 'off'
  return policy.reply
}

/** Whether this question may make the agent act on GitHub, beyond reading. */
export function mayAct(policy: AgentPolicy, asker: string, owner: string): boolean {
  if (asker.toLowerCase() === owner.toLowerCase()) return policy.act !== 'nobody'
  if (policy.act === 'everyone') return true
  return policy.act === 'only' && listed(policy.actLogins, asker)
}
