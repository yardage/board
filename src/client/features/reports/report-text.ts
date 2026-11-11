import type { MilestoneState, Report } from '../../../server/environment/reports.ts'
import { count, dateLocale, t } from '../../../shared/i18n/i18n.ts'
import { zoneNow } from '../../../shared/metrics.ts'

/**
 * A report holds figures and lists; these are the words put on them, in the language the reader chose, when the
 * page draws. The same file reads in French or in English, and a sentence changes here without touching what
 * was written in the shared history.
 */

const clock = (iso: string) => new Date(iso).toLocaleTimeString(dateLocale(), { hour: '2-digit', minute: '2-digit', timeZone: zoneNow() })
const dayIn = (iso: string) => new Intl.DateTimeFormat('en-CA', { timeZone: zoneNow(), year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso))
const minuteIn = (iso: string) => new Intl.DateTimeFormat('en-GB', { timeZone: zoneNow(), hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(iso))
/** A short month carries its own full stop in French; the sentence puts its own. */
const dueOf = (due: string) => new Date(`${due.slice(0, 10)}T12:00:00Z`).toLocaleDateString(dateLocale(), { day: 'numeric', month: 'short', timeZone: 'UTC' }).replace(/.$/, '')
const comma = (value: number) => value.toLocaleString(dateLocale(), { maximumFractionDigits: 1 })
/** A figure and its word, each form written in full, so that either language reads right. */
export const plural = (amount: number, one: string, many: string) => t(amount > 1 ? many : one, { 0: amount })
const more = (hidden: number) => (hidden > 0 ? t(', et {0} de plus', { 0: hidden }) : '')
const numbers = (list: number[], limit = 10) => `${list.slice(0, limit).map((number) => `#${number}`).join(', ')}${more(list.length - limit)}`
const titles = (list: string[], limit = 5) => `${list.slice(0, limit).join(' · ')}${more(list.length - limit)}`

/** "since midnight", "since 10:03", "since yesterday 22:00", or "that day" for a day's report. */
export function sinceWords(report: Pick<Report, 'kind' | 'day' | 'from'>): string {
  if (report.kind === 'day') return t('ce jour-là')
  if (dayIn(report.from) !== report.day) return t('depuis hier {0}', { 0: clock(report.from) })
  return minuteIn(report.from) === '00:00' ? t('depuis minuit') : t('depuis {0}', { 0: clock(report.from) })
}

/** How a milestone stands, in a word. */
export function milestoneWord(state: MilestoneState): string {
  switch (state) {
    case 'done':
      return t('terminé')
    case 'no-pace':
      return t('sans rythme mesurable')
    case 'no-due':
      return t('sans échéance')
    case 'on-schedule':
      return t('dans les temps')
    case 'at-risk':
      return t('à risque')
    case 'late':
      return t('en retard')
  }
}

/** How a milestone stands, in one sentence of arithmetic. */
export function milestoneWords(milestone: NonNullable<NonNullable<Report['repository']>['milestone']>): string {
  const done = `${milestone.closed} / ${milestone.total}`
  const due = milestone.due ? t(', échéance le {0}', { 0: dueOf(milestone.due) }) : ''
  if (milestone.state === 'done') return t('{0} : {1}, tout est fermé.', { 0: milestone.title, 1: done })
  if (milestone.daysLeft === null) return t('{0} : {1}{2}. Rien n’a été fermé ces 3 derniers jours.', { 0: milestone.title, 1: done, 2: due })
  return t('{0} : {1}{2}. Au rythme des 3 derniers jours, {3} par jour, il reste {4} jours : {5}.', { 0: milestone.title, 1: done, 2: due, 3: comma(milestone.pace), 4: comma(milestone.daysLeft), 5: milestoneWord(milestone.state) })
}

/** The key points of a report, as lines: what happened on the board, then in the repository. */
export function keyPoints(report: Report): string[] {
  const since = sinceWords(report)
  const lines: string[] = []
  const { board, repository: repo } = report

  if (board.threadsOpened.length) lines.push(t('{0} {1} : {2}.', { 0: plural(board.threadsOpened.length, '{0} fil ouvert', '{0} fils ouverts'), 1: since, 2: titles(board.threadsOpened.map((thread) => thread.title)) }))
  if (board.threadsClosed.length) lines.push(t('{0} {1} : {2}.', { 0: plural(board.threadsClosed.length, '{0} fil clos', '{0} fils clos'), 1: since, 2: titles(board.threadsClosed.map((thread) => thread.title)) }))
  const messages = board.messages.members + board.messages.drafts + board.messages.agents
  if (messages) {
    const who = board.byMember.slice(0, 6).map((row) => `${row.who} (${row.messages})`).join(', ')
    const agents = board.messages.agents ? t(', dont {0} des agents seuls', { 0: board.messages.agents }) : ''
    lines.push(who ? t('{0} {1}{2} : {3}.', { 0: plural(messages, '{0} message', '{0} messages'), 1: since, 2: agents, 3: who }) : t('{0} {1}{2}.', { 0: plural(messages, '{0} message', '{0} messages'), 1: since, 2: agents }))
  }
  if (board.pollsOpened.length) lines.push(t('{0} {1} : {2}.', { 0: plural(board.pollsOpened.length, '{0} sondage ouvert', '{0} sondages ouverts'), 1: since, 2: titles(board.pollsOpened.map((poll) => poll.question)) }))
  for (const poll of board.pollsClosed) lines.push(poll.leading ? t('Sondage clos : « {0} », {1} en tête, {2}.', { 0: poll.question, 1: poll.leading, 2: plural(poll.voters, '{0} votant', '{0} votants') }) : t('Sondage clos sans vote : « {0} ».', { 0: poll.question }))
  if (board.syntheses) lines.push(plural(board.syntheses, '{0} synthèse écrite.', '{0} synthèses écrites.'))

  if (!repo) {
    if (!lines.length) lines.push(t('Rien de neuf {0}.', { 0: since }))
    return lines
  }

  // A quiet period says so in one line: what stands, red or waiting, was said when it happened.
  const quietRepo = repo.since.merged + repo.since.closed + repo.since.opened + repo.ci.finished === 0
  if (quietRepo) {
    if (!lines.length) lines.push(t('Rien de neuf {0}.', { 0: since }))
    return lines
  }
  {
    if (repo.since.merged) lines.push(t('{0} {1} : {2}.', { 0: plural(repo.since.merged, '{0} PR mergée', '{0} PR mergées'), 1: since, 2: repo.mergedBy.map((row) => `${numbers(row.numbers, 14)}${row.who ? ` (${row.who})` : ''}`).join(' ; ') }))
    else lines.push(t('Aucun merge {0}.', { 0: since }))
    lines.push(t('{0}, {1} {2}.', { 0: plural(repo.since.closed, '{0} ticket fermé', '{0} tickets fermés'), 1: plural(repo.since.opened, '{0} ouvert', '{0} ouverts'), 2: since }))
  }
  if (repo.mainRed) lines.push(t('La branche principale est rouge : le dernier run terminé a échoué, lancé à {0}.', { 0: clock(repo.mainRed) }))
  if (repo.redPulls?.length) lines.push(t('{0} en rouge : {1}.', { 0: plural(repo.redPulls.length, '{0} PR ouverte', '{0} PR ouvertes'), 1: numbers(repo.redPulls) }))
  if (repo.ci.finished) lines.push(repo.ci.rate === null ? t('CI : {0} {1}, dont {2} en échec. Des runs manquent, donc pas de taux.', { 0: plural(repo.ci.finished, '{0} run terminé', '{0} runs terminés'), 1: since, 2: repo.ci.failure }) : t('CI : {0} % de réussite sur {1} {2}.', { 0: repo.ci.rate, 1: count(repo.ci.finished, 'run'), 2: since }))
  if (repo.milestone) lines.push(milestoneWords(repo.milestone))
  if (repo.waiting.length) lines.push(t('{0} : {1}.', { 0: plural(repo.waiting.length, '{0} point attend une personne', '{0} points attendent une personne'), 1: repo.waiting.map((item) => (item.who ? `#${item.number} (${item.who})` : `#${item.number}`)).join(', ') }))
  return lines
}

/** A day's report, told in a few parts: the summary, what was done, what is under way, where the work heads. */
export function daySections(report: Report): { title: string; lines: string[] }[] {
  const sections: { title: string; lines: string[] }[] = [{ title: t('Résumé'), lines: keyPoints(report) }]
  const repo = report.repository
  if (!repo) return sections
  if (repo.mergedBy.length) sections.push({ title: t('Fait'), lines: repo.mergedBy.map((row) => t('{0} : {1}.', { 0: row.who || t('une autre personne'), 1: plural(row.numbers.length, '{0} PR mergée', '{0} PR mergées') })) })
  if (repo.pulls) {
    const stale = repo.pulls.stale ? t(', {0} dont la revue est à refaire', { 0: repo.pulls.stale }) : ''
    sections.push({ title: t('En cours'), lines: [t('{0}, dont {1}, {2} en rouge{3}.', { 0: plural(repo.pulls.open, '{0} PR ouverte', '{0} PR ouvertes'), 1: plural(repo.pulls.draft, '{0} brouillon', '{0} brouillons'), 2: repo.pulls.red, 3: stale })] })
  }
  const course = [repo.milestone ? milestoneWords(repo.milestone) : t('Aucun jalon en cours.')]
  if (repo.nextMilestone) course.push(t('Ensuite : {0}{1}.', { 0: repo.nextMilestone.title, 1: repo.nextMilestone.due ? t(', échéance le {0}', { 0: dueOf(repo.nextMilestone.due) }) : '' }))
  sections.push({ title: t('Cap'), lines: course })
  return sections
}
