import { language, localize } from '../../../shared/i18n/i18n.ts'

const MONTHS = 'Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec'

/**
 * A generated report is written once, by rules and in French, in the shared history, where it stays. For someone who
 * reads English, these are the same rules' pieces: a sentence is made of them, and the figures between them don't change.
 * Longest first, because they apply in this order. Add a piece here when `server/reports.ts` gets a new one: a test reads
 * its sentences. A `\b` stops nothing after an accent, so a piece ending on one has none.
 */
const PIECES: [RegExp, string][] = [
  [/\b([\d,]+) j de développement depuis le ([^,]+), ([\d,]+) tickets fermés par jour en moyenne\./g, '$1 days of development since $2, $3 issues closed a day on average.'],
  [/À ce rythme, il reste ([\d,]+) j pour tous les tickets ouverts\. C'est une extrapolation, pas un engagement : de nouveaux tickets s'ouvrent chaque jour\./g, 'At this pace, $1 days remain for all open issues. This is an extrapolation, not a commitment: new issues open every day.'],
  [/\bAu rythme des (\d+) derniers jours, ([\d,]+) par jour, il reste ([\d,]+) j :/g, 'At the pace of the last $1 days, $2 a day, $3 days remain:'],
  [/\bRien n'a été fermé ces (\d+) derniers jours\./g, 'Nothing was closed in the last $1 days.'],
  [/Des runs manquent, donc pas de taux\./g, 'Some runs are missing, so no rate.'],
  [/\ble dernier run terminé a échoué, lancé à\b/g, 'the last finished run failed, started at'],
  [/\bmain est rouge\b/g, 'main is red'],
  [/\b1 PR mergée/g, '1 PR merged'],
  [/\b(\d+) PR mergées?/g, '$1 PRs merged'],
  [/\b1 ticket fermé/g, '1 issue closed'],
  [/\b(\d+) tickets? fermés?/g, '$1 issues closed'],
  [/\b1 PR ouverte/g, '1 open PR'],
  [/\b(\d+) PR ouvertes?/g, '$1 open PRs'],
  [/\b1 run terminé/g, '1 finished run'],
  [/\b(\d+) runs? terminés?/g, '$1 finished runs'],
  [/\b1 point attend une personne/g, '1 item waits for a person'],
  [/\b(\d+) points attendent une personne/g, '$1 items wait for a person'],
  [/, (\d+) ouverts?/g, ', $1 opened'],
  [/, et (\d+) de plus\b/g, ', and $1 more'],
  [/\bdont 1 brouillon\b/g, 'including 1 draft'],
  [/\bdont (\d+) brouillons?\b/g, 'including $1 drafts'],
  [/\bdont (\d+) en échec/g, 'with $1 failed'],
  [/, (\d+) dont la revue est à refaire/g, ', $1 to review again'],
  [/\ben rouge\b/g, 'red'],
  [/\bde réussite sur\b/g, 'success over'],
  [/\b(\d+) tickets\b/g, '$1 issues'],
  [/\bdepuis minuit\b/g, 'since midnight'],
  [/\bdepuis hier\b/g, 'since yesterday'],
  [/\bdepuis\b/g, 'since'],
  [/\bce jour-là/g, 'that day'],
  [/, échéance le\b/g, ', due'],
  [/\bAucun merge\b/g, 'No merge'],
  [/\bRien de neuf\b/g, 'Nothing new'],
  [/\bAucun jalon en cours\./g, 'No milestone under way.'],
  [/\bEnsuite :/g, 'Next:'],
  [/\btout est fermé/g, 'everything is closed'],
  [/\bdans les temps\b/g, 'on schedule'],
  [/à risque\b/g, 'at risk'],
  [/\ben retard\b/g, 'late'],
  [/\bterminé/g, 'finished'],
  [/\bsans échéance/g, 'no due date'],
  [/\bjanv\./g, 'Jan'],
  [/\bfévr\./g, 'Feb'],
  [/\bmars\b/g, 'Mar'],
  [/\bavr\./g, 'Apr'],
  [/\bmai\b/g, 'May'],
  [/\bjuin\b/g, 'Jun'],
  [/\bjuil\./g, 'Jul'],
  [/\baoût\b/g, 'Aug'],
  [/\bsept\./g, 'Sep'],
  [/\boct\./g, 'Oct'],
  [/\bnov\./g, 'Nov'],
  [/\bdéc\./g, 'Dec'],
  // A short French month ended the sentence on its own full stop.
  [new RegExp(`\\b(${MONTHS})(?= [A-Z]|$)`, 'g'), '$1.'],
  [/(\d),(\d)/g, '$1.$2'],
  [/(\d) %/g, '$1%'],
  [/ ([:;?!])/g, '$1'],
]

/** One sentence of a generated report, in the language shown. In French, it is what was written. */
export function reportLine(line: string): string {
  if (language() !== 'en') return line
  return PIECES.reduce((text, [piece, english]) => text.replace(piece, english), localize(line))
}
