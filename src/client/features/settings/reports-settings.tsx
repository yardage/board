import { useEffect, useMemo, useState } from 'react'
import { dateLocale, t } from '../../../shared/i18n/i18n.ts'
import { Group, Row } from './settings-parts.tsx'
import type { EnvironmentEditor } from './environment-draft.tsx'
import { CADENCES, validZone } from './environment-config.ts'
import { Pick, Problem, TextBox } from './environment-fields.tsx'

/** The hours a progress report is written at: from 01:00, every so many hours, as the server cuts them. */
const slotsOf = (every: number) => {
  const slots: string[] = []
  for (let hour = 1; hour < 24; hour += Math.max(1, every)) slots.push(`${String(hour).padStart(2, '0')}:00`)
  return slots
}

/** The time in a zone now, so that a zone typed by hand says whether it is the one meant. */
function useClock(zone: string): string | null {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(timer)
  }, [])
  if (!validZone(zone)) return null
  return new Date(now).toLocaleTimeString(dateLocale(), { timeZone: zone, hour: '2-digit', minute: '2-digit' })
}

/** When reports are written and in which time zone, and the team's habits the counts depend on. */
export function ReportsPart({ editor }: { editor: EnvironmentEditor }) {
  const { draft, editable, set, problems } = editor
  const conventions = draft.conventions
  const zones = useMemo(() => {
    try {
      return Intl.supportedValuesOf('timeZone')
    } catch {
      return []
    }
  }, [])
  const clock = useClock(draft.timezone)
  const slots = slotsOf(conventions.reportEveryHours)
  const hint = (key: string, text: string) => (problems[key] ? <Problem text={problems[key]} /> : text)
  return (
    <>
      <Group title={t('Rapports')} note={t('Un point aux heures dites, et un rapport pour chaque jour terminé, dans ce fuseau.')}>
        <Row label={t('Cadence')} hint={slots.length <= 8 ? t('Points à {0}.', { 0: slots.join(', ') }) : t('Points toutes les {0} h, de {1} à {2}.', { 0: conventions.reportEveryHours, 1: slots[0], 2: slots[slots.length - 1] })}>
          <Pick<string>
            value={String(conventions.reportEveryHours)}
            editable={editable}
            label={t('Cadence')}
            options={CADENCES.map((hours) => [String(hours), hours === 24 ? t('une fois par jour') : t('toutes les {0} h', { 0: hours })])}
            onPick={(hours) => set({ conventions: { ...conventions, reportEveryHours: Number(hours) } })}
          />
        </Row>
        <Row label={t('Fuseau horaire')} hint={hint('timezone', clock ? t('Il y est {0}.', { 0: clock }) : '')}>
          <TextBox value={draft.timezone} editable={editable} label={t('Fuseau horaire')} placeholder="Europe/Paris" list="set-zones" problem={problems.timezone} onChange={(timezone) => set({ timezone: timezone.trim() })} />
          {editable && (
            <datalist id="set-zones">
              {zones.map((zone) => (
                <option key={zone} value={zone} />
              ))}
            </datalist>
          )}
        </Row>
      </Group>
      <Group title={t('Conventions')} note={t('Les habitudes de l’équipe sur GitHub, que les comptes et les revues suivent.')}>
        <Row label={t('Étiquette des épics')} hint={hint('conventions.epicLabel', t('Les tickets qui la portent ne sont pas comptés comme du travail. Vide : aucune.'))}>
          <TextBox value={conventions.epicLabel} editable={editable} label={t('Étiquette des épics')} placeholder={t('aucune')} problem={problems['conventions.epicLabel']} onChange={(epicLabel) => set({ conventions: { ...conventions, epicLabel: epicLabel.trim() } })} />
        </Row>
        <Row label={t('Commentaire valant revue')} hint={hint('conventions.reviewComment', t('Un commentaire qui commence ainsi, puis APPROVE ou CHANGES et le commit, compte comme une revue. Vide : seules les revues GitHub comptent.'))}>
          <TextBox value={conventions.reviewComment} editable={editable} label={t('Commentaire valant revue')} placeholder={t('aucun')} problem={problems['conventions.reviewComment']} onChange={(reviewComment) => set({ conventions: { ...conventions, reviewComment } })} />
        </Row>
      </Group>
    </>
  )
}
