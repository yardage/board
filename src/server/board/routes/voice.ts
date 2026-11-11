import type { IncomingMessage, ServerResponse } from 'node:http'
import type { BoardContext, RouteHandler } from '../board-context.ts'
import { HttpError, MESSAGE_MAX, readBytes, readJson, send, text, WITH_FILES_MAX } from '../../lib/http.ts'
import { looksSecret } from '../../lib/secrets.ts'
import { statusOf } from '../../environment/store.ts'
import { cleanSegment, draftText, type EngineVariant } from '../../voice/engine.ts'

/** One passage: 60 s of 16 kHz, 16-bit audio, well over what the page cuts. */
const VOICE_PASSAGE_MAX = 60 * 16_000 * 2

/** The routes under /api/voice, and what the window asks when it closes to the tray. */
export function voiceRoutes(ctx: BoardContext): { handle: RouteHandler; stopListening: () => void } {
  const { drafts, voice, store, git, login, broadcast, wakeAgent, options, state } = ctx
  /** Which page holds the microphone: a second page in a browser isn't the one that came back from a reload. */
  let listeningPage = ''
  /** The window is closing and the page hasn't confirmed yet: its next passage hears it too. */
  let stopWanted = false
  /** What is on its way to the engine: a stop that comes from elsewhere waits for it. */
  let passage: Promise<unknown> = Promise.resolve()
  const publishingDrafts = new Set<string>()
  const setListening = (listening: boolean) => options.onListening?.(listening)

  /** Everything of the voice. No route opens a microphone: only a click in the page can. */
  async function handle(req: IncomingMessage, res: ServerResponse, url: URL, parts: string[], method: string): Promise<void> {
    if (method === 'GET' && parts.length === 1) {
      const listening = drafts.listening
      return send(res, 200, {
        status: await voice.status(),
        listening: listening ? { id: listening.id, threadId: listening.threadId, page: listeningPage } : null,
        drafts: (await drafts.list()).map((draft) => ({ ...draft, text: draftText(draft) })),
      })
    }
    if (method !== 'POST') throw new HttpError(404, 'Introuvable.')
    if (parts[1] === 'install') {
      const { engine, model } = await readJson(req, MESSAGE_MAX)
      if (engine !== 'cuda12' && engine !== 'cuda11' && engine !== 'cpu') throw new HttpError(400, 'Moteur inconnu.')
      if (drafts.listening) throw new HttpError(409, 'Arrêtez d’abord l’écoute.')
      try {
        await voice.install({ engine: engine as EngineVariant, model: String(model) })
      } catch (error) {
        throw new HttpError(400, (error as Error).message)
      }
      return send(res, 200, { started: true })
    }
    if (parts[1] === 'cancel') {
      voice.cancelInstall()
      return send(res, 200, { cancelled: true })
    }
    if (parts[1] === 'remove') {
      if (drafts.listening) throw new HttpError(409, 'Arrêtez d’abord l’écoute.')
      try {
        await voice.remove()
      } catch (error) {
        throw new HttpError(409, (error as Error).message)
      }
      return send(res, 200, { removed: true })
    }
    if (parts[1] !== 'sessions') throw new HttpError(404, 'Introuvable.')
    if (parts.length === 2) {
      const asked = await readJson(req, MESSAGE_MAX)
      const threadId = text(asked.threadId, 'Fil', 200)
      const found = await store.readThread(threadId).catch(() => null)
      if (!found) throw new HttpError(404, 'Ce fil n’existe plus.')
      if (statusOf(found.messages) === 'closed') throw new HttpError(400, 'Ce fil est clos.')
      const engine = await voice.status()
      if (!engine.ready) throw new HttpError(400, 'La transcription n’est pas installée : voyez Réglages.')
      if (engine.installing) throw new HttpError(409, 'Une installation est en cours : attendez qu’elle finisse.')
      if (drafts.listening) throw new HttpError(409, 'Vous êtes déjà à l’écoute.')
      const draft = await drafts.start(threadId)
      listeningPage = typeof asked.page === 'string' ? asked.page.slice(0, 64) : ''
      stopWanted = false
      setListening(true)
      return send(res, 201, { id: draft.id, startedAt: draft.startedAt })
    }
    const id = parts[2]
    const action = parts[3]
    if (action === 'audio') {
      if (state.stopped || drafts.listening?.id !== id) {
        req.resume()
        throw new HttpError(409, 'Cette écoute est terminée.')
      }
      const seq = Number(url.searchParams.get('seq'))
      const at = Number(url.searchParams.get('at'))
      if (!Number.isInteger(seq) || seq < 0 || !Number.isFinite(at) || at < 0) throw new HttpError(400, 'Passage invalide.')
      const pcm = await readBytes(req, VOICE_PASSAGE_MAX)
      if (!pcm.length || pcm.length % 2) throw new HttpError(400, 'Passage invalide.')
      const work = (async () => {
        let said: string
        try {
          said = await voice.transcribe(pcm)
        } catch (error) {
          await drafts.addSegment(id, { seq, at, text: '', lost: true })
          throw new HttpError(502, (error as Error).message)
        }
        const line = cleanSegment(said)
        const segment = line ? { seq, at, text: line } : null
        if (segment) await drafts.addSegment(id, segment)
        return segment
      })()
      passage = work.catch(() => undefined)
      const segment = await work
      return send(res, 200, { segment, ...(stopWanted ? { stop: true } : {}) })
    }
    if (action === 'stop') {
      try {
        await passage
        await drafts.stop(id)
      } finally {
        setListening(Boolean(drafts.listening))
      }
      return send(res, 200, { stopped: true })
    }
    if (action === 'text') {
      const edited = (await readJson(req, WITH_FILES_MAX)).text
      if (typeof edited !== 'string' || edited.length > MESSAGE_MAX) throw new HttpError(400, 'Texte trop long.')
      await drafts.setText(id, edited)
      return send(res, 200, { saved: true })
    }
    if (action === 'discard') {
      await drafts.remove(id)
      setListening(Boolean(drafts.listening))
      return send(res, 200, { discarded: true })
    }
    if (action === 'publish') {
      if (publishingDrafts.has(id)) throw new HttpError(409, 'Publication déjà en cours.')
      publishingDrafts.add(id)
      try {
        const draft = await drafts.get(id)
        if (!draft || drafts.listening?.id === id) throw new HttpError(404, 'Ce texte n’est plus à relire.')
        const body = text((await readJson(req, WITH_FILES_MAX)).text, 'Texte', MESSAGE_MAX)
        if (looksSecret(body)) throw new HttpError(400, 'Ce texte ressemble à un secret : il resterait à vie dans l’historique.')
        const found = await store.readThread(draft.threadId).catch(() => null)
        if (!found) throw new HttpError(404, 'Ce fil n’existe plus.')
        if (statusOf(found.messages) === 'closed') throw new HttpError(400, 'Ce fil est clos : rouvrez-le pour publier.')
        const { paths, message } = await store.addMessage(draft.threadId, { author: login, body, voice: true, spokenAt: draft.startedAt })
        await drafts.remove(id).catch(() => undefined)
        await git.publish(paths, `board: ${login} in ${draft.threadId}`).catch(() => undefined)
        broadcast('changed', { threadId: draft.threadId })
        void wakeAgent()
        return send(res, 201, message)
      } finally {
        publishingDrafts.delete(id)
      }
    }
    throw new HttpError(404, 'Introuvable.')
  }

  return {
    handle,
    /** The window is closing to the tray, where nothing would show that the microphone is open. */
    stopListening: () => {
      stopWanted = Boolean(drafts.listening)
      broadcast('voice-stop', {})
    },
  }
}
