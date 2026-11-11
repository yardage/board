import { createReadStream } from 'node:fs'
import { lstat, rm } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { extname, join } from 'node:path'
import { currentProvider } from '../../ai/harness.ts'
import type { BoardContext, RouteHandler } from '../board-context.ts'
import { HttpError, MESSAGE_MAX, readBody, readJson, readPoll, readUploads, send, text, WITH_FILES_MAX } from '../../lib/http.ts'
import { parsePolicy, replyFor } from '../../ai/policy.ts'
import { looksSecret } from '../../lib/secrets.ts'
import { assertThreadId, ATTACHMENT_FILE, oneLine, owedMention, parseSubject, pollOpen, sameLogin, showsSomething, statusOf } from '../../environment/store.ts'
import { checkNames, createIssues, stateOf, stringsOf, withStrings } from '../../ai/synthesis.ts'
import { firstWords, TITLE_MAX } from '../../ai/titles.ts'
import { detectLanguage, isLanguage } from '../../ai/translate.ts'
import { voiceState } from '../../ai/voice-summary.ts'
import { forProvider, isThreadUse, parseChoice, parseThreadChoices } from '../../../shared/ai-uses.ts'

/** What a browser may show by itself. Everything else, HTML and SVG first, can only be downloaded. */
const SHOWN_INLINE: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
}


