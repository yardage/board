import { useMemo, useState } from 'react'
import type { HostReading, Level } from '../../../server/infra/probes.ts'
import { ChartBoundary, Legend, LineChart, Meter, Section, TableView, Tip, useWidth } from '../../components/charts.tsx'
import { mapModel } from './environment-map-data.ts'
import { EnvironmentMap } from './environment-map.tsx'
import { lowestMemoryOf } from '../../../shared/metrics.ts'
import { REPOSITORY_URL } from '../../lib/subject.ts'
import { dateLocale, t } from '../../../shared/i18n/i18n.ts'

export type JobState = 'success' | 'failure' | 'other' | 'running' | 'queued'
export interface Job {
  id: number
  branch: string
  pr: number | null
  state: JobState
  start: string
  end: string | null
  runner: string | null
}
export interface Snapshot {
  at: string
  runners: { name: string; online: boolean; busy: boolean }[] | null
  jobs: Job[]
  truncated: boolean
  pulls: { open: number; draft: number; red: number } | null
  waiting: { number: number; title: string; who: string; question: string }[] | null
  stateAt: string | null
  milestones: { title: string; closed: number; total: number; due: string | null }[]
  main: { at: string; ci: JobState } | null
  endpoints: { name: string; url: string; ok: boolean; status: number | null; ms: number }[]
  /** Left out by a server older than the probes. */
  hosts?: HostReading[]
  live: { pull: boolean; main: boolean }
  brief: string[]
}

export const hour = (iso: string) => new Date(iso).toLocaleTimeString(dateLocale(), { hour: '2-digit', minute: '2-digit' })
/** The time, and the day too once it isn't today's: figures a day old mustn't read like today's. */
export const readAt = (iso: string) => {
  const date = new Date(iso)
  return date.toDateString() === new Date().toDateString() ? hour(iso) : `${date.toLocaleDateString(dateLocale(), { day: 'numeric', month: 'short' })} à ${hour(iso)}`
}
export const words: Record<JobState, string> = { success: t('réussi'), failure: t('échoué'), other: t('annulé ou ignoré'), running: t('en cours'), queued: t('en file') }
const percent = (part: number, whole: number) => (whole ? Math.round((100 * part) / whole) : 0)

// --- What the probes say. The server decides each level (`signalsOf`); this only draws it.

const decimal = (value: number) => value.toLocaleString(dateLocale(), { maximumFractionDigits: 1 })
export const mebi = (mib: number) => (mib >= 1024 ? t('{0} Gio', { 0: decimal(mib / 1024) }) : t('{0} Mio', { 0: Math.round(mib) }))
/** Rounded down, as the brief says it: 4.6 % free is under 5 %. */
const freeShare = (free: number, total: number) => Math.floor((100 * free) / total)
const ago = (seconds: number) => (seconds < 90 ? t('il y a {0}', { 0: `${seconds} s` }) : seconds < 5400 ? t('il y a {0} min', { 0: Math.round(seconds / 60) }) : t('il y a {0}', { 0: `${decimal(seconds / 3600)} h` }))
/** The mark of a level. Its words are in the row's last column, never the colour alone. */
const Mark = ({ level }: { level: Level }) => (level === 'ok' ? null : <i className={`inf-dot ${level === 'red' ? 'stop' : 'hold'}`} />)
const isCi = (host: HostReading) => host.role === 'ci'

/** What a host's probe says, in words: why there is no reading, or what is off in it. */
export function hostWords(host: HostReading): string {
  if (host.state === 'none') return t('pas encore de relevé : l\'hôte n\'a rien écrit')
  if (host.state === 'unreadable') return t('relevé refusé, {0}', { 0: host.problem ?? t('illisible') })
  const { reading, signals } = host
  if (!reading || !signals) return ''
  const words: string[] = []
  if (signals.age !== 'ok') words.push(t('relevé {0}', { 0: ago(host.age ?? 0) }))
  if (signals.memory === 'red') words.push(t('{0} OOM sur 6 h', { 0: signals.oomRecent }))
  else if (signals.memory === 'amber') words.push(t('mémoire libre sous {0}', { 0: mebi(signals.memoryFloor) }))
  if (signals.disk !== 'ok') words.push(t('disque libre sous {0} %', { 0: signals.disk === 'red' ? 5 : 15 }))
  return words.join(', ')
}

