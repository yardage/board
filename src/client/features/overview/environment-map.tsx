import type { ReactNode } from 'react'
import type { HostRole } from '../../../server/environment/config.ts'
import { edgeWidth, type MapModel, type NodeLevel } from './environment-map-data.ts'
import { t } from '../../../shared/i18n/i18n.ts'
import { plural } from '../reports/report-text.ts'
import { hour } from './infra.tsx'
import { personOf } from '../../lib/people.tsx'

/**
 * The environment at a glance: the repository in the middle, the members and their machines on its left, and on
 * its right the CI runners, then the servers and the public addresses. Every line carries a word or a figure, a
 * thicker line carried more jobs over the last two hours, and a line with dots running along it is a job running
 * now. Nothing here is drawn from a schema: a node exists because the configuration or GitHub names it, and a
 * line because something was read about it (`mapModel`).
 */

const W = 960
const PAD = 16
const COLUMN_W = 216
const LEFT_X = 24
const RIGHT_X = W - 24 - COLUMN_W
const HUB_W = 250
const HUB_H = 114
const HUB_X = (W - HUB_W) / 2
const CARD_H = 56
const MEMBERS_H = 68
const GAP = 12
const CAPTION_H = 20
const ROLE_WORDS: Record<HostRole, string> = { ci: 'CI', dev: t('développement'), server: t('serveur'), other: t('machine') }
/** A character of the 11-pixel label, so that a pill fits its word. */
const CHAR = 6.7

interface Placed {
  key: string
  y: number
  height: number
  kind: 'members' | 'host' | 'runner' | 'endpoint'
  index: number
}

/** Columns of cards with a caption over each group, stacked with gaps. */
function stack(groups: { caption: string | null; cards: { key: string; height: number; kind: Placed['kind']; index: number }[] }[]): { placed: Placed[]; captions: { y: number; text: string }[]; height: number } {
  const placed: Placed[] = []
  const captions: { y: number; text: string }[] = []
  let y = 0
  for (const group of groups) {
    if (!group.cards.length) continue
    if (group.caption) {
      captions.push({ y, text: group.caption })
      y += CAPTION_H
    }
    for (const card of group.cards) {
      placed.push({ key: card.key, y, height: card.height, kind: card.kind, index: card.index })
      y += card.height + GAP
    }
    y += GAP
  }
  return { placed, captions, height: Math.max(0, y - 2 * GAP) }
}

/** A point along a cubic curve, to put a word where the line passes. */
function along(x1: number, y1: number, cx1: number, cy1: number, cx2: number, cy2: number, x2: number, y2: number, s: number): [number, number] {
  const u = 1 - s
  return [u * u * u * x1 + 3 * u * u * s * cx1 + 3 * u * s * s * cx2 + s * s * s * x2, u * u * u * y1 + 3 * u * u * s * cy1 + 3 * u * s * s * cy2 + s * s * s * y2]
}

function Edge({ id, from, to, width, tone, label, at = 0.58, flowing = false, dotted = false, arrow = true }: { id: string; from: [number, number]; to: [number, number]; width: number; tone: 'on' | 'off' | 'red'; label: string; at?: number; flowing?: boolean; dotted?: boolean; arrow?: boolean }) {
  const dx = to[0] - from[0]
  const cx1 = from[0] + dx * 0.45
  const cx2 = to[0] - dx * 0.45
  const d = `M ${from[0]} ${from[1]} C ${cx1} ${from[1]}, ${cx2} ${to[1]}, ${to[0]} ${to[1]}`
  const [lx, ly] = along(from[0], from[1], cx1, from[1], cx2, to[1], to[0], to[1], at)
  const pillW = label.length * CHAR + 14
  return (
    <g className={`edge-group ${tone}`}>
      <path id={id} className={`edge ${dotted ? 'dotted' : ''} ${flowing ? 'flow' : ''}`} d={d} strokeWidth={width} markerEnd={arrow ? 'url(#env-arrow)' : undefined} />
      {flowing &&
        [0, 0.5].map((offset) => (
          <circle key={offset} className="flow-dot" r={2.5 + width / 2}>
            {/* Started in the past, not later: a dot waiting for its turn would sit in the map's corner until then. */}
            <animateMotion dur="1.8s" begin={`${-offset * 1.8}s`} repeatCount="indefinite" rotate="auto">
              <mpath href={`#${id}`} />
            </animateMotion>
          </circle>
        ))}
      <g className="pill" transform={`translate(${lx - pillW / 2} ${ly - 9})`}>
        <rect width={pillW} height={18} />
        <text x={pillW / 2} y={12.5} textAnchor="middle">
          {label}
        </text>
      </g>
    </g>
  )
}

