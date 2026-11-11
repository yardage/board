import { useCallback, useEffect, useState } from 'react'
import { type Allowed, type Done, DoneLine, ItemActions } from './answer.tsx'
import { SideList } from '../../components/side-list.tsx'
import { ageWords, type WaitingSort, waitingOrder } from '../../lib/lists.ts'
import { useRemembered } from '../../lib/memory.ts'
import { call } from '../../lib/api.ts'
import { Discuss, LinkedThreads } from '../../components/discuss.tsx'
import { personOf } from '../../lib/people.tsx'
import { subjectOfItem } from '../../lib/subject.ts'
import { Loading } from '../../components/ui.tsx'
import { dateLocale, t } from '../../../shared/i18n/i18n.ts'
import { SideTabs } from '../../components/side-tabs.tsx'

/**
 * What waits for a member on GitHub: an item with the configured label whose project field names them,
 * and a pull request whose review GitHub asks of them. GitHub is the record: an answer is a comment, a
 * review a review, both posted with the member's login, from here or from GitHub itself.
 */

interface Item {
  number: number
  title: string
  who: string
  question: string
  author?: string
  url?: string
  draft?: boolean
  reviewers?: string[]
  /** It waits for this member, by the field or by a review GitHub asks. */
  mine: boolean
  /** GitHub asks this member's review. */
  review: boolean
  createdAt?: string | null
  /** Open tickets listing this one under "Depends on". */
  unblocks?: number[]
}

export interface WaitingData {
  items: Item[] | null
  at: string | null
  repository: string
  label: string
  me: string
  may: Allowed
}

const isSort = (value: unknown): value is WaitingSort => value === 'age' || value === 'unblocks'

const shortDate = (iso: string) => new Date(iso).toLocaleString(dateLocale(), { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })

function Detail({ item, data, onDone }: { item: Item; data: WaitingData; onDone: (done: Done) => void }) {
  const pull = Boolean(item.reviewers?.length) || Boolean(item.url?.includes('/pull/'))
  const url = item.url ?? `${data.repository}/${pull ? 'pull' : 'issues'}/${item.number}`
  const subject = subjectOfItem(url, item.number, item.title, item.question || undefined)
  const labelled = Boolean(item.who || item.question) || !item.review
  return (
    <article className="wait-detail">
      <h2>
        <a href={url} target="_blank" rel="noreferrer" data-outside>
          #{item.number}
        </a>{' '}
        {item.title}
      </h2>
      <div className="wait-meta">
        {item.author && <span>{t('demandé par {0}', { 0: personOf(item.author).name })}</span>}
        {item.who && <span>{t('attend {0}', { 0: personOf(item.who).name })}</span>}
        {item.review && <span>{t('votre revue est demandée')}</span>}
        {item.draft && <span>{t('brouillon')}</span>}
        <LinkedThreads subject={subject} />
        <Discuss subject={subject} />
        {pull && (
          <a href={`${url}/files`} target="_blank" rel="noreferrer" data-outside>
            {t('voir les changements')}
          </a>
        )}
      </div>
      {item.question && (
        <>
          <h3>{t('La question')}</h3>
          <p>{item.question}</p>
        </>
      )}
      <ItemActions
        item={{
          number: item.number,
          kind: pull ? 'pull' : 'issue',
          url,
          open: true,
          author: item.author ?? '',
          waiting: labelled ? { who: item.who, question: item.question, mine: item.mine && (!item.review || Boolean(item.who)), label: data.label } : null,
          head: null,
          requested: item.review,
        }}
        may={data.may}
        me={data.me}
        onDone={onDone}
      />
    </article>
  )
}

export function WaitingScreen({ tick }: { tick: number }) {
  const [data, setData] = useState<WaitingData | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const [tab, setTab] = useState<'me' | 'other'>('me')
  const [selected, setSelected] = useState<number | null>(null)
  const [done, setDone] = useState<Done | null>(null)
  const [sort, setSort] = useRemembered<WaitingSort>('waiting-sort', 'age', isSort)
  const load = useCallback(() => {
    call<WaitingData>('waiting')
      .then((found) => {
        setData(found)
        setFailure(null)
      })
      .catch((error) => setFailure((error as Error).message))
  }, [])
  useEffect(load, [load, tick])
  const arriving = data !== null && !data.items && Boolean(data.repository)
  useEffect(() => {
    if (!arriving) return
    const timer = setInterval(load, 5000)
    return () => clearInterval(timer)
  }, [arriving, load])

  if (failure) return <div className="empty">{failure}</div>
  if (!data)
    return (
      <div className="empty">
        <Loading>{t('Chargement…')}</Loading>
      </div>
    )
  if (!data.repository) return <div className="empty">{t('Aucun dépôt n\'est configuré pour cet environnement : un administrateur l\'ajoute dans Réglages.')}</div>
  if (!data.items) return <div className="empty">{t('Synchronisation avec GitHub… Ce qui attend une réponse s’affichera ici.')}</div>

  const mine = data.items.filter((item) => item.mine)
  const others = data.items.filter((item) => !item.mine)
  const list = waitingOrder(tab === 'me' ? mine : others, sort)
  const current = list.find((item) => item.number === selected) ?? list[0] ?? null
  return (
    <section className="wait">
      <SideList>
        <div className="wait-list">
          <SideTabs<'me' | 'other'>
            label={t('À valider')}
            value={tab}
            onPick={setTab}
            tabs={[
              { id: 'me', label: t('Pour moi'), count: mine.length },
              { id: 'other', label: t('Autres'), count: others.length },
            ]}
          />
          {list.length > 1 && (
            <div className="viz-filters wait-sort" role="group" aria-label={t('Trier')}>
              {(
                [
                  ['age', t('Plus anciens')],
                  ['unblocks', t('Ce que ça débloque')],
                ] as const
              ).map(([id, label]) => (
                <button key={id} type="button" className={sort === id ? 'on' : ''} aria-pressed={sort === id} onClick={() => setSort(id)}>
                  {label}
                </button>
              ))}
            </div>
          )}
          {list.length === 0 && <p className="wait-note">{t('Rien en attente ici.')}</p>}
          {list.map((item) => (
            <button
              key={item.number}
              type="button"
              className={`wait-item ${current?.number === item.number ? 'on' : ''}`}
              onClick={() => {
                setSelected(item.number)
                setDone((shown) => (shown?.warning ? shown : null))
              }}
            >
              <strong>
                #{item.number} {item.title}
              </strong>
              <small>
                {item.review ? t('revue demandée') : t('attend {0}', { 0: item.who ? personOf(item.who).name : t("quelqu'un") })}
                {ageWords(item.createdAt, Date.now()) && ` · ${ageWords(item.createdAt, Date.now())}`}
                {(item.unblocks?.length ?? 0) > 0 && t(' · débloque {0}', { 0: item.unblocks?.length })}
              </small>
            </button>
          ))}
          <p className="wait-note">
            {t('Depuis GitHub : étiquette {0} et revues demandées', { 0: data.label })}
            {data.at ? t(', lu le {0}', { 0: shortDate(data.at) }) : ''}.
          </p>
        </div>
      </SideList>
      <div className="wait-pane">
        {done && <DoneLine done={done} />}
        {current ? (
          <Detail
            key={current.number}
            item={current}
            data={data}
            onDone={(result) => {
              setDone(result)
              load()
            }}
          />
        ) : (
          <div className="empty">{t('Rien à valider pour le moment.')}</div>
        )}
      </div>
    </section>
  )
}