function HostCells({ host }: { host: HostReading | undefined }) {
  const reading = host?.reading
  const signals = host?.signals
  if (!host || !reading || !signals)
    return (
      <>
        <div className="muted">—</div>
        <div className="muted">—</div>
        <div className="muted">—</div>
      </>
    )
  const old = signals.age !== 'ok' ? 'muted' : undefined
  return (
    <>
      <div className={old} title={t('Charge {0} sur {1} threads.', { 0: decimal(reading.load1), 1: reading.cpus })}>
        {t('{0} %', { 0: Math.round(reading.cpuBusy) })}
      </div>
      <div className={old} title={t('Au plus bas de la dernière minute, sur {0}. Sur 6 h : {1} au plus bas.', { 0: mebi(reading.memoryTotal), 1: mebi(signals.memoryLowest6h) })}>
        <Mark level={signals.memory} />
        {mebi(reading.memoryLowest)}
      </div>
      <div className={old} title={t('{0} libres sur {1}.', { 0: mebi(reading.diskFree), 1: mebi(reading.diskTotal) })}>
        <Mark level={signals.disk} />
        {t('{0} %', { 0: freeShare(reading.diskFree, reading.diskTotal) })}
      </div>
    </>
  )
}

/** A host that isn't a runner: its probe is all there is to say whether it is there. */
function ProbeState({ host }: { host: HostReading | undefined }) {
  if (host?.state === 'ok' && host.signals?.age !== 'red')
    return (
      <span className="muted">
        <i className="inf-dot idle" />
        {t('relevé')}
      </span>
    )
  if (host?.state === 'ok')
    return (
      <span>
        <i className="inf-dot stop" />
        {t('muet')}
      </span>
    )
  return (
    <span className="muted">
      <i className="inf-dot idle" />
      {host?.state === 'none' ? t('en attente') : host ? t('illisible') : t('non sondé')}
    </span>
  )
}

/** Whether a public address answers: a mark and a word, its figures being in the last column. */
function EndpointState({ endpoint }: { endpoint: Snapshot['endpoints'][number] }) {
  if (endpoint.ok)
    return (
      <span className="muted">
        <i className="inf-dot ok" />
        {t('en ligne')}
      </span>
    )
  return (
    <span>
      <i className="inf-dot stop" />
      {endpoint.status ? t('en erreur') : t('hors ligne')}
    </span>
  )
}

/** A share of the last hour, from each job's times. */
export const occupationOf = (jobs: Job[], name: string, now: number, since: number) =>
  percent(
    jobs.filter((job) => job.runner === name && job.state !== 'queued').reduce((sum, job) => sum + Math.max(0, (job.end ? Date.parse(job.end) : now) - Math.max(Date.parse(job.start), since)), 0),
    now - since,
  )

export function Brief({ data }: { data: Snapshot }) {
  return (
    <div className="inf-brief">
      <h4>{t('Résumé')}</h4>
      <p>{data.brief.length ? data.brief.join(' ') : t('Rien à signaler.')}</p>
    </div>
  )
}

const STATE_COLOR: Record<JobState, string> = { success: 'var(--green)', failure: 'var(--danger)', other: 'var(--faint)', running: 'var(--accent)', queued: 'var(--faint)' }