function Card({ x, y, width, height, level, children }: { x: number; y: number; width: number; height: number; level: NodeLevel | 'busy'; children: ReactNode }) {
  return (
    <g className={`card ${level}`} transform={`translate(${x} ${y})`}>
      <rect className="body" width={width} height={height} />
      <rect className="bar" width={3} height={height} />
      {children}
    </g>
  )
}

/** A small bar of what is used, with its word: the figures a host writes about itself. */
function Gauge({ x, y, label, share }: { x: number; y: number; label: string; share: number | null }) {
  const width = 54
  return (
    <g className={`gauge ${share !== null && share > 0.9 ? 'red' : share !== null && share > 0.75 ? 'amber' : ''}`} transform={`translate(${x} ${y})`}>
      <text className="gauge-label" x={0} y={8}>
        {label}
      </text>
      <rect className="track" x={28} y={2} width={width} height={6} />
      {share !== null && <rect className="fill" x={28} y={2} width={Math.max(1, width * share)} height={6} />}
      {share === null && (
        <text className="gauge-none" x={28} y={8}>
          —
        </text>
      )}
    </g>
  )
}

const trim = (name: string, max: number) => (name.length > max ? `${name.slice(0, max - 1)}…` : name)

export function EnvironmentMap({ model, now = Date.now() }: { model: MapModel; now?: number }) {
  const servers = model.hosts.filter((host) => host.role === 'server')
  const machines = model.hosts.filter((host) => host.role !== 'server')
  const right = stack([
    { caption: model.runners.length ? t('Intégration continue') : null, cards: model.runners.map((runner, index) => ({ key: `runner-${runner.name}`, height: CARD_H, kind: 'runner' as const, index })) },
    {
      caption: servers.length + model.endpoints.length ? t('En service') : null,
      cards: [...servers.map((host) => ({ key: `host-${host.name}`, height: CARD_H, kind: 'host' as const, index: model.hosts.indexOf(host) })), ...model.endpoints.map((endpoint, index) => ({ key: `endpoint-${endpoint.name}`, height: CARD_H, kind: 'endpoint' as const, index }))],
    },
  ])
  const left = stack([
    { caption: null, cards: model.members ? [{ key: 'members', height: MEMBERS_H, kind: 'members' as const, index: 0 }] : [] },
    { caption: machines.length ? t('Postes') : null, cards: machines.map((host) => ({ key: `host-${host.name}`, height: CARD_H, kind: 'host' as const, index: model.hosts.indexOf(host) })) },
  ])
  if (!right.placed.length && !left.placed.length) return null
  const height = Math.max(left.height, right.height, HUB_H) + 2 * PAD
  const hubY = (height - HUB_H) / 2
  const leftTop = (height - left.height) / 2
  const rightTop = (height - right.height) / 2
  /** Where a line leaves the hub: spread along its edge, so that no two lines share a start. */
  const anchors = (count: number) => Array.from({ length: count }, (_, index) => hubY + (count === 1 ? HUB_H / 2 : 14 + ((HUB_H - 28) * index) / (count - 1)))
  const leftAnchors = anchors(left.placed.length)
  const rightAnchors = anchors(right.placed.length)
  const main = model.repository.main
  const mainWord = main === 'failure' ? t('branche principale rouge') : main === 'success' ? t('branche principale verte') : main === 'running' || main === 'queued' ? t('branche principale en cours') : t('dépôt principal')
  const hubLevel: NodeLevel = main === 'failure' ? 'red' : main === 'success' ? 'ok' : 'none'
  // One fact per line: a line longer than the card would run out of it.
  const activity = [model.repository.running ? t('{0} en cours', { 0: model.repository.running }) : '', model.repository.queued ? t('{0} en file', { 0: model.repository.queued }) : ''].filter(Boolean).join(' · ')
  const states = { busy: t('occupé'), idle: t('libre'), offline: t('hors ligne') }
  const levels: Record<NodeLevel, string> = { ok: t('relevé normal'), amber: t('à surveiller'), red: t('alerte'), none: t('aucun relevé') }
  const minutes = (iso: string) => Math.max(0, Math.round((now - Date.parse(iso)) / 60_000))
  return (
    <div className="env-map">
      <svg viewBox={`0 0 ${W} ${height}`} role="img" aria-label={t('Carte de l’environnement : les membres, le dépôt, les machines et les adresses, avec ce qui circule entre eux')}>
        <defs>
          <marker id="env-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" markerUnits="userSpaceOnUse" orient="auto-start-reverse">
            <path d="M 0 0 L 8 4 L 0 8 z" />
          </marker>
        </defs>

        {/* Lines first, so that the cards cover their ends. */}
        {left.placed.map((card, index) => {
          const from: [number, number] = [LEFT_X + COLUMN_W, leftTop + card.y + card.height / 2]
          const to: [number, number] = [HUB_X, leftAnchors[index]]
          if (card.kind === 'members' && model.members) {
            const pulls = model.repository.pulls
            return <Edge key={card.key} id={`env-${card.key}`} from={from} to={to} width={edgeWidth(pulls ?? 0)} tone={model.members.online ? 'on' : 'off'} label={pulls === null ? t('{0} en ligne', { 0: model.members.online }) : t('{0} PR ouvertes', { 0: pulls })} at={0.5} />
          }
          const host = model.hosts[card.index]
          return <Edge key={card.key} id={`env-${card.key}`} from={from} to={to} width={1} tone="off" label={ROLE_WORDS[host.role]} dotted arrow={false} at={0.5} />
        })}
        {right.placed.map((card, index) => {
          const from: [number, number] = [HUB_X + HUB_W, rightAnchors[index]]
          const to: [number, number] = [RIGHT_X, rightTop + card.y + card.height / 2]
          if (card.kind === 'runner') {
            const runner = model.runners[card.index]
            const label = runner.running ?? (runner.jobs ? plural(runner.jobs, '{0} job', '{0} jobs') : t('aucun job'))
            return <Edge key={card.key} id={`env-${card.key}`} from={from} to={to} width={edgeWidth(runner.jobs)} tone={runner.running || runner.jobs ? 'on' : 'off'} label={label} flowing={Boolean(runner.running)} />
          }
          if (card.kind === 'host') return <Edge key={card.key} id={`env-${card.key}`} from={from} to={to} width={1} tone="off" label={ROLE_WORDS[model.hosts[card.index].role]} dotted arrow={false} />
          const endpoint = model.endpoints[card.index]
          return <Edge key={card.key} id={`env-${card.key}`} from={from} to={to} width={1} tone={endpoint.ok ? 'on' : 'red'} label={endpoint.ok ? t('{0} ms', { 0: endpoint.ms }) : t('ne répond pas')} />
        })}

        {/* The hub. */}
        <Card x={HUB_X} y={hubY} width={HUB_W} height={HUB_H} level={hubLevel}>
          <text className="name big" x={14} y={26}>
            {trim(model.repository.name, 26)}
          </text>
          <text className="state" x={14} y={46}>
            {hubLevel !== 'none' && <tspan className="mark">■ </tspan>}
            {mainWord}
          </text>
          {model.repository.pulls !== null && (
            <text className="meta" x={14} y={66}>
              {t('{0} PR ouvertes', { 0: model.repository.pulls })}
            </text>
          )}
          {activity && (
            <text className="meta accent" x={14} y={84}>
              {activity}
            </text>
          )}
          {model.repository.merging && (
            <text className="meta accent" x={14} y={102}>
              {t('merge en test')}
            </text>
          )}
        </Card>

        {/* The left column: members, then their machines. */}
        {left.captions.map((caption) => (
          <text key={caption.text} className="caption" x={LEFT_X} y={leftTop + caption.y + 12}>
            {caption.text}
          </text>
        ))}
        {left.placed.map((card) => {
          const y = leftTop + card.y
          if (card.kind === 'members' && model.members) {
            const { faces, online, total } = model.members
            return (
              <Card key={card.key} x={LEFT_X} y={y} width={COLUMN_W} height={card.height} level={online ? 'busy' : 'none'}>
                <text className="name" x={14} y={20}>
                  {t('Membres')}
                </text>
                <text className="state" x={14} y={36}>
                  {t('{0} en ligne sur {1}', { 0: online, 1: total })}
                </text>
                {faces.map((face, index) => {
                  const person = personOf(face.login)
                  return (
                    <g key={face.login} className={`face ${person.tone} ${face.online ? 'online' : 'away'}`} transform={`translate(${24 + index * 26} 53)`}>
                      <title>{t('{0} : {1}', { 0: person.name, 1: face.online ? t('en ligne') : t('hors ligne') })}</title>
                      <circle r={9} />
                      <text y={3.5} textAnchor="middle">
                        {person.initial}
                      </text>
                    </g>
                  )
                })}
                {total > faces.length && (
                  <text className="meta" x={24 + faces.length * 26 - 6} y={57}>
                    +{total - faces.length}
                  </text>
                )}
              </Card>
            )
          }
          const host = model.hosts[card.index]
          return (
            <Card key={card.key} x={LEFT_X} y={y} width={COLUMN_W} height={card.height} level={host.level}>
              <text className="name" x={14} y={20}>
                {trim(host.name, 24)}
              </text>
              <text className="state" x={14} y={36}>
                {host.level !== 'none' && host.level !== 'ok' && <tspan className="mark">■ </tspan>}
                {levels[host.level]}
              </text>
              <Gauge x={14} y={41} label="cpu" share={host.cpu} />
              <Gauge x={112} y={41} label="mem" share={host.memory} />
            </Card>
          )
        })}

        {/* The right column: the runners, then what serves. */}
        {right.captions.map((caption) => (
          <text key={caption.text} className="caption" x={RIGHT_X} y={rightTop + caption.y + 12}>
            {caption.text}
          </text>
        ))}
        {right.placed.map((card) => {
          const y = rightTop + card.y
          if (card.kind === 'runner') {
            const runner = model.runners[card.index]
            return (
              <Card key={card.key} x={RIGHT_X} y={y} width={COLUMN_W} height={card.height} level={runner.state === 'offline' ? 'amber' : runner.state === 'busy' ? 'busy' : 'ok'}>
                <text className="name" x={14} y={20}>
                  {trim(runner.name, 24)}
                </text>
                <text className="state" x={14} y={36}>
                  {runner.state === 'busy' && <tspan className="mark">● </tspan>}
                  {states[runner.state]}
                </text>
                <text className="meta" x={14} y={50}>
                  {runner.running && runner.since ? t('{0} · depuis {1}, {2} min', { 0: runner.running, 1: hour(runner.since), 2: minutes(runner.since) }) : runner.jobs ? t('{0} jobs en 2 h', { 0: runner.jobs }) : t('aucun job en 2 h')}
                </text>
              </Card>
            )
          }
          if (card.kind === 'host') {
            const host = model.hosts[card.index]
            return (
              <Card key={card.key} x={RIGHT_X} y={y} width={COLUMN_W} height={card.height} level={host.level}>
                <text className="name" x={14} y={20}>
                  {trim(host.name, 24)}
                </text>
                <text className="state" x={14} y={36}>
                  {host.level !== 'none' && host.level !== 'ok' && <tspan className="mark">■ </tspan>}
                  {levels[host.level]}
                </text>
                <Gauge x={14} y={41} label="cpu" share={host.cpu} />
                <Gauge x={112} y={41} label="disk" share={host.disk} />
              </Card>
            )
          }
          const endpoint = model.endpoints[card.index]
          return (
            <Card key={card.key} x={RIGHT_X} y={y} width={COLUMN_W} height={card.height} level={endpoint.ok ? 'ok' : 'red'}>
              <text className="name" x={14} y={20}>
                {trim(endpoint.name, 24)}
              </text>
              <text className="state" x={14} y={36}>
                <tspan className={`beat ${endpoint.ok ? 'ok' : 'red'}`}>● </tspan>
                {endpoint.ok ? t('répond, {0} ms', { 0: endpoint.ms }) : endpoint.status ? t('répond en erreur ({0})', { 0: endpoint.status }) : t('ne répond pas')}
              </text>
              <text className="meta" x={14} y={50}>
                {t('adresse publique')}
              </text>
            </Card>
          )
        })}
      </svg>
      <p className="env-legend">
        <span>
          <i className="key thick" /> {t('trait épais : plus de jobs sur 2 h')}
        </span>
        <span>
          <i className="key dots" /> {t('points en mouvement : un job tourne')}
        </span>
        <span>
          <i className="key dotted" /> {t('pointillé : rien ne circule, la machine est juste là')}
        </span>
      </p>
    </div>
  )
}
