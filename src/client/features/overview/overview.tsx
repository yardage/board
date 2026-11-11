import { useCallback, useEffect, useMemo, useState } from 'react'
import { trimEmptyStart } from '../../lib/lists.ts'
import { useRemembered } from '../../lib/memory.ts'
import { call } from '../../lib/api.ts'
import { ChartBoundary, Columns, HBars, Legend, LineChart, Meter, Section, SegmentedBar, StatTile, TableView, Spark } from '../../components/charts.tsx'
import { Discuss, LinkedThreads } from '../../components/discuss.tsx'
import { Brief, HostsTab, hour, readAt, type Snapshot, Timeline } from './infra.tsx'
import {
  activityBy,
  areasOf,
  bucketsFor,
  burnup,
  ciBy,
  ciSummary,
  ciWordOf,
  pullsNow,
  dayTicks,
  failingBranches,
  forecast,
  headline,
  HOUR,
  nextMilestone,
  OVERVIEW_TABS,
  type OverviewTab,
  type Range,
  RANGES,
  recentMerges,
  STATUSES,
  isTicket,
  dailyCounts,
  deliveryTimes,
  forecastRange,
  itemsOfBucket,
  oldestUnreviewed,
  queueWait,
  retriedRuns,
  runsOfBucket,
  ticketsOfArea,
  ticketsOfStatus,
  versusYesterday,
  startOfDay,
  statusCounts,
  subjectOfTab,
  toTab,
  whoShips,
} from '../../../shared/metrics.ts'
import { type NowData, TeamTab } from './team.tsx'
import { personOf } from '../../lib/people.tsx'
import { REPOSITORY_URL, subjectOfItem } from '../../lib/subject.ts'
import { Loading } from '../../components/ui.tsx'
import type { History, OpenPull } from '../../../server/github/copy.ts'
import { count, dateLocale, t } from '../../../shared/i18n/i18n.ts'
import { statusRamp } from '../../../shared/themes.ts'

/**
 * The overview: what needs someone now, how far the work has got, how it flows, how CI does, and the machines.
 * Every figure is a count of what GitHub lists, every colour comes with a word, and every chart has its table.
 */

const REFRESH_MS = 30_000
/** The first reading of the whole history takes a minute: it shows as soon as it exists. */
const FIRST_READING_MS = 5_000

/** The series keep their colour on every chart, and status colours always come with a word. */
const C = { pulls: 'var(--chart-1)', closed: 'var(--chart-2)', opened: 'var(--chart-3)', total: 'var(--chart-4)', success: 'var(--green)', failure: 'var(--danger)', other: 'var(--faint)' }

