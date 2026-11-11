import { readFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join } from 'node:path'
import type { BoardContext, RouteHandler } from '../board-context.ts'
import { dependents } from '../../github/dependencies.ts'
import { accessOf, repositoryUrl } from '../../environment/config.ts'
import { HttpError, MESSAGE_MAX, readJson, send } from '../../lib/http.ts'
import { looksSecret } from '../../lib/secrets.ts'
import { sameLogin } from '../../environment/store.ts'
import { detectLanguage } from '../../ai/translate.ts'
import { answerMark, commentBody, githubWaiting, isReviewEvent, isVerdict, REASON_MAX, reviewBody, reviewMark, type WaitingApi, type WaitingItem, waitsFor } from '../../github/waiting.ts'

/** What the copy of GitHub says waits for someone, with what an answer from here learnt since. */
export type WaitingState = { at?: string; waiting?: WaitingItem[] } | null

/** The routes under /api/waiting: what waits for a member, and their answer or review, posted with their own login. */
export function waitingRoutes(ctx: BoardContext): { handle: RouteHandler; readWaitingState: () => Promise<WaitingState> } {
  const { copy, knowledge, me, login, options, api, translator, knowledgeLoops, broadcast, state } = ctx
  /** Items this computer is answering right now. */
  const answeringItems = new Set<number>()
  const learntFields = new Map<number, { who: string; question: string; at: number }>()

  /** When each waiting point was opened and what it holds up, read again only when the copy has changed. */
  let waitingKnown: { at: string | undefined; created: Map<number, string>; unblocks: Map<number, number[]> } | null = null
  const waitingContext = async (at: string | undefined) => {
    if (waitingKnown && waitingKnown.at === at) return waitingKnown
    const history = (await copy()?.overview().catch(() => null))?.history
    waitingKnown = {
      at,
      created: new Map((history?.items ?? []).map((item) => [item.number, item.created])),
      unblocks: await dependents(join(knowledge.root, 'github', 'issues')),
    }
    return waitingKnown
  }

  const readWaitingState = () =>
      readFile(join(knowledge.root, 'github', 'state.json'), 'utf8')
        .then((found) => {
          const state = JSON.parse(found) as { at?: string; waiting?: WaitingItem[] }
          // What an answer learnt from GitHub just now, until the copy can have caught up.
          return {
            ...state,
            waiting: state.waiting?.map((item) => {
              const fresh = learntFields.get(item.number)
              return fresh && Date.now() - fresh.at < 30 * 60_000 ? { ...item, who: fresh.who, question: fresh.question } : item
            }),
          }
        })
        .catch(() => null)

  async function handle(req: IncomingMessage, res: ServerResponse, _url: URL, parts: string[], method: string): Promise<void> {
    const context = copy()
    const readState = readWaitingState
    if (method === 'GET' && !parts[1]) {
      const copied = context ? await readState() : null
      const known = await waitingContext(copied?.at)
      const items = copied?.waiting?.map((item) => ({
        ...item,
        mine: waitsFor(item, me()),
        review: (item.reviewers ?? []).some((who) => sameLogin(who, login)),
        createdAt: known.created.get(item.number) ?? null,
        unblocks: known.unblocks.get(item.number) ?? [],
      }))
      const access = context ? accessOf(state.config, context.repo) : null
      return send(res, 200, { items: items ?? null, at: copied?.at ?? null, repository: repositoryUrl(context?.repo ?? null), label: state.config.waiting.label, me: login, may: { comment: Boolean(access?.issues.comment || access?.pulls.comment), review: Boolean(access?.pulls.review) } })
    }
    if (!context) throw new HttpError(404, 'Aucun dépôt n’est configuré.')
    const number = Number(parts[1])
    if (!Number.isInteger(number) || number <= 0) throw new HttpError(404, 'Introuvable.')
    const input = await readJson(req, MESSAGE_MAX)
    const reason = String(input.reason ?? '').trim()
    if (reason.length > REASON_MAX) throw new HttpError(400, 'Ce texte est trop long.')
    if (looksSecret(reason)) throw new HttpError(400, 'Ce texte ressemble à un secret : il resterait à vie sur GitHub.')
    if (method === 'POST' && parts[2] === 'preview') {
      if (!reason) throw new HttpError(400, 'Rien à préparer : écrivez votre réponse.')
      // Everything on GitHub is in English. Only a member who works in English goes without the model.
      if (state.language === 'en' && detectLanguage(reason) === 'en') return send(res, 200, { text: reason })
      try {
        return send(res, 200, { text: (await translator.strings([reason], 'en', true))[0] })
      } catch (error) {
        if (detectLanguage(reason) === 'en') return send(res, 200, { text: reason })
        throw new HttpError(502, `Traduction impossible : ${(error as Error).message}. Écrivez une phrase complète en anglais.`)
      }
    }
    if (method === 'POST' && parts[2] === 'answer') {
      const waitingApi = options.waiting ?? githubWaiting(api, context.repo, state.config.waiting)
      const answerText = String(input.text ?? '').trim()
      const settle = input.settle === true
      const verdict = isVerdict(input.verdict) ? input.verdict : 'answer'
      if (!answerText && verdict === 'answer') throw new HttpError(400, 'Le texte à poster est vide.')
      if (answerText.length > REASON_MAX * 2) throw new HttpError(400, 'Le texte à poster est trop long.')
      if (looksSecret(answerText)) throw new HttpError(400, 'Ce texte ressemble à un secret : il resterait à vie sur GitHub.')
      if (detectLanguage(answerText) === 'fr') throw new HttpError(400, 'Le texte à poster doit être en anglais.')
      const item = (await readState())?.waiting?.find((candidate) => candidate.number === number)
      if (!item) throw new HttpError(404, "Ce ticket n'attend plus de réponse.")
      const isPull = Boolean(item.reviewers?.length) || Boolean(item.url?.includes('/pull/'))
      if (isPull ? !accessOf(state.config, context.repo).pulls.comment : !accessOf(state.config, context.repo).issues.comment) throw new HttpError(403, `L'environnement ne permet pas au board de commenter dans ${context.repo}.`)
      // Only the member named answers here: GitHub can't tell a click from anything else using the same login.
      const refuseOthers = (who: string) => {
        if (!waitsFor({ ...item, who }, me())) throw new HttpError(403, who ? `Réponse réservée à ${who}.` : 'Personne n’est nommé : la réponse se fait sur GitHub.')
      }
      refuseOthers(item.who)
      if (answeringItems.has(number)) throw new HttpError(409, 'Cette réponse est déjà en cours.')
      answeringItems.add(number)
      try {
        let comment: string | null
        const question = String(input.question ?? '')
        const mark = answerMark(login, number, question, answerText, settle, attemptOf(input), verdict)
        try {
          const current = await waitingApi.login()
          if (!sameLogin(current, login)) throw new HttpError(403, `GitHub est connecté avec le compte « ${current} », qui n'est pas le vôtre : rien n'est posté.`)
          const fresh = await waitingApi.current(number)
          if (fresh.who !== item.who || fresh.question !== item.question) learntFields.set(number, { who: fresh.who, question: fresh.question, at: Date.now() })
          if (fresh.labels.includes(state.config.waiting.label)) {
            refuseOthers(fresh.who)
            if (fresh.question !== question) throw new HttpError(409, `La question a changé sur GitHub : « ${fresh.question} ». Relisez-la avant de répondre.`)
          } else if (!(item.reviewers ?? []).some((who) => sameLogin(who, login))) throw new HttpError(409, "GitHub dit que ce ticket n'attend plus de réponse.")
          comment = await waitingApi.find(number, mark)
        } catch (error) {
          if (error instanceof HttpError) {
            if (error.status === 409 && knowledgeLoops) void context.refreshIfOlder(0).catch(() => undefined)
            throw error
          }
          throw new HttpError(502, `Impossible de relire GitHub, rien n'est posté : ${(error as Error).message}`)
        }
        if (!comment) {
          try {
            comment = await waitingApi.comment(number, commentBody(me().name, answerText, question, mark, verdict))
          } catch (error) {
            // A timeout says nothing about what GitHub did: the reference says.
            comment = await waitingApi.find(number, mark).catch(() => null)
            if (!comment) throw new HttpError(502, `GitHub n'a pas confirmé le commentaire : ${(error as Error).message}. Vérifiez sur GitHub, ou réessayez : il ne sera pas posté deux fois.`)
          }
        }
        let warning: string | null = null
        if (settle) {
          try {
            // Read again just before: this call replaces every label, and someone may have added one.
            const labels = await waitingApi.labels(number)
            if (labels.includes(state.config.waiting.label)) await waitingApi.setLabels(number, labels.filter((label) => label !== state.config.waiting.label))
          } catch (error) {
            warning = `Votre réponse est postée, mais l'étiquette ${state.config.waiting.label} reste à retirer (${(error as Error).message}).`
          }
        }
        if (knowledgeLoops) void context.refreshIfOlder(0).then(() => broadcast('changed', {}), () => undefined)
        broadcast('changed', {})
        return send(res, 200, { comment, warning })
      } finally {
        answeringItems.delete(number)
      }
    }
    if (method === 'POST' && parts[2] === 'review') {
      const waitingApi = options.waiting ?? githubWaiting(api, context.repo, state.config.waiting)
      const event = input.event
      if (!isReviewEvent(event)) throw new HttpError(400, 'Revue inconnue.')
      const reviewText = String(input.text ?? '').trim()
      if (!reviewText && event !== 'approve') throw new HttpError(400, 'Dites pourquoi : une demande de changements ou un commentaire a besoin de mots.')
      if (reviewText.length > REASON_MAX * 2) throw new HttpError(400, 'Le texte à poster est trop long.')
      if (looksSecret(reviewText)) throw new HttpError(400, 'Ce texte ressemble à un secret : il resterait à vie sur GitHub.')
      if (reviewText && detectLanguage(reviewText) === 'fr') throw new HttpError(400, 'Le texte à poster doit être en anglais.')
      if (!accessOf(state.config, context.repo).pulls.review) throw new HttpError(403, `L'environnement ne permet pas au board de relire les pull requests de ${context.repo}.`)
      if (answeringItems.has(number)) throw new HttpError(409, 'Cette réponse est déjà en cours.')
      answeringItems.add(number)
      try {
        let pull: Awaited<ReturnType<WaitingApi['pull']>>
        let review: string | null
        let mark: string
        try {
          const current = await waitingApi.login()
          if (!sameLogin(current, login)) throw new HttpError(403, `GitHub est connecté avec le compte « ${current} », qui n'est pas le vôtre : rien n'est posté.`)
          pull = await waitingApi.pull(number)
          if (!pull.open) throw new HttpError(409, "Cette pull request n'est plus ouverte.")
          if (event !== 'comment' && sameLogin(pull.author, login)) throw new HttpError(403, 'Une pull request ne se relit pas par son auteur : commentez-la, ou laissez un autre membre la relire.')
          // The member read a commit: a review of a newer one would say something about what they haven't seen.
          if (typeof input.head === 'string' && input.head && input.head !== pull.head) throw new HttpError(409, 'La pull request a changé depuis que vous l’avez lue : relisez-la avant de donner votre avis.')
          mark = reviewMark(login, number, pull.head, event, reviewText, attemptOf(input))
          review = await waitingApi.findReview(number, mark)
        } catch (error) {
          if (error instanceof HttpError) {
            if (error.status === 409 && knowledgeLoops) void context.refreshIfOlder(0).catch(() => undefined)
            throw error
          }
          throw new HttpError(502, `Impossible de relire GitHub, rien n'est posté : ${(error as Error).message}`)
        }
        if (!review) {
          try {
            review = await waitingApi.review(number, event, reviewBody(me().name, reviewText, mark), pull.head)
          } catch (error) {
            review = await waitingApi.findReview(number, mark).catch(() => null)
            if (!review) throw new HttpError(502, `GitHub n'a pas confirmé la revue : ${(error as Error).message}. Vérifiez sur GitHub, ou réessayez : elle ne sera pas postée deux fois.`)
          }
        }
        if (knowledgeLoops) void context.refreshIfOlder(0).then(() => broadcast('changed', {}), () => undefined)
        broadcast('changed', {})
        return send(res, 200, { review, head: pull.head })
      } finally {
        answeringItems.delete(number)
      }
    }
    throw new HttpError(404, 'Introuvable.')
  }

  /** What tells a second try from a second answer, as the page sent it. */
  const attemptOf = (input: any) => (typeof input.attempt === 'string' && /^[\w-]{1,64}$/.test(input.attempt) ? input.attempt : '')


  return { handle, readWaitingState }
}
