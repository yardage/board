import { useEffect, useState } from 'react'
import { type OverviewTab, readOverviewHash } from '../../shared/metrics.ts'
import { toThread } from '../lib/people.tsx'
import { readSettingsHash, type SettingsSection } from '../features/settings/settings-sections.ts'

/** The address is the state: a link opens the same thread or document. */
export type Route = { view: 'new' } | { view: 'thread'; id: string } | { view: 'doc'; path: string } | { view: 'overview'; tab: OverviewTab } | { view: 'reports'; path: string | null } | { view: 'settings'; section: SettingsSection } | { view: 'waiting' } | { view: 'polls'; id: string | null; creating: boolean } | { view: 'home' }

const REPORT_DOC = /^(documents\/[\w./-]+\/\d{4}-\d{2}-\d{2}\.md|reports\/\d{4}-\d{2}-\d{2}-\d{4}\.html)$/

export function readRoute(): Route {
  const hash = decodeURIComponent(location.hash.slice(1))
  if (hash.startsWith('t/')) return { view: 'thread', id: hash.slice(2) }
  if (hash === 'nouveau') return { view: 'new' }
  // A report has its own place, wherever a link to it comes from.
  const generated = hash.match(/^d\/reports\/(\d{4}-\d{2}-\d{2}-(?:\d{4}|day))\.json$/)
  if (generated) return { view: 'reports', path: `auto/${generated[1]}` }
  if (hash.startsWith('d/')) return REPORT_DOC.test(hash.slice(2)) ? { view: 'reports', path: hash.slice(2) } : { view: 'doc', path: hash.slice(2) }
  if (hash === 'rapports') return { view: 'reports', path: null }
  if (/^rapports\/\d{4}-\d{2}-\d{2}-(\d{4}|day)$/.test(hash)) return { view: 'reports', path: `auto/${hash.slice('rapports/'.length)}` }
  const overview = readOverviewHash(hash)
  if (overview) return { view: 'overview', tab: overview }
  if (hash === 'valider') return { view: 'waiting' }
  if (hash === 'sondages') return { view: 'polls', id: null, creating: false }
  if (hash === 'sondages/nouveau') return { view: 'polls', id: null, creating: true }
  if (hash.startsWith('sondages/')) return { view: 'polls', id: hash.slice('sondages/'.length), creating: false }
  const section = readSettingsHash(hash)
  if (section) return { view: 'settings', section }
  return { view: 'home' }
}
export const toDoc = (path: string) => `#d/${encodeURI(path)}`

/** The address of a route, the other way round from `readRoute`. */
export function routeHash(route: Route): string {
  switch (route.view) {
    case 'thread':
      return toThread(route.id)
    case 'new':
      return '#nouveau'
    case 'doc':
      return toDoc(route.path)
    case 'overview':
      return route.tab === 'global' ? '#vue' : `#vue/${route.tab}`
    case 'reports':
      return route.path ? `#rapports/${route.path.replace(/^auto\//, '')}` : '#rapports'
    case 'waiting':
      return '#valider'
    case 'polls':
      return route.creating ? '#sondages/nouveau' : route.id ? `#sondages/${encodeURIComponent(route.id)}` : '#sondages'
    default:
      return '#'
  }
}

export function useRoute(): Route {
  const [route, setRoute] = useState(readRoute)
  useEffect(() => {
    const onChange = () => setRoute(readRoute())
    addEventListener('hashchange', onChange)
    return () => removeEventListener('hashchange', onChange)
  }, [])
  return route
}