const fmtDay = (iso: string) => new Date(iso).toLocaleDateString(dateLocale(), { day: 'numeric', month: 'short' })
/** A due date is a day, whichever time zone reads it. */
const fmtDue = (due: string) => {
  const [year, month, day] = due.slice(0, 10).split('-').map(Number)
  return new Date(year, month - 1, day).toLocaleDateString(dateLocale(), { day: 'numeric', month: 'short' })
}
const fmtMoment = (time: number) => new Date(time).toLocaleString(dateLocale(), { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
const agoLong = (iso: string, now: number) => {
  const hours = (now - Date.parse(iso)) / HOUR
  if (hours < 1) return `${Math.max(1, Math.round(hours * 60))} min`
  if (hours < 48) return `${Math.round(hours)} h`
  return t('{0} j', { 0: Math.round(hours / 24) })
}
const commaOf = (value: number) => value.toLocaleString(dateLocale(), { maximumFractionDigits: 1 })

interface OverviewData {
  history: History | null
  error: string | null
  members: { login: string; name: string }[]
  unconfigured?: boolean
}

const isRange = (value: unknown): value is Range => RANGES.some(([id]) => id === value)
const isChoice = (value: unknown): value is string | null => value === null || typeof value === 'string'

/** A number of hours, in the fewest words. */
const lengthOf = (hours: number | null) => (hours === null ? '—' : hours < 1 ? `${Math.round(hours * 60)} min` : hours < 48 ? t('{0} h', { 0: commaOf(hours) }) : t('{0} j', { 0: commaOf(hours / 24) }))
/** Nine in ten of a handful means nothing. */
const tenthWords = (spread: { count: number; p90: number | null }) => (spread.count >= 10 ? t(', 9 sur 10 en moins de {0}', { 0: lengthOf(spread.p90) }) : '')
const versusWords = (delta: number) => (delta === 0 ? t('autant qu\'hier à cette heure') : t('{0}{1} par rapport à hier à cette heure', { 0: delta > 0 ? '+' : '−', 1: Math.abs(delta) }))
const nameOf = (login: string) => personOf(login).name
const pullUrl = (number: number) => `${REPOSITORY_URL}/pull/${number}`

const reviewWords: Record<string, string> = { none: t('pas encore'), approved: t('✓ approuvée'), stale: t('▲ à refaire'), changes: t('× à reprendre') }
const CI_WORDS = { success: t('✓ verte'), failure: t('× rouge'), running: t('en cours'), other: t('autre'), none: t('pas vue') }
const ciWord = (ci: string) => CI_WORDS[ciWordOf(ci)]

/** A figure's last days and how it compares. */
function Trend({ times, now }: { times: (string | null)[]; now: number }) {
  return (
    <span className="viz-trend">
      <Spark values={dailyCounts(times, now)} /> {versusWords(versusYesterday(times, now))}
    </span>
  )
}

/** What a chart's column or bar holds. */
function PickedItems({ title, items, onClose }: { title: string; items: { number: number; kind: string; title: string; note: string }[]; onClose: () => void }) {
  return (
    <div className="viz-picked">
      <header>
        <strong>{title}</strong>
        <small>{items.length ? count(items.length, t('élément')) : ''}</small>
        <button type="button" className="link" onClick={onClose}>
          {t('Fermer')}
        </button>
      </header>
      {items.length === 0 && <p className="muted">{t('Rien ici.')}</p>}
      <ul>
        {items.slice(0, 200).map((item) => (
          <li key={`${item.number}-${item.note}`}>
            <a href={`${REPOSITORY_URL}/${item.kind === 'pull' ? 'pull' : 'issues'}/${item.number}`} target="_blank" rel="noreferrer">
              #{item.number}
            </a>{' '}
            {item.title} {item.note && <small>{item.note}</small>}
          </li>
        ))}
      </ul>
      {items.length > 200 && <p className="muted">{t('Les 200 premiers, sur {0}.', { 0: items.length })}</p>}
    </div>
  )
}

function RangeRow({ range, onChange }: { range: Range; onChange: (range: Range) => void }) {
  return (
    <div className="viz-filters" role="group" aria-label={t('Période')}>
      {RANGES.map(([id, label]) => (
        <button key={id} type="button" className={range === id ? 'on' : ''} aria-pressed={range === id} onClick={() => onChange(id)}>
          {label}
        </button>
      ))}
    </div>
  )
}

/** The pull requests waiting for a review, oldest first, with their CI and review in words. */
function ReviewQueue({ pulls, read, now }: { pulls: OpenPull[]; read: boolean; now: number }) {
  const queue = pulls.filter((pull) => !pull.draft).sort((a, b) => a.created.localeCompare(b.created))
  const drafts = pulls.length - queue.length
  return (
    <Section title={t('À relire')} note={read ? t('{0}{1}', { 0: count(queue.length, t('prête')), 1: drafts ? t(', {0} à part', { 0: count(drafts, t('brouillon')) }) : '' }) : undefined}>
      {!read ? (
        <p className="muted">{t('Les pull requests n\'ont pas encore été lues.')}</p>
      ) : queue.length === 0 ? (
        <p className="muted">{t('Rien à relire.')}</p>
      ) : (
        <table className="viz-table">
          <thead>
            <tr>
              <th>PR</th>
              <th>{t('Auteur')}</th>
              <th>CI</th>
              <th>{t('Revue')}</th>
              <th className="n">{t('Ouverte depuis')}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {queue.map((pull) => (
              <tr key={pull.number} className={ciWordOf(pull.ci) === 'failure' ? 'red' : ''}>
                <td className="wide">
                  <a href={pullUrl(pull.number)}>#{pull.number}</a> {pull.title}
                </td>
                <td>{nameOf(pull.author)}</td>
                <td>{ciWord(pull.ci)}</td>
                <td>{reviewWords[pull.review] ?? ''}</td>
                <td className="n">{agoLong(pull.created, now)}</td>
                <td>
                  <Discuss subject={subjectOfItem(pullUrl(pull.number), pull.number, pull.title)}>{t('fil')}</Discuss>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Section>
  )
}

/** What waits for a person's word, from the copy of GitHub. */
function Decisions({ data }: { data: Snapshot }) {
  return (
    <Section title={t('Attend quelqu’un')} note={data.waiting ? String(data.waiting.length) : undefined}>
      {!data.waiting && <p className="muted">{t('Synchronisation avec GitHub…')}</p>}
      {data.waiting?.length === 0 && <p className="muted">{t('Rien n\'attend de réponse.')}</p>}
      {data.waiting && data.waiting.length > 0 && (
        <table className="viz-table">
          <tbody>
            {data.waiting.map((item) => (
              <tr key={item.number}>
                <td className="wide">
                  <a href={`${REPOSITORY_URL}/issues/${item.number}`}>#{item.number}</a> {item.title}
                </td>
                <td>{item.who ? t('attend {0}', { 0: nameOf(item.who) }) : t('attend une réponse')}</td>
                <td>
                  <a href="#valider" className="link">
                    {t('répondre')}
                  </a>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Section>
  )
}

function Headlines({ history, data, now }: { history: History; data: Snapshot; now: number }) {
  const head = useMemo(() => headline(history.items, history.runs, now), [history, now])
  const next = nextMilestone(data.milestones)
  const merged = useMemo(() => history.items.filter((item) => item.kind === 'pull').map((item) => item.merged), [history])
  const closed = useMemo(() => history.items.filter(isTicket).map((item) => item.closed), [history])
  // Not read yet: the copy's count, rather than a list that reads as "none".
  const pulls = history.pullsAt ? pullsNow(history.pulls) : data.pulls
  const waiting = oldestUnreviewed(history.pulls)
  // A day whose first runs weren't all read says from when it counts.
  const runsSince = history.runsFrom && Date.parse(history.runsFrom) > startOfDay(now) ? t(' depuis {0}', { 0: hour(history.runsFrom) }) : ''
  const mainWords: Record<string, string> = { success: t('✓ main verte'), failure: t('× main rouge'), other: t('main annulée'), running: t('main en cours'), queued: t('main en file') }
  const mainWord = data.main ? mainWords[data.main.ci] : t('rien sur main depuis 2 h')
  return (
    <div className="viz-tiles five">
      <StatTile value={head.merged} label={t('PR mergées aujourd\'hui')} detail={<>{pulls ? t('{0}, dont {1} en brouillon', { 0: count(pulls.open, t('ouverte')), 1: pulls.draft }) : ''}<Trend times={merged} now={now} /></>} />
      <StatTile value={head.closed} label={t('tickets fermés aujourd\'hui')} detail={<>{t('{0} aujourd\'hui', { 0: count(head.opened, t('ouvert')) })}<Trend times={closed} now={now} /></>} />
      <StatTile value={waiting ? agoLong(waiting.created, now) : history.pullsAt ? '—' : '…'} label={t('plus ancienne PR sans revue')} detail={waiting ? `#${waiting.number}${pulls?.red ? t(', {0} en rouge', { 0: pulls.red }) : ''}` : history.pullsAt ? t('aucune') : t('pas encore lu')} />
      <StatTile value={head.ci.rate === null ? '—' : t('{0} %', { 0: head.ci.rate })} label={t('CI réussie aujourd\'hui')} detail={head.ci.finished ? `${count(head.ci.finished, 'run')}${runsSince}, ${mainWord}` : mainWord} />
      {next ? (
        <StatTile value={t('{0} %', { 0: Math.floor((100 * next.closed) / Math.max(next.total, 1)) })} label={t('jalon {0}', { 0: next.title.split(' ')[0] })} detail={`${next.closed} / ${next.total}${next.due ? t(', échéance {0}', { 0: fmtDue(next.due) }) : ''}`} />
      ) : (
        <StatTile value="—" label={t('jalon')} detail={t('aucun en cours')} />
      )}
    </div>
  )
}

/** Now: what is red, what waits for someone, and the day's figures. */
function GlobalTab({ data, history, now, waiting }: { data: Snapshot; history: History | null; now: number; waiting: boolean }) {
  return (
    <>
      <Brief data={data} />
      {history ? <Headlines history={history} data={data} now={now} /> : waiting && <FirstReading />}
      {history && <ReviewQueue pulls={history.pulls} read={Boolean(history.pullsAt)} now={now} />}
      <Decisions data={data} />
    </>
  )
}

const FirstReading = () => (
  <p className="side-empty">
    <Loading>{t('Première lecture de l\'historique de GitHub. Elle prend environ une minute, une seule fois.')}</Loading>
  </p>
)

function Burnup({ title, history, milestone, now, due }: { title: string; history: History; milestone: string | null; now: number; due?: string | null }) {
  const points = useMemo(() => burnup(history.items, milestone, now), [history, milestone, now])
  if (!points.length)
    return (
      <Section title={title}>
        <p className="muted">{t('Aucun ticket.')}</p>
      </Section>
    )
  const last = points[points.length - 1]
  const labels = points.map((point) => fmtMoment(point.time))
  const axis = dayTicks(points.map((point) => point.time), 8).map((index) => ({ index, label: fmtDay(new Date(points[index].time).toISOString()) }))
  return (
    <Section title={title} note={`${last.closed} / ${last.total}${due ? t(', échéance {0}', { 0: fmtDue(due) }) : ''}`}>
      <Legend
        items={[
          { name: t('Total'), color: C.total, line: true },
          { name: t('Fermés'), color: C.closed, line: true },
        ]}
      />
      <LineChart
        label={t('{0} : {1} tickets fermés sur {2}', { 0: title, 1: last.closed, 2: last.total })}
        labels={labels}
        axis={axis}
        series={[
          { name: t('Total'), color: C.total, values: points.map((point) => point.total) },
          { name: t('Fermés'), color: C.closed, values: points.map((point) => point.closed) },
        ]}
      />
      <TableView
        head={[t('Moment'), t('Total'), t('Fermés')]}
        numeric={1}
        rows={points.filter((_, index) => index % 6 === 0 || index === points.length - 1).map((point) => [fmtMoment(point.time), point.total, point.closed])}
      />
    </Section>
  )
}

/** A line of arithmetic, and it says so: the pace of the last days, nothing about what comes next. */
function ForecastLine({ history, title, milestone, due, now }: { history: History; title: string; milestone: string; due: string | null; now: number }) {
  const { total, remaining, pace, daysLeft, daysToDue } = useMemo(() => forecast(history.items, milestone, due, now), [history, milestone, due, now])
  const range = useMemo(() => forecastRange(history.items, milestone, due, now), [history, milestone, due, now])
  const rangeWords = range ? t(' Selon le rythme des {0} derniers jours : entre {1} et {2} j.', { 0: range.windows.join(', ').replace(/, (\d+)$/, t(' ou $1')), 1: commaOf(range.low), 2: commaOf(range.high) }) : ''
  if (total === 0) return null
  if (remaining === 0) return <p className="viz-note">{t('{0} : tout est fermé.', { 0: title })}</p>
  const dueWords = daysToDue === null ? '' : daysToDue < 0 ? t(' L\'échéance est dépassée de {0} j.', { 0: -daysToDue }) : daysToDue === 0 ? t(' L\'échéance est aujourd\'hui.') : t(' L\'échéance est dans {0} j.', { 0: daysToDue })
  return (
    <p className="viz-note">
      {daysLeft === null
        ? t('{0} : {1} à fermer, et aucun n\'a été fermé ces 3 derniers jours.{2}', { 0: title, 1: count(remaining, t('ticket')), 2: dueWords })
        : t('{0} : {1} à fermer. Au rythme des 3 derniers jours, {2} par jour, cela ferait {3} j.{4}{5} C\'est un calcul sur le rythme passé, pas une prévision.', { 0: title, 1: count(remaining, t('ticket')), 2: commaOf(pace), 3: commaOf(daysLeft), 4: rangeWords, 5: dueWords })}
    </p>
  )
}

/** How far the work has got: a milestone's curve and pace, every milestone, the project's statuses, the open work by area. */
function ProgressTab({ data, history, now }: { data: Snapshot; history: History; now: number }) {
  const next = nextMilestone(data.milestones)
  const [wanted, setAsked] = useRemembered<string | null>('overview-milestone', null, isChoice)
  // A milestone remembered may be gone since.
  const asked = wanted === 'all' || data.milestones.some((one) => one.title === wanted) ? wanted : null
  /** `'all'` for every ticket. Not chosen: the milestone that comes next. */
  const chosen = asked === 'all' ? null : (asked ?? next?.title ?? null)
  const milestone = data.milestones.find((one) => one.title === chosen) ?? null
  const scope = chosen ?? t('Tous les tickets')
  const statuses = history.project?.statuses
  const counts = useMemo(() => (statuses ? statusCounts(history.items, statuses, chosen) : null), [history, statuses, chosen])
  const areas = useMemo(() => areasOf(history.items, chosen).filter((area) => area.open > 0).slice(0, 14), [history, chosen])
  const [picked, setPicked] = useState<{ kind: 'status' | 'area'; name: string } | null>(null)
  const pickedRows = useMemo(() => {
    if (!picked) return []
    const found = picked.kind === 'area' ? ticketsOfArea(history.items, picked.name, chosen).filter((item) => !item.closed) : statuses ? ticketsOfStatus(history.items, statuses, picked.name, chosen) : []
    return found.map((item) => ({ number: item.number, kind: item.kind, title: item.title, note: item.closed ? t('fermé') : '' }))
  }, [picked, history, statuses, chosen])
  const showPicked = (kind: 'status' | 'area') => picked?.kind === kind && <PickedItems title={`${picked.name}, ${scope}`} items={pickedRows} onClose={() => setPicked(null)} />
  const ramp = statusRamp()
  const colourOf = (status: string, index: number) => ramp[Math.max(STATUSES.indexOf(status), index % ramp.length)]
  return (
    <>
      <div className="viz-filters">
        <label>
          {t('Jalon')}{' '}
          <select value={asked === 'all' ? 'all' : (chosen ?? 'all')} onChange={(event) => setAsked(event.target.value)}>
            <option value="all">{t('Tous les tickets')}</option>
            {data.milestones.map((one) => (
              <option key={one.title} value={one.title}>
                {one.title}
              </option>
            ))}
          </select>
        </label>
        <small>{t('Un ticket compte dans son jalon actuel.')}</small>
      </div>
      <Burnup title={scope} history={history} milestone={chosen} now={now} due={milestone?.due} />
      {chosen && <ForecastLine history={history} title={chosen} milestone={chosen} due={milestone?.due ?? null} now={now} />}
      <Section title={t('Jalons')} note={t('tickets fermés')}>
        {data.milestones.length === 0 && <p className="muted">{t('Aucun jalon ouvert.')}</p>}
        <div className="viz-milestones">
          {data.milestones.map((one) => (
            <button key={one.title} type="button" className={one.title === chosen ? 'on' : ''} aria-pressed={one.title === chosen} onClick={() => setAsked(one.title === chosen ? 'all' : one.title)}>
              <span className="name" title={one.title}>
                {one.title}
              </span>
              <Meter part={one.closed} whole={one.total} label={one.title} />
              <span className="num">
                {one.closed} / {one.total}
                {one.total ? `, ${t('{0} %', { 0: Math.floor((100 * one.closed) / one.total) })}` : ''}
              </span>
              <span className="num">{one.due ? fmtDue(one.due) : ''}</span>
            </button>
          ))}
        </div>
      </Section>
      <div className="viz-two">
        <Section title={t('Tableau du projet')} note={history.project ? t('{0}, lu à {1}', { 0: scope, 1: readAt(history.project.at) }) : scope}>
          {counts && counts.length > 0 ? (
            <>
              <SegmentedBar label={t('Tickets par statut du projet')} parts={counts.map(({ status, count: amount }, index) => ({ name: status, value: amount, color: colourOf(status, index) }))} />
              <table className="viz-table">
                <tbody>
                  {counts.map(({ status, count: amount }, index) => (
                    <tr key={status}>
                      <td>
                        <i className="viz-key" style={{ background: colourOf(status, index) }} /> {status}
                      </td>
                      <td className="n">{amount}</td>
                      <td>
                        {amount > 0 && (
                          <button type="button" className="link" onClick={() => setPicked({ kind: 'status', name: status })}>
                            {t('voir')}
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {showPicked('status')}
            </>
          ) : counts ? (
            <p className="muted">{t('Aucun ticket dans le projet.')}</p>
          ) : (
            <p className="muted">{t('Pas encore synchronisé. Ce compte GitHub doit avoir accès au projet.')}</p>
          )}
        </Section>
        <Section title={t('Ouverts par domaine')} note={scope}>
          {areas.length ? (
            <>
              <HBars rows={areas.map((area) => ({ label: area.area, parts: [{ name: t('Ouverts'), color: C.opened, value: area.open }] }))} onPick={(name) => setPicked({ kind: 'area', name })} />
              {showPicked('area')}
              <TableView head={[t('Domaine'), t('Ouverts'), t('Fermés')]} numeric={1} rows={areas.map((area) => [area.area, area.open, area.closed])} />
            </>
          ) : (
            <p className="muted">{t('Aucun ticket ouvert n\'a de domaine ici.')}</p>
          )}
        </Section>
      </div>
    </>
  )
}

/** How the work flows: what was merged, closed and opened, how long it took, who did it. */
function ActivityTab({ history, now }: { history: History; now: number }) {
  const [range, setRange] = useRemembered<Range>('overview-range-activity', 'week', isRange)
  const buckets = useMemo(() => bucketsFor(range, now), [range, now])
  const rows = useMemo(() => {
    const found = activityBy(buckets, history.items)
    return range === 'today' ? found : trimEmptyStart(found, (row) => row.merged + row.closed + row.opened === 0)
  }, [buckets, history, range])
  const from = buckets[0]?.from ?? now
  const ships = useMemo(() => whoShips(history.items, history.pulls, history.lines ?? {}, from, now + 1, nameOf), [history, from, now])
  const merges = useMemo(() => recentMerges(history.items), [history])
  const sum = (key: 'merged' | 'closed' | 'opened') => rows.reduce((total, row) => total + row[key], 0)
  const [picked, setPicked] = useState<number | null>(null)
  const bucket = picked === null ? undefined : buckets[buckets.length - rows.length + picked]
  const pickedRows = useMemo(() => {
    if (!bucket) return []
    const found = itemsOfBucket(history.items, bucket)
    return [
      ...found.merged.map((item) => ({ number: item.number, kind: item.kind, title: item.title, note: t('mergée') })),
      ...found.closed.map((item) => ({ number: item.number, kind: item.kind, title: item.title, note: t('fermé') })),
      ...found.opened.map((item) => ({ number: item.number, kind: item.kind, title: item.title, note: t('ouvert') })),
    ]
  }, [bucket, history])
  const times = useMemo(() => deliveryTimes(history.items, from, now + 1), [history, from, now])
  return (
    <>
      <RangeRow
        range={range}
        onChange={(next) => {
          setRange(next)
          setPicked(null)
        }}
      />
      <div className="viz-tiles three">
        <StatTile value={sum('merged')} label={t('PR mergées')} />
        <StatTile value={sum('closed')} label={t('tickets fermés')} />
        <StatTile value={sum('opened')} label={t('tickets ouverts')} />
      </div>
      <Section title={t('Flux')} note={range === 'today' ? t('par heure, depuis minuit') : t('par jour')}>
        <Legend
          items={[
            { name: t('PR mergées'), color: C.pulls },
            { name: t('Tickets fermés'), color: C.closed },
            { name: t('Tickets ouverts'), color: C.opened },
          ]}
        />
        <Columns
          label={t('PR mergées, tickets fermés et ouverts par période')}
          labels={rows.map((row) => row.label)}
          series={[
            { name: t('PR mergées'), color: C.pulls, values: rows.map((row) => row.merged) },
            { name: t('Tickets fermés'), color: C.closed, values: rows.map((row) => row.closed) },
            { name: t('Tickets ouverts'), color: C.opened, values: rows.map((row) => row.opened) },
          ]}
          onPick={setPicked}
        />
        {bucket && <PickedItems title={bucket.label} items={pickedRows} onClose={() => setPicked(null)} />}
        <TableView head={[t('Période'), t('PR mergées'), t('Tickets fermés'), t('Tickets ouverts')]} numeric={1} rows={rows.map((row) => [row.label, row.merged, row.closed, row.opened])} />
      </Section>
      <Section title={t('Délais')} note={t('pour ce qui s\'est terminé sur la période')}>
        <div className="viz-tiles three">
          <StatTile value={lengthOf(times.pulls.median)} label={t('ouverture à merge, médiane')} detail={times.pulls.count ? `${times.pulls.count} PR${tenthWords(times.pulls)}` : t('aucune PR mergée')} />
          <StatTile value={lengthOf(times.tickets.median)} label={t('ouverture à fermeture, médiane')} detail={times.tickets.count ? `${count(times.tickets.count, t('ticket'))}${tenthWords(times.tickets)}` : t('aucun ticket fermé')} />
          <StatTile value={merges.length ? agoLong(merges[0].merged ?? '', now) : '—'} label={t('dernier merge')} detail={merges.length ? `#${merges[0].number}` : t('aucun')} />
        </div>
      </Section>
      <div className="viz-two">
        <Section title={t('Qui livre')} note={range === 'today' ? t('aujourd\'hui') : t('sur la période')}>
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
              {ships.map((row) => (
                <tr key={row.who}>
                  <td>{row.who}</td>
                  <td className="n">{row.open}</td>
                  <td className="n">{row.merged}</td>
                  <td className="n">{row.opened}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {ships.length === 0 && <p className="muted">{t('Rien sur la période.')}</p>}
        </Section>
        <Section title={t('Derniers merges')}>
          <table className="viz-table">
            <tbody>
              {merges.map((item) => (
                <tr key={item.number}>
                  <td className="wide">
                    <a href={pullUrl(item.number)}>#{item.number}</a> {item.title}
                  </td>
                  <td>{nameOf(item.author)}</td>
                  <td className="n">{t('il y a {0}', { 0: agoLong(item.merged ?? '', now) })}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {merges.length === 0 && <p className="muted">{t('Aucun merge encore.')}</p>}
        </Section>
      </div>
    </>
  )
}

/** CI: how often it passes, how long it takes, what runs now, and where it breaks. */
function CiTab({ data, history, now }: { data: Snapshot; history: History; now: number }) {
  const [range, setRange] = useRemembered<Range>('overview-range-ci', 'today', isRange)
  const buckets = useMemo(() => bucketsFor(range, now), [range, now])
  const rows = useMemo(() => {
    const found = ciBy(buckets, history.runs)
    return range === 'today' ? found : trimEmptyStart(found, (row) => row.success + row.failure === 0)
  }, [buckets, history, range])
  const from = buckets[0]?.from ?? now
  const summary = useMemo(() => ciSummary(history.runs, from, now + 1), [history, from, now])
  const failing = useMemo(() => failingBranches(history.runs, from, now + 1), [history, from, now])
  const [picked, setPicked] = useState<number | null>(null)
  const bucket = picked === null ? undefined : buckets[buckets.length - rows.length + picked]
  const pickedRuns = useMemo(() => (bucket ? runsOfBucket(history.runs, bucket) : []), [bucket, history])
  const retried = useMemo(() => retriedRuns(history.runs, from, now + 1), [history, from, now])
  const wait = useMemo(() => queueWait(data.jobs), [data])
  // Days of no runs and days not read mustn't look alike.
  const partial = history.runsFrom && Date.parse(history.runsFrom) > from ? history.runsFrom : null
  const queued = data.jobs.filter((job) => job.state === 'queued').length
  return (
    <>
      <RangeRow
        range={range}
        onChange={(next) => {
          setRange(next)
          setPicked(null)
        }}
      />
      {partial && <p className="viz-stale">{t('▲ Avant le {0}, des runs manquent : ces chiffres et ces graphiques sont incomplets.', { 0: fmtMoment(Date.parse(partial)) })}</p>}
      <div className="viz-tiles">
        <StatTile value={summary.rate === null ? '—' : t('{0} %', { 0: summary.rate })} label={t('réussis')} detail={`${t('{0} sur {1}', { 0: summary.success, 1: count(summary.finished, 'run') })} ${summary.finished > 1 ? t('terminés') : t('terminé')}`} />
        <StatTile value={summary.failure} label={t('× échoués')} detail={summary.other ? t('et {0} annulés ou ignorés', { 0: summary.other }) : undefined} />
        <StatTile value={summary.medianMinutes === null ? '—' : `${Math.round(summary.medianMinutes)} min`} label={t('durée médiane')} detail={summary.longestMinutes === null ? undefined : t('le plus long : {0} min', { 0: Math.round(summary.longestMinutes) })} />
        <StatTile value={retried.attemptsKnown ? retried.retried : '—'} label={t('runs relancés')} detail={retried.attemptsKnown ? t('sur {0} dont l\'essai est connu', { 0: count(retried.attemptsKnown, 'run') }) : t('pas encore noté sur ces runs')} />
      </div>
      <Section title={t('Runs')} note={range === 'today' ? t('par heure de démarrage, depuis minuit') : t('par jour de démarrage')}>
        <Legend
          items={[
            { name: t('✓ réussis'), color: C.success },
            { name: t('× échoués'), color: C.failure },
          ]}
        />
        <Columns
          stacked
          label={t('Runs réussis et échoués par période')}
          labels={rows.map((row) => row.label)}
          series={[
            { name: t('réussis'), color: C.success, values: rows.map((row) => row.success) },
            { name: t('échoués'), color: C.failure, values: rows.map((row) => row.failure) },
          ]}
          onPick={setPicked}
        />
        {bucket && (
          <div className="viz-picked">
            <header>
              <strong>{bucket.label}</strong>
              <small>{count(pickedRuns.length, 'run')}</small>
              <button type="button" className="link" onClick={() => setPicked(null)}>
                {t('Fermer')}
              </button>
            </header>
            {pickedRuns.length === 0 && <p className="muted">{t('Rien ici.')}</p>}
            <ul>
              {pickedRuns.slice(0, 200).map((run) => (
                <li key={run.id}>
                  <a href={`${REPOSITORY_URL}/actions/runs/${run.id}`} target="_blank" rel="noreferrer">
                    {run.state === 'failure' ? t('× échoué') : t('✓ réussi')}
                  </a>{' '}
                  {run.workflow ?? ''} <code>{run.branch}</code> {run.pr && <a href={pullUrl(run.pr)}>#{run.pr}</a>}
                  {(run.attempt ?? 1) > 1 && <small>{' '}{t('essai {0}', { 0: run.attempt })}</small>}
                </li>
              ))}
            </ul>
          </div>
        )}
        <TableView head={[t('Période'), t('Réussis'), t('Échoués'), t('Durée médiane (min)')]} numeric={1} rows={rows.map((row) => [row.label, row.success, row.failure, row.medianMinutes === null ? '' : Math.round(row.medianMinutes)])} />
      </Section>
      <Section title={t('En ce moment')} note={t('les deux dernières heures')}>
        <div className="viz-tiles three">
          <StatTile value={data.jobs.filter((job) => job.state === 'running').length} label={t('jobs en cours')} detail={queued ? t('{0} en file', { 0: queued }) : t('aucun en file')} />
          <StatTile value={wait.median === null ? '—' : `${commaOf(wait.median)} min`} label={t('attente d\'un runner, médiane')} detail={wait.count ? t('{0}, {1} min au plus', { 0: count(wait.count, 'job'), 1: commaOf(wait.longest ?? 0) }) : t('aucun job n’a attendu')} />
          <StatTile value={data.runners ? `${data.runners.filter((runner) => runner.busy).length} / ${data.runners.length}` : '—'} label={t('runners occupés')} detail={data.runners ? (data.runners.some((runner) => !runner.online) ? t('{0} hors ligne', { 0: data.runners.filter((runner) => !runner.online).length }) : t('tous en ligne')) : t('ce compte ne liste pas les runners')} />
        </div>
        <Timeline data={data} />
      </Section>
      <Section title={t('Là où ça casse')} note={t('runs échoués, par branche')}>
        {failing.length ? (
          <HBars
            rows={failing.map((row) => ({
              label: row.branch,
              href: row.pr ? pullUrl(row.pr) : undefined,
              note: t('sur {0}', { 0: row.total }),
              parts: [{ name: t('échoués'), color: C.failure, value: row.failure }],
            }))}
          />
        ) : (
          <p className="muted">{t('✓ Aucun échec sur cette période.')}</p>
        )}
      </Section>
    </>
  )
}

export function OverviewScreen({ tab, tick }: { tab: OverviewTab; tick: number }) {
  const [data, setData] = useState<Snapshot | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [overview, setOverview] = useState<OverviewData | null>(null)
  const [overviewError, setOverviewError] = useState<string | null>(null)
  const [now, setNow] = useState<NowData | null>(null)
  const [unconfigured, setUnconfigured] = useState(false)
  const loadNow = useCallback(() => {
    call<NowData>('now').then(setNow).catch(() => undefined)
  }, [])
  useEffect(loadNow, [loadNow, tick])
  useEffect(() => {
    let closed = false
    const load = async () => {
      // In a browser, a hidden tab. In the app a page can't tell, so the server answers from memory (`onScreen`).
      if (document.hidden) return
      try {
        // Null from a window nobody can see, when nothing has been read yet.
        const next = await call<Snapshot | { unconfigured: true } | null>('infra')
        if (closed || !next) return
        if ('unconfigured' in next) setUnconfigured(true)
        else {
          setData(next)
          setError(null)
        }
      } catch (failure) {
        if (!closed) setError((failure as Error).message)
      }
    }
    void load()
    // Only while this screen is open: closed, it costs no request.
    const timer = setInterval(() => {
      void load()
      loadNow()
    }, REFRESH_MS)
    // Back from the tray, what is shown is as old as the time away.
    const onFocus = () => void load()
    window.addEventListener('focus', onFocus)
    return () => {
      window.removeEventListener('focus', onFocus)
      closed = true
      clearInterval(timer)
    }
  }, [loadNow])
  const known = overview?.history != null
  useEffect(() => {
    let closed = false
    const load = async () => {
      if (document.hidden) return
      try {
        const next = await call<OverviewData>('overview')
        if (!closed) {
          setOverview(next)
          setOverviewError(null)
        }
      } catch (failure) {
        if (!closed) setOverviewError((failure as Error).message)
      }
    }
    void load()
    const timer = setInterval(load, known ? REFRESH_MS : FIRST_READING_MS)
    return () => {
      closed = true
      clearInterval(timer)
    }
  }, [known])
  const history = overview?.history ?? null
  // Today is today's date, even when what has been read is older: the screen says how old. By the minute, so that
  // the charts' work is done again when something changed, not at every drawing.
  const time = Math.floor(Date.now() / 60_000) * 60_000
  const historyProblem = overviewError ?? overview?.error ?? null
  // The ledger is read more often than the copy, whose date the schema shows.
  const shown = data && history?.pullsAt && (!data.stateAt || Date.parse(history.pullsAt) > Date.parse(data.stateAt)) ? { ...data, pulls: pullsNow(history.pulls), stateAt: history.pullsAt } : data
  const label = OVERVIEW_TABS.find(([id]) => id === tab)?.[1] ?? ''
  const subject = subjectOfTab(tab)
  const needsHistory = tab === 'avancement' || tab === 'activite' || tab === 'ci'
  return (
    <section className="now">
      <header className="chat-head">
        <div>
          <span className="kind">{data ? t('Lu à {0}', { 0: readAt(data.at) }) : t('En direct')}</span>
          <h1>{t('Vue d\'ensemble')}</h1>
        </div>
        <div className="chat-actions">
          <LinkedThreads subject={subject} />
          <Discuss subject={{ ...subject, title: label }} className="ghost" />
        </div>
      </header>
      <nav className="page-tabs" aria-label={t("Vue d'ensemble")}>
        {OVERVIEW_TABS.map(([id, name]) => (
          <a key={id} href={toTab(id)} aria-current={tab === id ? 'page' : undefined}>
            {name}
          </a>
        ))}
      </nav>
      <div className="now-scroll">
        <div className="inf-body">
          {error && (
            <div className="inline-error">
              {error}
              {data ? t(' Ce qui suit est la dernière lecture.') : ''}
            </div>
          )}
          {historyProblem && history && <p className="viz-stale">{t('▲ Ces chiffres sont ceux de {0} : GitHub n\'a pas répondu à la dernière lecture.', { 0: readAt(history.at) })}</p>}
          {historyProblem && !history && <div className="inline-error">{t('L\'historique de GitHub n\'a pas pu être lu : {0} Il sera redemandé.', { 0: historyProblem })}</div>}
          <ChartBoundary key={tab}>
            {tab === 'equipe' && <TeamTab data={now} />}
            {tab !== 'equipe' && (unconfigured || overview?.unconfigured) && <p className="hint">{t('Aucun dépôt n’est configuré : un administrateur en ajoute un sous « Réglages · Environnement ».')}</p>}
            {tab !== 'equipe' && !unconfigured && !overview?.unconfigured && !data && !error && <Loading>{t('Lecture des runners et des jobs…')}</Loading>}
            {shown && tab === 'global' && <GlobalTab data={shown} history={history} now={time} waiting={!historyProblem} />}
            {data && needsHistory && !history && !historyProblem && <FirstReading />}
            {shown && history && tab === 'avancement' && <ProgressTab data={shown} history={history} now={time} />}
            {history && tab === 'activite' && <ActivityTab history={history} now={time} />}
            {shown && history && tab === 'ci' && <CiTab data={shown} history={history} now={time} />}
            {shown && tab === 'hotes' && <HostsTab data={shown} members={now?.members ?? null} />}
          </ChartBoundary>
        </div>
      </div>
    </section>
  )
}
