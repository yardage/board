import { useEffect, useMemo, useRef, useState } from 'react'
import { useScrollMemory } from '../../lib/memory.ts'
import type { LegacyReport, Report, ReportPull, RepositoryFacts } from '../../../server/environment/reports.ts'
import { call } from '../../lib/api.ts'
import { ChartBoundary, Columns, HBars, Legend, LineChart, Meter, Section, SegmentedBar, StatTile, TableView } from '../../components/charts.tsx'
import { Discuss } from '../../components/discuss.tsx'
import { parseMermaid } from '../../lib/mermaid.ts'
import { type BurnPoint, ciWordOf, dayTicks, STATUSES, zoneNow } from '../../../shared/metrics.ts'
import { REPOSITORY_URL } from '../../lib/subject.ts'
import { personOf } from '../../lib/people.tsx'
import { Loading } from '../../components/ui.tsx'
import { count, dateLocale, t } from '../../../shared/i18n/i18n.ts'
import { daySections, keyPoints, plural, sinceWords } from './report-text.ts'
import { reportLine } from './report-words.ts'
import { statusRamp } from '../../../shared/themes.ts'

/** The same colours as the overview: a series keeps its colour wherever it is drawn. */
const C = { pulls: 'var(--chart-1)', closed: 'var(--chart-2)', opened: 'var(--chart-3)', total: 'var(--chart-1)', success: 'var(--green)', failure: 'var(--danger)' }
/** Reports are cut in the environment's zone: their hours read in it too, whatever this computer's. */
const inZone = () => ({ timeZone: zoneNow() })
const clock = (iso: string) => new Date(iso).toLocaleTimeString(dateLocale(), { hour: '2-digit', minute: '2-digit', ...inZone() })
const fullDay = (day: string) => new Date(`${day}T12:00:00Z`).toLocaleDateString(dateLocale(), { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' })
const shortDay = (time: number) => new Date(time).toLocaleDateString(dateLocale(), { day: 'numeric', month: 'short', ...inZone() })
const moment = (time: number) => new Date(time).toLocaleString(dateLocale(), { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', ...inZone() })
const dueOf = (due: string) => new Date(`${due.slice(0, 10)}T12:00:00Z`).toLocaleDateString(dateLocale(), { day: 'numeric', month: 'short', timeZone: 'UTC' })
const nameOf = (person: string) => (person ? personOf(person).name : t('une autre personne'))
const reviewWords: Record<string, string> = { none: t('pas encore'), approved: t('✓ approuvée'), stale: t('▲ à refaire'), changes: t('× à reprendre') }
const CI_WORDS = { success: t('✓ verte'), failure: t('× rouge'), running: t('en cours'), other: t('autre'), none: t('pas vue') }
const LATE_NOTE = () => t('▲ Écrit après coup : ce qui était ouvert ce jour-là n\'est plus connu, donc il n\'est pas dit. Un ticket compte dans son jalon actuel, et l\'échéance est celle d\'aujourd\'hui.')

/** Bold and ticket numbers, the only marks a report's sentences use. The text is never treated as HTML. */
function Sentence({ text }: { text: string }) {
  return (
    <>
      {text.split(/(\*\*[^*]+\*\*|#\d+)/).map((part, index) => {
        if (part.startsWith('**')) return <strong key={index}><Sentence text={part.slice(2, -2)} /></strong>
        if (/^#\d+$/.test(part) && REPOSITORY_URL)
          return (
            <a key={index} href={`${REPOSITORY_URL}/issues/${part.slice(1)}`} target="_blank" rel="noreferrer">
              {part}
            </a>
          )
        return part
      })}
    </>
  )
}

const pullLink = (pull: ReportPull) => (
  <>
    <a href={`${REPOSITORY_URL}/pull/${pull.number}`} target="_blank" rel="noreferrer">
      #{pull.number}
    </a>{' '}
    {pull.title}
  </>
)

function Lines({ sections }: { sections: { title: string; lines: string[] }[] }) {
  return (
    <>
      {sections.map((section) => (
        <Section key={section.title} title={section.title}>
          <ul className="rep-lines">
            {section.lines.map((line, index) => (
              <li key={index}>
                <Sentence text={line} />
              </li>
            ))}
          </ul>
        </Section>
      ))}
    </>
  )
}

function Burn({ title, points, due }: { title: string; points: BurnPoint[]; due?: string | null }) {
  const last = points.at(-1)
  if (!last) return null
  return (
    <Section title={title} note={`${last.closed} / ${last.total}${due ? t(', échéance {0}', { 0: dueOf(due) }) : ''}`}>
      <Legend
        items={[
          { name: t('Total'), color: C.total, line: true },
          { name: t('Fermés'), color: C.closed, line: true },
        ]}
      />
      <LineChart
        label={t('{0} : {1} tickets fermés sur {2}', { 0: title, 1: last.closed, 2: last.total })}
        labels={points.map((point) => moment(point.time))}
        axis={dayTicks(points.map((point) => point.time), 8).map((index) => ({ index, label: shortDay(points[index].time) }))}
        series={[
          { name: t('Total'), color: C.total, values: points.map((point) => point.total) },
          { name: t('Fermés'), color: C.closed, values: points.map((point) => point.closed) },
        ]}
      />
    </Section>
  )
}

/** The charts of a repository's period, drawn the same for a report of today and for one from an older version. */
type Charts = Pick<RepositoryFacts, 'burnup' | 'activity' | 'merged' | 'milestones' | 'statuses' | 'ships' | 'areas' | 'queue' | 'ciRows' | 'failing'> & { pullsRead: boolean; milestoneDue: string | null; mergedCount: number }

function RepositoryCharts({ charts, finished, since, to }: { charts: Charts; finished: boolean; since: string; to: string }) {
  const burnTitle = (title: string) => (title === 'all' || title === 'Tous les tickets' ? t('Tous les tickets') : title)
  return (
    <>
      {charts.burnup.length > 0 && (
        <div className="viz-two">
          {charts.burnup.map((curve, index) => (
            <Burn key={curve.title} title={burnTitle(curve.title)} points={curve.points} due={index === 1 ? charts.milestoneDue : undefined} />
          ))}
        </div>
      )}
      {charts.activity.length > 0 && (
        <Section title={t('Activité')} note={t('par heure, le {0}', { 0: shortDay(Date.parse(to) - 1) })}>
          <Legend
            items={[
              { name: t('PR mergées'), color: C.pulls },
              { name: t('Tickets fermés'), color: C.closed },
              { name: t('Tickets ouverts'), color: C.opened },
            ]}
          />
          <Columns
            label={t('PR mergées, tickets fermés et ouverts par heure')}
            labels={charts.activity.map((row) => row.label)}
            series={[
              { name: t('PR mergées'), color: C.pulls, values: charts.activity.map((row) => row.merged) },
              { name: t('Tickets fermés'), color: C.closed, values: charts.activity.map((row) => row.closed) },
              { name: t('Tickets ouverts'), color: C.opened, values: charts.activity.map((row) => row.opened) },
            ]}
          />
          <TableView head={[t('Heure'), t('PR mergées'), t('Tickets fermés'), t('Tickets ouverts')]} numeric={1} rows={charts.activity.map((row) => [row.label, row.merged, row.closed, row.opened])} />
        </Section>
      )}
      {charts.merged.length > 0 && (
        <Section title={finished ? t('Merges du jour') : t('Merges {0}', { 0: since })} note={`${charts.mergedCount} PR`}>
          <table className="viz-table">
            <tbody>
              {charts.merged.map((pull) => (
                <tr key={pull.number}>
                  <td className="wide">{pullLink(pull)}</td>
                  <td>{pull.who}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Section>
      )}
      {charts.milestones.length > 0 && (
        <Section title={t('Jalons')} note={t('tickets fermés')}>
          <div className="viz-milestones static">
            {charts.milestones.map((one) => (
              <div key={one.title} className="row">
                <span className="name" title={one.title}>
                  {one.title}
                </span>
                <Meter part={one.closed} whole={one.total} label={one.title} />
                <span className="num">
                  {one.closed} / {one.total}
                  {one.total ? `, ${t('{0} %', { 0: Math.floor((100 * one.closed) / one.total) })}` : ''}
                </span>
                <span className="num">{one.due ? dueOf(one.due) : ''}</span>
              </div>
            ))}
          </div>
        </Section>
      )}
      {charts.statuses && charts.statuses.length > 0 && (
        <Section title={t('Tableau du projet')}>
          <SegmentedBar label={t('Tickets par statut du projet')} parts={charts.statuses.map(({ status, count: value }, index) => ({ name: status, value, color: statusRamp()[Math.max(STATUSES.indexOf(status), index % statusRamp().length)] }))} />
          <TableView head={[t('Statut'), t('Tickets')]} numeric={1} rows={charts.statuses.map(({ status, count: value }) => [status, value])} />
        </Section>
      )}
      {charts.ships.length > 0 && (
        <Section title={t('Qui livre')}>
          <table className="viz-table">
            <thead>
              <tr>
                <th>{t('Qui')}</th>
                <th className="n">{t('PR ouvertes')}</th>
                <th className="n">{t('Mergées')}</th>
                <th className="n">{t('Tickets ouverts')}</th>
              </tr>
            </thead>
            <tbody>
              {charts.ships.map((row) => (
                <tr key={row.who}>
                  <td>{row.who}</td>
                  <td className="n">{charts.pullsRead ? row.open : '—'}</td>
                  <td className="n">{row.merged}</td>
                  <td className="n">{row.opened}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Section>
      )}
      {charts.areas.length > 0 && (
        <Section title={t('Domaines')}>
          <Legend
            items={[
              { name: t('Fermés'), color: C.closed },
              { name: t('Ouverts'), color: C.opened },
            ]}
          />
          <HBars
            rows={charts.areas.map((area) => ({
              label: area.area,
              parts: [
                { name: t('Fermés'), color: C.closed, value: area.closed },
                { name: t('Ouverts'), color: C.opened, value: area.open },
              ],
            }))}
          />
        </Section>
      )}
      {charts.queue && charts.queue.length > 0 && (
        <Section title={t('File de relecture')} note={count(charts.queue.length, t('prête'))}>
          <table className="viz-table">
            <thead>
              <tr>
                <th>PR</th>
                <th>{t('Auteur')}</th>
                <th>CI</th>
                <th>{t('Revue')}</th>
                <th className="n">{t('Ouverte depuis')}</th>
              </tr>
            </thead>
            <tbody>
              {charts.queue.map((pull) => (
                <tr key={pull.number}>
                  <td className="wide">{pullLink(pull)}</td>
                  <td>{pull.who}</td>
                  <td>{CI_WORDS[ciWordOf(pull.ci)]}</td>
                  <td>{reviewWords[pull.review] ?? ''}</td>
                  <td className="n">{pull.hours < 48 ? t('{0} h', { 0: pull.hours }) : t('{0} j', { 0: Math.round(pull.hours / 24) })}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Section>
      )}
      {charts.ciRows.length > 0 && (
        <Section title={t('CI')} note={t('par heure de démarrage')}>
          <Legend
            items={[
              { name: t('✓ réussis'), color: C.success },
              { name: t('× échoués'), color: C.failure },
            ]}
          />
          <Columns
            stacked
            label={t('Runs réussis et échoués par heure')}
            labels={charts.ciRows.map((row) => row.label)}
            series={[
              { name: t('réussis'), color: C.success, values: charts.ciRows.map((row) => row.success) },
              { name: t('échoués'), color: C.failure, values: charts.ciRows.map((row) => row.failure) },
            ]}
          />
          {charts.failing.length > 0 && (
            <>
              <h5 className="rep-sub">{t('Là où ça casse')}</h5>
              <HBars
                rows={charts.failing.map((row) => ({
                  label: row.branch,
                  href: row.pr ? `${REPOSITORY_URL}/pull/${row.pr}` : undefined,
                  note: t('sur {0}', { 0: row.total }),
                  parts: [{ name: t('échoués'), color: C.failure, value: row.failure }],
                }))}
              />
            </>
          )}
        </Section>
      )}
    </>
  )
}

/** The repository's figures of the period: what was done today, the milestone, the CI. */
function RepositoryTiles({ repo, finished, since }: { repo: RepositoryFacts; finished: boolean; since: string }) {
  const period = finished ? t('ce jour-là') : t("aujourd'hui")
  // Since the last report, when that isn't the whole of the day.
  const sinceStart = !finished && since !== t('depuis minuit') ? t('{0} : {1}', { 0: since, 1: repo.since.merged }) : undefined
  return (
    <>
      <StatTile value={repo.today.merged} label={t('PR mergées {0}', { 0: period })} detail={sinceStart} />
      <StatTile value={repo.today.closed} label={t('tickets fermés {0}', { 0: period })} detail={plural(repo.today.opened, '{0} ouvert', '{0} ouverts')} />
      {repo.milestone ? (
        <StatTile value={repo.milestone.total ? t('{0} %', { 0: Math.floor((100 * repo.milestone.closed) / repo.milestone.total) }) : '—'} label={t('jalon {0}', { 0: repo.milestone.title.split(' ')[0] })} detail={`${repo.milestone.closed} / ${repo.milestone.total}${repo.milestone.due ? t(', échéance {0}', { 0: dueOf(repo.milestone.due) }) : ''}`} />
      ) : (
        <StatTile value="—" label={t('jalon')} detail={t('aucun en cours')} />
      )}
      <StatTile value={repo.ci.rate === null ? '—' : t('{0} %', { 0: repo.ci.rate })} label={t('CI réussie')} detail={`${repo.ci.finished ? count(repo.ci.finished, 'run') : t('aucun run terminé')} ${since}`} />
    </>
  )
}

function Body({ report }: { report: Report }) {
  const { board, repository: repo } = report
  const finished = report.kind === 'day'
  const since = sinceWords(report)
  const sections = finished ? daySections(report) : [{ title: t('Résumé'), lines: keyPoints(report) }]
  const messages = board.messages.members + board.messages.drafts + board.messages.agents
  const polls = board.pollsOpened.length + board.pollsClosed.length
  const repoQuiet = !repo || repo.since.merged + repo.since.closed + repo.since.opened + repo.ci.finished === 0
  return (
    <>
      {report.late && <p className="viz-stale">{LATE_NOTE()}</p>}
      <Lines sections={sections} />
      <div className="viz-tiles">
        <StatTile value={messages} label={t('messages {0}', { 0: since })} detail={board.messages.agents ? t('dont {0} des agents seuls', { 0: board.messages.agents }) : board.byMember.length ? plural(board.byMember.length, '{0} membre a écrit', '{0} membres ont écrit') : undefined} />
        <StatTile value={board.threadsOpened.length} label={t('fils ouverts {0}', { 0: since })} detail={board.threadsClosed.length ? plural(board.threadsClosed.length, '{0} fil clos', '{0} fils clos') : undefined} />
        {polls > 0 && <StatTile value={board.pollsOpened.length} label={t('sondages ouverts {0}', { 0: since })} detail={board.pollsClosed.length ? plural(board.pollsClosed.length, '{0} sondage clos', '{0} sondages clos') : undefined} />}
        {repo && <RepositoryTiles repo={repo} finished={finished} since={since} />}
      </div>
      {board.threadsOpened.length > 0 && (
        <Section title={t('Fils ouverts')} note={plural(board.threadsOpened.length, '{0} fil', '{0} fils')}>
          <table className="viz-table">
            <tbody>
              {board.threadsOpened.map((thread) => (
                <tr key={thread.id}>
                  <td className="wide">
                    <a href={`#t/${thread.id}`}>{thread.title}</a>
                  </td>
                  <td>{thread.who}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Section>
      )}
      {board.pollsClosed.length > 0 && (
        <Section title={t('Sondages clos')}>
          <table className="viz-table">
            <tbody>
              {board.pollsClosed.map((poll) => (
                <tr key={poll.messageId}>
                  <td className="wide">
                    <a href={`#t/${poll.threadId}`}>{poll.question}</a>
                  </td>
                  <td>{poll.leading ?? t('sans vote')}</td>
                  <td className="n">{plural(poll.voters, '{0} votant', '{0} votants')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Section>
      )}
      {repo && !repoQuiet && <RepositoryCharts charts={{ ...repo, pullsRead: repo.pulls !== null, milestoneDue: repo.milestone?.due ?? null, mergedCount: repo.since.merged }} finished={finished} since={since} to={report.to} />}
    </>
  )
}

/** A report from an earlier version: its sentences were written in French, and are read through their pieces. */
function LegacyBody({ report }: { report: LegacyReport }) {
  const { figures } = report
  const finished = report.kind === 'day'
  const since = reportLine(report.sinceWord)
  const period = finished ? t('ce jour-là') : t("aujourd'hui")
  const sinceStart = !finished && report.sinceWord !== 'depuis minuit' ? t('{0} : {1}', { 0: since, 1: figures.since.merged }) : undefined
  return (
    <>
      {report.late && <p className="viz-stale">{LATE_NOTE()}</p>}
      <Lines sections={report.sections.map((section) => ({ title: reportLine(section.title), lines: section.lines.map(reportLine) }))} />
      <div className="viz-tiles">
        <StatTile value={figures.today.merged} label={t('PR mergées {0}', { 0: period })} detail={sinceStart} />
        <StatTile value={figures.today.closed} label={t('tickets fermés {0}', { 0: period })} detail={plural(figures.today.opened, '{0} ouvert', '{0} ouverts')} />
        {figures.milestone ? (
          <StatTile value={figures.milestone.total ? t('{0} %', { 0: Math.floor((100 * figures.milestone.closed) / figures.milestone.total) }) : '—'} label={t('jalon {0}', { 0: figures.milestone.title.split(' ')[0] })} detail={`${figures.milestone.closed} / ${figures.milestone.total}${figures.milestone.due ? t(', échéance {0}', { 0: dueOf(figures.milestone.due) }) : ''}`} />
        ) : (
          <StatTile value="—" label={t('jalon')} detail={t('aucun en cours')} />
        )}
        <StatTile value={figures.ci.rate === null ? '—' : t('{0} %', { 0: figures.ci.rate })} label={t('CI réussie')} detail={`${figures.ci.finished ? count(figures.ci.finished, 'run') : t('aucun run terminé')} ${since}`} />
      </div>
      {!report.quiet && (
        <RepositoryCharts
          charts={{ burnup: report.burnup.map((curve) => ({ ...curve, title: reportLine(curve.title) })), activity: report.activity, merged: report.merged, milestones: report.milestones, statuses: report.board, ships: report.ships, areas: report.areas, queue: report.queue, ciRows: report.ci, failing: report.failing, pullsRead: figures.pulls !== null, milestoneDue: figures.milestone?.due ?? null, mergedCount: figures.since.merged }}
          finished={finished}
          since={since}
          to={report.to}
        />
      )}
    </>
  )
}

/** A report, drawn from its figures in the reader's language: opening one spends no translation. */
export function ReportPage({ id }: { id: string }) {
  const [report, setReport] = useState<Report | LegacyReport | null>(null)
  const [error, setError] = useState<string | null>(null)
  const zone = useRef<HTMLDivElement>(null)
  useScrollMemory(id, zone, Boolean(report))
  useEffect(() => {
    let closed = false
    setReport(null)
    setError(null)
    call<Report | LegacyReport>(`reports/${encodeURIComponent(id)}`).then(
      (found) => {
        if (!closed) setReport(found)
      },
      (failure) => {
        if (!closed) setError((failure as Error).message)
      },
    )
    return () => {
      closed = true
    }
  }, [id])
  const title = report ? (report.kind === 'day' ? t('Rapport du {0}', { 0: fullDay(report.day) }) : t('Point de {0}:00, {1}', { 0: String(report.slot).padStart(2, '0'), 1: fullDay(report.day) })) : t('Rapport')
  const subject = useMemo(() => ({ label: title, doc: `reports/${id}.json` }), [title, id])
  return (
    <section className="now">
      <header className="chat-head">
        <div>
          <span className="kind">{report ? t('Généré automatiquement à {0} par l’app de {1}', { 0: clock(report.at), 1: nameOf(report.by) }) : t('Rapport')}</span>
          <h1>{title}</h1>
        </div>
        <div className="chat-actions">
          <Discuss subject={subject} className="ghost" />
        </div>
      </header>
      <div className="now-scroll" ref={zone}>
        <div className="inf-body">
          {error && <div className="inline-error">{error}</div>}
          {!report && !error && <Loading>{t('Lecture du rapport…')}</Loading>}
          <ChartBoundary key={id}>{report && (report.v === 1 ? <LegacyBody report={report} /> : <Body report={report} />)}</ChartBoundary>
        </div>
      </div>
    </section>
  )
}

/** A chart written in a message, in the colours its caption names. */
export function MermaidBlock({ source }: { source: string }) {
  return (
    <ChartBoundary>
      <MermaidDrawing source={source} />
    </ChartBoundary>
  )
}

function MermaidDrawing({ source }: { source: string }) {
  const parsed = useMemo(() => parseMermaid(source), [source])
  if (!parsed)
    return (
      <pre>
        <code>{source}</code>
      </pre>
    )
  if (parsed.kind === 'flow') {
    const nameOf = (id: string) => parsed.nodes.find((node) => node.id === id)?.name ?? id
    return (
      <div className="rep-flow">
        <div className="rep-flow-nodes">
          {parsed.nodes.map((node) => (
            <div key={node.id} className="rep-flow-node">
              <span>{node.name}</span>
              {node.count && <b>{node.count}</b>}
            </div>
          ))}
        </div>
        {parsed.edges.length > 0 && (
          <ul>
            {parsed.edges.map((edge, index) => (
              <li key={index}>
                {nameOf(edge.from)} → {nameOf(edge.to)} : {edge.label}
              </li>
            ))}
          </ul>
        )}
      </div>
    )
  }
  const series = parsed.series.map((one, index) => ({ name: t('Série {0}', { 0: index + 1 }), color: one.color, values: one.values }))
  const onlyLines = parsed.series.every((one) => one.type === 'line')
  return (
    <div className="rep-mermaid">
      {onlyLines ? <LineChart label={parsed.title || t('Graphique')} labels={parsed.labels} series={series} height={170} /> : <Columns label={parsed.title || t('Graphique')} labels={parsed.labels} series={series} height={170} />}
    </div>
  )
}