/** The routes under /api/threads: the list, a thread and its messages, polls, drafts, syntheses and what an agent does there. */
export function threadsRoutes(ctx: BoardContext): RouteHandler {
  const {
    store,
    git,
    login,
    broadcast,
    wakeAgent,
    nameThread,
    aiView,
    threadModels,
    knownModels,
    setThreadModels,
    saveSettings,
    saveAgent,
    translator,
    synthesisFiles,
    live,
    readDraft,
    draftFile,
    dismiss,
    activities,
    agentErrors,
    me,
    memberOf,
    answering,
    cancelled,
    failedDrafts,
    failedSyntheses,
    failedSummaries,
    runAgent,
    runVoiceSummary,
    runSynthesis,
    synthesisNames,
    knowledgeLoops,
    issueApi,
    creatingIssues,
    runner,
    state,
  } = ctx

  /** Who closed each poll of a thread, and when, for the screen. */
  const pollStatesOf = async (id: string): Promise<Record<string, { at: string; by: string }>> =>
    Object.fromEntries([...(await store.pollStates(id)).values()].filter((state) => state.closed).map((state) => [state.poll, { at: new Date(state.at).toISOString(), by: state.by }]))

  async function handle(req: IncomingMessage, res: ServerResponse, _url: URL, parts: string[], method: string): Promise<void> {
    if (method === 'GET' && !parts[1]) {
      // The page asks at every refresh: when nothing moved since its last answer, the answer is that.
      const tag = `"threads-${store.version}"`
      if (req.headers['if-none-match'] === tag) {
        res.writeHead(304, { etag: tag, 'cache-control': 'no-cache' })
        res.end()
        return
      }
      const list = await store.listThreads()
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-cache', etag: tag })
      res.end(JSON.stringify(list))
      return
    }
    if (method === 'POST' && !parts[1]) {
      const input = await readJson(req, WITH_FILES_MAX)
      // Sessions write their own title. In the app, a thread gets one from its first message, and can be renamed.
      const given = input.title === undefined ? '' : text(input.title, 'Titre', TITLE_MAX)
      if (looksSecret(given)) throw new HttpError(400, 'Ce titre ressemble à un secret : il resterait à vie dans l’historique.')
      const poll = readPoll(input)
      const uploads = readUploads(input)
      const body = readBody(input, uploads, poll)
      const kind = input.kind === 'question' || poll || (input.kind === undefined && body.replace(/\S*:\/\/\S*/g, '').includes('?')) ? 'question' : 'topic'
      const subject = parseSubject(input.subject)
      if (subject) for (const field of ['title', 'detail'] as const) if (subject[field] && looksSecret(subject[field])) delete subject[field]
      const fromSubject = subject ? [subject.label, subject.title].filter(Boolean).join(' · ').slice(0, TITLE_MAX) : ''
      const title = given || (looksSecret(fromSubject) ? '' : fromSubject) || (poll ? poll.question.slice(0, 80) : '') || firstWords(body) || 'Nouveau fil'
      const thread = await store.createThread({ title, kind, author: login, subject: subject ?? undefined })
      const { paths, message: first } = await store.addMessage(thread.id, { author: login, body, uploads, ...(poll ? { poll } : {}) })
      const chosenModels = parseThreadChoices(input.models)
      if (Object.keys(chosenModels).length) {
        setThreadModels(thread.id, chosenModels)
        await saveSettings().catch(() => undefined)
      }
      await git.publish([`threads/${thread.id}/thread.json`, ...paths], `board: new thread ${thread.id}`)
      send(res, 201, { ...thread, firstMessage: first.id })
      broadcast('changed', { threadId: thread.id })
      void wakeAgent()
      if (!given && !subject && !poll) void nameThread(thread.id, body)
      return
    }
    const id = parts[1]
    if (!id) throw new HttpError(404, 'Introuvable.')
    assertThreadId(id)
    if (parts[2] === 'models') {
      if (!(await store.readThread(id))) throw new HttpError(404, 'Introuvable.')
      const threadView = async () => ({ ai: { ...(await aiView()), thread: forProvider(threadModels.get(id), currentProvider(), knownModels(currentProvider())) } })
      if (method === 'GET') return send(res, 200, await threadView())
      if (method === 'POST') {
        const input = await readJson(req, MESSAGE_MAX)
        const provider = currentProvider()
        const choice = parseChoice(input, provider, knownModels(provider))
        if (!isThreadUse(input.use) || !choice) throw new HttpError(400, 'Modèle ou effort inconnu.')
        setThreadModels(id, parseThreadChoices({ ...threadModels.get(id), [input.use]: choice }))
        await saveSettings()
        return send(res, 200, await threadView())
      }
    }
    if (method === 'GET' && parts[2] === 'attachments') {
      const file = parts[3] ?? ''
      if (!ATTACHMENT_FILE.test(file)) throw new HttpError(404, 'Fichier introuvable.')
      const full = join(store.root, id, 'attachments', file)
      // lstat: a link someone pushed is no file of theirs to download.
      const isFile = await lstat(full).then((found) => found.isFile(), () => false)
      if (!isFile) throw new HttpError(404, 'Fichier introuvable.')
      const inline = SHOWN_INLINE[extname(file).toLowerCase()]
      res.writeHead(200, {
        'content-type': inline ?? 'application/octet-stream',
        'content-disposition': inline ? 'inline' : `attachment; filename="${file}"`,
        'x-content-type-options': 'nosniff',
        'content-security-policy': "sandbox; default-src 'none'",
      })
      createReadStream(full).on('error', () => res.destroy()).pipe(res)
      return
    }
    const found = await store.readThread(id)
    if (!found) throw new HttpError(404, 'Fil introuvable.')
    if (method === 'GET' && !parts[2]) {
      const translations: Record<string, string> = {}
      // A synthesis is always in English: it can become issues, and its few words may not be enough to tell.
      const messages = found.messages.map((message) => ({ ...message, language: message.status ? null : message.synthesis ? ('en' as const) : detectLanguage(message.body) }))
      const current = found.messages.findLast((message) => message.synthesis)
      for (const message of messages) {
        if (!message.language || message.language === state.language || message.id === current?.id) continue
        const translated = await translator.cachedText(message.body, state.language)
        if (translated !== null) translations[message.id] = translated
      }
      let synthesisView = null
      if (current?.synthesis) {
        const strings = state.language === 'en' ? null : await translator.cachedStrings(stringsOf(current.synthesis), state.language)
        synthesisView = { id: current.id, state: stateOf(current.synthesis, await synthesisFiles.issues(id, current.id)), translated: strings ? withStrings(current.synthesis, strings) : null }
      }
      // Who is asked and hasn't answered yet, and what each one's agent does about it.
      const presence = await live.read(state.members.map((member) => member.login)).catch(() => live.last)
      const waitingOn = state.members
        .filter((member) => !sameLogin(member.login, login) && owedMention(found.messages, member.login))
        .map((member) => {
          const known = presence.members.find((entry) => sameLogin(entry.login, member.login))
          return { login: member.login, name: member.name, online: Boolean(known?.online), reply: known?.reply ?? null }
        })
      const draft = await readDraft(id)
      return send(res, 200, {
        ...found,
        messages,
        translations,
        synthesis: synthesisView,
        voice: voiceState(found.messages),
        votes: await store.votes(id),
        pollStates: await pollStatesOf(id),
        activity: activities.get(id) ?? null,
        agentError: agentErrors.get(id) ?? null,
        waitingOn,
        draft,
        muted: state.policy.mutedThreads.includes(id),
      })
    }
    if (method === 'POST' && parts[2] === 'title') {
      const title = oneLine(text((await readJson(req, MESSAGE_MAX)).title, 'Titre', TITLE_MAX), TITLE_MAX)
      if (!showsSomething(title)) throw new HttpError(400, 'Titre manquant.')
      if (looksSecret(title)) throw new HttpError(400, 'Ce titre ressemble à un secret : il resterait à vie dans l’historique.')
      if (title === found.thread.title) return send(res, 200, { title })
      await git.publish([await store.addTitle(id, title, login)], `board: ${login} renamed ${id}`)
      send(res, 200, { title })
      broadcast('changed', { threadId: id })
      return
    }
    if (method === 'POST' && parts[2] === 'mute') {
      const muted = (await readJson(req, MESSAGE_MAX)).muted === true
      state.policy = parsePolicy({ ...state.policy, mutedThreads: muted ? [...state.policy.mutedThreads.filter((one) => one !== id), id] : state.policy.mutedThreads.filter((one) => one !== id) })
      await saveAgent()
      return send(res, 200, { muted })
    }
    if (method === 'POST' && parts[2] === 'votes') {
      const input = await readJson(req, MESSAGE_MAX)
      const poll = found.messages.find((message) => message.id === input.poll && message.poll)
      if (!poll?.poll) throw new HttpError(404, 'Ce sondage est introuvable.')
      if (statusOf(found.messages) === 'closed') throw new HttpError(409, 'Ce fil est clos.')
      const pollState = (await store.pollStates(id)).get(poll.id)
      if (!pollOpen({ threadStatus: 'open', poll: poll.poll, closed: pollState?.closed ? { at: '', by: pollState.by } : null })) throw new HttpError(409, 'Ce sondage est clos.')
      const choices = [...new Set(Array.isArray(input.choices) ? input.choices : [])].filter((choice): choice is number => Number.isInteger(choice) && (choice as number) >= 0 && (choice as number) < poll.poll!.options.length)
      if (!poll.poll.multiple && choices.length > 1) throw new HttpError(400, 'Un seul choix pour ce sondage.')
      await git.publish([await store.addVote(id, poll.id, choices, login)], `board: ${login} voted in ${id}`)
      broadcast('changed', { threadId: id })
      return send(res, 200, { votes: await store.votes(id) })
    }
    if (method === 'POST' && parts[2] === 'polls' && parts[3] && parts[4] === 'close') {
      const input = await readJson(req, MESSAGE_MAX)
      const poll = found.messages.find((message) => message.id === parts[3] && message.poll)
      if (!poll?.poll) throw new HttpError(404, 'Ce sondage est introuvable.')
      if (statusOf(found.messages) === 'closed') throw new HttpError(409, 'Ce fil est clos.')
      // Its author decides when it ends, and an admin can end any.
      if (!sameLogin(poll.author, login) && !me().admin) throw new HttpError(403, 'Seul l’auteur du sondage, ou un administrateur, le clôt.')
      const closed = input.closed !== false
      await git.publish([await store.setPollClosed(id, poll.id, closed, login)], `board: ${login} ${closed ? 'closed' : 'reopened'} a poll in ${id}`)
      broadcast('changed', { threadId: id })
      return send(res, 200, { closed, pollStates: await pollStatesOf(id) })
    }
    if (parts[2] === 'draft') {
      if (method === 'POST' && !parts[3]) {
        if (statusOf(found.messages) === 'closed') throw new HttpError(409, 'Ce fil est clos.')
        if (!state.knowledgeReady) throw new HttpError(409, 'Les dépôts se synchronisent encore : réessayez dans une minute.')
        if (answering.has(id)) throw new HttpError(409, 'Votre agent travaille déjà sur ce fil.')
        agentErrors.delete(id)
        failedDrafts.delete(id)
        void runAgent(id, null, true)
        return send(res, 202, { started: true })
      }
      const draft = await readDraft(id)
      if (method === 'POST' && parts[3] === 'discard') {
        await rm(draftFile(id), { force: true })
        if (draft?.forMessage) await dismiss(draft.forMessage)
        broadcast('changed', { threadId: id })
        return send(res, 200, { discarded: true })
      }
      if (method === 'POST' && parts[3] === 'send') {
        if (!draft) throw new HttpError(404, 'Ce brouillon n’existe plus.')
        if (statusOf(found.messages) === 'closed') throw new HttpError(409, 'Ce fil est clos : rouvrez-le pour publier.')
        const body = text((await readJson(req, MESSAGE_MAX)).body, 'Message', MESSAGE_MAX)
        if (looksSecret(body)) throw new HttpError(400, 'Ce message ressemble à un secret : il resterait à vie dans l’historique.')
        const { paths, message } = await store.addMessage(id, { author: login, agent: 'draft', body, sources: draft.sources, actions: draft.actions, seen: found.messages.at(-1)?.id })
        await rm(draftFile(id), { force: true })
        await git.publish(paths, `board: ${login} in ${id}`)
        broadcast('changed', { threadId: id })
        void wakeAgent()
        return send(res, 201, message)
      }
      throw new HttpError(404, 'Introuvable.')
    }
    if (method === 'POST' && parts[2] === 'voice-summary') {
      if (statusOf(found.messages) === 'closed') throw new HttpError(409, 'Ce fil est clos.')
      if (!state.knowledgeReady) throw new HttpError(409, 'Les dépôts se synchronisent encore : réessayez dans une minute.')
      if (answering.has(id)) throw new HttpError(409, 'Votre agent travaille déjà sur ce fil.')
      // Another member may have just asked for the same thing, on their quota.
      if (knowledgeLoops && (await git.pull().catch(() => false))) store.changed()
      const again = await store.readThread(id)
      const spoken = again ? voiceState(again.messages) : null
      if (!spoken?.ready) throw new HttpError(409, spoken?.parts.length ? 'Il faut au moins deux voix publiées pour un résumé.' : 'Un résumé de cette conversation vient d’arriver.')
      agentErrors.delete(id)
      failedSyntheses.delete(id)
      failedSummaries.delete(id)
      void runVoiceSummary(id)
      return send(res, 202, { started: true })
    }
    if (method === 'POST' && parts[2] === 'synthesis' && !parts[3]) {
      if (statusOf(found.messages) === 'closed') throw new HttpError(409, 'Ce fil est clos.')
      if (!state.knowledgeReady) throw new HttpError(409, 'Les dépôts se synchronisent encore : réessayez dans une minute.')
      agentErrors.delete(id)
      failedSyntheses.delete(id)
      failedSummaries.delete(id)
      void runSynthesis(id)
      return send(res, 202, { started: true })
    }
    if (method === 'POST' && parts[2] === 'synthesis') {
      const message = found.messages.findLast((candidate) => candidate.synthesis)
      if (!message?.synthesis || message.id !== parts[3]) throw new HttpError(409, 'Une synthèse plus récente la remplace.')
      // A synthesis is an agent's proposal: a message that only says it is one doesn't count.
      if (!message.agent) throw new HttpError(409, 'Cette synthèse n’a pas été écrite par un agent.')
      const synthesis = message.synthesis
      if (parts[4] === 'translate') {
        const input = await readJson(req, MESSAGE_MAX)
        const to = input.to
        if (!isLanguage(to)) throw new HttpError(400, 'Langue inconnue.')
        try {
          return send(res, 200, { synthesis: withStrings(synthesis, await translator.strings(stringsOf(synthesis), to, input.again === true)) })
        } catch (error) {
          throw new HttpError(502, `Traduction impossible : ${(error as Error).message}`)
        }
      }
      if (statusOf(found.messages) === 'closed') throw new HttpError(409, 'Ce fil est clos.')
      if (parts[4] === 'issues') {
        if (creatingIssues.has(message.id)) throw new HttpError(409, 'La création de ces tickets est déjà en cours.')
        creatingIssues.add(message.id)
        try {
          // What another member did may only be on GitHub: never decide from an old copy.
          await git.pull()
          if (git.lastError) throw new HttpError(503, `Impossible de vérifier l'état du fil : ${git.lastError}`)
          const check = async () => {
            const again = await store.readThread(id)
            if (!again || statusOf(again.messages) === 'closed') throw new HttpError(409, 'Ce fil est clos.')
            if (again.messages.findLast((candidate) => candidate.synthesis)?.id !== message.id) throw new HttpError(409, 'Une synthèse plus récente la remplace.')
            const progress = stateOf(synthesis, await synthesisFiles.issues(id, message.id))
            if (progress.waiting === 'open') throw new HttpError(409, 'Des points restent à trancher : réglez-les dans le fil, puis synthétisez à nouveau.')
            if (progress.waiting === 'no-work') throw new HttpError(409, 'Cette synthèse ne propose aucun travail.')
            // Written by another app, or before the configuration changed: the names are checked here, now.
            try {
              checkNames(synthesis, await synthesisNames())
            } catch (error) {
              throw new HttpError(409, (error as Error).message)
            }
            return progress
          }
          const before = await check()
          if (before.issues.length === synthesis.work.length) return send(res, 200, { issues: before.issues })
          // Only one member creates them, whatever two computers do at the same moment.
          const mine = JSON.stringify({ by: login, at: new Date().toISOString() })
          const claim = await git.claim(synthesisFiles.claimPath(id, message.id), mine)
          let claimedBy = ''
          try {
            claimedBy = String(JSON.parse(claim).by ?? '')
          } catch {
            claimedBy = ''
          }
          if (!sameLogin(claimedBy, login)) throw new HttpError(409, `${memberOf(claimedBy || '?').name} a déjà lancé la création de ces tickets.`)
          const progress = await check()
          const { issues, error } = await createIssues({
            synthesis,
            existing: progress.issues,
            thread: found.thread,
            message: message.id,
            api: issueApi,
            config: state.config,
            // The same member again, after a run that was cut short.
            resume: claim !== mine,
            onCreated: async (list) => {
              await git.publish([await synthesisFiles.saveIssues(id, message.id, list)], `board: ${login} created an issue from ${id}`)
              broadcast('changed', { threadId: id })
            },
          })
          if (issues.length > progress.issues.length) {
            const list = issues.map((issue) => `${issue.repo ?? ''}#${issue.number}`).join(', ')
            const added = await store.addMessage(id, { author: login, body: `Issues created from the synthesis: ${list}.` })
            await git.publish([added.path], `board: ${login} in ${id}`)
            broadcast('changed', { threadId: id })
          }
          if (error) throw new HttpError(502, `${issues.length} sur ${synthesis.work.length} créés. ${error}`)
          return send(res, 200, { issues })
        } finally {
          creatingIssues.delete(message.id)
        }
      }
      throw new HttpError(404, 'Introuvable.')
    }
    if (method === 'POST' && parts[2] === 'messages' && parts[4] === 'translate') {
      const message = found.messages.find((candidate) => candidate.id === parts[3])
      if (!message) throw new HttpError(404, 'Message introuvable.')
      const to = (await readJson(req, MESSAGE_MAX)).to
      if (!isLanguage(to)) throw new HttpError(400, 'Langue inconnue.')
      try {
        return send(res, 200, { body: await translator.text(message.body, to) })
      } catch (error) {
        throw new HttpError(502, `Traduction impossible : ${(error as Error).message}`)
      }
    }
    if (method === 'POST' && parts[2] === 'messages') {
      const input = await readJson(req, WITH_FILES_MAX)
      const poll = readPoll(input)
      if (statusOf(found.messages) === 'closed') throw new HttpError(409, 'Ce fil est clos : rouvrez-le pour écrire.')
      const uploads = readUploads(input)
      const { paths, message } = await store.addMessage(id, { author: login, body: readBody(input, uploads, poll), uploads, ...(poll ? { poll } : {}) })
      await git.publish(paths, `board: ${login} in ${id}`)
      send(res, 201, message)
      broadcast('changed', { threadId: id })
      void wakeAgent()
      return
    }
    if (method === 'POST' && parts[2] === 'status') {
      const status = (await readJson(req, MESSAGE_MAX)).status === 'closed' ? 'closed' : 'open'
      const body = status === 'closed' ? 'Fil clos.' : 'Fil rouvert.'
      const { path } = await store.addMessage(id, { author: login, body, status })
      await git.publish([path], `board: ${login} ${status} ${id}`)
      broadcast('changed', { threadId: id })
      return send(res, 200, { status })
    }
    if (method === 'POST' && parts[2] === 'stop') {
      if (answering.has(id) && !runner.isRunning(id)) cancelled.add(id)
      runner.stop(id)
      return send(res, 200, { stopped: true })
    }
    if (method === 'POST' && parts[2] === 'retry') {
      agentErrors.delete(id)
      if (failedSyntheses.delete(id)) {
        void runSynthesis(id)
        return send(res, 200, { retried: true })
      }
      if (failedSummaries.delete(id)) {
        void runVoiceSummary(id)
        return send(res, 200, { retried: true })
      }
      if (failedDrafts.delete(id)) {
        void runAgent(id, null, true)
        return send(res, 200, { retried: true })
      }
      // The member's policy may have changed since: it decides again.
      const mention = owedMention(found.messages, login)
      const mode = mention ? replyFor(state.policy, mention.author, id) : 'off'
      if (mention && mode !== 'off' && !runner.isRunning(id)) void runAgent(id, mention, mode === 'draft')
      return send(res, 200, { retried: !!mention && mode !== 'off' })
    }
    throw new HttpError(404, 'Introuvable.')
  }

  return handle
}
