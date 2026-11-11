import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { replyTask } from '../ai/agent.ts'
import type { BoardAgent, BoardCore, Draft } from './board-context.ts'
import { mainRepository } from '../environment/config.ts'
import { mayAct, replyFor } from '../ai/policy.ts'
import { looksSecret } from '../lib/secrets.ts'
import { assertThreadId, type Message, owedMention, sameLogin, statusOf, type Thread } from '../environment/store.ts'
import { checkNames, forAgents, readAnswer, stateOf, stringsOf, type Synthesis, synthesisBody, synthesisFix, type SynthesisNames, synthesisTask } from '../ai/synthesis.ts'
import { madeTitle, TITLE_SYSTEM, titleSource } from '../ai/titles.ts'
import { aiRun, detectLanguage, writeWhole } from '../ai/translate.ts'
import { voiceState, voiceSummaryTask, withoutMentions } from '../ai/voice-summary.ts'
import type { AiUse } from '../../shared/ai-uses.ts'

/** An agent reads GitHub's state no older than this. */
const FRESH_FOR_AGENT_MS = 2 * 60_000
/** An agent answers from the last copy rather than wait for a slow GitHub. */
const AGENT_WAITS_MS = 45_000
/** Questions whose draft was thrown away, so it isn't prepared again. */
export const DISMISSED_MAX = 500

/**
 * This member's agent at work on the environment: woken when a question is owed an answer, asked for a draft,
 * a synthesis, a spoken summary or a title, always in their name and with their quota.
 */