/** Each job of the last two hours, on the runner that ran it. The last hour's occupation is a percentage GitHub's times give. */
export function Timeline({ data }: { data: Snapshot }) {
  const [ref, measured] = useWidth()
  const width = Math.max(measured, 560)
  const now = Date.parse(data.at)
  const from = now - 2 * 60 * 60 * 1000
  const [tip, setTip] = useState<{ x: number; y: number; job: number } | null>(null)
  const X0 = 92
  const X1 = width - 58
  const x = (t: number) => X0 + ((Math.max(t, from) - from) / (now - from)) * (X1 - X0)
  // A runner GitHub lists, or a CI host the environment names: the rest ran on GitHub's own machines.
  const own = useMemo(() => new Set([...(data.runners?.map((runner) => runner.name) ?? []), ...(data.hosts ?? []).filter(isCi).map((host) => host.name)]), [data.runners, data.hosts])
  const isOwn = (name: string | null) => Boolean(name && own.has(name))
  const placed = useMemo(() => {
    const ordered = [...data.jobs].filter((job) => job.state !== 'queued').sort((a, b) => a.start.localeCompare(b.start))
    const tracks: number[] = []
    const track = new Map<number, number>()
    for (const job of ordered.filter((one) => !isOwn(one.runner))) {
      const start = Date.parse(job.start)
      let index = tracks.findIndex((end) => end <= start)
      if (index < 0) {
        index = tracks.length
        tracks.push(0)
      }
      tracks[index] = job.end ? Date.parse(job.end) + 10_000 : now
      track.set(job.id, index)
    }
    return { ordered, track, trackCount: tracks.length }
  }, [data.jobs, now, own])
  const names = [...new Set([...(data.runners?.map((runner) => runner.name) ?? []), ...data.jobs.map((job) => job.runner ?? '').filter((name) => isOwn(name))])].sort()
  const th = 14
  const lane = 26
  const yG = 22
  // Room above the lanes for the two lines of "occupé sur 1 h".
  const yC = Math.max(yG + placed.trackCount * th + (placed.trackCount ? 10 : 0), 40)
  const laneOf = (name: string) => yC + names.indexOf(name) * lane
  const bottom = yC + names.length * lane
  const hourAgo = now - 60 * 60 * 1000
  const occupation = (name: string) => occupationOf(data.jobs, name, now, hourAgo)
  const ticks: number[] = []
  const first = new Date(from)
  first.setMinutes(first.getMinutes() < 30 ? 30 : 60, 0, 0)
  for (let t = first.getTime(); t < now; t += 30 * 60_000) ticks.push(t)
  // Read at each render, so a refresh can't leave an old result showing.
  const tipJob = tip && data.jobs.find((job) => job.id === tip.job)
  const tipMinutes = tipJob ? Math.round(((tipJob.end ? Date.parse(tipJob.end) : now) - Date.parse(tipJob.start)) / 60_000) : 0
  const describe = (job: Job, element: Element) => {
    const box = element.getBoundingClientRect()
    setTip({ x: box.left, y: box.bottom, job: job.id })
  }
  return (
    <>
      <Legend
        items={[
          { name: t('réussi'), color: STATE_COLOR.success },
          { name: t('× échoué'), color: STATE_COLOR.failure },
          { name: t('en cours'), color: STATE_COLOR.running },
          { name: t('annulé ou ignoré'), color: STATE_COLOR.other },
        ]}
      />
      <div ref={ref} className="inf-schema">
        {measured > 0 && (
          <svg className="inf-fit" width={width} height={bottom + 22} role="img" aria-label={t('Jobs CI par runner sur deux heures')}>
            <text className="inf-pc small" x={width} y={yC - 20}>
              {t('occupé')}
            </text>
            <text className="inf-pc small" x={width} y={yC - 7}>
              {t('sur 1 h')}
            </text>
            {ticks.map((t) => (
              <g key={t}>
                <line className="inf-grid" x1={x(t)} x2={x(t)} y1={yG - 4} y2={bottom} />
                <text className="inf-ax" x={x(t)} y={bottom + 15} textAnchor="middle">
                  {hour(new Date(t).toISOString())}
                </text>
              </g>
            ))}
            <line className="inf-grid" x1={X0} x2={X1} y1={bottom} y2={bottom} />
            <line x1={X1} x2={X1} y1={yG - 4} y2={bottom} stroke="var(--fg)" strokeOpacity=".5" />
            <text className="inf-ax" x={X1} y={yG - 9} textAnchor="end">
              {t('maintenant')}
            </text>
            {placed.trackCount > 0 && (
              <>
                <text className="inf-lane" x="0" y={yG + 11}>
                  GitHub
                </text>
                <text className="inf-lane sub" x="0" y={yG + 25}>
                  {t('hébergés')}
                </text>
              </>
            )}
            {names.map((name) => (
              <g key={name}>
                <text className="inf-lane" x="0" y={laneOf(name) + 15}>
                  {name}
                </text>
                <text className="inf-pc" x={width} y={laneOf(name) + 16}>
                  {t('{0} %', { 0: occupation(name) })}
                </text>
              </g>
            ))}
            {placed.ordered
              .filter((job) => (job.end ? Date.parse(job.end) : now) >= from)
              .map((job) => {
                const y = job.runner && isOwn(job.runner) ? laneOf(job.runner) + 3 : yG + (placed.track.get(job.id) ?? 0) * th
                const height = isOwn(job.runner) ? 18 : th - 2
                const start = x(Date.parse(job.start))
                const size = Math.max(x(job.end ? Date.parse(job.end) : now) - start, 4)
                const hover = { onMouseEnter: (event: { currentTarget: Element }) => describe(job, event.currentTarget), onMouseLeave: () => setTip(null), onFocus: (event: { currentTarget: Element }) => describe(job, event.currentTarget), onBlur: () => setTip(null) }
                const mark = (
                  <g className={`inf-bar ${job.state === 'running' ? 'run' : ''}`}>
                    {/* The target is taller than a thin bar, so that a short job can be reached. */}
                    <rect x={start} y={y} width={Math.max(size, 8)} height={height} fill="transparent" />
                    <rect x={start} y={y} width={size} height={height} rx="2" fill={STATE_COLOR[job.state]} />
                    {job.state === 'failure' && size > 9 && (
                      <text x={start + size / 2} y={y + height - 3} textAnchor="middle" className="inf-x">
                        ×
                      </text>
                    )}
                  </g>
                )
                return job.pr ? (
                  <a key={job.id} href={`${REPOSITORY_URL}/pull/${job.pr}`} target="_blank" rel="noreferrer" {...hover}>
                    {mark}
                  </a>
                ) : (
                  <g key={job.id} tabIndex={0} {...hover}>
                    {mark}
                  </g>
                )
              })}
          </svg>
        )}
      </div>
      <Tip
        tip={
          tip && tipJob
            ? {
                x: tip.x,
                y: tip.y,
                content: (
                  <>
                    <strong>{tipJob.pr ? `${tipJob.branch}, #${tipJob.pr}` : tipJob.branch}</strong>
                    <span>
                      {t('{0}, {1}, {2} min, {3}', { 0: tipJob.runner ?? t('sans runner'), 1: hour(tipJob.start), 2: tipMinutes, 3: words[tipJob.state] })}
                    </span>
                  </>
                ),
              }
            : null
        }
      />
      {data.truncated && <p className="inf-foot">{t('Les 100 derniers runs sont montrés : de plus anciens, dans ces deux heures, peuvent manquer.')}</p>}
      <TableView
        head={[t('Début'), t('Branche'), t('Runner'), t('État')]}
        rows={[...data.jobs].sort((a, b) => b.start.localeCompare(a.start)).map((job) => [hour(job.start), job.pr ? `${job.branch}, #${job.pr}` : job.branch, job.runner ?? '', words[job.state]])}
      />
    </>
  )
}

