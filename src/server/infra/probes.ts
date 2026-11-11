import type { HostRole } from '../environment/config.ts'

/**
 * A host's CPU, memory and disk, in the format the board's reporter writes (host/report.sh): the host writes its
 * reading to a variable of the environment repository (see live.ts and host/README.md).
 * A reading is someone else's text: a job on a CI runner runs as root and can make its host say
 * anything. So only numbers in range are kept, and nothing acts on them.
 */

const MAX_POINTS = 400
/** Unix seconds from 2001 to 2286: anything else isn't a time. */
const SECONDS: [number, number] = [1_000_000_000, 10_000_000_000]
const FUTURE_S = 120

/** Free memory under which a CI host shows amber, unless the environment's conventions say otherwise. */
export const CI_MEMORY_MIB = 1536
export const OTHER_MEMORY_SHARE = 0.1
export const DISK_AMBER = 0.15
export const DISK_RED = 0.05
export const AGE_AMBER_S = 3 * 60
export const AGE_RED_S = 15 * 60

export interface ProbePoint {
  at: number
  lowest: number
  cpu: number
  diskFree: number
  oomKills: number
}

export interface ProbeReading {
  /** Unix seconds, by the host's clock. */
  at: number
  uptime: number
  cpus: number
  cpuBusy: number
  load1: number
  load5: number
  memoryTotal: number
  memoryAvailable: number
  /** The lowest free memory of the minute: a full check peaks for seconds. */
  memoryLowest: number
  pressure: number | null
  oomKills: number
  diskTotal: number
  diskFree: number
  /** Oldest first, up to 6 hours. */
  points: ProbePoint[]
}

export type Level = 'ok' | 'amber' | 'red'

export interface HostSignals {
  memory: Level
  disk: Level
  age: Level
  /** OOM kills within the points, with no reboot between two of them. */
  oomRecent: number
  /** The lowest free memory over the points, in MiB. */
  memoryLowest6h: number
  /** Under this much free memory, in MiB, the host shows amber. */
  memoryFloor: number
}

export interface HostReading {
  name: string
  role: HostRole
  /** ok: a reading; none: the host has written nothing yet; unreadable: what it wrote isn't a reading. */
  state: 'ok' | 'none' | 'unreadable'
  /** Seconds since the reading, by the host's clock when it wrote it and by GitHub's since. */
  age: number | null
  reading: ProbeReading | null
  signals: HostSignals | null
  /** Why there is no reading, in a few words of ours, never with what the host sent. */
  problem: string | null
}

const number = (value: unknown, min: number, max: number): number | null => (typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max ? value : null)
const integer = (value: unknown, min: number, max: number): number | null => {
  const found = number(value, min, max)
  return found !== null && Number.isInteger(found) ? found : null
}