export function boardAgent(core: BoardCore): BoardAgent {
  const { options, login, cacheDir, knowledgeLoops, store, git, knowledge, live, runner, synthesisFiles, activities, agentErrors, failedSyntheses, failedSummaries, failedDrafts, answering, cancelled, me, memberOf, names, broadcast, pick, saveAgent, copy, state } = core
  const draftsDir = join(cacheDir, 'drafts')
  /** Questions already tried in this run, so a failing agent doesn't retry every ten seconds. */
  const attempted = new Set<string>()

  const run = (input: { thread: Thread; messages: Message[]; task: string; asker: string; act: boolean; use: AiUse; doing?: string; now: string }) =>
    options.agent ? options.agent(input) : runner.answer({ ...input, streams: input.use === 'reply' })

  /** What an agent learns of now: who has what on GitHub, and whether its copies are current. */
  const nowForAgents = async () => {
    const history = (await copy()?.overview().catch(() => null))?.history
    const lines: string[] = []
    if (history) {
      for (const member of state.members) {
        const assigned = history.items.filter((item) => !item.closed && item.kind === 'issue' && (item.assignees ?? []).some((who) => sameLogin(who, member.login))).slice(0, 15)
        const pulls = history.pulls.filter((pull) => sameLogin(pull.author, member.login))
        if (assigned.length || pulls.length) lines.push(`- ${member.name} (${member.login}): ${assigned.map((item) => `#${item.number}`).join(', ') || 'no issue'} assigned; ${pulls.map((pull) => `PR #${pull.number}`).join(', ') || 'no open pull request'}.`)
      }
    }
    const people = live.last.members
    const online = state.members.filter((member) => people.some((entry) => entry.online && sameLogin(entry.login, member.login))).map((member) => member.name)
    const who = `${lines.length ? `Assigned on GitHub (${mainRepository(state.config)}):\n${lines.join('\n')}` : 'Nothing assigned on GitHub is known yet.'}\nOnline now: ${online.join(', ') || 'nobody else is known to be online'}.`
    return knowledge.lastError ? `${who}\nSome copies could not be refreshed, so they may be old: ${knowledge.lastError}` : who
  }

  const draftFile = (threadId: string) => join(draftsDir, `${threadId}.json`)
  const readDraft = async (threadId: string): Promise<Draft | null> => {
    assertThreadId(threadId)
    return readFile(draftFile(threadId), 'utf8').then((found) => JSON.parse(found) as Draft, () => null)
  }
  const saveDraft = async (draft: Draft) => {
    await mkdir(draftsDir, { recursive: true })
    await writeWhole(draftFile(draft.threadId), JSON.stringify(draft))
  }
  const dismiss = async (id: string) => {
    if (!id || state.dismissed.includes(id)) return
    state.dismissed = [...state.dismissed, id].slice(-DISMISSED_MAX)
    await saveAgent()
  }

  /**
   * Two windows of the app can be open on this environment: one of them is the member's agent, the other leaves
   * it be. The owner writes its process id and the time; a process that is gone, or quiet for a minute, loses it.
   */
  const ownerFile = join(cacheDir, 'agent-owner.json')
  const AGENT_OWNER_MS = 60_000
  const ownsAgent = async (): Promise<boolean> => {
    if (!knowledgeLoops) return true
    try {
      const found = JSON.parse(await readFile(ownerFile, 'utf8')) as { pid?: number; at?: number }
      if (found.pid && found.pid !== process.pid && Date.now() - (found.at ?? 0) < AGENT_OWNER_MS) {
        try {
          process.kill(found.pid, 0)
          return false
        } catch {
          // The process is gone: the file says nothing any more.
        }
      }
    } catch {
      // No owner yet, or a file that isn't one.
    }
    await writeWhole(ownerFile, JSON.stringify({ pid: process.pid, at: Date.now() })).catch(() => undefined)
    return true
  }

  /** Starts this member's agent wherever someone else's question is owed an answer, as their policy says. */
  async function wakeAgent(): Promise<void> {
    if (!state.knowledgeReady || state.policy.reply === 'off') return
    if (!(await ownsAgent())) return
    try {
      for (const summary of await store.listThreads()) {
        if (state.stopped) return
        if (summary.status === 'closed' || runner.isRunning(summary.id) || answering.has(summary.id)) continue
        const found = await store.readThread(summary.id)
        if (!found) continue
        const mention = owedMention(found.messages, login)
        if (!mention || attempted.has(mention.id) || state.dismissed.includes(mention.id)) continue
        const mode = replyFor(state.policy, mention.author, summary.id)
        if (mode === 'off') continue
        if (mode === 'draft' && (await readDraft(summary.id))?.forMessage === mention.id) continue
        attempted.add(mention.id)
        agentErrors.delete(found.thread.id)
        failedSyntheses.delete(found.thread.id)
        failedSummaries.delete(found.thread.id)
        void runAgent(found.thread.id, mention, mode === 'draft')
      }
    } catch {
      // Said by nothing: only a later wake-up can do anything about it.
    }
  }

  /** Waits for a fresh copy of GitHub, within reason: an agent answers from what is true now. */
  const freshCopy = async (threadId: string) => {
    const context = copy()
    if (!knowledgeLoops || !context || Date.now() - context.refreshedAt <= FRESH_FOR_AGENT_MS) return
    const waiting = { threadId, agent: login, doing: 'Synchronise GitHub', partial: '' }
    activities.set(threadId, waiting)
    broadcast('activity', waiting)
    await Promise.race([context.refreshIfOlder(FRESH_FOR_AGENT_MS), new Promise((done) => setTimeout(done, AGENT_WAITS_MS))])
  }

  const latestSynthesisLine = async (threadId: string, messages: Message[]) => {
    const latest = messages.findLast((message) => message.synthesis)
    if (!latest?.synthesis) return ''
    const line = forAgents(stateOf(latest.synthesis, await synthesisFiles.issues(threadId, latest.id)))
    return line ? `\n${line}` : ''
  }

  /** One run at a time on a thread. A failure is said on the thread, and costs nothing more until someone asks again. */
  async function runAgent(threadId: string, mention: Message | null, draft: boolean): Promise<void> {
    if (answering.has(threadId)) return
    answering.add(threadId)
    try {
      await freshCopy(threadId)
      if (state.stopped || cancelled.has(threadId)) return
      const found = await store.readThread(threadId)
      if (!found || statusOf(found.messages) === 'closed') return
      const asker = mention?.author ?? login
      const act = mayAct(state.policy, asker, login)
      const task = replyTask(me(), memberOf(asker), draft || !mention)
      const result = await run({ thread: found.thread, messages: found.messages, task, asker, act, use: 'reply', now: (await nowForAgents()) + (await latestSynthesisLine(threadId, found.messages)) })
      if (state.stopped || cancelled.has(threadId)) return
      // What an agent writes goes in the history for good too: one that looks like a secret waits for its member to read it.
      if (draft || !mention || looksSecret(result.body)) {
        await saveDraft({ threadId, body: result.body, sources: result.sources, actions: result.actions, forMessage: mention?.id ?? '', asker, at: new Date().toISOString() })
        broadcast('draft', { threadId })
        return
      }
      const { path } = await store.addMessage(threadId, { author: login, agent: 'auto', body: result.body, sources: result.sources, actions: result.actions, seen: found.messages.at(-1)?.id })
      await git.publish([path], `board: ${login} (agent) in ${threadId}`)
    } catch (error) {
      agentErrors.set(threadId, (error as Error).message)
      if (!mention) failedDrafts.add(threadId)
    } finally {
      answering.delete(threadId)
      cancelled.delete(threadId)
      activities.delete(threadId)
      broadcast('activity', { threadId, agent: login, done: true })
      broadcast('changed', { threadId })
      void wakeAgent()
    }
  }

  /** The names a synthesis may use: GitHub has the last word. */
  const synthesisNames = async (): Promise<SynthesisNames> => {
    const labels = await readFile(join(knowledge.root, 'github', 'labels.json'), 'utf8').then((found) => JSON.parse(found) as string[], () => [] as string[])
    const areas = labels.some((label) => label.startsWith('area:')) ? labels.filter((label) => label.startsWith('area:')) : labels.slice(0, 60)
    const milestones = await readFile(join(knowledge.root, 'github', 'milestones.json'), 'utf8').then((found) => (JSON.parse(found) as { title: string }[]).map((m) => m.title), () => [] as string[])
    return { members: state.members.map((member) => member.login), repos: state.config.repos.filter((repo) => repo.issues.create).map((repo) => repo.name), areas, milestones }
  }

  /** A title from what was asked. If this fails, the thread keeps the first words of its message: nobody has to do anything. */
  async function nameThread(threadId: string, body: string): Promise<void> {
    const write = options.titler ?? (!knowledgeLoops ? null : aiRun(() => pick('title')))
    const source = titleSource(body)
    if (!write || !/\p{L}/u.test(source)) return
    const decided = Date.now()
    try {
      const title = madeTitle(await write(TITLE_SYSTEM, source))
      if (!title || state.stopped || (await store.latestTitle(threadId))) return
      await git.publish([await store.addTitle(threadId, title, login, decided)], `board: ${login} named ${threadId}`)
      broadcast('changed', { threadId })
    } catch {
      // Not logged in, or out of quota: this isn't worth a message.
    }
  }

  async function runSynthesis(threadId: string): Promise<void> {
    if (answering.has(threadId)) return
    answering.add(threadId)
    try {
      const doing = 'Prépare la synthèse'
      const waiting = { threadId, agent: login, doing, partial: '' }
      activities.set(threadId, waiting)
      broadcast('activity', waiting)
      await freshCopy(threadId)
      if (state.stopped || cancelled.has(threadId)) return
      const found = await store.readThread(threadId)
      if (!found || statusOf(found.messages) === 'closed') return
      const namesFor = await synthesisNames()
      const now = (await nowForAgents()) + (await latestSynthesisLine(threadId, found.messages))
      const write = (fix = '') => run({ thread: found.thread, messages: found.messages, task: synthesisTask(namesFor) + fix, asker: login, act: false, use: 'synthesis', doing, now })
      const accepted = (answer: string) => {
        const read = readAnswer(answer)
        if (stringsOf(read).some(looksSecret)) throw new Error('La synthèse contient ce qui ressemble à un secret : elle resterait à vie dans l’historique.')
        if (detectLanguage(stringsOf(read).join(' ')) === 'fr') throw new Error('La synthèse doit être en anglais : réessayez.')
        checkNames(read, namesFor)
        return read
      }
      let { body, sources } = await write()
      let synthesis: Synthesis
      try {
        synthesis = accepted(body)
      } catch (error) {
        // A model's slip rarely happens twice. A failure of Claude Code itself isn't retried: it costs nothing more until someone asks.
        if (state.stopped || cancelled.has(threadId)) return
        ;({ body, sources } = await write(synthesisFix((error as Error).message, body)))
        synthesis = accepted(body)
      }
      if (state.stopped || cancelled.has(threadId)) return
      const { path } = await store.addMessage(threadId, { author: login, agent: 'auto', body: synthesisBody(synthesis), sources, seen: found.messages.at(-1)?.id, synthesis })
      await git.publish([path], `board: ${login} (agent) synthesised ${threadId}`)
    } catch (error) {
      failedSyntheses.add(threadId)
      agentErrors.set(threadId, `Synthèse impossible : ${(error as Error).message}`)
    } finally {
      answering.delete(threadId)
      cancelled.delete(threadId)
      activities.delete(threadId)
      broadcast('activity', { threadId, agent: login, done: true })
      broadcast('changed', { threadId })
      void wakeAgent()
    }
  }

  async function runVoiceSummary(threadId: string): Promise<void> {
    if (answering.has(threadId)) return
    answering.add(threadId)
    try {
      const doing = 'Résume la conversation'
      const waiting = { threadId, agent: login, doing, partial: '' }
      activities.set(threadId, waiting)
      broadcast('activity', waiting)
      const found = await store.readThread(threadId)
      if (!found || statusOf(found.messages) === 'closed') return
      const spoken = voiceState(found.messages)
      if (!spoken.ready) return
      const result = await run({ thread: found.thread, messages: found.messages, task: voiceSummaryTask(spoken.turns, names()), asker: login, act: false, use: 'summary', doing, now: await nowForAgents() })
      if (state.stopped || cancelled.has(threadId)) return
      const body = withoutMentions(result.body).trim()
      if (!body) throw new Error("L'agent n'a rien écrit.")
      if (looksSecret(body)) throw new Error('Le résumé contient ce qui ressemble à un secret : il resterait à vie dans l’historique.')
      const { path } = await store.addMessage(threadId, { author: login, agent: 'auto', body, sources: result.sources, seen: found.messages.at(-1)?.id, voiceSummary: true, covers: spoken.messages })
      await git.publish([path], `board: ${login} (agent) summarised ${threadId}`)
    } catch (error) {
      failedSummaries.add(threadId)
      agentErrors.set(threadId, `Résumé impossible : ${(error as Error).message}`)
    } finally {
      answering.delete(threadId)
      cancelled.delete(threadId)
      activities.delete(threadId)
      broadcast('activity', { threadId, agent: login, done: true })
      broadcast('changed', { threadId })
      void wakeAgent()
    }
  }

  return { ownsAgent, wakeAgent, runAgent, runSynthesis, runVoiceSummary, synthesisNames, nameThread, draftFile, readDraft, dismiss }
}