export function RunnerState({ runner, data }: { runner: { name: string; online: boolean; busy: boolean }; data: Snapshot }) {
  const job = data.jobs.find((candidate) => candidate.state === 'running' && candidate.runner === runner.name)
  if (!runner.online)
    return (
      <span>
        <i className="inf-dot stop" />
        {t('hors ligne')}
      </span>
    )
  if (!runner.busy)
    return (
      <span className="muted">
        <i className="inf-dot idle" />
        {t('libre')}
      </span>
    )
  return (
    <span>
      <i className="inf-dot busy" />
      {job ? t('CI sur {0}', { 0: job.pr ? `#${job.pr}` : job.branch }) : t('occupé')}
    </span>
  )
}

/** One line per runner, the ones GitHub lists first, then the CI hosts only a probe knows. */
function ciRows(data: Snapshot): string[] {
  const names = data.runners?.map((runner) => runner.name) ?? []
  for (const host of data.hosts ?? []) if (isCi(host) && !names.includes(host.name)) names.push(host.name)
  return names
}

function LowestMemory({ hosts }: { hosts: HostReading[] }) {
  const chart = useMemo(() => lowestMemoryOf(hosts.filter((host) => isCi(host) && host.state === 'ok')), [hosts])
  if (!chart) return null
  const color = (index: number) => `var(--chart-${(index % 6) + 1})`
  const labels = chart.times.map((time) => hour(new Date(time * 1000).toISOString()))
  const gib = (value: number | null) => (value === null ? null : Math.round(value / 102.4) / 10)
  return (
    <Section title={t('Mémoire libre au plus bas')} note={t('runners CI, par tranche de 5 min, sur 6 h')}>
      <ChartBoundary>
        <Legend items={chart.series.map((one, index) => ({ name: one.name, color: color(index), line: true }))} />
        <LineChart
          label={t('Mémoire libre au plus bas des runners CI, par tranche de 5 minutes : {0}', { 0: chart.series.map((one) => t('{0} {1} au plus bas', { 0: one.name, 1: mebi(Math.min(...one.values.filter((value): value is number => value !== null))) })).join(', ') })}
          labels={labels}
          unit={t(' Gio')}
          height={170}
          series={chart.series.map((one, index) => ({ name: one.name, color: color(index), values: one.values.map(gib) }))}
        />
        <TableView
          head={[t('Moment'), ...chart.series.map((one) => one.name)]}
          numeric={1}
          rows={labels.flatMap((label, index) => (index % 6 === 0 || index === labels.length - 1 ? [[label, ...chart.series.map((one) => (one.values[index] === null ? '—' : mebi(one.values[index]!)))]] : []))}
        />
      </ChartBoundary>
      <p className="inf-foot">{t('Chaque point est le minimum d’une minute, mesuré chaque seconde par la machine elle-même.')}</p>
    </Section>
  )
}

