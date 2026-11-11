import type { HostRole } from '../../../server/environment/config.ts'
import type { HostReading } from '../../../server/infra/probes.ts'
import type { JobState, Snapshot } from './infra.tsx'

/**
 * What the environment's map draws, worked out from a snapshot and who is online. Nothing here is a schema:
 * a node is a machine, an address or the repository that the configuration or GitHub names, and a line carries
 * what was read about it.
 */

export type NodeLevel = 'ok' | 'amber' | 'red' | 'none'

export interface MapModel {
  repository: { name: string; main: JobState | null; pulls: number | null; merging: boolean; running: number; queued: number }
  /** Who is online, and a few faces: the online ones first. */
  members: { online: number; total: number; faces: { login: string; online: boolean }[] } | null
  runners: { name: string; state: 'busy' | 'idle' | 'offline'; jobs: number; running: string | null; since: string | null }[]
  /** Shares used, between 0 and 1, when the host has written a reading. */
  hosts: { name: string; role: HostRole; level: NodeLevel; cpu: number | null; memory: number | null; disk: number | null }[]
  endpoints: { name: string; ok: boolean; ms: number; status: number | null }[]
}

export const FACES_SHOWN = 5
const RANK: Record<string, number> = { ok: 0, amber: 1, red: 2 }

/** The worst of a host's signals, or none when it has written nothing readable. */
export function hostLevel(host: HostReading): NodeLevel {
  if (host.state !== 'ok' || !host.signals) return 'none'
  const levels = [host.signals.memory, host.signals.disk, host.signals.age] as string[]
  return levels.reduce<NodeLevel>((worst, level) => ((RANK[level] ?? 0) > RANK[worst] ? (level as NodeLevel) : worst), 'ok')
}

/** A line's width grows with the jobs it carried: one pixel, then one more for every two jobs, five at most. */
export const edgeWidth = (jobs: number) => Math.min(5, 1 + Math.floor(jobs / 2))

const share = (used: number, total: number) => (total > 0 ? Math.min(1, Math.max(0, used / total)) : null)

export function mapModel(data: Snapshot, members: { login?: string; online: boolean }[] | null, repository: string): MapModel {
  const hosts = data.hosts ?? []
  const runnerNames = data.runners ? data.runners.map((runner) => runner.name) : [...new Set(data.jobs.flatMap((job) => (job.runner ? [job.runner] : [])))]
  for (const host of hosts) if (host.role === 'ci' && !runnerNames.includes(host.name)) runnerNames.push(host.name)
  const runners = runnerNames.map((name) => {
    const known = data.runners?.find((runner) => runner.name === name)
    const running = data.jobs.find((job) => job.state === 'running' && job.runner === name)
    return {
      name,
      state: running || known?.busy ? ('busy' as const) : known && !known.online ? ('offline' as const) : ('idle' as const),
      jobs: data.jobs.filter((job) => job.runner === name).length,
      running: running ? (running.pr ? `#${running.pr}` : running.branch) : null,
      since: running?.start ?? null,
    }
  })
  const faces = members
    ? [...members]
        .filter((member) => member.login)
        .sort((a, b) => Number(b.online) - Number(a.online))
        .slice(0, FACES_SHOWN)
        .map((member) => ({ login: member.login as string, online: member.online }))
    : []
  return {
    repository: {
      name: repository,
      main: data.main?.ci ?? null,
      pulls: data.pulls?.open ?? null,
      merging: data.live.main,
      running: data.jobs.filter((job) => job.state === 'running').length,
      queued: data.jobs.filter((job) => job.state === 'queued').length,
    },
    members: members ? { online: members.filter((member) => member.online).length, total: members.length, faces } : null,
    runners,
    hosts: hosts
      .filter((host) => host.role !== 'ci')
      .map((host) => ({
        name: host.name,
        role: host.role,
        level: hostLevel(host),
        cpu: host.reading ? Math.min(1, Math.max(0, host.reading.cpuBusy)) : null,
        memory: host.reading ? share(host.reading.memoryTotal - host.reading.memoryAvailable, host.reading.memoryTotal) : null,
        disk: host.reading ? share(host.reading.diskTotal - host.reading.diskFree, host.reading.diskTotal) : null,
      })),
    endpoints: data.endpoints.map((endpoint) => ({ name: endpoint.name, ok: endpoint.ok, ms: endpoint.ms, status: endpoint.status })),
  }
}
