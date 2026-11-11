import { useState } from 'react'
import { Section } from '../../components/charts.tsx'
import { Discuss } from '../../components/discuss.tsx'
import { Avatar, ago, type ReplyMode, toThread } from '../../lib/people.tsx'
import { REPOSITORY_URL, subjectOfItem } from '../../lib/subject.ts'
import { Loading } from '../../components/ui.tsx'
import { t } from '../../../shared/i18n/i18n.ts'

/**
 * Who does what, from GitHub itself: what is assigned to each member, their open pull requests, and the
 * reviews asked of them. Online and the agent's mode come from the environment's variables (live.ts).
 * Nothing here comes from anyone's computer.
 */

export interface MemberNow {
  login: string
  name: string
  admin: boolean
  online: boolean
  reply: ReplyMode | null
  seenAt: string | null
  assigned: { number: number; title: string; kind: 'issue' | 'pull' }[]
  pulls: { number: number; title: string; draft: boolean; review: string; ci: string }[]
}

export interface NowData {
  me: string
  members: MemberNow[]
  activities: { threadId: string; agent: string; doing: string }[]
  liveError: string | null
}

const REPLY: Record<ReplyMode, string> = { off: t('répond en personne'), auto: t('agent : répond seul'), draft: t('agent : prépare des brouillons') }
const REVIEW: Record<string, string> = { none: t('sans revue'), approved: t('approuvée'), stale: t('revue à refaire'), changes: t('changements demandés') }

const link = (kind: 'issue' | 'pull', number: number) => `${REPOSITORY_URL}/${kind === 'pull' ? 'pull' : 'issues'}/${number}`

const PULLS_SHOWN = 12
const SEARCH_FROM = 12

export function TeamTab({ data }: { data: NowData | null }) {
  const [query, setQuery] = useState('')
  if (!data) return <Loading>{t('Chargement…')}</Loading>
  const wanted = query.trim().toLowerCase()
  // Online first, then by name: who is there to talk to comes before who isn't.
  const shown = [...data.members]
    .filter((member) => !wanted || member.login.toLowerCase().includes(wanted) || member.name.toLowerCase().includes(wanted))
    .sort((a, b) => Number(b.online) - Number(a.online) || a.name.localeCompare(b.name))
  const online = data.members.filter((member) => member.online).length
  return (
    <div className="team">
      {data.members.length >= SEARCH_FROM && (
        <div className="viz-filters team-tools">
          <input value={query} placeholder={t('Chercher un membre…')} aria-label={t('Chercher un membre…')} onChange={(event) => setQuery(event.target.value)} />
          <small>{t('{0} membres, {1} en ligne', { 0: data.members.length, 1: online })}</small>
        </div>
      )}
      {data.liveError && <p className="inline-error">{t('Qui est en ligne n\'a pas pu être lu : {0}', { 0: data.liveError })}</p>}
      {data.activities.length > 0 && (
        <Section title={t('Votre agent, maintenant')}>
          <ul>
            {data.activities.map((activity) => (
              <li key={activity.threadId}>
                <a href={toThread(activity.threadId)}>{activity.doing || t('Écrit')}</a>
              </li>
            ))}
          </ul>
        </Section>
      )}
      <div className="team-grid">
        {shown.map((member) => (
          <article key={member.login} className="team-member">
            <header>
              <Avatar login={member.login} size={28} />
              <div>
                <strong>{member.name}</strong> <small>{member.login}</small>
                {member.admin && <> <span className="tag">{t('admin')}</span></>}
                <div className="team-state">
                  <span className={member.online ? 'ok' : 'muted'}>{member.online ? t('en ligne') : member.seenAt ? t('vu {0}', { 0: ago(member.seenAt) }) : t('hors ligne')}</span>
                  {member.reply && <span> · {REPLY[member.reply]}</span>}
                </div>
              </div>
            </header>
            <h4>{t('Assigné ({0})', { 0: member.assigned.length })}</h4>
            {member.assigned.length === 0 && <p className="side-empty">{t('Rien d\'assigné sur GitHub.')}</p>}
            <ul>
              {member.assigned.slice(0, 12).map((item) => (
                <li key={item.number}>
                  <a href={link(item.kind, item.number)} target="_blank" rel="noreferrer">
                    #{item.number}
                  </a>{' '}
                  {item.title} <Discuss subject={subjectOfItem(link(item.kind, item.number), item.number, item.title)}>{t('fil')}</Discuss>
                </li>
              ))}
              {member.assigned.length > 12 && <li className="side-empty">{t('et {0} autres', { 0: member.assigned.length - 12 })}</li>}
            </ul>
            <h4>{t('Pull requests ouvertes ({0})', { 0: member.pulls.length })}</h4>
            <ul>
              {member.pulls.slice(0, PULLS_SHOWN).map((pull) => (
                <li key={pull.number}>
                  <a href={link('pull', pull.number)} target="_blank" rel="noreferrer">
                    #{pull.number}
                  </a>{' '}
                  {pull.title} <small>{[pull.draft ? t('brouillon') : '', REVIEW[pull.review] ?? '', pull.ci].filter(Boolean).join(' · ')}</small>
                </li>
              ))}
              {member.pulls.length > PULLS_SHOWN && <li className="side-empty">{t('et {0} autres', { 0: member.pulls.length - PULLS_SHOWN })}</li>}
            </ul>
          </article>
        ))}
      </div>
    </div>
  )
}