export function HostsTab({ data, members }: { data: Snapshot; members: { login: string; online: boolean }[] | null }) {
  const hosts = data.hosts ?? []
  const repository = REPOSITORY_URL.split('/').slice(-2).join('/') || t('dépôt')
  const byName = new Map(hosts.map((host) => [host.name, host]))
  const ci = ciRows(data)
  const dev = hosts.filter((host) => !isCi(host))
  const words = (name: string) => {
    const host = byName.get(name)
    return host ? hostWords(host) : ''
  }
  const Head = () => (
    <div className="inf-tr head">
      <div>{t('Machine')}</div>
      <div>{t('État')}</div>
      <div>{t('CPU')}</div>
      <div>{t('Mémoire libre')}</div>
      <div>{t('Disque libre')}</div>
      <div>{t('Activité')}</div>
    </div>
  )
  return (
    <>
      <Brief data={data} />
      <EnvironmentMap model={mapModel(data, members, repository)} />
      <div className="inf-table">
        <Head />
        <div className="inf-tr host">
          <div className="name">CI</div>
          <div />
          <div />
          <div />
          <div />
          <div className="act">{data.runners ? t('{0} runners auto-hébergés', { 0: data.runners.length }) : ''}</div>
        </div>
        {!data.runners && (
          <div className="inf-tr">
            <div className="muted">{t('Ce compte GitHub ne peut pas lister les runners.')}</div>
          </div>
        )}
        {ci.map((name, index) => {
          const runner = data.runners?.find((candidate) => candidate.name === name)
          return (
            <div key={name} className="inf-tr">
              <div className="name">
                <span className="branch">{index === ci.length - 1 ? '└─' : '├─'}</span> {name}
              </div>
              <div className="state">{runner ? <RunnerState runner={runner} data={{ ...data, jobs: [] }} /> : <ProbeState host={byName.get(name)} />}</div>
              <HostCells host={byName.get(name)} />
              <div className="act">
                <Activity runner={name} data={data} />
                {words(name) && <span className={byName.get(name)?.state === 'ok' ? undefined : 'muted'}>{hasActivity(name, data) ? ' · ' : ''}{words(name)}</span>}
              </div>
            </div>
          )
        })}
        {dev.length > 0 && (
          <div className="inf-tr host">
            <div className="name">{t('Autres machines')}</div>
            <div />
            <div />
            <div />
            <div />
            <div className="act">{dev.length > 1 ? t('{0} machines', { 0: dev.length }) : t('1 machine')}</div>
          </div>
        )}
        {dev.map((host, index) => (
          <div key={host.name} className="inf-tr">
            <div className="name">
              <span className="branch">{index === dev.length - 1 ? '└─' : '├─'}</span> {host.name}
            </div>
            <div className="state">
              <ProbeState host={host} />
            </div>
            <HostCells host={host} />
            <div className={host.state === 'ok' ? 'act' : 'act muted'}>{hostWords(host)}</div>
          </div>
        ))}
        {data.endpoints.length > 0 && (
          <div className="inf-tr host">
            <div className="name">{t('Adresses publiques')}</div>
            <div />
            <div />
            <div />
            <div />
            <div className="act">{data.endpoints.length > 1 ? t('{0} adresses', { 0: data.endpoints.length }) : t('1 adresse')}</div>
          </div>
        )}
        {data.endpoints.map((endpoint, index) => (
          <div key={endpoint.url} className="inf-tr">
            <div className="name">
              <span className="branch">{index === data.endpoints.length - 1 ? '└─' : '├─'}</span> {endpoint.name}
            </div>
            <div className="state">
              <EndpointState endpoint={endpoint} />
            </div>
            <div />
            <div />
            <div />
            <div className="act">
              {endpoint.ok ? t('répond, {0} ms', { 0: endpoint.ms }) : endpoint.status ? t('répond en erreur ({0})', { 0: endpoint.status }) : t('ne répond pas')}
            </div>
          </div>
        ))}
      </div>
      <LowestMemory hosts={hosts} />
    </>
  )
}

/** Whether `Activity` says anything for this runner. */
const hasActivity = (runner: string, data: Snapshot) => data.jobs.some((job) => job.runner === runner && (job.state === 'running' || job.end))

function Activity({ runner, data }: { runner: string; data: Snapshot }) {
  const job = data.jobs.find((candidate) => candidate.state === 'running' && candidate.runner === runner)
  if (job) return <>{t('CI sur')}{' '}{job.pr ? `#${job.pr}` : job.branch}{t(', depuis {0}', { 0: hour(job.start) })}</>
  const last = data.jobs.filter((candidate) => candidate.runner === runner && candidate.end).sort((a, b) => (b.end ?? '').localeCompare(a.end ?? ''))[0]
  return last ? <>{t('dernier job {0} à {1}', { 0: words[last.state], 1: hour(last.end ?? '') })}</> : null
}