/** A reading, or why it isn't one. Unknown fields are left out, a missing or odd one refuses the whole of it. */
export function parseReading(text: string, hostNow: number): { reading: ProbeReading; age: number } | { problem: string } {
  let raw: any
  try {
    raw = JSON.parse(text)
  } catch {
    return { problem: 'pas du JSON' }
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { problem: 'pas un relevé' }
  if (raw.v !== 1) return { problem: 'format inconnu' }
  const memoryTotal = integer(raw.memory_total_mib, 1, 2 ** 26)
  const diskTotal = integer(raw.disk_total_mib, 1, 2 ** 34)
  const fields = {
    at: integer(raw.at, ...SECONDS),
    uptime: integer(raw.uptime_s, 0, 100 * 365 * 86_400),
    cpus: integer(raw.cpus, 1, 4096),
    cpuBusy: number(raw.cpu_busy_pct, 0, 100),
    load1: number(raw.load1, 0, 100_000),
    load5: number(raw.load5, 0, 100_000),
    memoryTotal,
    memoryAvailable: memoryTotal === null ? null : integer(raw.memory_available_mib, 0, memoryTotal),
    memoryLowest: memoryTotal === null ? null : integer(raw.memory_available_lowest_mib, 0, memoryTotal),
    oomKills: integer(raw.oom_kills, 0, 1e12),
    diskTotal,
    diskFree: diskTotal === null ? null : integer(raw.disk_free_mib, 0, diskTotal),
  }
  const bad = Object.entries(fields).find(([, value]) => value === null)
  if (bad) return { problem: `valeur refusée (${bad[0]})` }
  const pressure = raw.memory_pressure_avg60 === null ? null : number(raw.memory_pressure_avg60, 0, 100)
  if (pressure === null && raw.memory_pressure_avg60 !== null) return { problem: 'valeur refusée (pressure)' }
  if (!Array.isArray(raw.points) || raw.points.length > MAX_POINTS) return { problem: 'historique refusé' }
  const points: ProbePoint[] = []
  for (const point of raw.points) {
    if (!Array.isArray(point) || point.length !== 5) return { problem: 'historique refusé' }
    const [at, lowest, cpu, diskFree, oomKills] = [integer(point[0], ...SECONDS), integer(point[1], 0, fields.memoryTotal!), integer(point[2], 0, 100), integer(point[3], 0, fields.diskTotal!), integer(point[4], 0, 1e12)]
    if (at === null || lowest === null || cpu === null || diskFree === null || oomKills === null) return { problem: 'historique refusé' }
    points.push({ at, lowest, cpu, diskFree, oomKills })
  }
  points.sort((a, b) => a.at - b.at)
  const age = Math.round(hostNow / 1000 - fields.at!)
  if (age < -FUTURE_S) return { problem: 'daté du futur' }
  return { reading: { ...(fields as { [K in keyof typeof fields]: number }), pressure, points }, age: Math.max(0, age) }
}

/** OOM kills that the points saw happen: a count going down is a reboot, which starts it again. */
export function recentOomKills(points: ProbePoint[]): number {
  let kills = 0
  for (let index = 1; index < points.length; index++) {
    const step = points[index].oomKills - points[index - 1].oomKills
    if (step > 0) kills += step
  }
  return kills
}

/** The levels a reading gives. The board only displays them. */
export function signalsOf(role: HostRole, reading: ProbeReading, age: number, ciMemoryMib = CI_MEMORY_MIB): HostSignals {
  const oomRecent = recentOomKills(reading.points)
  const memoryFloor = Math.round(role === 'ci' ? ciMemoryMib : reading.memoryTotal * OTHER_MEMORY_SHARE)
  const diskShare = reading.diskFree / reading.diskTotal
  return {
    memory: oomRecent > 0 ? 'red' : reading.memoryLowest < memoryFloor ? 'amber' : 'ok',
    disk: diskShare < DISK_RED ? 'red' : diskShare < DISK_AMBER ? 'amber' : 'ok',
    age: age > AGE_RED_S ? 'red' : age > AGE_AMBER_S ? 'amber' : 'ok',
    oomRecent,
    memoryLowest6h: Math.min(reading.memoryLowest, ...reading.points.map((point) => point.lowest)),
    memoryFloor,
  }
}

/**
 * Every host to show: those the configuration names, with their role, then any other that writes a
 * reading, CI first. `written` is when GitHub received each one.
 */
export function hostReadings(
  configured: { name: string; role: HostRole }[],
  written: { name: string; value: string; updatedAt: string }[],
  now = Date.now(),
  ciMemoryMib = CI_MEMORY_MIB,
): HostReading[] {
  const roles = new Map(configured.map((host) => [host.name, host.role]))
  const names = [...configured.map((host) => host.name), ...written.map((entry) => entry.name).filter((name) => !roles.has(name))]
  const rank = (name: string) => ((roles.get(name) ?? 'other') === 'ci' ? 0 : 1)
  return [...new Set(names)]
    .sort((a, b) => rank(a) - rank(b) || a.localeCompare(b, 'en', { numeric: true }))
    .map((name): HostReading => {
      const role = roles.get(name) ?? 'other'
      const entry = written.find((candidate) => candidate.name === name)
      if (!entry) return { name, role, state: 'none', age: null, reading: null, signals: null, problem: "n'a encore rien écrit" }
      const received = Date.parse(entry.updatedAt)
      const parsed = parseReading(entry.value, Number.isFinite(received) ? received : now)
      if ('problem' in parsed) return { name, role, state: 'unreadable', age: null, reading: null, signals: null, problem: parsed.problem }
      const age = parsed.age + Math.max(0, Math.round((now - (Number.isFinite(received) ? received : now)) / 1000))
      return { name, role, state: 'ok', age, reading: parsed.reading, signals: signalsOf(role, parsed.reading, age, ciMemoryMib), problem: null }
    })
}
