import { useEffect, useState } from 'react'
import type { ReportSummary } from '../../../server/environment/reports.ts'
import { call } from '../../lib/api.ts'
import { latestGenerated, mergeReportDays, type ReportDay } from '../../../shared/metrics.ts'
import { ReportPage } from './report-page.tsx'
import { SideList } from '../../components/side-list.tsx'
import { Loading } from '../../components/ui.tsx'
import { dateLocale, t } from '../../../shared/i18n/i18n.ts'

/**
 * The reports, read by date. Today shows its updates; a day that ended shows its one report, with its updates folded.
 * Every report is written by the apps themselves: nobody asks for one, and the list says when the last one couldn't be.
 */

const dayName = (day: string) => {
  const date = new Date(`${day}T12:00:00`)
  return Number.isNaN(date.getTime()) ? day : date.toLocaleDateString(dateLocale(), { weekday: 'long', day: 'numeric', month: 'long' })
}

const AUTO = 'auto/'
const toReport = (path: string) => `#rapports/${path.slice(AUTO.length)}`

function DayGroup({ entry, current }: { entry: ReportDay; current: string | null }) {
  const row = (report: ReportDay['reports'][number]) => (
    <a key={report.path} className={`wait-item ${report.path === current ? 'on' : ''}`} href={toReport(report.path)} aria-current={report.path === current ? 'page' : undefined}>
      <strong>{report.name}</strong>
    </a>
  )
  const inFold = entry.folded?.some((report) => report.path === current)
  return (
    <div className="rep-day">
      <h3>{dayName(entry.day)}</h3>
      {entry.reports.map(row)}
      {entry.folded && entry.folded.length > 0 && (
        <details className="rep-fold" open={inFold || undefined}>
          <summary>{t('Les points de la journée ({0})', { 0: entry.folded.length })}</summary>
          {entry.folded.map(row)}
        </details>
      )}
    </div>
  )
}

export function ReportsScreen({ path, tick }: { path: string | null; tick: number }) {
  const [generated, setGenerated] = useState<ReportSummary[]>([])
  const [problem, setProblem] = useState<string | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    let closed = false
    call<{ reports: ReportSummary[]; error: string | null }>('reports').then(
      ({ reports, error }) => {
        if (closed) return
        setGenerated(reports)
        setProblem(error)
        setFailed(false)
        setLoaded(true)
      },
      (failure) => {
        if (closed) return
        setProblem((failure as Error).message)
        setFailed(true)
        setLoaded(true)
      },
    )
    return () => {
      closed = true
    }
  }, [tick])
  const all = mergeReportDays(generated, Date.now())
  const current = path ?? latestGenerated(all)
  // Once shown, the latest stays put: a report arriving from another member's app must not change what is being read.
  useEffect(() => {
    if (!path && current && loaded && !failed) location.replace(toReport(current))
  }, [path, current, loaded, failed])
  const body = () => {
    if (!current) return <div className="empty">{!loaded ? '' : all.length ? t('Choisissez un rapport.') : t('Les rapports apparaîtront ici.')}</div>
    return <ReportPage key={current} id={current.slice(AUTO.length)} />
  }
  return (
    <section className="wait rep">
      <SideList>
        <div className="wait-list rep-list">
          {all.length === 0 && <p className="side-empty">{loaded ? t('Aucun rapport pour l\'instant.') : <Loading>{t('Récupération des rapports…')}</Loading>}</p>}
          {all.map((entry) => (
            <DayGroup key={entry.day} entry={entry} current={current} />
          ))}
          <p className="rep-about">{t('Écrits automatiquement à partir de l’activité du board et de GitHub : un point à heures fixes, et un rapport pour chaque jour terminé.')}</p>
          {problem && <p className="inline-error">{t('Le dernier rapport n\'a pas pu être écrit : {0}', { 0: problem })}</p>}
        </div>
      </SideList>
      <div className="rep-page">{body()}</div>
    </section>
  )
}
